import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RAGClient, RAGServiceError } from './rag-client';

describe('RAG Client Service-to-Service Integration', () => {
  let client: RAGClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new RAGClient('http://127.0.0.1:8001');
  });

  it('successfully queries RAG and receives structured citations', async () => {
    const mockResponse = {
      query: 'What is my fasting glucose?',
      answer: 'Based on your records, your glucose is 115 mg/dL.',
      summary: '1 relevant finding.',
      citations: [
        {
          document_id: 'doc_1',
          document_name: 'lab_report.pdf',
          page_number: 1,
          section_heading: 'LABORATORY RESULTS',
          chunk_id: 'chk_1',
          excerpt: 'Fasting Blood Glucose: 115 mg/dL',
          relevance_score: 0.35,
        },
      ],
      sourceDocuments: ['lab_report.pdf'],
      pageReferences: [1],
      confidenceAssessment: 'HIGH',
      missingInformation: [],
      safetyFlags: [],
      generatedAt: new Date().toISOString(),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await client.queryRAG({
      userId: 'user_test_1',
      query: 'What is my fasting glucose?',
    });

    expect(result.answer).toContain('115 mg/dL');
    expect(result.citations.length).toBe(1);
    expect(result.citations[0].document_name).toBe('lab_report.pdf');
    expect(result.confidenceAssessment).toBe('HIGH');
  });

  it('handles microservice 500 error gracefully by throwing RAGServiceError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal RAG worker failure',
    } as unknown as Response);

    await expect(
      client.queryRAG({
        userId: 'user_test_1',
        query: 'What is my fasting glucose?',
      })
    ).rejects.toThrow(RAGServiceError);
  });

  it('returns false on checkHealth when service is offline', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection refused'));
    const isHealthy = await client.checkHealth();
    expect(isHealthy).toBe(false);
  });
});
