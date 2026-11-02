"""
MediMate AI — Document Chunk Data Models
Preserves full provenance metadata for every retrieved chunk.
"""

from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class DocumentChunk(BaseModel):
    chunk_id: str = Field(description="Deterministic unique chunk identifier")
    document_id: str = Field(description="Parent document identifier")
    tenant_id: str = Field(description="Multi-tenant namespace identifier")
    user_id: str = Field(description="Document owner subject identifier")
    page_number: int = Field(ge=1, description="1-indexed source document page")
    section_heading: str = Field(default="GENERAL", description="Clinical section heading")
    content: str = Field(description="Normalized text content of the chunk")
    chunk_index: int = Field(ge=0, description="0-indexed order within document")
    word_count: int = Field(ge=1, description="Number of words in chunk")
    content_hash: str = Field(description="SHA-256 hash of chunk text")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Extensible metadata")


class ScoredChunk(BaseModel):
    chunk: DocumentChunk
    similarity_score: float = Field(description="Cosine similarity score (0.0 to 1.0)")
