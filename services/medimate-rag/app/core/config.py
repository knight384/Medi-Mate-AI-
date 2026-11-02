"""
MediMate AI — Python RAG Microservice Configuration
Centralized settings validated via Pydantic Settings.
"""

from typing import Literal, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, field_validator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Service Bind
    rag_service_host: str = Field(default="0.0.0.0", description="Bind address")
    rag_service_port: int = Field(default=8001, description="Bind port")
    environment: Literal["local", "test", "staging", "production"] = Field(
        default="local", description="Runtime environment"
    )

    # Internal Trust Boundary
    internal_service_secret: str = Field(
        default="local-dev-medimate-internal-secret-32-chars-min!",
        description="Shared secret for signing internal HMAC service assertions",
    )
    assertion_clock_skew_seconds: int = Field(
        default=30, description="Permissible clock skew for assertion validation"
    )
    assertion_max_lifetime_seconds: int = Field(
        default=300, description="Maximum lifetime of service assertion (5 minutes)"
    )

    # Scratch & Temporary Storage
    scratch_dir: str = Field(
        default="/app/scratch", description="Ephemeral RAM tmpfs scratch directory"
    )
    max_upload_size_bytes: int = Field(
        default=33554432, description="Maximum document upload size (32MB)"
    )

    # Embedding Settings
    embedding_provider: Literal["local", "deterministic", "remote"] = Field(
        default="deterministic", description="Embedding provider type"
    )
    embedding_model_name: str = Field(
        default="sentence-transformers/all-MiniLM-L6-v2",
        description="Embedding model identifier",
    )
    embedding_dimensions: int = Field(
        default=384, description="Vector embedding dimensions"
    )

    # Vector Store Settings
    vector_store_backend: Literal["memory", "pgvector"] = Field(
        default="memory", description="Vector database backend"
    )
    database_url: Optional[str] = Field(
        default=None, description="PostgreSQL database URL for pgvector"
    )

    # RAG Retrieval Defaults
    default_top_k: int = Field(default=4, description="Default number of chunks to retrieve")
    similarity_threshold: float = Field(
        default=0.05, description="Minimum cosine similarity threshold"
    )
    chunk_size_words: int = Field(
        default=400, description="Target chunk size in words"
    )
    chunk_overlap_words: int = Field(
        default=80, description="Word overlap between consecutive chunks"
    )
    max_chunks_per_document: int = Field(
        default=500, description="Hard cap on chunks per document"
    )

    @field_validator("internal_service_secret")
    @classmethod
    def validate_secret_strength(cls, v: str, info) -> str:
        # In production/staging, secret MUST be at least 32 characters
        if len(v) < 16:
            raise ValueError("INTERNAL_SERVICE_SECRET must be at least 16 characters (32+ recommended)")
        return v


settings = Settings()
