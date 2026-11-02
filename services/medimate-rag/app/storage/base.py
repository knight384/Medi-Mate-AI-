"""
MediMate AI — Vector Store Abstraction
Defines the interface for tenant-isolated vector indexing and similarity retrieval.
"""

from abc import ABC, abstractmethod
from typing import List, Optional
from app.chunking.models import DocumentChunk, ScoredChunk


class BaseVectorStore(ABC):
    @abstractmethod
    def add_chunks(
        self,
        tenant_id: str,
        user_id: str,
        chunks: List[DocumentChunk],
        embeddings: List[List[float]],
    ) -> int:
        """Stores document chunks with their vector embeddings under strict tenant/user isolation."""
        pass

    @abstractmethod
    def search(
        self,
        tenant_id: str,
        user_id: str,
        query_embedding: List[float],
        top_k: int = 4,
        similarity_threshold: float = 0.25,
        document_ids: Optional[List[str]] = None,
    ) -> List[ScoredChunk]:
        """Performs cosine similarity search constrained strictly to the authenticated tenant and user."""
        pass

    @abstractmethod
    def delete_document(self, tenant_id: str, user_id: str, document_id: str) -> int:
        """Deletes all chunks and vector embeddings associated with a specific document."""
        pass

    @abstractmethod
    def delete_user(self, tenant_id: str, user_id: str) -> int:
        """Deletes all indexed content for a user (GDPR / Right to be forgotten)."""
        pass

    @abstractmethod
    def count(self, tenant_id: str, user_id: str) -> int:
        """Counts total indexed chunks for an authorized tenant and user."""
        pass
