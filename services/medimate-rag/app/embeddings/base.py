"""
MediMate AI — Embedding Provider Interface
"""

from abc import ABC, abstractmethod
from typing import List
from pydantic import BaseModel, Field


class EmbeddingMetadata(BaseModel):
    model_name: str
    dimension: int
    normalized: bool = True
    provider_type: str
    version: str = "1.0"


class BaseEmbeddingProvider(ABC):
    default_threshold: float = 0.25

    @abstractmethod
    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """Generates normalized vector embeddings for a list of document chunks."""
        pass

    @abstractmethod
    def embed_query(self, text: str) -> List[float]:
        """Generates a normalized vector embedding for a single query."""
        pass

    @abstractmethod
    def get_metadata(self) -> EmbeddingMetadata:
        """Returns embedding model metadata."""
        pass
