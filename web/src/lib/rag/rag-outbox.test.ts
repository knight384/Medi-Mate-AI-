import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RAGOutboxService } from './rag-outbox';
import { RAGClient } from './rag-client';
import { localStorageDriver } from '@/lib/storage';

describe('RAGOutboxService — Durable Ingestion & Deletion Queue', () => {
  let outbox: RAGOutboxService;
  let mockClient: RAGClient;

  beforeEach(() => {
    outbox = RAGOutboxService.getInstance();
    outbox.clear();
    mockClient = {
      ingestDocument: vi.fn().mockResolvedValue({
        success: true,
        document_id: 'doc_1',
        file_name: 'test.pdf',
        total_pages: 1,
        total_chunks: 2,
        content_hash: 'hash123',
        extraction_method: 'pdf_text',
        ingested_at: new Date().toISOString(),
      }),
      deleteDocumentIndex: vi.fn().mockResolvedValue({
        success: true,
        document_id: 'doc_1',
        deleted_chunks: 2,
        deleted_at: new Date().toISOString(),
      }),
    } as unknown as RAGClient;
  });

  it('enqueues an ingestion event and executes successfully', async () => {
    vi.spyOn(localStorageDriver, 'exists').mockResolvedValue(true);
    vi.spyOn(localStorageDriver, 'readStream').mockResolvedValue({
      stream: (async function* () {
        yield Buffer.from('test pdf content');
      })(),
      size: 16,
      mimeType: 'application/pdf',
    } as any);

    const event = await outbox.enqueueIngest({
      userId: 'user_patient_1',
      tenantId: 'tenant_clinic_a',
      documentId: 'doc_101',
      fileName: 'lab_report.pdf',
      storageKey: 'users/user_patient_1/doc_101.pdf',
    });

    expect(event.status).toBe('PENDING');
    expect(event.attempts).toBe(0);

    const ok = await outbox.executeEvent(event.id, mockClient);
    expect(ok).toBe(true);

    const updated = outbox.getEvent(event.id);
    expect(updated?.status).toBe('COMPLETED');
    expect(updated?.attempts).toBe(1);
    expect(mockClient.ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_patient_1',
        documentId: 'doc_101',
        fileName: 'lab_report.pdf',
      })
    );
  });

  it('enqueues a deletion event and marks status completed', async () => {
    const event = await outbox.enqueueDelete({
      userId: 'user_patient_1',
      tenantId: 'tenant_clinic_a',
      documentId: 'doc_101',
    });

    expect(outbox.isPendingDeletion('doc_101')).toBe(true);

    const ok = await outbox.executeEvent(event.id, mockClient);
    expect(ok).toBe(true);

    const updated = outbox.getEvent(event.id);
    expect(updated?.status).toBe('COMPLETED');
    expect(mockClient.deleteDocumentIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_patient_1',
        documentId: 'doc_101',
      })
    );
  });

  it('handles transient microservice errors with exponential backoff and leaves job in outbox', async () => {
    const failingClient = {
      deleteDocumentIndex: vi.fn().mockRejectedValue(new Error('Connection refused by RAG container')),
    } as unknown as RAGClient;

    const event = await outbox.enqueueDelete({
      userId: 'user_patient_1',
      documentId: 'doc_fail_1',
    });

    const ok = await outbox.executeEvent(event.id, failingClient);
    expect(ok).toBe(false);

    const updated = outbox.getEvent(event.id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.attempts).toBe(1);
    expect(updated?.lastError).toContain('Connection refused by RAG container');
    expect(updated?.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
    // Document is still recognized as pending deletion to protect clinical privacy
    expect(outbox.isPendingDeletion('doc_fail_1')).toBe(true);
  });

  it('processes pending events during reconciliation loop', async () => {
    const event1 = await outbox.enqueueDelete({
      userId: 'user_patient_1',
      documentId: 'doc_batch_1',
    });
    const event2 = await outbox.enqueueDelete({
      userId: 'user_patient_1',
      documentId: 'doc_batch_2',
    });

    const result = await outbox.processPendingEvents(mockClient);
    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);

    expect(outbox.getEvent(event1.id)?.status).toBe('COMPLETED');
    expect(outbox.getEvent(event2.id)?.status).toBe('COMPLETED');
  });
});
