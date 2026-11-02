"""
MediMate AI — Pytest Fixtures & Synthetic Medical Documents
"""

import os
import pytest
from fastapi.testclient import TestClient

from app.api.deps import set_rag_engine
from app.core.config import settings
from app.embeddings.mock_provider import DeterministicEmbeddingProvider
from app.main import app
from app.orchestration.engine import RAGEngine
from app.security.assertion import create_internal_assertion
from app.storage.memory_store import MemoryVectorStore


@pytest.fixture
def mock_embedding_provider():
    return DeterministicEmbeddingProvider(dimension=1536)


@pytest.fixture
def memory_vector_store():
    return MemoryVectorStore()


@pytest.fixture
def rag_engine(memory_vector_store, mock_embedding_provider):
    engine = RAGEngine(
        vector_store=memory_vector_store,
        embedding_provider=mock_embedding_provider,
    )
    set_rag_engine(engine)
    return engine


@pytest.fixture
def client(rag_engine):
    return TestClient(app)


@pytest.fixture
def sample_clinical_report_bytes() -> bytes:
    """Synthetic clinical laboratory report for testing."""
    text = (
        "--- Page 1 ---\n"
        "PATIENT INFORMATION:\n"
        "Name: Jane Doe, Age: 45, MRN: 987654\n"
        "Date of Service: 2026-10-15\n\n"
        "LABORATORY RESULTS:\n"
        "Fasting Blood Glucose: 115 mg/dL (Reference Range: 70-99 mg/dL) [HIGH]\n"
        "Hemoglobin A1c: 6.8 % (Reference Range: 4.0-5.6 %) [ELEVATED]\n"
        "Total Cholesterol: 210 mg/dL (Reference Range: <200 mg/dL)\n"
        "Triglycerides: 160 mg/dL (Reference Range: <150 mg/dL)\n"
        "HDL Cholesterol: 48 mg/dL (Reference Range: >50 mg/dL)\n"
        "LDL Cholesterol: 130 mg/dL (Reference Range: <100 mg/dL)\n\n"
        "--- Page 2 ---\n"
        "MEDICATIONS:\n"
        "Metformin 500 mg PO BID with meals\n"
        "Atorvastatin 20 mg PO QHS\n\n"
        "ASSESSMENT AND PLAN:\n"
        "1. Type 2 Diabetes Mellitus - suboptimal glycemic control with A1c 6.8%.\n"
        "2. Hyperlipidemia - initiate lifestyle changes and titrate statin.\n"
        "Follow-up in 3 months for repeat HbA1c and lipid panel."
    )
    return text.encode("utf-8")


@pytest.fixture
def conflicting_clinical_report_bytes() -> bytes:
    """Synthetic conflicting follow-up report for discrepancy detection."""
    text = (
        "--- Page 1 ---\n"
        "PATIENT INFORMATION:\n"
        "Name: Jane Doe, Age: 45, MRN: 987654\n"
        "Date of Service: 2026-11-01\n\n"
        "LABORATORY RESULTS:\n"
        "Fasting Blood Glucose: 98 mg/dL (Reference Range: 70-99 mg/dL) [NORMAL]\n"
        "Hemoglobin A1c: 6.1 % (Reference Range: 4.0-5.6 %) [IMPROVED]\n\n"
        "MEDICATIONS:\n"
        "Metformin 850 mg PO BID\n"
    )
    return text.encode("utf-8")


@pytest.fixture
def make_auth_header():
    def _maker(
        sub: str = "user_test_123",
        tenant_id: str = "tenant_test_1",
        op: str = "QUERY",
        resource_id: str = None,
        secret: str = None,
        expires_in_seconds: int = 60,
    ) -> dict:
        token = create_internal_assertion(
            sub=sub,
            tenant_id=tenant_id,
            op=op,
            resource_id=resource_id,
            secret=secret,
            expires_in_seconds=expires_in_seconds,
        )
        return {"Authorization": f"Bearer {token}"}

    return _maker
