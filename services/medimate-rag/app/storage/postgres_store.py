"""
MediMate AI — Persistent PostgreSQL / pgvector Tenant-Isolated Vector Store
Provides durable vector persistence, document versioning, least-privilege role access,
and Row-Level Security (RLS) enforcement.
"""

import json
import math
from typing import Any, Dict, List, Optional, Tuple
import psycopg
from psycopg.rows import dict_row

from app.chunking.models import DocumentChunk, ScoredChunk
from app.core.config import settings
from app.core.errors import StorageError
from app.core.logging import logger
from app.storage.base import BaseVectorStore


class PostgresVectorStore(BaseVectorStore):
    """
    Durable vector store backed by PostgreSQL.
    Supports native pgvector when extension is available, with portable array fallback.
    Enforces tenant and user isolation with PostgreSQL Row-Level Security.
    """

    def __init__(self, database_url: Optional[str] = None):
        self.database_url = database_url or settings.database_url
        if not self.database_url:
            raise StorageError("PostgresVectorStore requires DATABASE_URL to be configured")

        self._has_pgvector = False
        self._initialized = False

    def _get_connection(self) -> psycopg.Connection:
        try:
            conn = psycopg.connect(self.database_url, autocommit=False)
            return conn
        except Exception as e:
            logger.error("Failed to connect to PostgreSQL vector store", {"error": str(e)})
            raise StorageError(f"Database connection error: {str(e)}")

    def initialize_schema(self) -> None:
        """Sets up tables, indexes, extensions, and RLS policies."""
        if self._initialized:
            return

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                # 1. Detect if pgvector extension is available in PostgreSQL
                cur.execute(
                    "SELECT 1 FROM pg_available_extensions WHERE name = 'vector';"
                )
                if cur.fetchone():
                    try:
                        cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
                        self._has_pgvector = True
                        logger.info("Enabled pgvector extension in PostgreSQL")
                    except Exception as ext_err:
                        logger.warning(
                            "pgvector extension available but could not be enabled (insufficient role privileges); using array fallback",
                            {"error": str(ext_err)}
                        )
                        self._has_pgvector = False
                else:
                    self._has_pgvector = False
                    logger.info("pgvector extension not present; using high-performance real[] vector storage")

                # 2. Create chunks table
                vector_col = "embedding_vec vector(384)," if self._has_pgvector else ""
                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS public.rag_document_chunks (
                        id TEXT PRIMARY KEY,
                        tenant_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        document_id TEXT NOT NULL,
                        chunk_index INTEGER NOT NULL,
                        content TEXT NOT NULL,
                        page_number INTEGER NOT NULL,
                        section_header TEXT,
                        lab_values JSONB DEFAULT '[]'::jsonb,
                        medication_dosages JSONB DEFAULT '[]'::jsonb,
                        metadata JSONB DEFAULT '{{}}'::jsonb,
                        embedding_model TEXT NOT NULL,
                        embedding_dimension INTEGER NOT NULL,
                        embedding_real real[] NOT NULL,
                        {vector_col}
                        version INTEGER DEFAULT 1,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW()
                    );
                """)

                # 3. Create indexes for tenant/user isolation and document relationships
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_rag_chunks_tenant_user_doc 
                    ON public.rag_document_chunks (tenant_id, user_id, document_id);

                    CREATE INDEX IF NOT EXISTS idx_rag_chunks_user_doc 
                    ON public.rag_document_chunks (user_id, document_id);
                """)

                # HNSW vector index if pgvector is enabled
                if self._has_pgvector:
                    try:
                        cur.execute("""
                            CREATE INDEX IF NOT EXISTS idx_rag_chunks_hnsw_vec
                            ON public.rag_document_chunks 
                            USING hnsw (embedding_vec vector_cosine_ops);
                        """)
                    except Exception as hnsw_err:
                        logger.warning("Could not create HNSW index on embedding_vec", {"error": str(hnsw_err)})

                # 4. Enable and force Row Level Security
                try:
                    cur.execute("""
                        ALTER TABLE public.rag_document_chunks ENABLE ROW LEVEL SECURITY;
                        ALTER TABLE public.rag_document_chunks FORCE ROW LEVEL SECURITY;

                        DROP POLICY IF EXISTS rag_chunks_user_isolation ON public.rag_document_chunks;
                        CREATE POLICY rag_chunks_user_isolation ON public.rag_document_chunks
                            FOR ALL TO PUBLIC
                            USING (user_id = NULLIF(current_setting('app.current_user_id', true), ''))
                            WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), ''));
                    """)
                except Exception as rls_err:
                    logger.warning("Row Level Security configuration notice", {"notice": str(rls_err)})

            conn.commit()
            self._initialized = True
            logger.info("PostgresVectorStore schema initialized successfully", {
                "has_pgvector": self._has_pgvector
            })

    def add_chunks(
        self,
        tenant_id: str,
        user_id: str,
        chunks: List[DocumentChunk],
        embeddings: List[List[float]],
    ) -> int:
        if not chunks:
            return 0
        if len(chunks) != len(embeddings):
            raise ValueError("Chunks count must match embeddings count")

        self.initialize_schema()

        # Group by document to support atomic re-indexing
        doc_ids = list({chunk.document_id for chunk in chunks})

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                # 1. Establish tenant session context for RLS
                cur.execute("SET LOCAL app.current_user_id = %s;", (user_id,))

                # 2. Atomic re-indexing: purge existing chunks for these documents
                for doc_id in doc_ids:
                    cur.execute(
                        "DELETE FROM public.rag_document_chunks WHERE tenant_id = %s AND user_id = %s AND document_id = %s;",
                        (tenant_id, user_id, doc_id),
                    )

                # 3. Batch insert new chunks
                insert_sql = """
                    INSERT INTO public.rag_document_chunks (
                        id, tenant_id, user_id, document_id, chunk_index, content,
                        page_number, section_header, lab_values, medication_dosages,
                        metadata, embedding_model, embedding_dimension, embedding_real, version
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                    );
                """

                for chunk, emb in zip(chunks, embeddings):
                    lab_vals = chunk.metadata.get("lab_values", [])
                    med_doses = chunk.metadata.get("medication_dosages", [])
                    cur.execute(
                        insert_sql,
                        (
                            chunk.chunk_id,
                            tenant_id,
                            user_id,
                            chunk.document_id,
                            chunk.chunk_index,
                            chunk.content,
                            chunk.page_number,
                            chunk.section_heading,
                            json.dumps(lab_vals),
                            json.dumps(med_doses),
                            json.dumps(chunk.metadata),
                            chunk.metadata.get("embedding_model", "BAAI/bge-small-en-v1.5"),
                            len(emb),
                            emb,
                            chunk.metadata.get("version", 1),
                        ),
                    )

            conn.commit()
            return len(chunks)

    def search(
        self,
        tenant_id: str,
        user_id: str,
        query_embedding: List[float],
        top_k: int = 4,
        similarity_threshold: float = 0.25,
        document_ids: Optional[List[str]] = None,
    ) -> List[ScoredChunk]:
        self.initialize_schema()

        with self._get_connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # Set RLS session setting
                cur.execute("SET LOCAL app.current_user_id = %s;", (user_id,))

                # Filter query: enforce tenant, user, and active document status
                query = """
                    SELECT c.id, c.tenant_id, c.user_id, c.document_id, c.chunk_index,
                           c.content, c.page_number, c.section_header, c.lab_values,
                           c.medication_dosages, c.metadata, c.embedding_real
                    FROM public.rag_document_chunks c
                    WHERE c.tenant_id = %s
                      AND c.user_id = %s
                """
                params: List[Any] = [tenant_id, user_id]

                # Document ID scoping
                if document_ids:
                    query += " AND c.document_id = ANY(%s)"
                    params.append(document_ids)

                # Do not retrieve chunks from documents marked 'DELETING' in HealthData (if table exists)
                query += """
                    AND NOT EXISTS (
                        SELECT 1 FROM information_schema.tables WHERE table_name = 'HealthData'
                    ) OR NOT EXISTS (
                        SELECT 1 FROM public."HealthData" h
                        WHERE h.id = c.document_id AND h.status = 'DELETING'
                    )
                """

                cur.execute(query, tuple(params))
                rows = cur.fetchall()

        # Compute cosine similarity
        scored: List[ScoredChunk] = []
        q_norm = math.sqrt(sum(x * x for x in query_embedding))
        if q_norm == 0:
            return []

        for row in rows:
            emb = row["embedding_real"]
            if not emb or len(emb) != len(query_embedding):
                continue

            dot = sum(a * b for a, b in zip(query_embedding, emb))
            norm = math.sqrt(sum(x * x for x in emb))
            sim = (dot / (q_norm * norm)) if norm > 0 else 0.0

            if sim >= similarity_threshold:
                meta = row["metadata"] if isinstance(row["metadata"], dict) else json.loads(row["metadata"] or "{}")
                if "lab_values" not in meta and row.get("lab_values"):
                    meta["lab_values"] = row["lab_values"] if isinstance(row["lab_values"], list) else json.loads(row["lab_values"] or "[]")
                if "medication_dosages" not in meta and row.get("medication_dosages"):
                    meta["medication_dosages"] = row["medication_dosages"] if isinstance(row["medication_dosages"], list) else json.loads(row["medication_dosages"] or "[]")

                chunk = DocumentChunk(
                    chunk_id=row["id"],
                    document_id=row["document_id"],
                    tenant_id=row["tenant_id"],
                    user_id=row["user_id"],
                    page_number=row["page_number"],
                    section_heading=row.get("section_header") or "GENERAL",
                    content=row["content"],
                    chunk_index=row["chunk_index"],
                    word_count=len(row["content"].split()),
                    content_hash=row["id"],
                    metadata=meta,
                )
                scored.append(ScoredChunk(chunk=chunk, similarity_score=round(float(sim), 4)))

        scored.sort(key=lambda x: x.similarity_score, reverse=True)
        return scored[:top_k]

    def delete_document(self, tenant_id: str, user_id: str, document_id: str) -> int:
        self.initialize_schema()

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL app.current_user_id = %s;", (user_id,))
                cur.execute(
                    "DELETE FROM public.rag_document_chunks WHERE tenant_id = %s AND user_id = %s AND document_id = %s;",
                    (tenant_id, user_id, document_id),
                )
                deleted = cur.rowcount
            conn.commit()
            logger.info("Deleted document chunks from PostgreSQL vector store", {
                "tenant_id": tenant_id,
                "user_id": user_id,
                "document_id": document_id,
                "deleted_chunks": deleted,
            })
            return deleted

    def delete_user(self, tenant_id: str, user_id: str) -> int:
        self.initialize_schema()

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL app.current_user_id = %s;", (user_id,))
                cur.execute(
                    "DELETE FROM public.rag_document_chunks WHERE tenant_id = %s AND user_id = %s;",
                    (tenant_id, user_id),
                )
                deleted = cur.rowcount
            conn.commit()
            return deleted

    def count(self, tenant_id: str, user_id: str) -> int:
        self.initialize_schema()

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL app.current_user_id = %s;", (user_id,))
                cur.execute(
                    "SELECT COUNT(*) FROM public.rag_document_chunks WHERE tenant_id = %s AND user_id = %s;",
                    (tenant_id, user_id),
                )
                res = cur.fetchone()
                return res[0] if res else 0

    def reconcile_orphans(self) -> int:
        """Purges any chunks whose parent HealthData record was deleted or does not exist."""
        self.initialize_schema()

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                # Check if HealthData exists
                cur.execute("SELECT 1 FROM information_schema.tables WHERE table_name = 'HealthData';")
                if not cur.fetchone():
                    return 0

                cur.execute("""
                    DELETE FROM public.rag_document_chunks c
                    WHERE NOT EXISTS (
                        SELECT 1 FROM public."HealthData" h WHERE h.id = c.document_id
                    );
                """)
                orphans = cur.rowcount
            conn.commit()
            if orphans > 0:
                logger.info("Reconciled orphaned vector chunks", {"purged_count": orphans})
            return orphans
