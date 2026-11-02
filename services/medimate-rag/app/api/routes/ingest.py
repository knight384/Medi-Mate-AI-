"""
MediMate AI — Document Ingestion API Route
Receives encrypted or decrypted document bytes from authenticated Next.js backend,
chunks, embeds, and stores in the tenant-isolated vector index.
"""

from fastapi import APIRouter, Depends, File, Form, UploadFile
from app.api.deps import get_authenticated_claims, get_rag_engine
from app.core.errors import ForbiddenOperationError
from app.orchestration.engine import RAGEngine
from app.schemas.ingest import IngestResponse
from app.security.assertion import InternalServiceClaims

router = APIRouter(prefix="/api/v1/documents", tags=["Ingest"])


@router.post("/ingest", response_model=IngestResponse)
async def ingest_document(
    file: UploadFile = File(...),
    document_id: str = Form(...),
    claims: InternalServiceClaims = Depends(get_authenticated_claims),
    engine: RAGEngine = Depends(get_rag_engine),
):
    # Verify operation is permitted by internal assertion token
    if claims.op != "INGEST":
        raise ForbiddenOperationError(f"Assertion op '{claims.op}' does not allow INGEST")

    # If assertion is bound to a specific document, verify match
    if claims.resourceId and claims.resourceId != document_id:
        raise ForbiddenOperationError(
            f"Assertion bound to resource '{claims.resourceId}', cannot ingest '{document_id}'"
        )

    content = await file.read()
    file_name = file.filename or f"doc_{document_id}.pdf"

    result = engine.ingest_document(
        tenant_id=claims.tenantId,
        user_id=claims.sub,
        document_bytes=content,
        file_name=file_name,
        document_id=document_id,
    )

    return IngestResponse(
        success=True,
        document_id=result.document_id,
        file_name=result.file_name,
        total_pages=result.total_pages,
        total_chunks=result.total_chunks,
        content_hash=result.content_hash,
        extraction_method=result.extraction_method,
        ingested_at=result.ingested_at,
    )
