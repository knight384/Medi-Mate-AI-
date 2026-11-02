"""
MediMate AI — Production Hardening & Configuration Guards
Verifies that development fallbacks (in-memory store, deterministic mock embeddings)
are strictly prevented from entering production.
"""

import pytest
from app.core.config import Settings


def test_production_rejects_deterministic_embeddings():
    with pytest.raises(ValueError, match="Deterministic mock embeddings are strictly prohibited in production"):
        Settings(
            environment="production",
            embedding_provider="deterministic",
            vector_store_backend="pgvector",
            database_url="postgresql://medimate_app:pass@localhost:5432/open-health",
            redis_url="redis://localhost:6379/0",
            internal_service_secret="super_secret_for_production_env_at_least_32_chars!",
        )


def test_production_rejects_memory_vector_store():
    with pytest.raises(ValueError, match="MemoryVectorStore is strictly prohibited in production"):
        Settings(
            environment="production",
            embedding_provider="local",
            vector_store_backend="memory",
            database_url="postgresql://medimate_app:pass@localhost:5432/open-health",
            redis_url="redis://localhost:6379/0",
            internal_service_secret="super_secret_for_production_env_at_least_32_chars!",
        )


def test_production_rejects_missing_redis_url():
    with pytest.raises(ValueError, match="REDIS_URL is required in production"):
        Settings(
            environment="production",
            embedding_provider="local",
            vector_store_backend="pgvector",
            database_url="postgresql://medimate_app:pass@localhost:5432/open-health",
            redis_url=None,
            internal_service_secret="super_secret_for_production_env_at_least_32_chars!",
        )


def test_production_rejects_missing_database_url():
    with pytest.raises(ValueError, match="DATABASE_URL is required in production"):
        Settings(
            environment="production",
            embedding_provider="local",
            vector_store_backend="pgvector",
            database_url=None,
            redis_url="redis://localhost:6379/0",
            internal_service_secret="super_secret_for_production_env_at_least_32_chars!",
        )


def test_production_accepts_valid_configuration():
    s = Settings(
        environment="production",
        embedding_provider="local",
        embedding_model_name="BAAI/bge-small-en-v1.5",
        vector_store_backend="pgvector",
        database_url="postgresql://medimate_app:pass@localhost:5432/open-health",
        redis_url="redis://localhost:6379/0",
        internal_service_secret="super_secret_for_production_env_at_least_32_chars!",
    )
    assert s.environment == "production"
    assert s.embedding_provider == "local"
    assert s.vector_store_backend == "pgvector"
