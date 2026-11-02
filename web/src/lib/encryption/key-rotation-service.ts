import { LocalKeyProvider } from './key-providers';
import { logger } from '@/lib/logger';
import crypto from 'node:crypto';

export interface KeyLifecycleMetrics {
  activeKeyId: string;
  createdAt: number;
  totalInvocations: number;
  maxInvocationsThreshold: number; // Defaults to 2^24 = 16,777,216 per NIST SP 800-38D
  maxAgeMs: number;               // Defaults to 90 days = 7,776,000,000 ms
}

/**
 * Key Rotation & Lifecycle Service
 *
 * Implements NIST SP 800-38D rotation bounds to prevent GCM nonce collision risks.
 */
export class KeyRotationService {
  private readonly metrics: KeyLifecycleMetrics;
  private readonly keyProvider: LocalKeyProvider;

  constructor(
    keyProvider: LocalKeyProvider,
    options?: {
      maxInvocationsThreshold?: number;
      maxAgeMs?: number;
      createdAt?: number;
    }
  ) {
    this.keyProvider = keyProvider;
    this.metrics = {
      activeKeyId: keyProvider.getActiveKeyId(),
      createdAt: options?.createdAt || Date.now(),
      totalInvocations: 0,
      maxInvocationsThreshold: options?.maxInvocationsThreshold || 16_777_216, // 2^24 operations
      maxAgeMs: options?.maxAgeMs || 90 * 24 * 60 * 60 * 1000, // 90 days
    };
  }

  public recordInvocation(count = 1): void {
    this.metrics.totalInvocations += count;
  }

  public isRotationDue(): { due: boolean; reason?: 'INVOCATIONS_EXCEEDED' | 'AGE_EXCEEDED' } {
    if (this.metrics.totalInvocations >= this.metrics.maxInvocationsThreshold) {
      return { due: true, reason: 'INVOCATIONS_EXCEEDED' };
    }
    const age = Date.now() - this.metrics.createdAt;
    if (age >= this.metrics.maxAgeMs) {
      return { due: true, reason: 'AGE_EXCEEDED' };
    }
    return { due: false };
  }

  public rotateMasterKey(newKeyId?: string): { oldKeyId: string; newKeyId: string } {
    const oldKeyId = this.keyProvider.getActiveKeyId();
    const nextKeyId = newKeyId || `k${String(Date.now()).slice(-3)}`;
    const newKeyBytes = crypto.randomBytes(32);

    this.keyProvider.rotateKey(newKeyBytes, nextKeyId);

    this.metrics.activeKeyId = nextKeyId;
    this.metrics.createdAt = Date.now();
    this.metrics.totalInvocations = 0;

    logger.info('Rotated master encryption key', {
      oldKeyId,
      newKeyId: nextKeyId,
      timestamp: new Date().toISOString(),
    });

    return { oldKeyId, newKeyId: nextKeyId };
  }

  public getMetrics(): KeyLifecycleMetrics {
    return { ...this.metrics };
  }
}
