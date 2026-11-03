import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { HealthContextEngine } from '@/lib/health-intelligence/context-engine';
import { CompanionResponseGenerator } from '@/lib/health-intelligence/response-generator';
import { HealthMemoryService } from '@/lib/health-intelligence/memory';
import { HealthAlertService } from '@/lib/health-intelligence/alerts/alert-service';
import { LongitudinalHealthService } from '@/lib/health-intelligence/longitudinal';
import { WearableConsentService } from '@/lib/wearables/consent';
import { WearableDeletionService } from '@/lib/wearables/deletion';
import { ragClient } from '@/lib/rag/rag-client';
import prisma from '@/lib/prisma';
import { NormalizedObservation } from '@/lib/wearables/types';

// Mock RAG client for deterministic synthetic document evidence
vi.mock('@/lib/rag/rag-client', () => ({
  ragClient: {
    queryRAG: vi.fn().mockImplementation(async (params: { query: string }) => {
      if (params.query.includes('HbA1c') || params.query.includes('blood test') || params.query.includes('lab')) {
        return {
          query: params.query,
          answer: 'Your latest blood test shows an HbA1c level of 5.8%, which falls in the pre-diabetes reference range (5.7% - 6.4%).',
          summary: 'Endocrinology report indicates mildly elevated glycated hemoglobin.',
          citations: [
            {
              document_id: 'doc_synthetic_lab_001',
              document_name: 'Synthetic_Metabolic_Panel_2026.pdf',
              page_number: 1,
              section_heading: 'Comprehensive Metabolic & Glycemic Panel',
              chunk_id: 'chunk_hba1c_01',
              excerpt: 'HbA1c (Glycated Hemoglobin): 5.8% [Reference Range: Normal < 5.7%, Pre-diabetes 5.7 - 6.4%, Diabetes >= 6.5%]',
              relevance_score: 0.96,
            },
          ],
          sourceDocuments: ['Synthetic_Metabolic_Panel_2026.pdf'],
          pageReferences: [1],
          confidenceAssessment: 'HIGH',
          missingInformation: [],
          safetyFlags: [],
          generatedAt: '2026-11-03T09:00:00Z',
        };
      }

      if (params.query.includes('unrecorded') || params.query.includes('genetic')) {
        return {
          query: params.query,
          answer: '',
          summary: '',
          citations: [],
          sourceDocuments: [],
          pageReferences: [],
          confidenceAssessment: 'NONE',
          missingInformation: ['No genetic sequencing or DNA reports uploaded.'],
          safetyFlags: [],
          generatedAt: '2026-11-03T09:00:00Z',
        };
      }

      return {
        query: params.query,
        answer: 'Clinical records inspected.',
        summary: 'General medical documentation.',
        citations: [],
        sourceDocuments: [],
        pageReferences: [],
        confidenceAssessment: 'MEDIUM',
        missingInformation: [],
        safetyFlags: [],
        generatedAt: '2026-11-03T09:00:00Z',
      };
    }),
    ingestDocument: vi.fn().mockResolvedValue({
      success: true,
      document_id: 'doc_synthetic_lab_001',
      file_name: 'Synthetic_Metabolic_Panel_2026.pdf',
      total_pages: 1,
      total_chunks: 3,
      content_hash: 'hash_abc123',
      extraction_method: 'pdf_text_parser',
      ingested_at: '2026-11-03T09:00:00Z',
    }),
    deleteDocumentIndex: vi.fn().mockResolvedValue({
      success: true,
      deleted_chunks: 3,
    }),
  },
}));

function makeObs(partial: Partial<NormalizedObservation> & { metric: NormalizedObservation['metric']; value: number; startTime: string }): NormalizedObservation {
  return {
    id: partial.id || `obs_${Math.random().toString(36).substring(2, 9)}`,
    userId: partial.userId || 'user_journey_patient_01',
    providerId: partial.providerId || 'fitbit',
    externalRecordId: partial.externalRecordId || `ext_${Math.random()}`,
    metric: partial.metric,
    category: partial.category || 'HEART',
    value: partial.value,
    unit: partial.unit || 'bpm',
    startTime: partial.startTime,
    endTime: partial.endTime || partial.startTime,
    dataQuality: partial.dataQuality || 'MEASURED',
    syncedAt: new Date().toISOString(),
  };
}

describe('MediMate AI Phase 9 — Complete User-Journey Integration Suite', () => {
  const userId = 'user_journey_patient_01';
  const tenantId = 'tenant_primary_hospital';

  beforeAll(async () => {
    if (process.env.DATABASE_URL) {
      await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: {
          id: userId,
          username: userId,
          password: 'hashed_password_phase9',
        },
      }).catch(() => {});
    }
  });

  beforeEach(() => {
    HealthMemoryService._resetInMemoryStore();
    HealthAlertService._resetInMemoryStore();
    WearableConsentService._resetInMemoryCache();
  });

  // Scenario A — New User & Default-Deny Privacy Preferences
  it('Scenario A: verifies new user onboarding and default-deny cloud processing consent', async () => {
    const consent = await WearableConsentService.getActiveConsent(userId, 'fitbit');
    expect(consent).toBeNull(); // Default-deny: no unauthorized connections exist

    // Save initial privacy preferences into user-controlled memory
    const pref = await HealthMemoryService.recordMemory({
      userId,
      category: 'PREFERENCE',
      key: 'cloud_data_egress',
      content: 'STRICT_LOCAL_ONLY',
    });

    expect(pref.key).toBe('cloud_data_egress');
    expect(pref.content).toBe('STRICT_LOCAL_ONLY');

    const activeMemories = await HealthMemoryService.getActiveMemories(userId, 'PREFERENCE');
    expect(activeMemories.length).toBe(1);
    expect(activeMemories[0].content).toBe('STRICT_LOCAL_ONLY');
  });

  // Scenario B — Medical Document Processing & RAG Ingestion
  it('Scenario B: ingests synthetic laboratory document and verifies vector citation extraction', async () => {
    const ingestRes = await ragClient.ingestDocument({
      userId,
      tenantId,
      documentId: 'doc_synthetic_lab_001',
      fileName: 'Synthetic_Metabolic_Panel_2026.pdf',
      fileBuffer: Buffer.from('%PDF-1.4 synthetic clinical document buffer'),
    });

    expect(ingestRes.success).toBe(true);
    expect(ingestRes.total_chunks).toBe(3);

    // Query RAG for extracted biomarker
    const queryRes = await ragClient.queryRAG({
      userId,
      tenantId,
      query: 'What was the recorded HbA1c result?',
    });

    expect(queryRes.citations.length).toBeGreaterThan(0);
    expect(queryRes.citations[0].document_name).toBe('Synthetic_Metabolic_Panel_2026.pdf');
    expect(queryRes.citations[0].excerpt).toContain('HbA1c');
    expect(queryRes.citations[0].page_number).toBe(1);
  });

  // Scenario C — Conversational Health Companion
  it('Scenario C: answers lab report questions grounded in evidence and abstains when info is missing', async () => {
    // 1. Question grounded in available report
    const responseGrounded = await CompanionResponseGenerator.generateCompanionResponse({
      userId,
      query: 'Explain my latest HbA1c blood test result and reference range',
    });

    expect(responseGrounded.intent).toBe('DOCUMENT_EXPLANATION');
    expect(responseGrounded.citations.documents.length).toBeGreaterThan(0);
    expect(responseGrounded.citations.documents[0].documentName).toBe('Synthetic_Metabolic_Panel_2026.pdf');
    expect(responseGrounded.clinicianDiscussionPrompts?.length).toBeGreaterThan(0);

    // 2. Question absent from records -> honest abstention
    const responseAbsent = await CompanionResponseGenerator.generateCompanionResponse({
      userId,
      query: 'What are my unrecorded genetic DNA sequencing findings?',
    });

    expect(responseAbsent.answer).toContain('do not have access to any recorded measurements');
  });

  // Scenario D — Wearable Integration & Continuous Telemetry
  it('Scenario D: grants wearable category consent, synchronizes telemetry, and calculates longitudinal trends', async () => {
    // 1. Grant consent for HEART and SLEEP
    await WearableConsentService.recordConsent({
      userId,
      providerId: 'fitbit',
      categories: ['HEART', 'SLEEP'],
      purpose: 'Cardiovascular tracking',
    });

    const activeConsent = await WearableConsentService.getActiveConsent(userId, 'fitbit');
    expect(activeConsent).not.toBeNull();
    expect(activeConsent?.categories).toContain('HEART');
    expect(activeConsent?.categories).toContain('SLEEP');
    expect(activeConsent?.categories).not.toContain('ACTIVITY'); // Unconsented

    // 2. Synthetic telemetry observations
    const observations: NormalizedObservation[] = [
      makeObs({ metric: 'RESTING_HEART_RATE', value: 65, startTime: '2026-10-02T08:00:00Z' }),
      makeObs({ metric: 'RESTING_HEART_RATE', value: 66, startTime: '2026-10-04T08:00:00Z' }),
      makeObs({ metric: 'RESTING_HEART_RATE', value: 64, startTime: '2026-10-06T08:00:00Z' }),
      makeObs({ metric: 'RESTING_HEART_RATE', value: 72, startTime: '2026-10-09T08:00:00Z' }),
      makeObs({ metric: 'RESTING_HEART_RATE', value: 73, startTime: '2026-10-11T08:00:00Z' }),
      makeObs({ metric: 'RESTING_HEART_RATE', value: 74, startTime: '2026-10-13T08:00:00Z' }),
    ];

    const periodA = { label: 'Week 1', startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-07T23:59:59Z') };
    const periodB = { label: 'Week 2', startDate: new Date('2026-10-08T00:00:00Z'), endDate: new Date('2026-10-14T23:59:59Z') };

    const comp = LongitudinalHealthService.comparePeriods({
      metric: 'RESTING_HEART_RATE',
      periodA,
      periodB,
      observations,
    });

    expect(comp.periodA.avg).toBe(65);
    expect(comp.periodB.avg).toBe(73);
    expect(comp.delta.direction).toBe('INCREASE');
    expect(comp.delta.isMeaningfulChange).toBe(true);
    expect(comp.nonDiagnosticDisclaimer).toContain('observational trends');
  });

  // Scenario E — Unified Multi-Modal Health Intelligence
  it('Scenario E: combines medical records, wearable trends, and user goals into a cohesive response', async () => {
    // Record user goal
    await HealthMemoryService.recordMemory({
      userId,
      category: 'GOAL',
      key: 'rhr_target',
      content: 'Maintain resting heart rate below 70 bpm through consistent aerobic exercise',
    });

    const ctx = await HealthContextEngine.aggregateContext(userId, {
      query: 'Compare my recent heart rate observations and blood test results with my health goals',
      includeRag: true,
    });

    expect(ctx.userGoalsAndPreferences.goals.length).toBeGreaterThan(0);
    expect(ctx.userGoalsAndPreferences.goals[0]).toContain('resting heart rate');

    const promptText = HealthContextEngine.formatForPrompt(ctx);
    expect(promptText).toContain('User-Confirmed Health Goals');
    expect(promptText).toContain('resting heart rate');
  });

  // Scenario F — User Memory Lifecycle
  it('Scenario F: executes complete user memory lifecycle (add, pause, resume, delete)', async () => {
    const item = await HealthMemoryService.recordMemory({
      userId,
      category: 'TOPIC',
      key: 'monitored_symptom',
      content: 'Mild post-exercise knee soreness discussed in previous session',
    });

    // 1. Pause memory
    await HealthMemoryService.togglePauseMemory(userId, item.id, true);
    let active = (await HealthMemoryService.getActiveMemories(userId)).filter((m) => m.id === item.id);
    expect(active.length).toBe(0);

    // 2. Resume memory
    await HealthMemoryService.togglePauseMemory(userId, item.id, false);
    active = (await HealthMemoryService.getActiveMemories(userId)).filter((m) => m.id === item.id);
    expect(active.length).toBe(1);

    // 3. Delete memory
    const deleted = await HealthMemoryService.deleteMemory(userId, item.id);
    expect(deleted).toBe(true);
    active = (await HealthMemoryService.getActiveMemories(userId)).filter((m) => m.id === item.id);
    expect(active.length).toBe(0);
  });

  // Scenario G — Reminders, Quiet Hours & Cooldown
  it('Scenario G: validates opt-in reminders, quiet hours, and 24-hour alert cooldown', async () => {
    // Quiet hours
    HealthAlertService.updateAlertPreferences(userId, {
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      cooldownHours: 24,
    });

    expect(HealthAlertService.isInQuietHours(userId, new Date('2026-11-03T23:30:00'))).toBe(true);
    expect(HealthAlertService.isInQuietHours(userId, new Date('2026-11-03T14:00:00'))).toBe(false);

    // Cooldown
    const topic = 'RESTING_HR_ELEVATION_NOTE';
    const now = new Date('2026-11-03T10:00:00Z');
    expect(HealthAlertService.isAlertInCooldown(userId, topic, now)).toBe(false);

    HealthAlertService.recordAlertTriggered(userId, topic, now);
    expect(HealthAlertService.isAlertInCooldown(userId, topic, new Date('2026-11-03T12:00:00Z'))).toBe(true);
  });

  // Scenario H — Complete Cascading Deletion
  it('Scenario H: purges wearable telemetry, revokes consent, and purges RAG vector chunks', async () => {
    // Mock prisma summary records to verify cascading RAG index purge
    vi.spyOn(prisma.healthData, 'findMany')
      .mockResolvedValueOnce([]) // for obsRecords
      .mockResolvedValueOnce([
        {
          id: 'summary_synthetic_01',
          authorId: userId,
          type: 'WEARABLE_SUMMARY',
          metadata: { providerId: 'fitbit', ragDocumentId: 'rag_summary_fitbit_week1' },
          createdAt: new Date(),
          updatedAt: new Date(),
          data: {},
        } as any,
      ]);
    vi.spyOn(prisma.healthData, 'deleteMany').mockResolvedValue({ count: 1 });
    vi.spyOn(prisma.wearableConnection, 'update').mockResolvedValue({} as any);

    const purgeResult = await WearableDeletionService.purgeAllWearableData({
      userId,
      tenantId,
      providerId: 'fitbit',
    });

    expect(purgeResult.success).toBe(true);
    expect(purgeResult.providerId).toBe('fitbit');
    expect(ragClient.deleteDocumentIndex).toHaveBeenCalledWith({
      userId,
      documentId: 'rag_summary_fitbit_week1',
    });

    // Verify consent revoked
    const consent = await WearableConsentService.getActiveConsent(userId, 'fitbit');
    expect(consent).toBeNull();
  });
});
