import { LocalKeyProvider } from './key-providers';
import { logger } from '@/lib/logger';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
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

export class DistributedAccountingUnavailableError extends Error {
  public readonly code = 'DISTRIBUTED_ACCOUNTING_UNAVAILABLE';
  constructor(message = 'Encryption write blocked: Reliable distributed GCM invocation accounting is unavailable.') {
    super(message);
    this.name = 'DistributedAccountingUnavailableError';
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
  requireDistributedAccounting?: boolean;
  persistenceFilePath?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redisClient?: any;
}

/**
 * Key Rotation & Lifecycle Service
 *
 * Implements global GCM invocation tracking and rotation bounds aligned with NIST SP 800-38D Section 8.3.
 * Supports cross-instance counter aggregation via Redis and local ledger persistence across restarts.
 * Fails closed on encryption writes when reliable distributed accounting cannot be guaranteed.
 */
export class KeyRotationService {
  private readonly metrics: KeyLifecycleMetrics;
  private readonly keyProvider: LocalKeyProvider;
  private readonly retiredKeysSet = new Set<string>();
  private readonly memoryCounters = new Map<string, number>();
  private readonly requireDistributedAccounting: boolean;
  private readonly persistenceFilePath?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private injectedRedisClient?: any;

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

    this.requireDistributedAccounting = Boolean(options?.requireDistributedAccounting);
    this.persistenceFilePath = options?.persistenceFilePath;
    this.injectedRedisClient = options?.redisClient;

    this.memoryCounters.set(activeKeyId, 0);

    // If local persistence file exists, synchronously attempt load
    if (this.persistenceFilePath && fs.existsSync(this.persistenceFilePath)) {
      try {
        const raw = fs.readFileSync(this.persistenceFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.counters && typeof parsed.counters === 'object') {
          for (const [k, v] of Object.entries(parsed.counters)) {
            if (typeof v === 'number') {
              this.memoryCounters.set(k, v);
            }
          }
        }
        if (typeof parsed.activeKeyId === 'string' && parsed.activeKeyId === activeKeyId) {
          this.metrics.totalInvocations = this.memoryCounters.get(activeKeyId) || 0;
        }
      } catch (err) {
        logger.warn('Failed reading local key lifecycle ledger file', {
          path: this.persistenceFilePath,
          error: String(err),
        });
      }
    }
  }

  /**
   * For tests or runtime configuration
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public setRedisClient(client: any): void {
    this.injectedRedisClient = client;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRedisClient(): any | undefined {
    if (this.injectedRedisClient) return this.injectedRedisClient;
    try {
      const conn = redisConnectionManager;
      if (conn.getConnectionState().connected) {
        return conn.getClient();
      }
    } catch {
      // Redis manager unavailable
    }
    return undefined;
  }

  /**
   * Recovers/synchronizes invocation counters from Redis or durable storage.
   * Call on instance startup to ensure counts survive restarts.
   */
  public async syncFromStore(keyId?: string): Promise<number> {
    const id = keyId || this.metrics.activeKeyId;
    const client = this.getRedisClient();

    if (client) {
      try {
        const redisKey = `medimate:gcm:invocations:${id}`;
        const val = await client.get(redisKey);
        if (val !== null && val !== undefined) {
          const num = parseInt(String(val), 10);
          if (!isNaN(num)) {
            this.memoryCounters.set(id, Math.max(num, this.memoryCounters.get(id) || 0));
            if (id === this.metrics.activeKeyId) {
              this.metrics.totalInvocations = this.memoryCounters.get(id) || 0;
            }
            return this.memoryCounters.get(id)!;
          }
        }
      } catch (err) {
        logger.warn('Failed syncing key invocations from Redis', {
          keyId: id,
          error: String(err),
        });
        if (this.requireDistributedAccounting) {
          throw new DistributedAccountingUnavailableError(
            `Unable to sync GCM invocation count from Redis for key ${id}: ${String(err)}`
          );
        }
      }
    }

    return this.getInvocationCount(id);
  }

  /**
   * Asserts that a key is permitted for NEW encryption operations.
   * Throws RetiredKeyEncryptionError if the key has been retired.
   * Throws NistIvLimitExceededError if the key has reached the 2^32 NIST boundary.
   * Throws DistributedAccountingUnavailableError if distributed accounting is required but unavailable.
   */
  public assertCanEncrypt(keyId?: string): void {
    const id = keyId || this.metrics.activeKeyId;
    if (this.retiredKeysSet.has(id)) {
      throw new RetiredKeyEncryptionError(id);
    }

    if (this.requireDistributedAccounting) {
      const client = this.getRedisClient();
      if (!client) {
        throw new DistributedAccountingUnavailableError(
          `Encryption write blocked: Distributed accounting is required but Redis is offline/unreachable.`
        );
      }
    }

    const currentCount = this.getInvocationCount(id);
    if (currentCount >= this.metrics.hardLimitInvocations) {
      throw new NistIvLimitExceededError(id, currentCount);
    }
  }

  /**
   * Asserts that a key is permitted for DECRYPTION operations.
   * Decryption never fails due to retired status or accounting offline.
   */
  public assertCanDecrypt(keyId?: string): void {
    const id = keyId || this.metrics.activeKeyId;
    // Decryption does not generate IVs, so even retired or uncounted keys may decrypt
    logger.debug('Key permitted for decryption', { keyId: id });
  }

  /**
   * Asynchronously and atomically records an encryption invocation.
   * In distributed mode, coordinates with Redis atomically before returning.
   */
  public async recordInvocationAsync(count = 1, keyId?: string): Promise<number> {
    const id = keyId || this.metrics.activeKeyId;
    this.assertCanEncrypt(id);

    const client = this.getRedisClient();
    if (client) {
      try {
        const redisKey = `medimate:gcm:invocations:${id}`;
        const newCount = await client.incrby(redisKey, count);
        this.memoryCounters.set(id, newCount);

        if (id === this.metrics.activeKeyId) {
          this.metrics.totalInvocations = newCount;
        }

        if (newCount > this.metrics.hardLimitInvocations) {
          throw new NistIvLimitExceededError(id, newCount);
        }

        await this.persistLocalLedger();
        return newCount;
      } catch (err) {
        if (err instanceof NistIvLimitExceededError) {
          throw err;
        }
        if (this.requireDistributedAccounting) {
          throw new DistributedAccountingUnavailableError(
            `Encryption write blocked: Redis invocation increment failed: ${String(err)}`
          );
        }
      }
    } else if (this.requireDistributedAccounting) {
      throw new DistributedAccountingUnavailableError(
        'Encryption write blocked: Distributed accounting required but no Redis client is available.'
      );
    }

    // Local / single-instance accounting
    return this.recordInvocation(count, id);
  }

  /**
   * Atomically records an encryption invocation for the given key synchronously.
   */
  public recordInvocation(count = 1, keyId?: string): number {
    const id = keyId || this.metrics.activeKeyId;
    this.assertCanEncrypt(id);

    const current = (this.memoryCounters.get(id) || 0) + count;
    this.memoryCounters.set(id, current);

    if (id === this.metrics.activeKeyId) {
      this.metrics.totalInvocations = current;
    }

    if (current > this.metrics.hardLimitInvocations) {
      throw new NistIvLimitExceededError(id, current);
    }

    // Trigger async sync to Redis and local ledger in background
    const client = this.getRedisClient();
    if (client) {
      const redisKey = `medimate:gcm:invocations:${id}`;
      client.incrby(redisKey, count).catch((err: unknown) => {
        logger.warn('Failed to increment distributed key invocation count in Redis', {
          keyId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    this.persistLocalLedger().catch(() => {});

    return current;
  }

  private async persistLocalLedger(): Promise<void> {
    if (!this.persistenceFilePath) return;
    try {
      const dir = path.dirname(this.persistenceFilePath);
      if (!fs.existsSync(dir)) {
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      }
      const data = {
        updatedAt: new Date().toISOString(),
        activeKeyId: this.metrics.activeKeyId,
        counters: Object.fromEntries(this.memoryCounters.entries()),
        retiredKeys: Array.from(this.retiredKeysSet),
      };
      await fsp.writeFile(this.persistenceFilePath, JSON.stringify(data, null, 2), {
        mode: 0o600,
      });
    } catch {
      // Non-fatal for ephemeral ledger writes
    }
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

    this.persistLocalLedger().catch(() => {});

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

  /**
   * Generates a sanitized audit report for security compliance without exposing key material.
   */
  public generateAuditableReport() {
    const totalInvocations = this.getInvocationCount(this.metrics.activeKeyId);
    const rotationCheck = this.isRotationDue();
    return {
      activeKeyId: this.metrics.activeKeyId,
      createdAt: new Date(this.metrics.createdAt).toISOString(),
      ageDays: Math.floor((Date.now() - this.metrics.createdAt) / (24 * 60 * 60 * 1000)),
      totalInvocations,
      maxInvocationsThreshold: this.metrics.maxInvocationsThreshold,
      hardLimitInvocations: this.metrics.hardLimitInvocations,
      remainingUntilOperationalThreshold: Math.max(0, this.metrics.maxInvocationsThreshold - totalInvocations),
      remainingUntilNistHardLimit: Math.max(0, this.metrics.hardLimitInvocations - totalInvocations),
      retiredKeysCount: this.retiredKeysSet.size,
      retiredKeys: Array.from(this.retiredKeysSet),
      distributedAccountingEnforced: this.requireDistributedAccounting,
      isRotationRequired: rotationCheck.due,
      rotationReason: rotationCheck.reason,
    };
  }
}
