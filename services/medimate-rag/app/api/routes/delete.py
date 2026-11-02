"""
MediMate AI — Document Deletion API Route
Ensures that document deletion in the core web app propagates immediately
to the RAG vector index, purging all derived chunks and embeddings.
"""

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel
from app.api.deps import get_authenticated_claims, get_rag_engine
from app.core.errors import ForbiddenOperationError
from app.orchestration.engine import RAGEngine
from app.security.assertion import InternalServiceClaims

router = APIRouter(prefix="/api/v1/documents", tags=["Delete"])


class DeleteDocumentResponse(BaseModel):
    success: bool
    document_id: str
    deleted_chunks: int


@router.delete("/{document_id}", response_model=DeleteDocumentResponse)
def delete_document_index(
    document_id: str = Path(..., description="Document identifier to purge from index"),
    claims: InternalServiceClaims = Depends(get_authenticated_claims),
    engine: RAGEngine = Depends(get_rag_engine),
):
    if claims.op != "DELETE":
        raise ForbiddenOperationError(f"Assertion op '{claims.op}' does not allow DELETE")

    if claims.resourceId and claims.resourceId != document_id:
        raise ForbiddenOperationError(
            f"Assertion bound to resource '{claims.resourceId}', cannot delete '{document_id}'"
        )

    deleted_count = engine.delete_document(
        tenant_id=claims.tenantId,
        user_id=claims.sub,
        document_id=document_id,
    )

    return DeleteDocumentResponse(
        success=True,
        document_id=document_id,
        deleted_chunks=deleted_count,
    )
