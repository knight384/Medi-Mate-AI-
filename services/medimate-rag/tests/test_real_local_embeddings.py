"""
MediMate AI — Real Local FastEmbed ONNX Model Tests
Validates real embedding generation, exact 384 dimensions, metadata,
and semantic discrimination on synthetic clinical texts.
"""

import math
import pytest
from app.embeddings.local_provider import LocalEmbeddingProvider


@pytest.fixture(scope="module")
def embedding_provider():
    return LocalEmbeddingProvider(model_name="BAAI/bge-small-en-v1.5")


def test_real_embedding_generation_and_dimensions(embedding_provider):
    texts = [
        "Patient presents with fasting glucose of 145 mg/dL and HbA1c 7.4%.",
        "Assessment: Type 2 Diabetes Mellitus with sub-optimal glycemic control.",
    ]
    embeddings = embedding_provider.embed_documents(texts)

    assert len(embeddings) == 2
    for vec in embeddings:
        assert len(vec) == 384  # Exact BAAI/bge-small-en-v1.5 dimension
        # Check normalized vector: norm should be approximately 1.0
        norm = math.sqrt(sum(x * x for x in vec))
        assert abs(norm - 1.0) < 1e-3


def test_real_embedding_query_compatibility(embedding_provider):
    query = "What is the patient diabetes lab reading?"
    q_vec = embedding_provider.embed_query(query)

    assert len(q_vec) == 384
    q_norm = math.sqrt(sum(x * x for x in q_vec))
    assert abs(q_norm - 1.0) < 1e-3


def test_real_embedding_semantic_discrimination(embedding_provider):
    diabetes_doc = "Laboratory report confirms HbA1c 7.4% and fasting blood glucose 142 mg/dL."
    ortho_doc = "Left knee arthroscopy shows intact anterior cruciate ligament with minor meniscus fraying."

    docs = embedding_provider.embed_documents([diabetes_doc, ortho_doc])
    query = embedding_provider.embed_query("What was the patient HbA1c glucose level?")

    # Cosine similarities
    sim_diabetes = sum(a * b for a, b in zip(docs[0], query))
    sim_ortho = sum(a * b for a, b in zip(docs[1], query))

    # Relevant clinical text must have substantially higher similarity than irrelevant ortho text
    assert sim_diabetes > 0.60
    assert sim_diabetes > sim_ortho + 0.15


def test_real_embedding_metadata(embedding_provider):
    meta = embedding_provider.get_metadata()
    assert meta.model_name == "BAAI/bge-small-en-v1.5"
    assert meta.dimension == 384
    assert meta.normalized is True
    assert meta.provider_type == "fastembed_onnx"
    assert meta.version == "1.5"
