"""
MediMate AI — Quantitative Retrieval Evaluation Benchmark
Evaluates Precision@K, Recall@K, Mean Reciprocal Rank (MRR),
Citation Accuracy, and Unanswerable Question Guarding on a synthetic clinical dataset.
"""

from typing import Dict, List, Optional
from app.orchestration.engine import RAGEngine


EVALUATION_DATASET = [
    {
        "id": "q1_glucose",
        "question": "What is the fasting blood glucose level?",
        "expected_doc": "doc_eval_labs",
        "expected_pages": [1],
        "keywords": ["Glucose", "115 mg/dL"],
        "answerable": True,
    },
    {
        "id": "q2_a1c",
        "question": "What is the patient's Hemoglobin A1c percentage?",
        "expected_doc": "doc_eval_labs",
        "expected_pages": [1],
        "keywords": ["Hemoglobin", "A1c", "6.8"],
        "answerable": True,
    },
    {
        "id": "q3_meds",
        "question": "What daily oral medication was prescribed for diabetes?",
        "expected_doc": "doc_eval_labs",
        "expected_pages": [2],
        "keywords": ["Metformin", "Diabetes", "500 mg"],
        "answerable": True,
    },
    {
        "id": "q4_statin",
        "question": "What medication was prescribed for cholesterol management?",
        "expected_doc": "doc_eval_labs",
        "expected_pages": [1, 2],
        "keywords": ["Cholesterol", "Statin", "Atorvastatin"],
        "answerable": True,
    },
    {
        "id": "q5_unanswerable_mri",
        "question": "What were the findings on the brain MRI scan?",
        "expected_doc": None,
        "expected_pages": [],
        "keywords": [],
        "answerable": False,
    },
    {
        "id": "q6_unanswerable_covid",
        "question": "Did the patient test positive for COVID-19 PCR?",
        "expected_doc": None,
        "expected_pages": [],
        "keywords": [],
        "answerable": False,
    },
]


def test_retrieval_evaluation_benchmark(
    rag_engine: RAGEngine, sample_clinical_report_bytes: bytes
):
    tenant_id = "eval_tenant"
    user_id = "eval_patient_001"
    doc_id = "doc_eval_labs"

    # 1. Ingest evaluation document
    rag_engine.ingest_document(
        tenant_id=tenant_id,
        user_id=user_id,
        document_bytes=sample_clinical_report_bytes,
        file_name="eval_labs_2026.pdf",
        document_id=doc_id,
    )

    k = 3
    hits_at_k = 0
    reciprocal_ranks: List[float] = []
    unanswerable_correct = 0
    unanswerable_total = 0
    citation_correct = 0
    answerable_total = 0

    print("\n--- MediMate AI RAG Quantitative Retrieval Evaluation ---")

    for item in EVALUATION_DATASET:
        q = item["question"]
        res = rag_engine.query(
            tenant_id=tenant_id,
            user_id=user_id,
            query_text=q,
            top_k=k,
        )

        if item["answerable"]:
            answerable_total += 1
            # Check if expected document was retrieved in top-k
            citations = res.evidence.citations
            retrieved_doc_ids = [c.document_id for c in citations]

            # Find rank of expected doc
            rank = None
            for idx, c in enumerate(citations, 1):
                if c.document_id == item["expected_doc"]:
                    # Also verify keyword presence in retrieved chunk
                    if any(kw.lower() in c.excerpt.lower() for kw in item["keywords"]):
                        rank = idx
                        break

            if rank is not None and rank <= k:
                hits_at_k += 1
                reciprocal_ranks.append(1.0 / rank)
            else:
                reciprocal_ranks.append(0.0)

            # Check citation correctness (page number matching)
            if citations and citations[0].page_number in item["expected_pages"]:
                citation_correct += 1
        else:
            unanswerable_total += 1
            # For unanswerable queries, no chunks should be retrieved, or confidence should be NONE
            if (
                res.retrieved_chunk_count == 0
                or res.evidence.confidence_assessment == "NONE"
                or "not found in the uploaded medical records" in res.answer
            ):
                unanswerable_correct += 1

    precision_at_k = hits_at_k / answerable_total if answerable_total > 0 else 0.0
    mrr = sum(reciprocal_ranks) / len(reciprocal_ranks) if reciprocal_ranks else 0.0
    citation_accuracy = citation_correct / answerable_total if answerable_total > 0 else 0.0
    unanswerable_guard_accuracy = unanswerable_correct / unanswerable_total if unanswerable_total > 0 else 0.0

    print(f"Evaluated Queries: {len(EVALUATION_DATASET)}")
    print(f"Recall@{k} / Precision@{k}: {precision_at_k:.2%}")
    print(f"Mean Reciprocal Rank (MRR): {mrr:.4f}")
    print(f"Citation Page Accuracy: {citation_accuracy:.2%}")
    print(f"Unanswerable Question Accuracy: {unanswerable_guard_accuracy:.2%}")
    print("----------------------------------------------------------\n")

    # Assert rigorous benchmarks
    assert precision_at_k >= 0.75, f"Expected Precision@{k} >= 75%, got {precision_at_k:.2%}"
    assert mrr >= 0.70, f"Expected MRR >= 0.70, got {mrr:.4f}"
    assert citation_accuracy >= 0.75, f"Expected Citation Accuracy >= 75%, got {citation_accuracy:.2%}"
    assert unanswerable_guard_accuracy == 1.0, f"Expected 100% unanswerable accuracy, got {unanswerable_guard_accuracy:.2%}"
