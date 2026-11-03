import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '@/lib/encryption';
import {
  MAGIC_HEADER_V2,
  MAGIC_HEADER_V3,
  HEADER_SIZE_V2,
  HEADER_SIZE_V3,
} from '@/lib/storage/local-driver';
import { getWearableConnector, listSupportedProviders } from '@/lib/wearables/registry';
import { PlatformBlockedError } from '@/lib/wearables/connectors/blocked-adapters';

describe('Phase 9 — Encryption Integrity & Provider Capabilities Suite', () => {
  // 1. Authenticated AES-256-GCM Encryption with AAD Binding
  it('encrypts and decrypts with Additional Authenticated Data (AAD) and detects tampering', () => {
    const plaintext = 'Patient lab result: Fasting Blood Glucose = 95 mg/dL';
    const aad = 'user_journey_patient_01:medical_record_456';

    const ciphertext = encrypt(plaintext, { aad });
    expect(ciphertext.startsWith('v2:')).toBe(true);

    // Legitimate decryption with matching AAD
    const decrypted = decrypt(ciphertext, { aad });
    expect(decrypted).toBe(plaintext);

    // Tampered AAD (e.g. cross-user relocation attack) -> fail-closed
    expect(() => decrypt(ciphertext, { aad: 'other_user_attacker:medical_record_456' })).toThrow();

    // Tampered ciphertext payload -> fail-closed
    const rawPayload = Buffer.from(ciphertext.slice(3), 'base64');
    rawPayload[rawPayload.length - 1] ^= 0xff; // Flip bits in ciphertext
    const tamperedCiphertext = `v2:${rawPayload.toString('base64')}`;

    expect(() => decrypt(tamperedCiphertext, { aad })).toThrow();
  });

  // 2. Binary Container Header Integrity (MM_ENC02 vs MM_ENC03)
  it('validates binary magic headers and offsets for MM_ENC02 and MM_ENC03', () => {
    expect(MAGIC_HEADER_V2.toString('ascii')).toBe('MM_ENC02');
    expect(HEADER_SIZE_V2).toBe(36); // Magic(8) + Nonce(12) + Tag(16)

    expect(MAGIC_HEADER_V3.toString('ascii')).toBe('MM_ENC03');
    expect(HEADER_SIZE_V3).toBe(40); // Magic(8) + KeyId(4) + Nonce(12) + Tag(16)
  });

  // 3. Provider Capabilities & Fail-Closed Enforcement for Native Mobile Adapters
  it('accurately verifies supported cloud REST connectors and blocks native mobile adapters', async () => {
    const providers = listSupportedProviders();
    expect(providers.length).toBeGreaterThanOrEqual(5);

    // Cloud REST connectors (Fitbit & Oura)
    const fitbit = getWearableConnector('fitbit');
    expect(fitbit.getCapabilities().platform).toBe('CLOUD_API');
    expect(fitbit.getCapabilities().supportsPKCE).toBe(true);

    const oura = getWearableConnector('oura');
    expect(oura.getCapabilities().platform).toBe('CLOUD_API');

    const authParams = {
      state: 'state_test',
      categories: ['HEART' as const],
      redirectUri: 'http://localhost:3000/callback',
    };

    // Blocked native mobile adapters (Apple HealthKit & Android Health Connect)
    const apple = getWearableConnector('apple_health');
    await expect(apple.getAuthorizationUrl(authParams)).rejects.toThrowError(PlatformBlockedError);

    const android = getWearableConnector('health_connect');
    await expect(android.getAuthorizationUrl(authParams)).rejects.toThrowError(PlatformBlockedError);

    // Blocked partner contract adapter (Garmin)
    const garmin = getWearableConnector('garmin');
    await expect(garmin.getAuthorizationUrl(authParams)).rejects.toThrowError(PlatformBlockedError);
  });
});
