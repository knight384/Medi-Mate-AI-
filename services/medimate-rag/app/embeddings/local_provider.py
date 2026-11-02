"""
MediMate AI — Local FastEmbed ONNX Embedding Provider
Privacy-preserving, lightweight local embedding generation without external network calls or PyTorch bloat.
Uses BAAI/bge-small-en-v1.5 (384 dimensions) by default.
"""

from typing import List
from app.core.errors import EmbeddingError
from app.core.logging import logger
from app.embeddings.base import BaseEmbeddingProvider, EmbeddingMetadata


class LocalEmbeddingProvider(BaseEmbeddingProvider):
    """
    Local ONNX-based embedding provider using fastembed.
    Executes in-process without PyTorch or external API calls.
    """

    default_threshold = 0.65

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5"):
        self.model_name = model_name
        self._model = None
        self._dimension = 384
        self._version = "1.5"

        try:
            from fastembed import TextEmbedding

            self._model = TextEmbedding(model_name=self.model_name)
            logger.info("Loaded real local ONNX embedding model", {
                "model_name": self.model_name,
                "dimension": self._dimension,
            })
        except Exception as e:
            logger.error("Failed to load local FastEmbed model", {"error": str(e), "model": model_name})
            raise EmbeddingError(f"Local embedding model initialization failed: {str(e)}")

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        try:
            # fastembed.embed returns a generator of numpy arrays
            embeddings = list(self._model.embed(texts))
            return [list(map(float, vec)) for vec in embeddings]
        except Exception as e:
            logger.error("Local document embedding failed", {"error": str(e), "count": len(texts)})
            raise EmbeddingError(f"Document embedding computation failed: {str(e)}")

    def embed_query(self, text: str) -> List[float]:
        try:
            embedding = list(self._model.embed([text]))[0]
            return list(map(float, embedding))
        except Exception as e:
            logger.error("Local query embedding failed", {"error": str(e)})
            raise EmbeddingError(f"Query embedding computation failed: {str(e)}")

    def get_metadata(self) -> EmbeddingMetadata:
        return EmbeddingMetadata(
            model_name=self.model_name,
            dimension=self._dimension,
            normalized=True,
            provider_type="fastembed_onnx",
            version=self._version,
        )
