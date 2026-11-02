"""
MediMate AI — In-Memory Tenant-Isolated Vector Store
High-performance, thread-safe in-memory vector index with strict tenant boundaries.
Ideal for local self-hosted mode and containerized deployments.
"""

import math
import threading
from typing import Dict, List, Optional, Tuple
from app.chunking.models import DocumentChunk, ScoredChunk
from app.storage.base import BaseVectorStore


class MemoryVectorStore(BaseVectorStore):
    """
    Stores document vectors indexed by (tenant_id, user_id).
    Cross-tenant access is structurally impossible because keys are segmented by tenant.
    """

    def __init__(self):
        # (tenant_id, user_id) -> Dict[chunk_id, Tuple[DocumentChunk, List[float]]]
        self._partitions: Dict[Tuple[str, str], Dict[str, Tuple[DocumentChunk, List[float]]]] = {}
        self._lock = threading.RLock()

    def add_chunks(
        self,
        tenant_id: str,
        user_id: str,
        chunks: List[DocumentChunk],
        embeddings: List[List[float]],
    ) -> int:
        if len(chunks) != len(embeddings):
            raise ValueError("Chunks count must match embeddings count")

        key = (tenant_id, user_id)
        with self._lock:
            if key not in self._partitions:
                self._partitions[key] = {}

            partition = self._partitions[key]
            for chunk, emb in zip(chunks, embeddings):
                partition[chunk.chunk_id] = (chunk, emb)

            return len(chunks)

    def search(
        self,
        tenant_id: str,
        user_id: str,
        query_embedding: List[float],
        top_k: int = 4,
        similarity_threshold: float = 0.25,
        document_ids: Optional[List[str]] = None,
    ) -> List[ScoredChunk]:
        key = (tenant_id, user_id)
        with self._lock:
            partition = self._partitions.get(key)
            if not partition:
                return []

            target_doc_set = set(document_ids) if document_ids else None
            results: List[ScoredChunk] = []

            q_norm = math.sqrt(sum(x * x for x in query_embedding))
            if q_norm < 1e-12:
                return []

            for chunk, emb in partition.values():
                if target_doc_set and chunk.document_id not in target_doc_set:
                    continue

                # Cosine similarity
                dot = sum(a * b for a, b in zip(query_embedding, emb))
                c_norm = math.sqrt(sum(x * x for x in emb))
                if c_norm < 1e-12:
                    continue

                sim = dot / (q_norm * c_norm)
                if sim >= similarity_threshold:
                    results.append(ScoredChunk(chunk=chunk, similarity_score=round(sim, 4)))

            # Sort descending by similarity
            results.sort(key=lambda x: x.similarity_score, reverse=True)
            return results[:top_k]

    def delete_document(self, tenant_id: str, user_id: str, document_id: str) -> int:
        key = (tenant_id, user_id)
        with self._lock:
            partition = self._partitions.get(key)
            if not partition:
                return 0

            to_delete = [
                cid for cid, (chunk, _) in partition.items() if chunk.document_id == document_id
            ]
            for cid in to_delete:
                del partition[cid]

            return len(to_delete)

    def delete_user(self, tenant_id: str, user_id: str) -> int:
        key = (tenant_id, user_id)
        with self._lock:
            partition = self._partitions.pop(key, None)
            return len(partition) if partition else 0

    def count(self, tenant_id: str, user_id: str) -> int:
        key = (tenant_id, user_id)
        with self._lock:
            partition = self._partitions.get(key)
            return len(partition) if partition else 0
