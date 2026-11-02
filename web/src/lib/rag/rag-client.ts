import { getEnv } from '@/lib/config/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { createInternalServiceAssertion } from './rag-token';

export interface RAGCitation {
  document_id: string;
  document_name: string;
  page_number: number;
  section_heading: string;
  chunk_id: string;
  excerpt: string;
  relevance_score: number;
}

export interface RAGQueryResponse {
  query: string;
  answer: string;
  summary: string;
  citations: RAGCitation[];
  sourceDocuments: string[];
  pageReferences: number[];
  confidenceAssessment: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  missingInformation: string[];
  safetyFlags: string[];
  generatedAt: string;
}

export interface RAGIngestResponse {
  success: boolean;
  document_id: string;
  file_name: string;
  total_pages: number;
  total_chunks: number;
  content_hash: string;
  extraction_method: string;
  ingested_at: string;
}

export class RAGServiceError extends AppError {
  constructor(message: string, statusCode = 502, code = 'RAG_SERVICE_UNAVAILABLE') {
    super(message, statusCode, code);
    this.name = 'RAGServiceError';
  }
}

export class RAGClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    const env = getEnv();
    this.baseUrl = baseUrl || env.RAG_SERVICE_URL;
  }

  /**
   * Dispatches a document to the Python microservice for parsing, chunking, and vector indexing.
   */
  async ingestDocument(params: {
    userId: string;
    tenantId?: string;
    documentId: string;
    fileName: string;
    fileBuffer: Buffer;
  }): Promise<RAGIngestResponse> {
    const token = createInternalServiceAssertion({
      userId: params.userId,
      tenantId: params.tenantId,
      operation: 'INGEST',
      resourceId: params.documentId,
    });

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(params.fileBuffer)], { type: 'application/pdf' });
    formData.append('file', blob, params.fileName);
    formData.append('document_id', params.documentId);

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/documents/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error('RAG ingestion failed on Python microservice', {
          status: response.status,
          error: errorText,
          documentId: params.documentId,
        });
        throw new RAGServiceError(`RAG ingestion failed (${response.status}): ${errorText}`);
      }

      return (await response.json()) as RAGIngestResponse;
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.warn('RAG ingestion service unreachable', {
        error: (err as Error).message,
        documentId: params.documentId,
      });
      throw new RAGServiceError(`RAG service communication failed: ${(err as Error).message}`);
    }
  }

  /**
   * Queries the Python RAG microservice for authorized context-grounded evidence.
   */
  async queryRAG(params: {
    userId: string;
    tenantId?: string;
    query: string;
    topK?: number;
    similarityThreshold?: number;
    documentIds?: string[];
  }): Promise<RAGQueryResponse> {
    const token = createInternalServiceAssertion({
      userId: params.userId,
      tenantId: params.tenantId,
      operation: 'QUERY',
    });

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/rag/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: params.query,
          top_k: params.topK,
          similarity_threshold: params.similarityThreshold,
          document_ids: params.documentIds,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        logger.error('RAG query failed on microservice', {
          status: response.status,
          error: errText,
        });
        throw new RAGServiceError(`RAG query rejected (${response.status}): ${errText}`);
      }

      return (await response.json()) as RAGQueryResponse;
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.warn('RAG query service unreachable', { error: (err as Error).message });
      throw new RAGServiceError(`RAG query failed: ${(err as Error).message}`);
    }
  }

  /**
   * Deletes all vector chunks and index records for a given document.
   */
  async deleteDocumentIndex(params: {
    userId: string;
    tenantId?: string;
    documentId: string;
  }): Promise<{ success: boolean; deleted_chunks: number }> {
    const token = createInternalServiceAssertion({
      userId: params.userId,
      tenantId: params.tenantId,
      operation: 'DELETE',
      resourceId: params.documentId,
    });

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/documents/${encodeURIComponent(params.documentId)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        logger.error('RAG deletion failed', { status: response.status, error: errText });
        return { success: false, deleted_chunks: 0 };
      }

      return (await response.json()) as { success: boolean; deleted_chunks: number };
    } catch (err) {
      logger.warn('RAG deletion call failed', { error: (err as Error).message });
      return { success: false, deleted_chunks: 0 };
    }
  }

  /**
   * Probes microservice liveness.
   */
  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const ragClient = new RAGClient();
