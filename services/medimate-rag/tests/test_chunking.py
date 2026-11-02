"""
MediMate AI — Clinical Document Chunking Unit Tests
"""

from app.chunking.chunker import ClinicalDocumentChunker
from app.parsing.base import ParsedDocument, ParsedPage


def test_chunking_preserves_page_numbers():
    doc = ParsedDocument(
        document_id="doc_101",
        file_name="lab_report.pdf",
        content_hash="hash_101",
        pages=[
            ParsedPage(page_number=1, text="Page 1: Glucose: 110 mg/dL (70-99). Initial findings."),
            ParsedPage(page_number=2, text="Page 2: Metformin 500 mg BID. Plan of care."),
        ],
        total_pages=2,
        total_characters=80,
        extraction_method="test",
    )

    chunker = ClinicalDocumentChunker(target_words=50, overlap_words=10)
    chunks = chunker.chunk_document(doc, tenant_id="t1", user_id="u1")

    assert len(chunks) >= 2
    assert chunks[0].page_number == 1
    assert "Glucose" in chunks[0].content
    assert chunks[-1].page_number == 2
    assert "Metformin" in chunks[-1].content


def test_chunking_preserves_lab_results_intact():
    lab_text = (
        "LABORATORY FINDINGS:\n"
        "Fasting Blood Glucose: 115 mg/dL (Reference Range: 70-99 mg/dL) [HIGH]\n"
        "Hemoglobin A1c: 6.8 % (Reference Range: 4.0-5.6 %) [ELEVATED]\n"
        "Serum Creatinine: 0.9 mg/dL (Reference Range: 0.6-1.2 mg/dL)\n"
    )
    doc = ParsedDocument(
        document_id="doc_102",
        file_name="labs.pdf",
        content_hash="hash_102",
        pages=[ParsedPage(page_number=1, text=lab_text)],
        total_pages=1,
        total_characters=len(lab_text),
        extraction_method="test",
    )

    chunker = ClinicalDocumentChunker(target_words=100, overlap_words=20)
    chunks = chunker.chunk_document(doc, tenant_id="t1", user_id="u1")

    assert len(chunks) >= 1
    content = chunks[0].content
    # Verify unit is not separated from number
    assert "115 mg/dL" in content
    assert "6.8 %" in content
    assert "0.9 mg/dL" in content


def test_chunking_idempotent_and_stable():
    doc = ParsedDocument(
        document_id="doc_103",
        file_name="records.pdf",
        content_hash="hash_103",
        pages=[ParsedPage(page_number=1, text="Blood pressure 120/80 mmHg. Heart rate 72 bpm.")],
        total_pages=1,
        total_characters=50,
        extraction_method="test",
    )
    chunker = ClinicalDocumentChunker(target_words=50, overlap_words=10)
    chunks1 = chunker.chunk_document(doc, tenant_id="t1", user_id="u1")
    chunks2 = chunker.chunk_document(doc, tenant_id="t1", user_id="u1")

    assert len(chunks1) == len(chunks2)
    assert chunks1[0].chunk_id == chunks2[0].chunk_id
    assert chunks1[0].content_hash == chunks2[0].content_hash
