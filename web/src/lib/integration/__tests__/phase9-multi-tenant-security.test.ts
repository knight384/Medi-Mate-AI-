import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import prisma from '@/lib/prisma';
import { HealthMemoryService } from '@/lib/health-intelligence/memory';
import { HealthToolRegistry } from '@/lib/health-intelligence/tools/tool-registry';
import { createInternalServiceAssertion, verifyInternalServiceAssertion } from '@/lib/rag/rag-token';
import { WearableConsentService } from '@/lib/wearables/consent';

/**
 * Phase 3 — Multi-User & Multi-Tenant Security Validation
 * Validates cross-user and cross-tenant boundaries across User Alpha (Tenant A),
 * User Beta (Tenant A), and User Gamma (Tenant B).
 */
describe('Phase 9 — Multi-User & Multi-Tenant Security Suite', () => {
  const userAlpha = 'user_alpha_tenant_a';
  const tenantA = 'tenant_alpha_healthcare';

  const userBeta = 'user_beta_tenant_a';

  const userGamma = 'user_gamma_tenant_b';
  const tenantB = 'tenant_beta_clinic';

  beforeAll(async () => {
    if (process.env.DATABASE_URL) {
      for (const u of [userAlpha, userBeta, userGamma]) {
        await prisma.user.upsert({
          where: { id: u },
          update: {},
          create: {
            id: u,
            username: u,
            password: 'hashed_password_phase9',
          },
        }).catch(() => {});
      }
    }
  });

  beforeEach(() => {
    HealthMemoryService._resetInMemoryStore();
    WearableConsentService._resetInMemoryCache();
  });

  it('enforces strict cross-tenant isolation for conversational health memories', async () => {
    // 1. User Alpha (Tenant A) records a confidential health goal
    const alphaMem = await HealthMemoryService.recordMemory({
      userId: userAlpha,
      category: 'GOAL',
      key: 'confidential_alpha_plan',
      content: 'Undergoing confidential cardiac rehabilitation therapy',
    });

    // 2. User Gamma (Tenant B) attempts to read memories -> receives empty
    const gammaMemories = await HealthMemoryService.getActiveMemories(userGamma);
    expect(gammaMemories.length).toBe(0);

    // 3. User Gamma attempts cross-tenant deletion -> denied
    const deleteAttempt = await HealthMemoryService.deleteMemory(userGamma, alphaMem.id);
    expect(deleteAttempt).toBe(false);

    // 4. User Beta (same tenant A, different user) attempts to delete Alpha's memory -> denied
    const betaDeleteAttempt = await HealthMemoryService.deleteMemory(userBeta, alphaMem.id);
    expect(betaDeleteAttempt).toBe(false);

    // Alpha's record remains fully intact
    const alphaMemories = await HealthMemoryService.getActiveMemories(userAlpha);
    expect(alphaMemories.length).toBe(1);
    expect(alphaMemories[0].content).toContain('cardiac rehabilitation');
  });

  it('enforces strict cross-tenant isolation for wearable consent policies', async () => {
    // 1. User Alpha consents to Fitbit HEART telemetry
    await WearableConsentService.recordConsent({
      userId: userAlpha,
      providerId: 'fitbit',
      categories: ['HEART'],
      purpose: 'Cardiovascular tracking',
    });

    // 2. User Gamma (Tenant B) must not inherit or see Alpha's consent
    const gammaConsent = await WearableConsentService.getActiveConsent(userGamma, 'fitbit');
    expect(gammaConsent).toBeNull();

    // 3. User Gamma cannot revoke Alpha's consent
    await WearableConsentService.revokeConsent(userGamma, 'fitbit');
    const alphaConsentStillActive = await WearableConsentService.getActiveConsent(userAlpha, 'fitbit');
    expect(alphaConsentStillActive).not.toBeNull();
    expect(alphaConsentStillActive?.status).toBe('ACTIVE');
  });

  it('rejects cross-tenant and forged HMAC service assertions between microservices', () => {
    // 1. Legitimate assertion issued for User Alpha in Tenant A
    const legitimateToken = createInternalServiceAssertion({
      userId: userAlpha,
      tenantId: tenantA,
      operation: 'QUERY',
    });

    const verified = verifyInternalServiceAssertion(legitimateToken);
    expect(verified.userId).toBe(userAlpha);
    expect(verified.tenantId).toBe(tenantA);
    expect(verified.operation).toBe('QUERY');

    // 2. Tampered token payload (e.g. attempting to switch tenant to Tenant B)
    const [headerB64, payloadB64, signature] = legitimateToken.split('.');
    const decodedPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    decodedPayload.tenant_id = tenantB; // Attack: spoofing tenant identity
    decodedPayload.user_id = userGamma;

    const tamperedPayloadB64 = Buffer.from(JSON.stringify(decodedPayload)).toString('base64url');
    const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${signature}`;

    expect(() => verifyInternalServiceAssertion(tamperedToken)).toThrow();
  });

  it('enforces server-side authorization in all allowlisted health tools (IDOR prevention)', async () => {
    // Attempt tool execution with missing user context -> rejected
    const unauthExec = await HealthToolRegistry.executeTool('get_medical_history', { userId: '' });
    expect(unauthExec.success).toBe(false);
    expect(unauthExec.error).toContain('Unauthorized');

    // Attempt to invoke unlisted administrative or SQL tools -> rejected
    const sqlAttack = await HealthToolRegistry.executeTool('execute_raw_sql' as any, { userId: userAlpha });
    expect(sqlAttack.success).toBe(false);
    expect(sqlAttack.error).toContain('not found in allowlisted registry');
  });
});
