import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  encrypt,
  decrypt,
  encryptLegacyCBC,
  getCiphertextVersion,
  EncryptionError,
} from './index';
import {
  migrateCiphertextString,
  migrateLlmProviderApiKeys,
} from './migrate-ciphertext';

describe('Encryption Engine & Authenticated AES-256-GCM Architecture (src/lib/encryption)', () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  const testKey32Bytes = crypto.randomBytes(32).toString('base64');

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = testKey32Bytes;
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = originalKey;
  });

  describe('Part A — AES-256-GCM Primitives & Authenticity Guarantees', () => {
    it('produces versioned ciphertext with "v2:" prefix and guarantees unique nonces (IND-CPA)', () => {
      const plaintext = 'sk-synthetic-clinical-llm-provider-secret-key-12345';

      const cipher1 = encrypt(plaintext);
      const cipher2 = encrypt(plaintext);

      expect(cipher1).toMatch(/^v2:[A-Za-z0-9+/=]+$/);
      expect(cipher2).toMatch(/^v2:[A-Za-z0-9+/=]+$/);
      expect(cipher1).not.toBe(cipher2);

      // Decoded nonces (first 12 bytes) must be distinct
      const raw1 = Buffer.from(cipher1.slice(3), 'base64');
      const raw2 = Buffer.from(cipher2.slice(3), 'base64');
      const nonce1 = raw1.subarray(0, 12);
      const nonce2 = raw2.subarray(0, 12);

      expect(nonce1.length).toBe(12);
      expect(nonce2.length).toBe(12);
      expect(nonce1.equals(nonce2)).toBe(false);
    });

    it('preserves exact data integrity across round-trip encryption and decryption', () => {
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

    it('cryptographically binds Additional Authenticated Data (AAD)', () => {
      const sensitiveKey = 'sk-openai-confidential-user-credential-9988';
      const tenantContext = 'tenant:patient_alpha_774';

      const cipherWithAad = encrypt(sensitiveKey, tenantContext);

      // Successful decryption with matching AAD
      const decrypted = decrypt(cipherWithAad, tenantContext);
      expect(decrypted).toBe(sensitiveKey);

      // Decryption MUST fail if AAD does not match (wrong tenant or altered context)
      expect(() => {
        decrypt(cipherWithAad, 'tenant:patient_beta_999');
      }).toThrow(EncryptionError);

      // Decryption MUST fail if AAD was omitted on encrypted payload that expects it
      expect(() => {
        decrypt(cipherWithAad);
      }).toThrow(EncryptionError);
    });

    it('rejects tampered ciphertext bits with authentication failure', () => {
      const plaintext = 'confidential-medical-profile-data';
      const encryptedV2 = encrypt(plaintext);

      // Tamper with payload byte in the ciphertext portion
      const raw = Buffer.from(encryptedV2.slice(3), 'base64');
      raw[raw.length - 2] ^= 0xff; // Flip bits
      const tamperedV2 = `v2:${raw.toString('base64')}`;

      expect(() => {
        decrypt(tamperedV2);
      }).toThrow(/Authentication tag verification failed/);
    });

    it('rejects altered authentication tags before releasing plaintext', () => {
      const plaintext = 'diagnostic-lab-result-value-positive';
      const encryptedV2 = encrypt(plaintext);

      // Auth tag is located at offset 12..27 in decoded payload
      const raw = Buffer.from(encryptedV2.slice(3), 'base64');
      raw[15] ^= 0xaa; // Corrupt a byte in the 16-byte auth tag
      const corruptedTagCipher = `v2:${raw.toString('base64')}`;

      expect(() => {
        decrypt(corruptedTagCipher);
      }).toThrow(/Authentication tag verification failed/);
    });

    it('rejects decryption when an incorrect encryption key is supplied', () => {
      const plaintext = 'sensitive-ehr-record-content';
      const encrypted = encrypt(plaintext);

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

    it('validates key format constraints and rejects non-32-byte keys', () => {
      const invalidShortKey = crypto.randomBytes(16).toString('base64');
      process.env.ENCRYPTION_KEY = invalidShortKey;

      try {
        expect(() => {
          encrypt('test-data');
        }).toThrow(/ENCRYPTION_KEY must be a Base64-encoded 32-byte key/);
      } finally {
        process.env.ENCRYPTION_KEY = testKey32Bytes;
      }
    });

    it('rejects malformed or truncated payloads', () => {
      // Shorter than 28 bytes (12 nonce + 16 auth tag)
      const shortBase64 = Buffer.from('too-short').toString('base64');
      expect(() => {
        decrypt(`v2:${shortBase64}`);
      }).toThrow(/payload is too short for AES-256-GCM/);

      expect(() => {
        decrypt('');
      }).toThrow(/Ciphertext input must be a non-empty string/);
    });

    it('maintains decrypt-only backward compatibility with legacy AES-256-CBC payloads', () => {
      const legacySecret = 'legacy-secret-api-key-prior-to-5d23';

      // 1. Un-prefixed raw CBC format
      const rawCbc = encryptLegacyCBC(legacySecret, false);
      expect(rawCbc).not.toContain('v2:');
      expect(rawCbc).not.toContain('v1:');
      expect(decrypt(rawCbc)).toBe(legacySecret);

      // 2. "v1:" prefixed CBC format
      const v1Cbc = encryptLegacyCBC(legacySecret, true);
      expect(v1Cbc.startsWith('v1:')).toBe(true);
      expect(decrypt(v1Cbc)).toBe(legacySecret);
    });

    it('detects ciphertext versioning accurately via getCiphertextVersion', () => {
      const gcmCipher = encrypt('modern-data');
      const v1Cipher = encryptLegacyCBC('v1-data', true);
      const rawCbc = encryptLegacyCBC('raw-cbc-data', false);

      expect(getCiphertextVersion(gcmCipher)).toBe('v2');
      expect(getCiphertextVersion(v1Cipher)).toBe('v1');
      expect(getCiphertextVersion(rawCbc)).toBe('legacy');
      expect(getCiphertextVersion('invalid-non-base64-???')).toBe('unrecognized');
    });
  });

  describe('Part B — Safe Encrypted Data Migration Utility', () => {
    it('migrates legacy CBC ciphertext string to authenticated AES-256-GCM with round-trip check', () => {
      const originalSecret = 'sk-legacy-provider-key-migration-candidate';
      const legacyCiphertext = encryptLegacyCBC(originalSecret, false);

      expect(legacyCiphertext.startsWith('v2:')).toBe(false);

      const { newCiphertext, wasMigrated } = migrateCiphertextString(legacyCiphertext);

      expect(wasMigrated).toBe(true);
      expect(newCiphertext.startsWith('v2:')).toBe(true);

      // Verify that new ciphertext decrypts to original plaintext
      const decrypted = decrypt(newCiphertext);
      expect(decrypted).toBe(originalSecret);
    });

    it('is idempotent when encountering already-migrated v2 ciphertext', () => {
      const v2Cipher = encrypt('already-v2-data');
      const { newCiphertext, wasMigrated } = migrateCiphertextString(v2Cipher);

      expect(wasMigrated).toBe(false);
      expect(newCiphertext).toBe(v2Cipher);
    });

    it('handles empty strings gracefully without migration', () => {
      const { newCiphertext, wasMigrated } = migrateCiphertextString('');
      expect(wasMigrated).toBe(false);
      expect(newCiphertext).toBe('');
    });

    it('fails safely and preserves legacy ciphertext if payload is corrupt', () => {
      const corruptCipher = Buffer.from('corrupt-non-cbc-bytes-padding-error').toString('base64');
      expect(() => {
        migrateCiphertextString(corruptCipher);
      }).toThrow(/Legacy decryption failed during migration/);
    });

    it('enforces format validation on legacy CBC decryption and rejects binary garbage or control characters', () => {
      // Craft a legacy CBC ciphertext containing null / unprintable control bytes (simulating bit-flipped tampering)
      const garbageSecret = 'sk-leg\x00\x01\x1Fbinary-corruption';
      const garbageCbc = encryptLegacyCBC(garbageSecret, false);

      expect(() => {
        migrateCiphertextString(garbageCbc);
      }).toThrow(/Decrypted legacy secret failed format validation/);
    });

    it('executes batch migration over simulated LLMProvider database records with backup ledger', async () => {
      const rawKey1 = 'sk-provider-1-alpha';
      const rawKey2 = 'sk-provider-2-beta';
      const alreadyV2Key = encrypt('sk-provider-3-v2');

      const mockDb: Record<string, { id: string; apiKey: string }> = {
        'prov-1': { id: 'prov-1', apiKey: encryptLegacyCBC(rawKey1) },
        'prov-2': { id: 'prov-2', apiKey: encryptLegacyCBC(rawKey2, true) },
        'prov-3': { id: 'prov-3', apiKey: alreadyV2Key },
        'prov-4': { id: 'prov-4', apiKey: '' }, // empty default key
      };

      const mockPrisma = {
        lLMProvider: {
          findMany: async () => Object.values(mockDb),
          update: async ({ where, data }: { where: { id: string }; data: { apiKey: string } }) => {
            mockDb[where.id].apiKey = data.apiKey;
            return mockDb[where.id];
          },
        },
      };

      const summary = await migrateLlmProviderApiKeys(mockPrisma);

      expect(summary.totalRecords).toBe(4);
      expect(summary.migrated).toBe(2);
      expect(summary.alreadyV2).toBe(1);
      expect(summary.skippedEmpty).toBe(1);
      expect(summary.failed).toBe(0);

      // Verify that migrated keys are now v2: and decrypt to expected plaintexts
      expect(mockDb['prov-1'].apiKey.startsWith('v2:')).toBe(true);
      expect(decrypt(mockDb['prov-1'].apiKey)).toBe(rawKey1);

      expect(mockDb['prov-2'].apiKey.startsWith('v2:')).toBe(true);
      expect(decrypt(mockDb['prov-2'].apiKey)).toBe(rawKey2);

      // Verify that empty key was untouched
      expect(mockDb['prov-4'].apiKey).toBe('');
    });
  });
});
