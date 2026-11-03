import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '@/lib/prisma';
import { WearableDeletionService } from '../deletion';
import { WearableConsentService } from '../consent';
import { encryptOAuthToken } from '../oauth';
import { ragClient } from '@/lib/rag/rag-client';

vi.mock('@/lib/rag/rag-client', () => ({
  ragClient: {
    deleteDocumentIndex: vi.fn().mockResolvedValue({ success: true, deleted_chunks: 3 }),
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    wearableConnection: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    healthData: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

describe('Wearable Disconnection, Revocation & Deletion Lifecycle (Phase 7)', () => {
  const userId = 'del_patient_99';
  const providerId = 'fitbit';

  beforeEach(async () => {
    vi.clearAllMocks();
    await WearableConsentService.recordConsent({
      userId,
      providerId,
      categories: ['HEART', 'ACTIVITY', 'SLEEP'],
      purpose: 'Deletion testing',
    });
  });

  it('disconnects provider, revokes consent, and wipes stored credentials', async () => {
    const encryptedAccess = encryptOAuthToken({
      token: 'fitbit_access_mock_to_revoke',
      userId,
      providerId,
    });

    vi.mocked(prisma.wearableConnection.findUnique).mockResolvedValueOnce({
      userId,
      providerId,
      encryptedAccessToken: encryptedAccess,
    } as any);

    vi.mocked(prisma.wearableConnection.update).mockResolvedValueOnce({} as any);

    const res = await WearableDeletionService.disconnectProvider(userId, providerId);

    expect(res.success).toBe(true);
    expect(res.tokenRevoked).toBe(true);

    // Verify consent is revoked
    const consent = await WearableConsentService.getActiveConsent(userId, providerId);
    expect(consent).toBeNull();

    // Verify tokens were wiped in database
    expect(prisma.wearableConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DISCONNECTED',
          encryptedAccessToken: '',
          encryptedRefreshToken: null,
        }),
      })
    );
  });

  it('executes complete data deletion: purges observations and deletes RAG index summaries', async () => {
    const encryptedAccess = encryptOAuthToken({
      token: 'fitbit_access_mock_purge',
      userId,
      providerId,
    });

    vi.mocked(prisma.wearableConnection.findUnique).mockResolvedValueOnce({
      userId,
      providerId,
      encryptedAccessToken: encryptedAccess,
    } as any);

    // Mock 5 observations and 1 summary found in DB
    vi.mocked(prisma.healthData.findMany)
      .mockResolvedValueOnce([
        { id: 'obs_1' },
        { id: 'obs_2' },
        { id: 'obs_3' },
        { id: 'obs_4' },
        { id: 'obs_5' },
      ] as any)
      .mockResolvedValueOnce([
        {
          id: 'summary_1',
          metadata: { ragDocumentId: 'wearable_summary_doc_1' },
        },
      ] as any);

    vi.mocked(prisma.healthData.deleteMany).mockResolvedValue({ count: 5 } as any);

    const purgeResult = await WearableDeletionService.deleteProviderHealthData(
      userId,
      providerId
    );

    expect(purgeResult.observationsDeleted).toBe(5);
    expect(purgeResult.summariesDeleted).toBe(1);
    expect(purgeResult.ragChunksPurged).toBe(3);
    expect(purgeResult.consentRevoked).toBe(true);

    // Verify RAG client delete called for the summary
    expect(ragClient.deleteDocumentIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        documentId: 'wearable_summary_doc_1',
      })
    );
  });
});
