"""
MediMate AI — FastAPI Route Dependencies
Extracts and validates internal service assertions and initializes singleton RAGEngine.
"""

from typing import Optional
from fastapi import Header, Depends
from app.core.errors import AuthenticationError
from app.orchestration.engine import RAGEngine
from app.security.assertion import InternalServiceClaims, verify_service_assertion

# Global singleton engine instance
_engine_instance: Optional[RAGEngine] = None


def get_rag_engine() -> RAGEngine:
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = RAGEngine()
    return _engine_instance


def set_rag_engine(engine: RAGEngine):
    """Allows test suites to inject custom vector stores or mock embedding providers."""
    global _engine_instance
    _engine_instance = engine


def get_authenticated_claims(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> InternalServiceClaims:
    """
    Extracts Bearer assertion token from the Authorization header and cryptographically validates it.
    Rejects any raw unauthenticated request.
    """
    if not authorization:
        raise AuthenticationError("Missing Authorization header")

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise AuthenticationError("Invalid Authorization format: Expected 'Bearer <token>'")

    token = parts[1]
    return verify_service_assertion(token)
