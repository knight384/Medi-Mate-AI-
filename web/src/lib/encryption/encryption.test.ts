import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';

describe('Encryption Engine & Key Management Integrity (src/lib/encryption)', () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  const testKey32Bytes = crypto.randomBytes(32).toString('base64');

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = testKey32Bytes;
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = originalKey;
  });

  it('guarantees unique IV / nonces for identical plaintexts (IND-CPA property)', async () => {
    const { encrypt } = await import('./index');
    const plaintext = 'sk-synthetic-clinical-llm-provider-secret-key-12345';

    const cipher1 = encrypt(plaintext);
    const cipher2 = encrypt(plaintext);

    // Encrypted payloads must differ due to unique IV generation
    expect(cipher1).not.toBe(cipher2);

    // Decoded IVs (first 16 bytes) must be distinct
    const iv1 = Buffer.from(cipher1, 'base64').subarray(0, 16);
    const iv2 = Buffer.from(cipher2, 'base64').subarray(0, 16);
    expect(iv1.equals(iv2)).toBe(false);
  });

  it('preserves exact data integrity across encryption and decryption round-trip', async () => {
    const { encrypt, decrypt } = await import('./index');
    const complexClinicalData = JSON.stringify({
      provider: 'Anthropic',
      apiKey: 'sk-ant-api03-test-token-clinical-data',
      patientAuditId: 'p-9941-omega',
      specialChars: 'UTF-8: 日本語, Español, äöü, \u0000\u0001',
    });

    const encrypted = encrypt(complexClinicalData);
    const decrypted = decrypt(encrypted);

    expect(decrypted).toBe(complexClinicalData);
  });

  it('fails decryption cleanly when ciphertext is tampered or corrupted', async () => {
    const { encrypt, decrypt } = await import('./index');
    const plaintext = 'confidential-medical-profile-data';
    const encryptedBase64 = encrypt(plaintext);

    // Tamper with ciphertext bytes (flip bits in the payload past the 16-byte IV)
    const buffer = Buffer.from(encryptedBase64, 'base64');
    buffer[buffer.length - 2] ^= 0xff; // Corrupt ciphertext byte
    const corruptedBase64 = buffer.toString('base64');

    expect(() => {
      decrypt(corruptedBase64);
    }).toThrow();
  });

  it('rejects decryption when an incorrect encryption key is supplied', async () => {
    const { encrypt, decrypt } = await import('./index');
    const plaintext = 'sensitive-ehr-record-content';
    const encrypted = encrypt(plaintext);

    // Temporarily swap out key for a different valid 32-byte key
    const differentKey = crypto.randomBytes(32).toString('base64');
    process.env.ENCRYPTION_KEY = differentKey;

    try {
      expect(() => {
        decrypt(encrypted);
      }).toThrow();
    } finally {
      process.env.ENCRYPTION_KEY = testKey32Bytes;
    }
  });

  it('validates key format constraints and rejects non-32-byte keys', async () => {
    // 16-byte key (too short for 256-bit encryption)
    const invalidShortKey = crypto.randomBytes(16).toString('base64');
    process.env.ENCRYPTION_KEY = invalidShortKey;

    try {
      const { encrypt } = await import('./index');
      expect(() => {
        encrypt('test-data');
      }).toThrow(/ENCRYPTION_KEY must be a Base64-encoded 32-byte key/);
    } finally {
      process.env.ENCRYPTION_KEY = testKey32Bytes;
    }
  });
});
