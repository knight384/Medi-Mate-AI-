"""
MediMate AI — Context-Aware RAG Query API Route
Answers health questions grounded strictly in authorized patient documents.
"""

from fastapi import APIRouter, Depends
from app.api.deps import get_authenticated_claims, get_rag_engine
from app.core.errors import ForbiddenOperationError
from app.orchestration.engine import RAGEngine
from app.schemas.query import RAGQueryRequest, RAGQueryResponse
from app.security.assertion import InternalServiceClaims

router = APIRouter(prefix="/api/v1/rag", tags=["RAG"])


@router.post("/query", response_model=RAGQueryResponse)
def query_rag(
    request: RAGQueryRequest,
    claims: InternalServiceClaims = Depends(get_authenticated_claims),
    engine: RAGEngine = Depends(get_rag_engine),
):
    if claims.op != "QUERY":
        raise ForbiddenOperationError(f"Assertion op '{claims.op}' does not allow QUERY")

    result = engine.query(
        tenant_id=claims.tenantId,
        user_id=claims.sub,
        query_text=request.query,
        top_k=request.top_k,
        similarity_threshold=request.similarity_threshold,
        document_ids=request.document_ids,
    )

    evidence = result.evidence
    return RAGQueryResponse(
        query=result.query,
        answer=result.answer,
        summary=result.summary,
        citations=evidence.citations,
        sourceDocuments=evidence.source_documents,
        pageReferences=evidence.page_references,
        confidenceAssessment=evidence.confidence_assessment,
        missingInformation=evidence.missing_information,
        safetyFlags=evidence.safety_flags,
        generatedAt=result.generated_at,
    )
