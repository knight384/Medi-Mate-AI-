"""
MediMate AI — Document Ingestion Schemas
"""

from typing import Optional
from pydantic import BaseModel, Field


class IngestResponse(BaseModel):
    success: bool
    document_id: str
    file_name: str
    total_pages: int
    total_chunks: int
    content_hash: str
    extraction_method: str
    ingested_at: str
