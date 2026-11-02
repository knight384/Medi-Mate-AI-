"""
MediMate AI — Python RAG Microservice Main Application
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health, ingest, query, delete
from app.core.config import settings
from app.core.errors import RAGException
from app.core.logging import logger


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        f"Starting MediMate RAG Microservice on {settings.rag_service_host}:{settings.rag_service_port}",
        extra={"structured_data": {"environment": settings.environment}}
    )
    yield
    logger.info("Stopping MediMate RAG Microservice")


app = FastAPI(
    title="MediMate AI RAG Microservice",
    description="Context-Aware Health Intelligence and Tenant-Isolated Vector Retrieval",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS: Restricted to local/internal network callers
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://app:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Exception handlers
@app.exception_handler(RAGException)
async def rag_exception_handler(request: Request, exc: RAGException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.message,
            "code": exc.error_code,
            "details": exc.details,
        },
    )


# Include API Routers
app.include_router(health.router)
app.include_router(ingest.router)
app.include_router(query.router)
app.include_router(delete.router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.rag_service_host,
        port=settings.rag_service_port,
        reload=(settings.environment == "local"),
    )
