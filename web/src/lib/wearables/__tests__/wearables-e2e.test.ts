import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '@/lib/prisma';
import { getWearableConnector, listSupportedProviders } from '../registry';
import { generateOAuthState, consumeOAuthState, encryptOAuthToken } from '../oauth';
import { WearableConsentService } from '../consent';
import { WearableSyncEngine } from '../sync';
import { WearableRAGSummaryService } from '../rag-summary';
import { WearableDeletionService } from '../deletion';
import { ragClient } from '@/lib/rag/rag-client';
import { WearableSummary } from '../types';

vi.mock('@/lib/rag/rag-client', () => ({
  ragClient: {
    ingestDocument: vi.fn().mockResolvedValue({
      success: true,
      document_id: 'rag_wearable_summary_e2e_doc',
      total_chunks: 3,
    }),
    deleteDocumentIndex: vi.fn().mockResolvedValue({
      success: true,
      deleted_chunks: 3,
    }),
  },
}));

vi.mock('@/lib/prisma', () => {
  return {
    default: {
      wearableConnection: {
        findUnique: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      },
      wearableConsent: {
        findUnique: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      },
      healthData: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn(),
      },
    },
  };
});

describe('MediMate AI Phase 7 — Wearable End-to-End Workflow & Provenance Test', () => {
  const userId = 'synthetic_e2e_patient_01';
  const providerId = 'fitbit';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes complete 15-step wearable lifecycle from connection to deletion', async () => {
    // -------------------------------------------------------------
    // Step 1: Discover supported providers and check capabilities
    // -------------------------------------------------------------
    const providers = listSupportedProviders();
    expect(providers.length).toBeGreaterThanOrEqual(5);

    const fitbitCap = providers.find((p) => p.providerId === 'fitbit');
    expect(fitbitCap).toBeDefined();
    expect(fitbitCap?.platform).toBe('CLOUD_API');

    // -------------------------------------------------------------
    // Step 2 & 3: Connect provider and grant granular category consent
    // -------------------------------------------------------------
    const connector = getWearableConnector(providerId);

    const state = generateOAuthState({
      userId,
      providerId,
      redirectUri: 'https://medimate.example.com/api/wearables/callback',
      codeVerifier: 'e2e_code_verifier_123',
    });

    const authUrl = await connector.getAuthorizationUrl({
      state,
      categories: ['HEART', 'ACTIVITY', 'SLEEP'],
      redirectUri: 'https://medimate.example.com/api/wearables/callback',
    });

    expect(authUrl).toContain('client_id');
    expect(authUrl).toContain('state');

    // Grant granular consent
    const consent = await WearableConsentService.recordConsent({
      userId,
      providerId,
      categories: ['HEART', 'ACTIVITY', 'SLEEP'],
      purpose: 'Cardiovascular and sleep wellness tracking',
    });

    expect(consent.status).toBe('ACTIVE');
    expect(consent.categories).toContain('HEART');
    expect(consent.categories).toContain('ACTIVITY');
    expect(consent.categories).toContain('SLEEP');

    // -------------------------------------------------------------
    // Step 4: OAuth code exchange & Token encryption at rest
    // -------------------------------------------------------------
    const stateMeta = consumeOAuthState(state, userId, providerId);
    expect(stateMeta.userId).toBe(userId);

    const tokenResult = await connector.exchangeCode({
      code: 'mock_code_e2e',
      codeVerifier: stateMeta.codeVerifier,
      redirectUri: stateMeta.redirectUri,
    });

    const encryptedAccess = encryptOAuthToken({
      token: tokenResult.accessToken,
      userId,
      providerId,
    });

    expect(encryptedAccess).toMatch(/^v2:/);

    // Mock connection lookup
    vi.mocked(prisma.wearableConnection.findUnique).mockResolvedValue({
      userId,
      providerId,
      status: 'CONNECTED',
      encryptedAccessToken: encryptedAccess,
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastSyncAt: null,
      syncCursor: null,
    } as any);

    // -------------------------------------------------------------
    // Step 5, 6, 7 & 8: Historical synchronization and normalization
    // -------------------------------------------------------------
    vi.mocked(prisma.healthData.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.healthData.create).mockResolvedValue({ id: 'hd_e2e_obs_1' } as any);
    vi.mocked(prisma.wearableConnection.update).mockResolvedValue({} as any);

    const syncResult = await WearableSyncEngine.syncUserProvider({
      userId,
      providerId,
      mode: 'HISTORICAL',
      lookbackDays: 7,
    });

    expect(syncResult.status).toBe('SUCCESS');
    expect(syncResult.recordsIngested).toBeGreaterThan(0);
    expect(syncResult.duplicatesSkipped).toBe(0);

    // -------------------------------------------------------------
    // Step 9 & 10: Build WearableSummary with full clinical provenance
    // -------------------------------------------------------------
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

    const syntheticObs = await connector.fetchHistoricalData(userId, {
      accessToken: tokenResult.accessToken,
      startDate: sevenDaysAgo,
      endDate: now,
      categories: ['HEART', 'ACTIVITY', 'SLEEP'],
    });

    const summary: WearableSummary = WearableRAGSummaryService.buildSummary({
      userId,
      providerId,
      period: 'WEEKLY',
      startDate: sevenDaysAgo,
      endDate: now,
      observations: syntheticObs,
    });

    expect(summary.period).toBe('WEEKLY');
    expect(summary.metrics['RESTING_HEART_RATE']).toBeDefined();
    expect(summary.metrics['STEPS']).toBeDefined();
    expect(summary.provenance.provider).toBe('fitbit');
    expect(summary.provenance.underlyingObservationIds.length).toBeGreaterThan(0);

    // -------------------------------------------------------------
    // Step 11: Publish Summary to RAG microservice with guardrails
    // -------------------------------------------------------------
    const ragResult = await WearableRAGSummaryService.publishSummaryToRAG(summary);
    expect(ragResult.success).toBe(true);
    expect(ragResult.totalChunks).toBe(3);

    // Formatted document must include non-diagnostic clinical safeguard
    const docText = WearableRAGSummaryService.formatSummaryDocument(summary);
    expect(docText).toContain('Notice: Wearable telemetry reflects observational consumer trends');
    expect(docText).toContain('Always consult a qualified healthcare provider');

    // -------------------------------------------------------------
    // Step 12 & 13: Revoke consent & verify synchronization stops
    // -------------------------------------------------------------
    await WearableConsentService.revokeConsent(userId, providerId, 'PATIENT_REQUEST');

    // Future sync must fail closed immediately
    await expect(
      WearableSyncEngine.syncUserProvider({
        userId,
        providerId,
        mode: 'INCREMENTAL',
      })
    ).rejects.toThrow();

    // -------------------------------------------------------------
    // Step 14 & 15: Delete synchronized records & purge RAG index
    // -------------------------------------------------------------
    vi.mocked(prisma.healthData.findMany)
      .mockResolvedValueOnce([{ id: 'hd_e2e_1' }, { id: 'hd_e2e_2' }] as any) // observations
      .mockResolvedValueOnce([
        { id: 'hd_e2e_sum_1', metadata: { ragDocumentId: summary.id } },
      ] as any); // summaries

    vi.mocked(prisma.healthData.deleteMany).mockResolvedValue({ count: 2 } as any);

    const deletionResult = await WearableDeletionService.deleteProviderHealthData(
      userId,
      providerId
    );

    expect(deletionResult.observationsDeleted).toBe(2);
    expect(deletionResult.summariesDeleted).toBe(1);
    expect(deletionResult.ragChunksPurged).toBe(3);
    expect(deletionResult.consentRevoked).toBe(true);

    expect(ragClient.deleteDocumentIndex).toHaveBeenCalledWith({
      userId,
      documentId: summary.id,
    });
  });
});
