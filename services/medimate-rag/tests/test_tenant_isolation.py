"""
MediMate AI — Multi-Tenant & Cross-User Isolation Security Tests
"""

from app.orchestration.engine import RAGEngine


def test_cross_tenant_retrieval_isolation(rag_engine: RAGEngine, sample_clinical_report_bytes: bytes):
    # 1. Ingest document for Tenant Alpha / User 1
    ingest_res = rag_engine.ingest_document(
        tenant_id="tenant_alpha",
        user_id="user_alpha_1",
        document_bytes=sample_clinical_report_bytes,
        file_name="alpha_labs.pdf",
        document_id="doc_alpha_101",
    )
    assert ingest_res.total_chunks > 0

    # 2. Tenant Alpha / User 1 queries -> gets matching chunks
    res_alpha = rag_engine.query(
        tenant_id="tenant_alpha",
        user_id="user_alpha_1",
        query_text="What is the fasting blood glucose level?",
    )
    assert res_alpha.retrieved_chunk_count > 0
    assert "Glucose" in res_alpha.answer

    # 3. Tenant Beta / User 2 queries identical question -> MUST RETURN ZERO CHUNKS
    res_beta = rag_engine.query(
        tenant_id="tenant_beta",
        user_id="user_beta_2",
        query_text="What is the fasting blood glucose level?",
    )
    assert res_beta.retrieved_chunk_count == 0
    assert "not found in the uploaded medical records" in res_beta.answer
    assert len(res_beta.evidence.citations) == 0


def test_cross_user_same_tenant_isolation(rag_engine: RAGEngine, sample_clinical_report_bytes: bytes):
    # Ingest for User 1 in Clinic 1
    rag_engine.ingest_document(
        tenant_id="clinic_general",
        user_id="patient_1",
        document_bytes=sample_clinical_report_bytes,
        file_name="patient1_labs.pdf",
        document_id="doc_p1_01",
    )

    # Patient 2 in same clinic queries -> cannot retrieve Patient 1's records
    res_p2 = rag_engine.query(
        tenant_id="clinic_general",
        user_id="patient_2",
        query_text="What is the Hemoglobin A1c?",
    )
    assert res_p2.retrieved_chunk_count == 0


def test_cross_tenant_deletion_isolation(rag_engine: RAGEngine, sample_clinical_report_bytes: bytes):
    rag_engine.ingest_document(
        tenant_id="tenant_alpha",
        user_id="user_alpha_1",
        document_bytes=sample_clinical_report_bytes,
        file_name="alpha_labs.pdf",
        document_id="doc_alpha_101",
    )

    # Tenant Beta attempts to delete Tenant Alpha's document
    deleted = rag_engine.delete_document(
        tenant_id="tenant_beta",
        user_id="user_beta_2",
        document_id="doc_alpha_101",
    )
    assert deleted == 0

    # Tenant Alpha's document still exists and is retrievable
    res = rag_engine.query(
        tenant_id="tenant_alpha",
        user_id="user_alpha_1",
        query_text="Glucose",
    )
    assert res.retrieved_chunk_count > 0
