"""
MediMate AI — Document Lifecycle & Deletion Propagation Tests
"""

from app.orchestration.engine import RAGEngine


def test_document_deletion_removes_all_chunks(
    rag_engine: RAGEngine, sample_clinical_report_bytes: bytes
):
    user_id = "user_del_test"
    tenant_id = "tenant_del_test"
    doc_id = "doc_to_delete_99"

    # Ingest document
    rag_engine.ingest_document(
        tenant_id=tenant_id,
        user_id=user_id,
        document_bytes=sample_clinical_report_bytes,
        file_name="temp_labs.pdf",
        document_id=doc_id,
    )

    count_before = rag_engine.vector_store.count(tenant_id, user_id)
    assert count_before > 0

    # Delete document
    deleted_chunks = rag_engine.delete_document(tenant_id, user_id, doc_id)
    assert deleted_chunks == count_before

    count_after = rag_engine.vector_store.count(tenant_id, user_id)
    assert count_after == 0


def test_idempotent_deletion_of_nonexistent_document(rag_engine: RAGEngine):
    deleted = rag_engine.delete_document("tenant_x", "user_x", "non_existent_doc_id")
    assert deleted == 0
