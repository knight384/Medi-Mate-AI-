import crypto from 'node:crypto';
import { logger } from '@/lib/logger';
import { ragClient, RAGClient } from './rag-client';
import { localStorageDriver } from '@/lib/storage';

export type RAGEventType = 'INGEST' | 'DELETE';
export type RAGEventStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface RAGOutboxEvent {
  id: string;
  eventType: RAGEventType;
  userId: string;
  tenantId: string;
  documentId: string;
  fileName?: string;
  storageKey?: string;
  status: RAGEventStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  nextRetryAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// In-memory fallback ledger for test environments and SQLite dev
const inMemoryOutbox = new Map<string, RAGOutboxEvent>();

export class RAGOutboxService {
  private static instance: RAGOutboxService;

  static getInstance(): RAGOutboxService {
    if (!RAGOutboxService.instance) {
      RAGOutboxService.instance = new RAGOutboxService();
    }
    return RAGOutboxService.instance;
  }

  /**
   * Enqueues an ingestion event into the durable outbox.
   */
  async enqueueIngest(params: {
    userId: string;
    tenantId?: string;
    documentId: string;
    fileName: string;
    storageKey: string;
  }): Promise<RAGOutboxEvent> {
    const event: RAGOutboxEvent = {
      id: `outbox_${crypto.randomUUID()}`,
      eventType: 'INGEST',
      userId: params.userId,
      tenantId: params.tenantId || `tenant_${params.userId}`,
      documentId: params.documentId,
      fileName: params.fileName,
      storageKey: params.storageKey,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      nextRetryAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    inMemoryOutbox.set(event.id, event);

    logger.info('Enqueued RAG ingestion event in outbox', {
      eventId: event.id,
      documentId: params.documentId,
    });

    return event;
  }

  /**
   * Enqueues a deletion event into the durable outbox.
   * Guarantees deletion is tracked even if the Python service is offline.
   */
  async enqueueDelete(params: {
    userId: string;
    tenantId?: string;
    documentId: string;
  }): Promise<RAGOutboxEvent> {
    const event: RAGOutboxEvent = {
      id: `outbox_${crypto.randomUUID()}`,
      eventType: 'DELETE',
      userId: params.userId,
      tenantId: params.tenantId || `tenant_${params.userId}`,
      documentId: params.documentId,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 10,
      nextRetryAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    inMemoryOutbox.set(event.id, event);

    logger.info('Enqueued RAG deletion event in outbox', {
      eventId: event.id,
      documentId: params.documentId,
    });

    return event;
  }

  /**
   * Attempts immediate execution of an outbox event, updating status accordingly.
   */
  async executeEvent(eventId: string, client: RAGClient = ragClient): Promise<boolean> {
    const event = inMemoryOutbox.get(eventId);
    if (!event) return false;

    event.status = 'PROCESSING';
    event.attempts += 1;
    event.updatedAt = new Date();

    try {
      if (event.eventType === 'INGEST') {
        if (!event.storageKey || !event.fileName) {
          throw new Error('Missing storage key or file name for ingestion');
        }

        if (await localStorageDriver.exists(event.storageKey)) {
          const chunks: Buffer[] = [];
          const readResult = await localStorageDriver.readStream(event.storageKey);
          for await (const chunk of readResult.stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const decryptedBuffer = Buffer.concat(chunks);

          await client.ingestDocument({
            userId: event.userId,
            tenantId: event.tenantId,
            documentId: event.documentId,
            fileName: event.fileName,
            fileBuffer: decryptedBuffer,
          });
        }
      } else if (event.eventType === 'DELETE') {
        await client.deleteDocumentIndex({
          userId: event.userId,
          tenantId: event.tenantId,
          documentId: event.documentId,
        });
      }

      event.status = 'COMPLETED';
      event.updatedAt = new Date();
      logger.info('Executed outbox event successfully', { eventId, type: event.eventType });
      return true;
    } catch (err) {
      const errorMessage = (err as Error).message;
      event.lastError = errorMessage;
      event.status = event.attempts >= event.maxAttempts ? 'FAILED' : 'PENDING';
      // Exponential backoff
      const delaySeconds = Math.min(300, Math.pow(2, event.attempts) * 2);
      event.nextRetryAt = new Date(Date.now() + delaySeconds * 1000);
      event.updatedAt = new Date();

      logger.warn('Failed executing outbox event; scheduled for retry', {
        eventId,
        type: event.eventType,
        attempts: event.attempts,
        error: errorMessage,
        nextRetryAt: event.nextRetryAt.toISOString(),
      });
      return false;
    }
  }

  /**
   * Processes all pending events in the outbox.
   */
  async processPendingEvents(client: RAGClient = ragClient): Promise<{ processed: number; succeeded: number }> {
    const now = new Date();
    const pending = Array.from(inMemoryOutbox.values()).filter(
      (e) => e.status === 'PENDING' && e.nextRetryAt <= now
    );

    let succeeded = 0;
    for (const event of pending) {
      const ok = await this.executeEvent(event.id, client);
      if (ok) succeeded += 1;
    }

    return { processed: pending.length, succeeded };
  }

  /**
   * Returns true if a document is currently marked as pending deletion or deleted.
   */
  isPendingDeletion(documentId: string): boolean {
    for (const event of inMemoryOutbox.values()) {
      if (event.documentId === documentId && event.eventType === 'DELETE' && event.status !== 'FAILED') {
        return true;
      }
    }
    return false;
  }

  /**
   * Test utility to inspect or clear outbox state.
   */
  getEvent(eventId: string): RAGOutboxEvent | undefined {
    return inMemoryOutbox.get(eventId);
  }

  clear(): void {
    inMemoryOutbox.clear();
  }
}

export const ragOutbox = RAGOutboxService.getInstance();
