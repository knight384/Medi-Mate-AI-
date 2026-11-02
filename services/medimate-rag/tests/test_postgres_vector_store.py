"""
MediMate AI — PostgreSQL Vector Store Unit & Integration Tests
Validates schema initialization, RLS tenant context, atomic re-indexing,
and orphan reconciliation logic.
"""

from unittest.mock import MagicMock, patch
import pytest
from app.chunking.models import DocumentChunk
from app.storage.postgres_store import PostgresVectorStore


def test_postgres_vector_store_requires_database_url():
    with pytest.raises(Exception, match="DATABASE_URL"):
        PostgresVectorStore(database_url=None)


def test_postgres_vector_store_atomic_reindexing():
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.__enter__.return_value = mock_conn
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur

    store = PostgresVectorStore(database_url="postgresql://medimate_app:pass@localhost:5432/open-health")
    store._initialized = True  # bypass init for unit test

    with patch.object(store, "_get_connection", return_value=mock_conn):
        chunk1 = DocumentChunk(
            chunk_id="chk_01",
            document_id="doc_reindex_101",
            tenant_id="t1",
            user_id="u1",
            page_number=1,
            section_heading="MEDICATIONS",
            content="Apixaban 5mg BID for atrial fibrillation.",
            chunk_index=0,
            word_count=6,
            content_hash="hash01",
            metadata={"file_name": "rx.pdf"},
        )

        res = store.add_chunks(
            tenant_id="t1",
            user_id="u1",
            chunks=[chunk1],
            embeddings=[[0.1] * 384],
        )

        assert res == 1
        # Verify RLS session setting
        mock_cur.execute.assert_any_call("SET LOCAL app.current_user_id = %s;", ("u1",))
        # Verify atomic deletion of old chunks for this document
        mock_cur.execute.assert_any_call(
            "DELETE FROM public.rag_document_chunks WHERE tenant_id = %s AND user_id = %s AND document_id = %s;",
            ("t1", "u1", "doc_reindex_101"),
        )
        mock_conn.commit.assert_called()


def test_postgres_vector_store_deletion_propagation():
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.rowcount = 3
    mock_conn.__enter__.return_value = mock_conn
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur

    store = PostgresVectorStore(database_url="postgresql://medimate_app:pass@localhost:5432/open-health")
    store._initialized = True

    with patch.object(store, "_get_connection", return_value=mock_conn):
        deleted = store.delete_document(tenant_id="t1", user_id="u1", document_id="doc_to_delete")
        assert deleted == 3
        mock_cur.execute.assert_any_call("SET LOCAL app.current_user_id = %s;", ("u1",))
        mock_cur.execute.assert_any_call(
            "DELETE FROM public.rag_document_chunks WHERE tenant_id = %s AND user_id = %s AND document_id = %s;",
            ("t1", "u1", "doc_to_delete"),
        )
        mock_conn.commit.assert_called()


def test_postgres_vector_store_orphan_reconciliation():
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = [1]  # HealthData table exists
    mock_cur.rowcount = 5  # 5 orphans purged
    mock_conn.__enter__.return_value = mock_conn
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur

    store = PostgresVectorStore(database_url="postgresql://medimate_app:pass@localhost:5432/open-health")
    store._initialized = True

    with patch.object(store, "_get_connection", return_value=mock_conn):
        purged = store.reconcile_orphans()
        assert purged == 5
        mock_conn.commit.assert_called()
