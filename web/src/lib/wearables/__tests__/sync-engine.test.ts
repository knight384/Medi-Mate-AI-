import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '@/lib/prisma';
import { WearableSyncEngine, SyncEngineError } from '../sync';
import { WearableConsentService } from '../consent';
import { encryptOAuthToken } from '../oauth';

vi.mock('@/lib/prisma', () => {
  return {
    default: {
      wearableConnection: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      healthData: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    },
  };
});

describe('Wearable Synchronization Engine & Cursors (Phase 7)', () => {
  const userId = 'sync_user_42';
  const providerId = 'fitbit';

  beforeEach(async () => {
    vi.clearAllMocks();
    await WearableConsentService.recordConsent({
      userId,
      providerId,
      categories: ['HEART', 'ACTIVITY', 'SLEEP'],
      purpose: 'Sync testing',
    });
  });

  it('fails closed if provider connection does not exist', async () => {
    vi.mocked(prisma.wearableConnection.findUnique).mockResolvedValueOnce(null);

    await expect(
      WearableSyncEngine.syncUserProvider({
        userId,
        providerId,
      })
    ).rejects.toThrow(SyncEngineError);
  });

  it('fails closed if provider connection is in DISCONNECTED state', async () => {
    vi.mocked(prisma.wearableConnection.findUnique).mockResolvedValueOnce({
      userId,
      providerId,
      status: 'DISCONNECTED',
      encryptedAccessToken: 'token',
    } as any);

    await expect(
      WearableSyncEngine.syncUserProvider({
        userId,
        providerId,
      })
    ).rejects.toThrow(SyncEngineError);
  });

  it('executes synchronization cycle, persists new observations, and advances sync cursor', async () => {
    const encryptedAccess = encryptOAuthToken({
      token: 'fitbit_access_mock_valid',
      userId,
      providerId,
    });

    vi.mocked(prisma.wearableConnection.findUnique).mockResolvedValueOnce({
      userId,
      providerId,
      status: 'CONNECTED',
      encryptedAccessToken: encryptedAccess,
      encryptedRefreshToken: null,
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastSyncAt: null,
      syncCursor: null,
    } as any);

    // No duplicates exist
    vi.mocked(prisma.healthData.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.healthData.create).mockResolvedValue({ id: 'hd_1' } as any);
    vi.mocked(prisma.wearableConnection.update).mockResolvedValue({} as any);

    const result = await WearableSyncEngine.syncUserProvider({
      userId,
      providerId,
      mode: 'HISTORICAL',
      lookbackDays: 3,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.recordsIngested).toBeGreaterThan(0);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.nextCursor).toBeDefined();

    // Verify connection update called
    expect(prisma.wearableConnection.update).toHaveBeenCalled();
  });

  it('skips duplicate observations when deduplication hash matches existing record', async () => {
    const encryptedAccess = encryptOAuthToken({
      token: 'fitbit_access_mock_valid',
      userId,
      providerId,
    });

    vi.mocked(prisma.wearableConnection.findUnique).mockResolvedValueOnce({
      userId,
      providerId,
      status: 'CONNECTED',
      encryptedAccessToken: encryptedAccess,
      encryptedRefreshToken: null,
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastSyncAt: new Date(),
      syncCursor: 'cursor_123',
    } as any);

    // Simulate all observations already exist in DB
    vi.mocked(prisma.healthData.findFirst).mockResolvedValue({ id: 'existing_hd' } as any);
    vi.mocked(prisma.wearableConnection.update).mockResolvedValue({} as any);

    const result = await WearableSyncEngine.syncUserProvider({
      userId,
      providerId,
      mode: 'INCREMENTAL',
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.recordsIngested).toBe(0);
    expect(result.duplicatesSkipped).toBeGreaterThan(0);
  });
});
