"""
MediMate AI — RAG Query API Schemas
"""

from typing import List, Optional
from pydantic import BaseModel, Field
from app.orchestration.citations import Citation


class RAGQueryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000, description="Patient health query")
    top_k: Optional[int] = Field(default=None, ge=1, le=20, description="Max chunks to retrieve")
    similarity_threshold: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Minimum cosine similarity cutoff"
    )
    document_ids: Optional[List[str]] = Field(
        default=None, description="Optional document ID filter scope"
    )


class RAGQueryResponse(BaseModel):
    query: str
    answer: str
    summary: str
    citations: List[Citation]
    sourceDocuments: List[str]
    pageReferences: List[int]
    confidenceAssessment: str
    missingInformation: List[str]
    safetyFlags: List[str]
    generatedAt: str
