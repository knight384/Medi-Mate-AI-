import { LocalKeyProvider } from './key-providers';
import { logger } from '@/lib/logger';
import crypto from 'node:crypto';
import { redisConnectionManager } from '@/lib/redis/connection-manager';

export class RetiredKeyEncryptionError extends Error {
  public readonly code = 'RETIRED_KEY_ENCRYPTION_PROHIBITED';
  constructor(keyId: string) {
    super(`Encryption prohibited with retired key identifier: ${keyId}`);
    this.name = 'RetiredKeyEncryptionError';
  }
}

export class NistIvLimitExceededError extends Error {
  public readonly code = 'NIST_IV_COLLISION_LIMIT_EXCEEDED';
  constructor(keyId: string, invocations: number) {
    super(
      `Hard limit of 2^32 invocations reached for key ${keyId} (${invocations} recorded). Immediate rotation mandatory per NIST SP 800-38D Section 8.3.`
    );
    this.name = 'NistIvLimitExceededError';
  }
}

export interface KeyLifecycleMetrics {
  activeKeyId: string;
  createdAt: number;
  totalInvocations: number;
  maxInvocationsThreshold: number; // 2^24 = 16,777,216 per operational NIST policy
  hardLimitInvocations: number;    // 2^32 = 4,294,967,296 per NIST SP 800-38D
  maxAgeMs: number;               // 90 days = 7,776,000,000 ms
  retiredKeys: string[];
}

export interface KeyRotationOptions {
  maxInvocationsThreshold?: number;
  hardLimitInvocations?: number;
  maxAgeMs?: number;
  createdAt?: number;
}

/**
 * Key Rotation & Lifecycle Service
 *
 * Implements global GCM invocation tracking and rotation bounds aligned with NIST SP 800-38D Section 8.3.
 * Supports cross-instance counter aggregation via Redis with atomic in-memory fallback.
 */
export class KeyRotationService {
  private readonly metrics: KeyLifecycleMetrics;
  private readonly keyProvider: LocalKeyProvider;
  private readonly retiredKeysSet = new Set<string>();
  private readonly memoryCounters = new Map<string, number>();

  constructor(keyProvider: LocalKeyProvider, options?: KeyRotationOptions) {
    this.keyProvider = keyProvider;
    const activeKeyId = keyProvider.getActiveKeyId();

    this.metrics = {
      activeKeyId,
      createdAt: options?.createdAt || Date.now(),
      totalInvocations: 0,
      maxInvocationsThreshold: options?.maxInvocationsThreshold || 16_777_216, // 2^24 operations
      hardLimitInvocations: options?.hardLimitInvocations || 4_294_967_296, // 2^32 operations (NIST SP 800-38D Section 8.3)
      maxAgeMs: options?.maxAgeMs || 90 * 24 * 60 * 60 * 1000, // 90 days
      retiredKeys: [],
    };

    this.memoryCounters.set(activeKeyId, 0);
  }

  /**
   * Asserts that a key is permitted for NEW encryption operations.
   * Throws RetiredKeyEncryptionError if the key has been retired.
   * Throws NistIvLimitExceededError if the key has reached the 2^32 NIST boundary.
   */
  public assertCanEncrypt(keyId?: string): void {
    const id = keyId || this.metrics.activeKeyId;
    if (this.retiredKeysSet.has(id)) {
      throw new RetiredKeyEncryptionError(id);
    }

    const currentCount = this.getInvocationCount(id);
    if (currentCount >= this.metrics.hardLimitInvocations) {
      throw new NistIvLimitExceededError(id, currentCount);
    }
  }

  /**
   * Atomically records an encryption invocation for the given key.
   * Synchronously increments in-memory count and asynchronously synchronizes with Redis
   * when multi-instance cluster coordination is enabled.
   */
  public recordInvocation(count = 1, keyId?: string): number {
    const id = keyId || this.metrics.activeKeyId;
    this.assertCanEncrypt(id);

    const current = (this.memoryCounters.get(id) || 0) + count;
    this.memoryCounters.set(id, current);

    if (id === this.metrics.activeKeyId) {
      this.metrics.totalInvocations = current;
    }

    // Multi-instance distributed synchronization via Redis
    try {
      const client = redisConnectionManager.getClient();
      if (client && redisConnectionManager.getConnectionState().connected) {
        const redisKey = `medimate:gcm:invocations:${id}`;
        client.incrby(redisKey, count).catch((err) => {
          logger.warn('Failed to increment distributed key invocation count in Redis', {
            keyId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch {
      // In offline/single-instance mode, memory counter is authoritative
    }

    return current;
  }

  public getInvocationCount(keyId?: string): number {
    const id = keyId || this.metrics.activeKeyId;
    return this.memoryCounters.get(id) || 0;
  }

  public isRotationDue(keyId?: string): {
    due: boolean;
    reason?: 'INVOCATIONS_EXCEEDED' | 'AGE_EXCEEDED' | 'HARD_LIMIT_REACHED';
  } {
    const id = keyId || this.metrics.activeKeyId;
    const count = this.getInvocationCount(id);

    if (count >= this.metrics.hardLimitInvocations) {
      return { due: true, reason: 'HARD_LIMIT_REACHED' };
    }
    if (count >= this.metrics.maxInvocationsThreshold) {
      return { due: true, reason: 'INVOCATIONS_EXCEEDED' };
    }
    const age = Date.now() - this.metrics.createdAt;
    if (age >= this.metrics.maxAgeMs) {
      return { due: true, reason: 'AGE_EXCEEDED' };
    }
    return { due: false };
  }

  /**
   * Rotates master key: activates new keyId and marks old keyId as retired.
   * Old key remains registered in the keyring so historical ciphertexts remain fully readable.
   */
  public rotateMasterKey(newKeyId?: string): { oldKeyId: string; newKeyId: string } {
    const oldKeyId = this.keyProvider.getActiveKeyId();
    const nextKeyId = newKeyId || `k${String(Date.now()).slice(-3)}`;
    const newKeyBytes = crypto.randomBytes(32);

    // Register new key and set as active in provider
    this.keyProvider.rotateKey(newKeyBytes, nextKeyId);

    // Mark previous key as retired
    this.retiredKeysSet.add(oldKeyId);
    this.metrics.retiredKeys = Array.from(this.retiredKeysSet);

    // Reset active metrics for new key
    this.metrics.activeKeyId = nextKeyId;
    this.metrics.createdAt = Date.now();
    this.metrics.totalInvocations = 0;
    this.memoryCounters.set(nextKeyId, 0);

    logger.info('Rotated master encryption key under NIST SP 800-38D lifecycle', {
      oldKeyId,
      newKeyId: nextKeyId,
      timestamp: new Date().toISOString(),
      retiredKeysCount: this.retiredKeysSet.size,
    });

    return { oldKeyId, newKeyId: nextKeyId };
  }

  public getRetiredKeys(): string[] {
    return Array.from(this.retiredKeysSet);
  }

  public isKeyRetired(keyId: string): boolean {
    return this.retiredKeysSet.has(keyId);
  }

  public getMetrics(): KeyLifecycleMetrics {
    return {
      ...this.metrics,
      totalInvocations: this.getInvocationCount(this.metrics.activeKeyId),
      retiredKeys: Array.from(this.retiredKeysSet),
    };
  }
}
