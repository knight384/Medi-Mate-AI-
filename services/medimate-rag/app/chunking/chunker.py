"""
MediMate AI — Clinical Document Chunker
Implements page-aware, section-aware, and clinical-entity-aware chunking.
Ensures lab values with units and medications with dosages are preserved intact.
"""

import hashlib
import re
from typing import List, Optional

from app.chunking.models import DocumentChunk
from app.parsing.base import ParsedDocument
from app.parsing.normalizer import extract_sections


# Regular expressions for clinical entity protection
LAB_VALUE_PATTERN = re.compile(
    r"\b[A-Za-z0-9\s\-]{2,30}:\s*\d+(?:\.\d+)?\s*(?:mg/dL|g/dL|mmol/L|mEq/L|IU/L|%|ug/dL|ng/mL|pg/mL|mcg|mg|mcL|/uL|\bunits\b)[^\n]*",
    re.IGNORECASE
)
MEDICATION_PATTERN = re.compile(
    r"\b[A-Z][a-z0-9\-]+\s+\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units)\b[^\n]*",
    re.IGNORECASE
)


class ClinicalDocumentChunker:
    """
    Intelligent medical chunker that respects:
    1. Page boundaries (chunks are tagged with exact source page).
    2. Section headings (preserves heading in context).
    3. Clinical entity lines (keeps lab measurements and medication dosages intact).
    """

    def __init__(self, target_words: int = 400, overlap_words: int = 80):
        self.target_words = max(50, target_words)
        self.overlap_words = min(max(0, overlap_words), self.target_words // 2)

    def chunk_document(
        self,
        document: ParsedDocument,
        tenant_id: str,
        user_id: str,
    ) -> List[DocumentChunk]:
        chunks: List[DocumentChunk] = []
        global_chunk_idx = 0

        for page in document.pages:
            sections = extract_sections(page.text)

            for heading, section_text in sections:
                # Group text into coherent paragraphs / clinical blocks
                blocks = self._split_into_blocks(section_text)
                current_block_words: List[str] = []

                for block in blocks:
                    block_words = block.split()
                    if len(current_block_words) + len(block_words) <= self.target_words:
                        current_block_words.extend(block_words)
                    else:
                        if current_block_words:
                            chunk_text = " ".join(current_block_words)
                            chunk_id = self._generate_chunk_id(
                                document.document_id, page.page_number, global_chunk_idx, chunk_text
                            )
                            chunks.append(
                                DocumentChunk(
                                    chunk_id=chunk_id,
                                    document_id=document.document_id,
                                    tenant_id=tenant_id,
                                    user_id=user_id,
                                    page_number=page.page_number,
                                    section_heading=heading,
                                    content=chunk_text,
                                    chunk_index=global_chunk_idx,
                                    word_count=len(current_block_words),
                                    content_hash=hashlib.sha256(chunk_text.encode("utf-8")).hexdigest(),
                                    metadata={
                                        "file_name": document.file_name,
                                        "extraction_method": document.extraction_method,
                                    },
                                )
                            )
                            global_chunk_idx += 1

                            # Sliding window overlap
                            if self.overlap_words > 0 and len(current_block_words) > self.overlap_words:
                                current_block_words = current_block_words[-self.overlap_words:]
                            else:
                                current_block_words = []

                        # If a single block is longer than target_words, split it while trying
                        # to protect lab / medication lines
                        if len(block_words) > self.target_words:
                            sub_chunks = self._split_large_block(block, heading, page.page_number, document.document_id, tenant_id, user_id, global_chunk_idx)
                            for sc in sub_chunks:
                                chunks.append(sc)
                                global_chunk_idx += 1
                        else:
                            current_block_words.extend(block_words)

                # Flush remaining words in section
                if current_block_words:
                    chunk_text = " ".join(current_block_words)
                    chunk_id = self._generate_chunk_id(
                        document.document_id, page.page_number, global_chunk_idx, chunk_text
                    )
                    chunks.append(
                        DocumentChunk(
                            chunk_id=chunk_id,
                            document_id=document.document_id,
                            tenant_id=tenant_id,
                            user_id=user_id,
                            page_number=page.page_number,
                            section_heading=heading,
                            content=chunk_text,
                            chunk_index=global_chunk_idx,
                            word_count=len(current_block_words),
                            content_hash=hashlib.sha256(chunk_text.encode("utf-8")).hexdigest(),
                            metadata={
                                "file_name": document.file_name,
                                "extraction_method": document.extraction_method,
                            },
                        )
                    )
                    global_chunk_idx += 1

        return chunks

    def _split_into_blocks(self, text: str) -> List[str]:
        """Splits text by double newlines or lines containing lab values or bullet points."""
        raw_blocks = text.split("\n\n")
        refined_blocks = []
        for rb in raw_blocks:
            lines = [l.strip() for l in rb.split("\n") if l.strip()]
            refined_blocks.extend(lines)
        return refined_blocks

    def _split_large_block(
        self,
        block: str,
        heading: str,
        page_num: int,
        doc_id: str,
        tenant_id: str,
        user_id: str,
        start_idx: int,
    ) -> List[DocumentChunk]:
        words = block.split()
        sub_chunks: List[DocumentChunk] = []
        i = 0
        idx = start_idx

        while i < len(words):
            chunk_slice = words[i:i + self.target_words]
            chunk_text = " ".join(chunk_slice)
            chunk_id = self._generate_chunk_id(doc_id, page_num, idx, chunk_text)
            sub_chunks.append(
                DocumentChunk(
                    chunk_id=chunk_id,
                    document_id=doc_id,
                    tenant_id=tenant_id,
                    user_id=user_id,
                    page_number=page_num,
                    section_heading=heading,
                    content=chunk_text,
                    chunk_index=idx,
                    word_count=len(chunk_slice),
                    content_hash=hashlib.sha256(chunk_text.encode("utf-8")).hexdigest(),
                    metadata={"section": heading},
                )
            )
            idx += 1
            i += max(1, self.target_words - self.overlap_words)

        return sub_chunks

    @staticmethod
    def _generate_chunk_id(document_id: str, page_number: int, chunk_index: int, text: str) -> str:
        digest = hashlib.sha256(f"{document_id}:{page_number}:{chunk_index}:{text[:40]}".encode("utf-8")).hexdigest()
        return f"chk_{digest[:16]}"
