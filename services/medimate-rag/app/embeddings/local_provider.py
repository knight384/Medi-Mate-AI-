"""
MediMate AI — Local Sentence Transformer Embedding Provider
Adapted from HealthMate AI (MIT License, Copyright 2025 HealthMate AI).
Uses all-MiniLM-L6-v2 for local, privacy-preserving 384-dimensional dense vectors.
"""

from typing import List
from app.core.logging import logger
from app.embeddings.base import BaseEmbeddingProvider, EmbeddingMetadata
from app.embeddings.mock_provider import DeterministicEmbeddingProvider


class LocalEmbeddingProvider(BaseEmbeddingProvider):
    def __init__(self, model_name: str = "sentence-transformers/all-MiniLM-L6-v2"):
        self.model_name = model_name
        self._model = None
        self._fallback = DeterministicEmbeddingProvider(dimension=384, model_name=f"{model_name}-fallback")

        try:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(model_name)
            logger.info(f"Loaded local SentenceTransformer model: {model_name}")
        except Exception as e:
            logger.warning(
                f"SentenceTransformer not available or model download skipped ({str(e)}). "
                "Using high-fidelity deterministic embedding provider."
            )

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if self._model is not None:
            try:
                embeddings = self._model.encode(
                    texts, normalize_embeddings=True, show_progress_bar=False
                )
                return [list(map(float, vec)) for vec in embeddings]
            except Exception as e:
                logger.error(f"SentenceTransformer embedding failed: {str(e)}")

        return self._fallback.embed_documents(texts)

    def embed_query(self, text: str) -> List[float]:
        if self._model is not None:
            try:
                embedding = self._model.encode(
                    [text], normalize_embeddings=True, show_progress_bar=False
                )[0]
                return list(map(float, embedding))
            except Exception as e:
                logger.error(f"SentenceTransformer query embedding failed: {str(e)}")

        return self._fallback.embed_query(text)

    def get_metadata(self) -> EmbeddingMetadata:
        if self._model is not None:
            return EmbeddingMetadata(
                model_name=self.model_name,
                dimension=384,
                normalized=True,
                provider_type="local_sentence_transformers",
            )
        return self._fallback.get_metadata()
