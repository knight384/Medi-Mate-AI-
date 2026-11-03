import { describe, it, expect, beforeEach } from 'vitest';
import { WearableConsentService, ConsentError } from '../consent';

describe('Granular Wearable Consent & Policy Enforcement (Phase 7)', () => {
  const userId = 'consent_test_user_01';
  const providerId = 'fitbit';

  beforeEach(async () => {
    // Reset/revoke prior consent
    await WearableConsentService.revokeConsent(userId, providerId, 'TEST_RESET');
  });

  it('fails closed when attempting to access health data without prior consent', async () => {
    await expect(
      WearableConsentService.verifyConsentOrThrow(userId, providerId, 'HEART')
    ).rejects.toThrow(ConsentError);

    await expect(
      WearableConsentService.verifyConsentOrThrow(userId, providerId, 'HEART')
    ).rejects.toMatchObject({ code: 'CONSENT_NOT_FOUND' });
  });

  it('records explicit granular consent and allows authorized categories', async () => {
    await WearableConsentService.recordConsent({
      userId,
      providerId,
      categories: ['HEART', 'ACTIVITY'],
      purpose: 'Cardiovascular tracking and activity analysis',
    });

    // Authorized categories pass
    await expect(
      WearableConsentService.verifyConsentOrThrow(userId, providerId, 'HEART')
    ).resolves.not.toThrow();

    await expect(
      WearableConsentService.verifyConsentOrThrow(userId, providerId, 'ACTIVITY')
    ).resolves.not.toThrow();

    // Unauthorized category fails closed
    await expect(
      WearableConsentService.verifyConsentOrThrow(userId, providerId, 'SLEEP')
    ).rejects.toThrow(ConsentError);

    await expect(
      WearableConsentService.verifyConsentOrThrow(userId, providerId, 'SLEEP')
    ).rejects.toMatchObject({ code: 'CATEGORY_NOT_AUTHORIZED' });
  });

  it('filters category requests down to strictly authorized categories', async () => {
    await WearableConsentService.recordConsent({
      userId,
      providerId,
      categories: ['HEART', 'VITALS'],
      purpose: 'Vitals monitoring',
    });

    const filtered = await WearableConsentService.filterAuthorizedCategories(
      userId,
      providerId,
      ['HEART', 'ACTIVITY', 'SLEEP', 'VITALS']
    );

    expect(filtered).toEqual(['HEART', 'VITALS']);
  });

  it('immediately blocks access upon consent revocation', async () => {
    await WearableConsentService.recordConsent({
      userId,
      providerId,
      categories: ['HEART', 'ACTIVITY', 'SLEEP'],
      purpose: 'General monitoring',
    });

    // Access allowed before revocation
    await expect(
      WearableConsentService.verifyConsentOrThrow(userId, providerId, 'HEART')
    ).resolves.not.toThrow();

    // Revoke consent
    await WearableConsentService.revokeConsent(userId, providerId, 'USER_REQUEST');

    // Access blocked immediately after revocation
    await expect(
      WearableConsentService.verifyConsentOrThrow(userId, providerId, 'HEART')
    ).rejects.toThrow(ConsentError);
  });
});
