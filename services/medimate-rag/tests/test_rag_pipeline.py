"""
MediMate AI — End-to-End RAG HTTP Pipeline Tests
"""

import io
from fastapi.testclient import TestClient


def test_health_endpoints(client: TestClient):
    r1 = client.get("/health")
    assert r1.status_code == 200
    assert r1.json()["status"] == "ok"

    r2 = client.get("/health/ready")
    assert r2.status_code == 200
    assert r2.json()["status"] == "ready"

    r3 = client.get("/health/live")
    assert r3.status_code == 200
    assert r3.json()["status"] == "alive"


def test_unauthenticated_requests_rejected(client: TestClient):
    # Missing auth
    res = client.post("/api/v1/rag/query", json={"query": "What is my A1c?"})
    assert res.status_code == 401
    assert res.json()["code"] == "SERVICE_ASSERTION_UNAUTHORIZED"


def test_wrong_operation_token_rejected(client: TestClient, make_auth_header):
    # Using INGEST token on QUERY endpoint
    headers = make_auth_header(op="INGEST")
    res = client.post("/api/v1/rag/query", json={"query": "What is my A1c?"}, headers=headers)
    assert res.status_code == 403
    assert res.json()["code"] == "FORBIDDEN_OPERATION"


def test_full_document_to_answer_workflow(
    client: TestClient,
    make_auth_header,
    sample_clinical_report_bytes: bytes,
):
    user_id = "user_e2e_42"
    tenant_id = "tenant_e2e_general"
    doc_id = "doc_blood_work_2026"

    # 1. Ingest document via authenticated API
    ingest_headers = make_auth_header(sub=user_id, tenant_id=tenant_id, op="INGEST", resource_id=doc_id)
    files = {"file": ("report.pdf", io.BytesIO(sample_clinical_report_bytes), "application/pdf")}
    data = {"document_id": doc_id}

    ingest_res = client.post(
        "/api/v1/documents/ingest",
        headers=ingest_headers,
        data=data,
        files=files,
    )
    assert ingest_res.status_code == 200
    ingest_data = ingest_res.json()
    assert ingest_data["success"] is True
    assert ingest_data["document_id"] == doc_id
    assert ingest_data["total_chunks"] > 0

    # 2. Query for answer present in document
    query_headers = make_auth_header(sub=user_id, tenant_id=tenant_id, op="QUERY")
    query_payload = {"query": "What is my Fasting Blood Glucose and Hemoglobin A1c?"}

    query_res = client.post(
        "/api/v1/rag/query",
        headers=query_headers,
        json=query_payload,
    )
    assert query_res.status_code == 200
    ans_data = query_res.json()

    assert "Glucose" in ans_data["answer"]
    assert len(ans_data["citations"]) > 0
    first_citation = ans_data["citations"][0]
    assert first_citation["document_id"] == doc_id
    assert first_citation["page_number"] in [1, 2]
    assert ans_data["confidenceAssessment"] in ["HIGH", "MEDIUM", "LOW"]

    # 3. Query for information NOT present in document
    unanswerable_headers = make_auth_header(sub=user_id, tenant_id=tenant_id, op="QUERY")
    unanswerable_payload = {"query": "What is my MRI brain scan result for multiple sclerosis?"}
    unanswerable_res = client.post(
        "/api/v1/rag/query",
        headers=unanswerable_headers,
        json=unanswerable_payload,
    )
    assert unanswerable_res.status_code == 200
    unans_data = unanswerable_res.json()
    assert "not found in the uploaded medical records" in unans_data["answer"]
    assert len(unans_data["citations"]) == 0
    assert unans_data["confidenceAssessment"] == "NONE"

    # 4. Delete document
    del_headers = make_auth_header(sub=user_id, tenant_id=tenant_id, op="DELETE", resource_id=doc_id)
    del_res = client.delete(f"/api/v1/documents/{doc_id}", headers=del_headers)
    assert del_res.status_code == 200
    assert del_res.json()["deleted_chunks"] > 0

    # 5. Subsequent query after deletion must return unanswerable
    post_del_headers = make_auth_header(sub=user_id, tenant_id=tenant_id, op="QUERY")
    post_del_res = client.post(
        "/api/v1/rag/query",
        headers=post_del_headers,
        json=query_payload,
    )
    assert post_del_res.status_code == 200
    assert "not found in the uploaded medical records" in post_del_res.json()["answer"]
