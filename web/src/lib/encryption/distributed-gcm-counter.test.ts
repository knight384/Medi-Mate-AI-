import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalKeyProvider } from './key-providers';
import {
  KeyRotationService,
  DistributedAccountingUnavailableError,
  NistIvLimitExceededError,
  RetiredKeyEncryptionError,
} from './key-rotation-service';

/**
 * Mock Redis client implementing atomic INCRBY, GET, and connection state
 */
class MockDistributedRedisClient {
  public isConnected = true;
  private readonly store = new Map<string, number>();

  public async get(key: string): Promise<string | null> {
    if (!this.isConnected) {
      throw new Error('ECONNREFUSED: Redis cluster unreachable');
    }
    const val = this.store.get(key);
    return val !== undefined ? String(val) : null;
  }

  public async incrby(key: string, count: number): Promise<number> {
    if (!this.isConnected) {
      throw new Error('ECONNREFUSED: Redis cluster unreachable');
    }
    const current = this.store.get(key) || 0;
    const next = current + count;
    this.store.set(key, next);
    return next;
  }

  public set(key: string, val: number): void {
    this.store.set(key, val);
  }
}

describe('Phase 4 — Distributed GCM Invocation Accounting & Fail-Safe Fail-Closed Policies (Checkpoint 5D.26)', () => {
  let mockRedis: MockDistributedRedisClient;
  let keyProvider: LocalKeyProvider;
  let tempLedgerDir: string;
  let ledgerPath: string;

  beforeEach(async () => {
    mockRedis = new MockDistributedRedisClient();
    keyProvider = new LocalKeyProvider(crypto.randomBytes(32), 'k001');

    tempLedgerDir = path.join(os.tmpdir(), `medimate-ledger-${crypto.randomUUID()}`);
    await fsp.mkdir(tempLedgerDir, { recursive: true, mode: 0o700 });
    ledgerPath = path.join(tempLedgerDir, 'key-lifecycle.json');
  });

  afterEach(async () => {
    try {
      if (fs.existsSync(tempLedgerDir)) {
        await fsp.rm(tempLedgerDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore
    }
  });

  it('1. Coordinates atomic global increments across multiple application replicas sharing a key', async () => {
    // Replica A
    const replicaA = new KeyRotationService(keyProvider, {
      redisClient: mockRedis,
      requireDistributedAccounting: true,
      hardLimitInvocations: 1000,
    });

    // Replica B
    const replicaB = new KeyRotationService(keyProvider, {
      redisClient: mockRedis,
      requireDistributedAccounting: true,
      hardLimitInvocations: 1000,
    });

    // Both replicas concurrently record invocations
    const [countA1, countB1] = await Promise.all([
      replicaA.recordInvocationAsync(5, 'k001'),
      replicaB.recordInvocationAsync(10, 'k001'),
    ]);

    expect(countA1 + countB1).toBe(20); // 5 and 15 (5+10 in redis)
    expect(await mockRedis.get('medimate:gcm:invocations:k001')).toBe('15');

    // Replica A and Replica B both reflect shared global accounting
    await replicaA.syncFromStore('k001');
    await replicaB.syncFromStore('k001');
    expect(replicaA.getInvocationCount('k001')).toBe(15);
    expect(replicaB.getInvocationCount('k001')).toBe(15);
  });

  it('2. Fails closed on encryption writes when Redis disconnects in distributed mode', async () => {
    const service = new KeyRotationService(keyProvider, {
      redisClient: mockRedis,
      requireDistributedAccounting: true,
      hardLimitInvocations: 1000,
    });

    // Healthy write
    await service.recordInvocationAsync(10, 'k001');
    expect(service.getInvocationCount('k001')).toBe(10);

    // Redis connection outage occurs
    mockRedis.isConnected = false;

    // Encryption writes MUST fail closed to prevent untracked GCM nonce issuance
    await expect(service.recordInvocationAsync(5, 'k001')).rejects.toThrow(
      DistributedAccountingUnavailableError
    );

    // Synchronous assertCanEncrypt also blocks
    expect(() => {
      service.setRedisClient(null);
      service.assertCanEncrypt('k001');
    }).toThrow(DistributedAccountingUnavailableError);
  });

  it('3. Keeps authorized decryption available during distributed accounting outage', () => {
    const service = new KeyRotationService(keyProvider, {
      redisClient: null,
      requireDistributedAccounting: true,
    });

    // Decryption does not generate IVs; it must remain available
    expect(() => service.assertCanDecrypt('k001')).not.toThrow();
  });

  it('4. Recovers global counter across process restarts from Redis and local ledger', async () => {
    // Instance 1 runs and writes 42 invocations
    const instance1 = new KeyRotationService(keyProvider, {
      redisClient: mockRedis,
      requireDistributedAccounting: true,
      persistenceFilePath: ledgerPath,
    });
    await instance1.recordInvocationAsync(42, 'k001');

    // Instance 1 shuts down / restarts -> Instance 2 starts up
    const instance2 = new KeyRotationService(keyProvider, {
      redisClient: mockRedis,
      requireDistributedAccounting: true,
      persistenceFilePath: ledgerPath,
    });

    // Synchronous load from local ledger restored base count
    expect(instance2.getInvocationCount('k001')).toBe(42);

    // Sync from Redis recovers authoritative distributed count
    const recovered = await instance2.syncFromStore('k001');
    expect(recovered).toBe(42);
    expect(instance2.getMetrics().totalInvocations).toBe(42);
  });

  it('5. Strictly blocks replicas when the global NIST SP 800-38D hard limit is reached', async () => {
    const hardLimit = 50;

    const replicaA = new KeyRotationService(keyProvider, {
      redisClient: mockRedis,
      requireDistributedAccounting: true,
      hardLimitInvocations: hardLimit,
    });

    // Almost reach limit
    await replicaA.recordInvocationAsync(48, 'k001');

    // Replica B attempts write of 5, which would push total to 53 (> 50)
    const replicaB = new KeyRotationService(keyProvider, {
      redisClient: mockRedis,
      requireDistributedAccounting: true,
      hardLimitInvocations: hardLimit,
    });

    await expect(replicaB.recordInvocationAsync(5, 'k001')).rejects.toThrow(NistIvLimitExceededError);

    // Subsequent encryption writes on Replica A are also blocked
    await expect(replicaA.recordInvocationAsync(1, 'k001')).rejects.toThrow(NistIvLimitExceededError);
  });

  it('6. Prohibits encryption writes on retired keys while allowing decryption', async () => {
    const service = new KeyRotationService(keyProvider, {
      redisClient: mockRedis,
      requireDistributedAccounting: false,
    });

    const { oldKeyId, newKeyId } = service.rotateMasterKey('k002');
    expect(oldKeyId).toBe('k001');
    expect(newKeyId).toBe('k002');

    // Old key cannot encrypt
    expect(() => service.assertCanEncrypt('k001')).toThrow(RetiredKeyEncryptionError);

    // Old key can still decrypt historical documents
    expect(() => service.assertCanDecrypt('k001')).not.toThrow();

    // New key can encrypt
    expect(() => service.assertCanEncrypt('k002')).not.toThrow();
  });
});
