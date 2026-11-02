"""
MediMate AI — Standardized RAG Error Hierarchy
Ensures safe error responses without leaking internal file paths or PHI.
"""

from typing import Any, Dict, Optional


class RAGException(Exception):
    """Base exception for all RAG microservice errors."""

    def __init__(
        self,
        message: str,
        status_code: int = 500,
        error_code: str = "INTERNAL_RAG_ERROR",
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.error_code = error_code
        self.details = details or {}


class AuthenticationError(RAGException):
    def __init__(self, message: str = "Invalid or expired internal service assertion"):
        super().__init__(
            message=message,
            status_code=401,
            error_code="SERVICE_ASSERTION_UNAUTHORIZED",
        )


class ForbiddenOperationError(RAGException):
    def __init__(self, message: str = "Operation not permitted by service assertion scope"):
        super().__init__(
            message=message,
            status_code=403,
            error_code="FORBIDDEN_OPERATION",
        )


class TenantIsolationError(RAGException):
    def __init__(self, message: str = "Cross-tenant access or retrieval violation detected"):
        super().__init__(
            message=message,
            status_code=403,
            error_code="TENANT_ISOLATION_VIOLATION",
        )


class DocumentParsingError(RAGException):
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(
            message=message,
            status_code=422,
            error_code="DOCUMENT_PARSING_FAILED",
            details=details,
        )


class EmptyDocumentError(RAGException):
    def __init__(self, message: str = "Uploaded document contains no extractable text or content"):
        super().__init__(
            message=message,
            status_code=400,
            error_code="EMPTY_DOCUMENT",
        )


class PromptInjectionDetectedError(RAGException):
    def __init__(self, message: str = "Potentially malicious prompt injection patterns detected"):
        super().__init__(
            message=message,
            status_code=400,
            error_code="PROMPT_INJECTION_DETECTED",
        )


class EmbeddingError(RAGException):
    def __init__(self, message: str = "Failed to generate vector embeddings"):
        super().__init__(
            message=message,
            status_code=500,
            error_code="EMBEDDING_GENERATION_FAILED",
        )


class StorageError(RAGException):
    def __init__(self, message: str = "Vector storage operation failure"):
        super().__init__(
            message=message,
            status_code=500,
            error_code="STORAGE_OPERATION_FAILED",
        )
