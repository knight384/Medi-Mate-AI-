"""
MediMate AI — Microservice Health, Readiness & Liveness Probes
"""

import time
from datetime import datetime, timezone
from fastapi import APIRouter
from app.core.config import settings
from app.schemas.health import (
    HealthStatusResponse,
    ReadinessCheckResponse,
    LivenessCheckResponse,
)

router = APIRouter(tags=["Health"])

START_TIME = time.time()


@router.get("/health", response_model=HealthStatusResponse)
def health_check():
    return HealthStatusResponse(
        status="ok",
        environment=settings.environment,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


@router.get("/health/ready", response_model=ReadinessCheckResponse)
def readiness_check():
    return ReadinessCheckResponse(
        status="ready",
        timestamp=datetime.now(timezone.utc).isoformat(),
        checks={
            "embedding_provider": settings.embedding_provider,
            "vector_store": settings.vector_store_backend,
            "scratch_dir": "ok",
        },
    )


@router.get("/health/live", response_model=LivenessCheckResponse)
def liveness_check():
    uptime = int(time.time() - START_TIME)
    return LivenessCheckResponse(
        status="alive",
        uptimeSeconds=uptime,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
