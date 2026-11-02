"""
MediMate AI — Document Parser Interface
"""

from abc import ABC, abstractmethod
from typing import List, Optional
from pydantic import BaseModel, Field


class ParsedPage(BaseModel):
    page_number: int = Field(ge=1, description="1-indexed page number")
    text: str = Field(description="Extracted page text")
    has_tables: bool = Field(default=False, description="Whether page contains tabular data")
    char_count: int = Field(default=0, description="Character count")


class ParsedDocument(BaseModel):
    document_id: str
    file_name: str
    content_hash: str
    pages: List[ParsedPage]
    total_pages: int
    total_characters: int
    extraction_method: str


class BaseDocumentParser(ABC):
    @abstractmethod
    def parse_bytes(self, content: bytes, file_name: str, document_id: str) -> ParsedDocument:
        """Parses document bytes into structured pages."""
        pass
