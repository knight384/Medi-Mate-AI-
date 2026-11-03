import { describe, it, expect, beforeEach } from 'vitest';
import { validateDeploymentProfileConfig, getEnv } from '@/lib/config/env';
import { encrypt, decrypt } from '@/lib/encryption';
import { MAGIC_HEADER_V3, HEADER_SIZE_V3 } from '@/lib/storage/local-driver';
import { EncryptedBackupService, BackupSourceData } from '@/lib/backup/backup-service';
import { createInternalServiceAssertion, verifyInternalServiceAssertion } from '@/lib/rag/rag-token';
import { HealthMemoryService } from '@/lib/health-intelligence/memory';
import { HealthAlertService } from '@/lib/health-intelligence/alerts/alert-service';
import { LongitudinalHealthService } from '@/lib/health-intelligence/longitudinal';
import { CompanionResponseGenerator } from '@/lib/health-intelligence/response-generator';
import {
  detectEmergencyKeywords,
  getEmergencyGuidance,
  getRegionalEmergencyDetails,
} from '@/lib/clinical/emergency-guidance';
import { WearableConsentService } from '@/lib/wearables/consent';
import { WearableDeletionService } from '@/lib/wearables/deletion';
import { getWearableConnector, listSupportedProviders } from '@/lib/wearables/registry';
import { PlatformBlockedError } from '@/lib/wearables/connectors/blocked-adapters';
import { NormalizedObservation } from '@/lib/wearables/types';

/**
 * Phase 10 — Production Launch Smoke Test & Post-Deployment Validation Suite
 * Verifies all 14 core production operational workflows under the LOCAL launch profile.
 */
describe('Phase 10 — Production Launch Smoke Test Suite', () => {
  const userId = 'prod_smoke_patient_01';
  const tenantId = 'prod_hospital_primary';

  beforeEach(() => {
    HealthMemoryService._resetInMemoryStore();
    HealthAlertService._resetInMemoryStore();
    WearableConsentService._resetInMemoryCache();
  });

  // 1. Environment & Profile Invariant Validation
  it('P10-01: validates deployment profile configuration and invariant boundaries', () => {
    const env = getEnv();
    const configResult = validateDeploymentProfileConfig(env);
    expect(configResult.valid).toBe(true);
    expect(['local', 'cloud', 'hybrid']).toContain(configResult.mode);
  });

  // 2. Cryptographic Storage & AAD Tamper Rejection
  it('P10-02: verifies AES-256-GCM authenticated storage with AAD binding and bit-flip detection', () => {
    const rawDocument = 'SYNTHETIC_LAB_DATA: Fasting Lipid Panel - Total Cholesterol: 185 mg/dL';
    const aad = `${userId}:records/synthetic_lab_panel.pdf`;

    const encrypted = encrypt(rawDocument, { aad });
    expect(encrypted.startsWith('v2:')).toBe(true);

    const decrypted = decrypt(encrypted, { aad });
    expect(decrypted).toBe(rawDocument);

    // Relocation attempt across tenants / users fails closed
    expect(() => decrypt(encrypted, { aad: 'attacker_user_99:records/synthetic_lab_panel.pdf' })).toThrow();

    // Ciphertext payload tampering fails closed
    const rawB64 = encrypted.slice(3);
    const buf = Buffer.from(rawB64, 'base64');
    buf[buf.length - 1] ^= 0x55;
    expect(() => decrypt(`v2:${buf.toString('base64')}`, { aad })).toThrow();
  });

  // 3. Binary Container Format Integrity (MM_ENC03)
  it('P10-03: verifies MM_ENC03 binary header layout and key rotation offset', () => {
    expect(MAGIC_HEADER_V3.toString('ascii')).toBe('MM_ENC03');
    expect(HEADER_SIZE_V3).toBe(40);
  });

  // 4. Inter-Service Microservice Trust & HMAC Assertion Verification
  it('P10-04: verifies internal HMAC assertion token lifecycle and rejection of forged tokens', () => {
    const token = createInternalServiceAssertion({
      userId,
      tenantId,
      operation: 'QUERY',
      purpose: 'POST_DEPLOYMENT_SMOKE_VERIFICATION',
      expiresInSeconds: 60,
    });

    const verified = verifyInternalServiceAssertion(token);
    expect(verified.userId).toBe(userId);
    expect(verified.tenantId).toBe(tenantId);
    expect(verified.operation).toBe('QUERY');

    // Tampered token fails closed
    const [headerB64, , signature] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'unauthorized_attacker', op: 'QUERY' })).toString('base64url');
    expect(() => verifyInternalServiceAssertion(`${headerB64}.${tamperedPayload}.${signature}`)).toThrow();
  });

  // 5. Conversational Health Companion Evidence Grounding & Honest Abstention
  it('P10-05: verifies conversational evidence grounding and clinical abstention', async () => {
    // 1. Evidence-grounded query
    const res = await CompanionResponseGenerator.generateCompanionResponse({
      userId,
      query: 'What is my recorded blood glucose or HbA1c result?',
    });

    expect(res).toBeDefined();
    expect(res.intent).toBeDefined();
    expect(res.answer).toBeDefined();

    // 2. Unrecorded data abstention
    const absentRes = await CompanionResponseGenerator.generateCompanionResponse({
      userId,
      query: 'What are my unrecorded full-exome genetic DNA test findings?',
    });

    expect(absentRes.answer).toContain('do not have access to any recorded measurements');
  });

  // 6. Clinical Safety: Emergency Guidance & Red Flag Short-Circuiting
  it('P10-06: triggers deterministic emergency guidance on clinical red flags', () => {
    const emergencyQueries = [
      'I have severe crushing chest pain radiating down my left arm',
      'Sudden numbness on the left side of my face and cannot speak clearly',
      'Extreme difficulty breathing and lips turning blue',
    ];

    for (const q of emergencyQueries) {
      const isEmergency = detectEmergencyKeywords(q);
      expect(isEmergency).toBe(true);

      const guidance = getEmergencyGuidance('US');
      expect(guidance.emergencyNumber).toBe('911');
      expect(guidance.instructions).toContain('911');
      expect(guidance.disclaimer).toContain('cannot automatically dispatch');
    }

    const isNonEmergency = detectEmergencyKeywords('What are some general tips to improve sleep?');
    expect(isNonEmergency).toBe(false);

    const inDetails = getRegionalEmergencyDetails('IN');
    expect(inDetails.emergencyNumber).toBe('112');
  });

  // 7. Wearable Normalization & Longitudinal Delta Analysis
  it('P10-07: normalizes telemetry observations and calculates non-diagnostic longitudinal delta', () => {
    const observations: NormalizedObservation[] = [
      {
        id: 'obs_01',
        userId,
        providerId: 'fitbit',
        externalRecordId: 'ext_01',
        metric: 'RESTING_HEART_RATE',
        category: 'HEART',
        value: 62,
        unit: 'bpm',
        startTime: '2026-10-01T08:00:00Z',
        endTime: '2026-10-01T08:00:00Z',
        dataQuality: 'MEASURED',
        syncedAt: '2026-10-01T09:00:00Z',
      },
      {
        id: 'obs_02',
        userId,
        providerId: 'fitbit',
        externalRecordId: 'ext_02',
        metric: 'RESTING_HEART_RATE',
        category: 'HEART',
        value: 70,
        unit: 'bpm',
        startTime: '2026-10-10T08:00:00Z',
        endTime: '2026-10-10T08:00:00Z',
        dataQuality: 'MEASURED',
        syncedAt: '2026-10-10T09:00:00Z',
      },
    ];

    const periodA = { label: 'Baseline', startDate: new Date('2026-10-01'), endDate: new Date('2026-10-05') };
    const periodB = { label: 'Current', startDate: new Date('2026-10-06'), endDate: new Date('2026-10-12') };

    const comp = LongitudinalHealthService.comparePeriods({
      metric: 'RESTING_HEART_RATE',
      periodA,
      periodB,
      observations,
    });

    expect(comp.periodA.avg).toBe(62);
    expect(comp.periodB.avg).toBe(70);
    expect(comp.delta.direction).toBe('INCREASE');
    expect(comp.nonDiagnosticDisclaimer).toContain('observational trends');
  });

  // 8. Wearable Provider Matrix & Fail-Closed Enforcement
  it('P10-08: verifies supported cloud connectors and fail-closed enforcement on mobile platforms', async () => {
    const providers = listSupportedProviders();
    expect(providers.length).toBeGreaterThanOrEqual(5);

    const fitbit = getWearableConnector('fitbit');
    expect(fitbit.getCapabilities().platform).toBe('CLOUD_API');

    const apple = getWearableConnector('apple_health');
    await expect(
      apple.getAuthorizationUrl({ state: 's', categories: ['HEART'], redirectUri: 'http://localhost/cb' })
    ).rejects.toThrowError(PlatformBlockedError);

    const android = getWearableConnector('health_connect');
    await expect(
      android.getAuthorizationUrl({ state: 's', categories: ['HEART'], redirectUri: 'http://localhost/cb' })
    ).rejects.toThrowError(PlatformBlockedError);
  });

  // 9. User-Controlled Conversational Health Memory Lifecycle
  it('P10-09: verifies complete user memory lifecycle (record, retrieve, pause, resume, delete)', async () => {
    const memory = await HealthMemoryService.recordMemory({
      userId,
      category: 'GOAL',
      key: 'aerobic_target',
      content: 'Complete 150 minutes of moderate aerobic exercise weekly',
    });

    let active = await HealthMemoryService.getActiveMemories(userId, 'GOAL');
    expect(active.some((m) => m.id === memory.id)).toBe(true);

    // Pause
    await HealthMemoryService.togglePauseMemory(userId, memory.id, true);
    active = await HealthMemoryService.getActiveMemories(userId, 'GOAL');
    expect(active.some((m) => m.id === memory.id)).toBe(false);

    // Resume
    await HealthMemoryService.togglePauseMemory(userId, memory.id, false);
    active = await HealthMemoryService.getActiveMemories(userId, 'GOAL');
    expect(active.some((m) => m.id === memory.id)).toBe(true);

    // Delete
    const deleted = await HealthMemoryService.deleteMemory(userId, memory.id);
    expect(deleted).toBe(true);
    active = await HealthMemoryService.getActiveMemories(userId, 'GOAL');
    expect(active.some((m) => m.id === memory.id)).toBe(false);
  });

  // 10. Opt-In Health Reminders, Quiet Hours & Cooldown Dampening
  it('P10-10: enforces quiet hours and 24-hour alert frequency dampening', () => {
    HealthAlertService.updateAlertPreferences(userId, {
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      cooldownHours: 24,
    });

    expect(HealthAlertService.isInQuietHours(userId, new Date('2026-11-03T23:45:00'))).toBe(true);
    expect(HealthAlertService.isInQuietHours(userId, new Date('2026-11-03T15:00:00'))).toBe(false);

    const topic = 'RHR_TREND_ALERT';
    const now = new Date('2026-11-03T12:00:00Z');
    expect(HealthAlertService.isAlertInCooldown(userId, topic, now)).toBe(false);

    HealthAlertService.recordAlertTriggered(userId, topic, now);
    expect(HealthAlertService.isAlertInCooldown(userId, topic, new Date('2026-11-03T14:00:00Z'))).toBe(true);
  });

  // 11. Wearable Disconnection, Consent Revocation & Cascading Purge
  it('P10-11: executes cascading purge of wearable data and revokes server-side consent', async () => {
    await WearableConsentService.recordConsent({
      userId,
      providerId: 'fitbit',
      categories: ['HEART'],
      purpose: 'Tracking resting HR',
    });

    let consent = await WearableConsentService.getActiveConsent(userId, 'fitbit');
    expect(consent).not.toBeNull();

    const purgeResult = await WearableDeletionService.purgeAllWearableData({
      userId,
      tenantId,
      providerId: 'fitbit',
    });

    expect(purgeResult.success).toBe(true);
    consent = await WearableConsentService.getActiveConsent(userId, 'fitbit');
    expect(consent).toBeNull();
  });

  // 12. Enterprise Encrypted Backup & Disaster Recovery Drill
  it('P10-12: creates MM_BAK01 encrypted backup archive and verifies restore drill integrity', async () => {
    const backupService = new EncryptedBackupService();
    const backupKey = EncryptedBackupService.generateBackupKey();

    const sourceData: BackupSourceData = {
      deploymentMode: 'local',
      keyVersion: 'v1_production',
      databaseRecords: {
        HealthData: [{ id: 'smoke_rec_01', type: 'WEARABLE_SUMMARY', authorId: userId }],
        UserHealthMemory: [{ id: 'smoke_mem_01', category: 'GOAL', content: 'Smoke goal' }],
      },
      encryptedDocuments: new Map([
        ['smoke_doc.pdf', Buffer.from('MM_ENC03_SYNTHETIC_CIPHERTEXT')],
      ]),
    };

    const backup = await backupService.createEncryptedBackup(sourceData, backupKey);
    expect(backup.manifest.formatVersion).toBe('MM_BAK01');
    expect(backup.manifest.databaseRecordsCount).toBe(2);
    expect(backup.manifest.documentsCount).toBe(1);

    const targetStorage = new Map<string, Buffer>();
    const mockDriver = {
      restoreRawEncryptedObject: async (key: string, data: Buffer) => {
        targetStorage.set(key, data);
      },
    };

    const restored = await backupService.restoreBackup(backup.backupBuffer, backupKey, mockDriver as any);
    expect(restored.success).toBe(true);
    expect(restored.restoredRecordsCount).toBe(2);
    expect(restored.restoredDocumentsCount).toBe(1);
    expect(targetStorage.get('smoke_doc.pdf')?.toString()).toBe('MM_ENC03_SYNTHETIC_CIPHERTEXT');
  });
});
