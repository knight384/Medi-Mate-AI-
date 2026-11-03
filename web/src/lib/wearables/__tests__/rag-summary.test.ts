import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WearableRAGSummaryService, RAGSummaryError } from '../rag-summary';
import { WearableConsentService } from '../consent';
import { normalizeObservation } from '../normalization';
import { ragClient } from '@/lib/rag/rag-client';
import { NormalizedObservation } from '../types';

vi.mock('@/lib/rag/rag-client', () => ({
  ragClient: {
    ingestDocument: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    healthData: {
      create: vi.fn().mockResolvedValue({ id: 'hd_summary_1' }),
    },
  },
}));

describe('Wearable RAG Summaries & Clinical Grounding (Phase 7)', () => {
  const userId = 'rag_patient_101';
  const providerId = 'fitbit';

  const mockObservations: NormalizedObservation[] = [
    normalizeObservation({
      userId,
      providerId,
      externalRecordId: 'rhr_day_1',
      metric: 'RESTING_HEART_RATE',
      rawValue: 64,
      rawUnit: 'bpm',
      startTime: '2026-11-01T04:00:00.000Z',
      deviceModel: 'Fitbit Charge 6',
    }),
    normalizeObservation({
      userId,
      providerId,
      externalRecordId: 'rhr_day_2',
      metric: 'RESTING_HEART_RATE',
      rawValue: 68,
      rawUnit: 'bpm',
      startTime: '2026-11-02T04:00:00.000Z',
      deviceModel: 'Fitbit Charge 6',
    }),
    normalizeObservation({
      userId,
      providerId,
      externalRecordId: 'steps_day_1',
      metric: 'STEPS',
      rawValue: 8500,
      rawUnit: 'count',
      startTime: '2026-11-01T08:00:00.000Z',
      deviceModel: 'Fitbit Charge 6',
    }),
    normalizeObservation({
      userId,
      providerId,
      externalRecordId: 'steps_day_2',
      metric: 'STEPS',
      rawValue: 10200,
      rawUnit: 'count',
      startTime: '2026-11-02T08:00:00.000Z',
      deviceModel: 'Fitbit Charge 6',
    }),
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    await WearableConsentService.recordConsent({
      userId,
      providerId,
      categories: ['HEART', 'ACTIVITY'],
      purpose: 'RAG summary testing',
    });
  });

  it('aggregates discrete observations into a structured WearableSummary with provenance', () => {
    const summary = WearableRAGSummaryService.buildSummary({
      userId,
      providerId,
      period: 'WEEKLY',
      startDate: new Date('2026-11-01T00:00:00.000Z'),
      endDate: new Date('2026-11-07T23:59:59.000Z'),
      observations: mockObservations,
    });

    expect(summary.period).toBe('WEEKLY');
    expect(summary.totalObservations).toBe(4);
    expect(summary.dataQuality).toBe('DERIVED');

    // Resting heart rate summary: avg (64+68)/2 = 66 bpm
    const rhrAgg = summary.metrics['RESTING_HEART_RATE'];
    expect(rhrAgg).toBeDefined();
    expect(rhrAgg.avg).toBe(66);
    expect(rhrAgg.min).toBe(64);
    expect(rhrAgg.max).toBe(68);
    expect(rhrAgg.count).toBe(2);

    // Steps summary: total 8500 + 10200 = 18700
    const stepsAgg = summary.metrics['STEPS'];
    expect(stepsAgg).toBeDefined();
    expect(stepsAgg.total).toBe(18700);
    expect(stepsAgg.avg).toBe(9350);

    // Provenance
    expect(summary.provenance.provider).toBe('fitbit');
    expect(summary.provenance.deviceModel).toBe('Fitbit Charge 6');
    expect(summary.provenance.underlyingObservationIds).toHaveLength(4);
  });

  it('formats structured markdown document with clinical provenance and non-diagnostic disclaimers', () => {
    const summary = WearableRAGSummaryService.buildSummary({
      userId,
      providerId,
      period: 'WEEKLY',
      startDate: new Date('2026-11-01T00:00:00.000Z'),
      endDate: new Date('2026-11-07T23:59:59.000Z'),
      observations: mockObservations,
    });

    const docText = WearableRAGSummaryService.formatSummaryDocument(summary);

    expect(docText).toContain('# Clinical Wearable Observation Summary: FITBIT');
    expect(docText).toContain('Total Accumulation: 18700 count');
    expect(docText).toContain('Average: 66 bpm');
    expect(docText).toContain('Notice: Wearable telemetry reflects observational consumer trends');
    expect(docText).toContain('Always consult a qualified healthcare provider');
  });

  it('publishes summary to Python RAG microservice and returns chunking response', async () => {
    vi.mocked(ragClient.ingestDocument).mockResolvedValueOnce({
      success: true,
      document_id: 'doc_123',
      file_name: 'fitbit_summary.md',
      total_pages: 1,
      total_chunks: 2,
      content_hash: 'abc',
      extraction_method: 'text_markdown_parser',
      ingested_at: new Date().toISOString(),
    });

    const summary = WearableRAGSummaryService.buildSummary({
      userId,
      providerId,
      period: 'WEEKLY',
      startDate: new Date('2026-11-01T00:00:00.000Z'),
      endDate: new Date('2026-11-07T23:59:59.000Z'),
      observations: mockObservations,
    });

    const res = await WearableRAGSummaryService.publishSummaryToRAG(summary);

    expect(res.success).toBe(true);
    expect(res.totalChunks).toBe(2);
    expect(ragClient.ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        documentId: summary.id,
      })
    );
  });

  it('fails closed when publishing to RAG if user consent is revoked', async () => {
    // Revoke consent
    await WearableConsentService.revokeConsent(userId, providerId, 'USER_REQUEST');

    const summary = WearableRAGSummaryService.buildSummary({
      userId,
      providerId,
      period: 'WEEKLY',
      startDate: new Date('2026-11-01T00:00:00.000Z'),
      endDate: new Date('2026-11-07T23:59:59.000Z'),
      observations: mockObservations,
    });

    await expect(WearableRAGSummaryService.publishSummaryToRAG(summary)).rejects.toThrow(
      RAGSummaryError
    );
    expect(ragClient.ingestDocument).not.toHaveBeenCalled();
  });
});
