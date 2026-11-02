"""
MediMate AI — Health Probe Schemas
"""

from typing import Dict
from pydantic import BaseModel


class HealthStatusResponse(BaseModel):
    status: str
    service: str = "medimate-rag"
    environment: str
    timestamp: str


class ReadinessCheckResponse(BaseModel):
    status: str
    timestamp: str
    checks: Dict[str, str]


class LivenessCheckResponse(BaseModel):
    status: str
    uptimeSeconds: int
    timestamp: str
