"""
MediMate AI — Service Assertion & Trust Boundary Security Tests
"""

import time
import pytest
from app.core.errors import AuthenticationError, ForbiddenOperationError
from app.security.assertion import (
    create_internal_assertion,
    verify_service_assertion,
)


def test_valid_assertion_verification():
    token = create_internal_assertion(
        sub="usr_patient_001",
        tenant_id="ten_clinic_alpha",
        op="QUERY",
        expires_in_seconds=120,
    )
    claims = verify_service_assertion(token, expected_op="QUERY")
    assert claims.sub == "usr_patient_001"
    assert claims.tenantId == "ten_clinic_alpha"
    assert claims.op == "QUERY"
    assert claims.iss == "medimate-web"
    assert claims.aud == "medimate-rag"


def test_assertion_tampered_signature_rejected():
    token = create_internal_assertion(
        sub="usr_patient_001",
        tenant_id="ten_clinic_alpha",
        op="QUERY",
    )
    header, payload, sig = token.split(".")
    tampered_token = f"{header}.{payload}.{sig[:-4]}XXXX"

    with pytest.raises(AuthenticationError, match="Invalid service assertion signature"):
        verify_service_assertion(tampered_token)


def test_assertion_invalid_secret_rejected():
    token = create_internal_assertion(
        sub="usr_patient_001",
        tenant_id="ten_clinic_alpha",
        op="QUERY",
        secret="different-secret-from-expected-12345",
    )
    with pytest.raises(AuthenticationError, match="Invalid service assertion signature"):
        verify_service_assertion(token)


def test_expired_assertion_rejected():
    token = create_internal_assertion(
        sub="usr_patient_001",
        tenant_id="ten_clinic_alpha",
        op="QUERY",
        expires_in_seconds=-100,  # Already expired
    )
    with pytest.raises(AuthenticationError, match="Service assertion has expired"):
        verify_service_assertion(token)


def test_operation_mismatch_rejected():
    token = create_internal_assertion(
        sub="usr_patient_001",
        tenant_id="ten_clinic_alpha",
        op="QUERY",
    )
    with pytest.raises(ForbiddenOperationError, match="does not permit expected operation 'INGEST'"):
        verify_service_assertion(token, expected_op="INGEST")


def test_bound_resource_mismatch_rejected():
    token = create_internal_assertion(
        sub="usr_patient_001",
        tenant_id="ten_clinic_alpha",
        op="INGEST",
        resource_id="doc_authorized_001",
    )
    # Verification with different resource must fail
    with pytest.raises(ForbiddenOperationError, match="does not match target 'doc_unauthorized_999'"):
        verify_service_assertion(token, expected_op="INGEST", expected_resource_id="doc_unauthorized_999")


def test_replay_attack_rejected():
    token = create_internal_assertion(
        sub="usr_patient_001",
        tenant_id="ten_clinic_alpha",
        op="QUERY",
        nonce="unique_nonce_abc123",
        expires_in_seconds=60,
    )
    # First verification succeeds
    claims = verify_service_assertion(token, expected_op="QUERY")
    assert claims.nonce == "unique_nonce_abc123"

    # Second immediate verification with same token/nonce is rejected as a replay attack
    with pytest.raises(AuthenticationError, match="replay rejected"):
        verify_service_assertion(token, expected_op="QUERY")
