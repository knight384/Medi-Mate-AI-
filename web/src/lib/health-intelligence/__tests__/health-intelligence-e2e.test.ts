import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanionResponseGenerator } from '../response-generator';
import { HealthMemoryService } from '../memory';

vi.mock('@/lib/rag/rag-client', () => ({
  ragClient: {
    queryRAG: vi.fn().mockResolvedValue({
      query: 'blood test HbA1c',
      answer: 'HbA1c level is recorded as 5.8%.',
      summary: 'Glycated hemoglobin within pre-diabetes range.',
      citations: [
        {
          document_id: 'doc_101',
          document_name: 'Lab_Report_2026.pdf',
          page_number: 2,
          section_heading: 'Endocrinology Panel',
          chunk_id: 'chunk_1',
          excerpt: 'HbA1c: 5.8% (Normal: < 5.7%, Pre-diabetes: 5.7-6.4%)',
          relevance_score: 0.94,
        },
      ],
      sourceDocuments: ['Lab_Report_2026.pdf'],
      pageReferences: [2],
      confidenceAssessment: 'HIGH',
      missingInformation: [],
      safetyFlags: [],
      generatedAt: '2026-11-03T10:00:00Z',
    }),
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    healthData: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'hd_obs_1',
          type: 'WEARABLE_OBSERVATION',
          data: {
            id: 'obs_rhr_1',
            providerId: 'fitbit',
            metric: 'RESTING_HEART_RATE',
            value: 64,
            unit: 'bpm',
            startTime: '2026-11-02T08:00:00Z',
            endTime: '2026-11-02T08:00:00Z',
            dataQuality: 'MEASURED',
          },
          createdAt: new Date('2026-11-02T08:00:00Z'),
        },
        {
          id: 'hd_obs_2',
          type: 'WEARABLE_OBSERVATION',
          data: {
            id: 'obs_rhr_2',
            providerId: 'fitbit',
            metric: 'RESTING_HEART_RATE',
            value: 66,
            unit: 'bpm',
            startTime: '2026-11-03T08:00:00Z',
            endTime: '2026-11-03T08:00:00Z',
            dataQuality: 'MEASURED',
          },
          createdAt: new Date('2026-11-03T08:00:00Z'),
        },
      ]),
    },
    userHealthMemory: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

describe('Health Intelligence End-to-End Pipeline', () => {
  const userId = 'user_e2e_health_int_001';

  beforeEach(() => {
    HealthMemoryService._resetInMemoryStore();
  });

  it('delivers immediate emergency guidance when urgent symptoms are mentioned', async () => {
    const res = await CompanionResponseGenerator.generateCompanionResponse({
      userId,
      query: 'I feel crushing chest pain and shortness of breath',
      regionCode: 'IN',
    });

    expect(res.intent).toBe('EMERGENCY_QUERY');
    expect(res.emergencyGuidanceDelivered).toBe(true);
    expect(res.answer).toContain('112');
    expect(res.citations.documents.length).toBe(0);
    expect(res.limitations.some((l) => l.includes('cannot dispatch'))).toBe(true);
  });

  it('executes full context retrieval and generates grounded answer for lab report query', async () => {
    const res = await CompanionResponseGenerator.generateCompanionResponse({
      userId,
      query: 'Explain my latest blood test and HbA1c result',
    });

    expect(res.intent).toBe('DOCUMENT_EXPLANATION');
    expect(res.citations.documents.length).toBeGreaterThan(0);
    expect(res.citations.documents[0].documentName).toBe('Lab_Report_2026.pdf');
    expect(res.answer).toContain('Lab_Report_2026.pdf');
    expect(res.clinicalExplanations).toBeDefined();
    expect(res.clinicianDiscussionPrompts && res.clinicianDiscussionPrompts.length).toBeGreaterThan(0);
  });

  it('incorporates structured telemetry and applies non-diagnostic boundaries', async () => {
    const res = await CompanionResponseGenerator.generateCompanionResponse({
      userId,
      query: 'What are my recent wearable health readings?',
    });

    expect(res.citations.observations.length).toBeGreaterThan(0);
    expect(res.citations.observations[0].metric).toBe('RESTING_HEART_RATE');
    expect(res.limitations.length).toBeGreaterThan(0);
  });
});
