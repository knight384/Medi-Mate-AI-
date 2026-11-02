"""
MediMate AI — Structured Citation & Source Attribution Builder
Transforms retrieved chunks into traceable evidence for frontend display.
"""

from typing import List, Set
from pydantic import BaseModel, Field
from app.chunking.models import ScoredChunk


class Citation(BaseModel):
    document_id: str
    document_name: str
    page_number: int
    section_heading: str
    chunk_id: str
    excerpt: str
    relevance_score: float


class EvidenceAttribution(BaseModel):
    citations: List[Citation]
    source_documents: List[str]
    page_references: List[int]
    confidence_assessment: str = Field(description="HIGH | MEDIUM | LOW | NONE")
    missing_information: List[str] = Field(default_factory=list)
    safety_flags: List[str] = Field(default_factory=list)


def build_evidence_attribution(
    scored_chunks: List[ScoredChunk],
    min_confidence_score: float = 0.15,
) -> EvidenceAttribution:
    if not scored_chunks:
        return EvidenceAttribution(
            citations=[],
            source_documents=[],
            page_references=[],
            confidence_assessment="NONE",
            missing_information=["No relevant records found in uploaded documents."],
            safety_flags=[],
        )

    citations: List[Citation] = []
    doc_names: Set[str] = set()
    pages: Set[int] = set()
    safety_flags: List[str] = []

    for sc in scored_chunks:
        c = sc.chunk
        doc_name = str(c.metadata.get("file_name", c.document_id))
        doc_names.add(doc_name)
        pages.add(c.page_number)

        # Create concise excerpt (first 350 chars)
        excerpt = c.content[:350] + ("..." if len(c.content) > 350 else "")

        citations.append(
            Citation(
                document_id=c.document_id,
                document_name=doc_name,
                page_number=c.page_number,
                section_heading=c.section_heading,
                chunk_id=c.chunk_id,
                excerpt=excerpt,
                relevance_score=sc.similarity_score,
            )
        )

    top_score = scored_chunks[0].similarity_score
    if top_score >= 0.35:
        confidence = "HIGH"
    elif top_score >= min_confidence_score:
        confidence = "MEDIUM"
    else:
        confidence = "LOW"

    # Detect potentially conflicting dates or values
    if len(doc_names) > 1:
        safety_flags.append("MULTIPLE_SOURCES_REFERENCED")

    return EvidenceAttribution(
        citations=citations,
        source_documents=sorted(list(doc_names)),
        page_references=sorted(list(pages)),
        confidence_assessment=confidence,
        missing_information=[],
        safety_flags=safety_flags,
    )
