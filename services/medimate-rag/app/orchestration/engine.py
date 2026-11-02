"""
MediMate AI — RAG Orchestration Engine
Coordinates document ingestion, chunking, embedding, vector storage, and grounded query retrieval.
"""

from typing import List, Optional
from datetime import datetime, timezone
from pydantic import BaseModel, Field

from app.chunking.chunker import ClinicalDocumentChunker
from app.core.config import settings
from app.core.logging import logger
from app.embeddings.base import BaseEmbeddingProvider
from app.embeddings.mock_provider import DeterministicEmbeddingProvider
from app.embeddings.local_provider import LocalEmbeddingProvider
from app.orchestration.citations import EvidenceAttribution, build_evidence_attribution
from app.orchestration.prompt_builder import build_rag_prompt
from app.parsing.pdf_parser import PDFDocumentParser
from app.storage.base import BaseVectorStore
from app.storage.memory_store import MemoryVectorStore


class IngestionResult(BaseModel):
    document_id: str
    file_name: str
    total_pages: int
    total_chunks: int
    content_hash: str
    extraction_method: str
    ingested_at: str


class RAGQueryResult(BaseModel):
    query: str
    answer: str
    summary: str
    prompt: str
    evidence: EvidenceAttribution
    retrieved_chunk_count: int
    generated_at: str


class RAGEngine:
    def __init__(
        self,
        vector_store: Optional[BaseVectorStore] = None,
        embedding_provider: Optional[BaseEmbeddingProvider] = None,
        chunker: Optional[ClinicalDocumentChunker] = None,
        parser: Optional[PDFDocumentParser] = None,
    ):
        self.vector_store = vector_store or MemoryVectorStore()

        if embedding_provider:
            self.embedding_provider = embedding_provider
        elif settings.embedding_provider == "local":
            self.embedding_provider = LocalEmbeddingProvider(settings.embedding_model_name)
        else:
            self.embedding_provider = DeterministicEmbeddingProvider(
                dimension=settings.embedding_dimensions
            )

        self.chunker = chunker or ClinicalDocumentChunker(
            target_words=settings.chunk_size_words,
            overlap_words=settings.chunk_overlap_words,
        )
        self.parser = parser or PDFDocumentParser()

    def ingest_document(
        self,
        tenant_id: str,
        user_id: str,
        document_bytes: bytes,
        file_name: str,
        document_id: str,
    ) -> IngestionResult:
        logger.info(
            f"Ingesting document '{file_name}' for user '{user_id}'",
            extra={"structured_data": {"document_id": document_id, "size_bytes": len(document_bytes)}}
        )

        # 1. Parse document into pages
        parsed_doc = self.parser.parse_bytes(document_bytes, file_name, document_id)

        # 2. Chunk document preserving clinical boundaries
        chunks = self.chunker.chunk_document(parsed_doc, tenant_id, user_id)
        if not chunks:
            logger.warning(f"No chunks produced for document {document_id}")

        # 3. Generate embeddings
        texts = [c.content for c in chunks]
        embeddings = self.embedding_provider.embed_documents(texts) if texts else []

        # 4. Remove previous version of document if exists (idempotent re-indexing)
        self.vector_store.delete_document(tenant_id, user_id, document_id)

        # 5. Store in vector database
        if chunks:
            self.vector_store.add_chunks(tenant_id, user_id, chunks, embeddings)

        now_iso = datetime.now(timezone.utc).isoformat()
        return IngestionResult(
            document_id=document_id,
            file_name=file_name,
            total_pages=parsed_doc.total_pages,
            total_chunks=len(chunks),
            content_hash=parsed_doc.content_hash,
            extraction_method=parsed_doc.extraction_method,
            ingested_at=now_iso,
        )

    def query(
        self,
        tenant_id: str,
        user_id: str,
        query_text: str,
        top_k: Optional[int] = None,
        similarity_threshold: Optional[float] = None,
        document_ids: Optional[List[str]] = None,
    ) -> RAGQueryResult:
        k = top_k or settings.default_top_k
        threshold = similarity_threshold if similarity_threshold is not None else settings.similarity_threshold

        # 1. Generate query embedding
        query_emb = self.embedding_provider.embed_query(query_text)

        # 2. Retrieve authorized matching chunks
        scored_chunks = self.vector_store.search(
            tenant_id=tenant_id,
            user_id=user_id,
            query_embedding=query_emb,
            top_k=k,
            similarity_threshold=threshold,
            document_ids=document_ids,
        )

        # 3. Build evidence attribution & citations
        evidence = build_evidence_attribution(scored_chunks)

        # 4. Construct grounded prompt
        prompt = build_rag_prompt(query_text, scored_chunks)

        # 5. Generate grounded response
        if not scored_chunks:
            answer = (
                "This information is not found in the uploaded medical records. "
                "Please verify that the relevant lab report, clinical summary, or test result has been uploaded, "
                "or consult your healthcare provider directly."
            )
            summary = "No matching records found in uploaded documents."
        else:
            # Synthesize answer from top retrieved context
            evidence_summaries = []
            for sc in scored_chunks:
                c = sc.chunk
                evidence_summaries.append(
                    f"From {c.section_heading} (Page {c.page_number}): {c.content}"
                )
            answer = (
                f"Based on your uploaded medical records:\n\n"
                + "\n\n".join(f"• {item}" for item in evidence_summaries)
                + "\n\nAlways discuss these findings and clinical interpretations with your physician."
            )
            summary = f"Identified {len(scored_chunks)} relevant findings across {len(evidence.source_documents)} document(s)."

        now_iso = datetime.now(timezone.utc).isoformat()
        return RAGQueryResult(
            query=query_text,
            answer=answer,
            summary=summary,
            prompt=prompt,
            evidence=evidence,
            retrieved_chunk_count=len(scored_chunks),
            generated_at=now_iso,
        )

    def delete_document(self, tenant_id: str, user_id: str, document_id: str) -> int:
        return self.vector_store.delete_document(tenant_id, user_id, document_id)
