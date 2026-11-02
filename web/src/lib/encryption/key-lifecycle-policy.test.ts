import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { LocalKeyProvider } from './key-providers';
import {
  KeyRotationService,
  RetiredKeyEncryptionError,
  NistIvLimitExceededError,
} from './key-rotation-service';
import {
  validateProviderKeyPlausibility,
  migrateCiphertextString,
  maskSecretForAudit,
  rollbackLlmProviderMigrations,
} from './migrate-ciphertext';
import { encryptLegacyCBC } from './index';

describe('Part E & G — GCM Key Usage Lifecycle, NIST SP 800-38D Limits & CBC Migration Integrity (Checkpoint 5D.25)', () => {
  let initialKey: Buffer;
  let keyProvider: LocalKeyProvider;
  let rotationService: KeyRotationService;

  beforeEach(() => {
    initialKey = crypto.randomBytes(32);
    keyProvider = new LocalKeyProvider(initialKey, 'k001');
    rotationService = new KeyRotationService(keyProvider, {
      maxInvocationsThreshold: 100, // Scaled down for testing
      hardLimitInvocations: 200,    // Scaled down from 2^32 for testing
      maxAgeMs: 10_000,
    });
  });

  describe('Part E: GCM Key Usage and Rotation Policy', () => {
    it('tracks global invocations and triggers operational warning at threshold', () => {
      expect(rotationService.isRotationDue().due).toBe(false);

      rotationService.recordInvocation(99);
      expect(rotationService.isRotationDue().due).toBe(false);

      rotationService.recordInvocation(1);
      expect(rotationService.isRotationDue()).toEqual({
        due: true,
        reason: 'INVOCATIONS_EXCEEDED',
      });
    });

    it('enforces NIST SP 800-38D hard invocation limit (2^32 boundary)', () => {
      rotationService.recordInvocation(200);

      // Subsequent encryption attempt MUST be rejected to prevent IV collision
      expect(() => rotationService.assertCanEncrypt('k001')).toThrow(NistIvLimitExceededError);
      expect(() => rotationService.recordInvocation(1)).toThrow(NistIvLimitExceededError);
    });

    it('rotates master key, retires old key, and prohibits new encryptions with retired key', async () => {
      const { oldKeyId, newKeyId } = rotationService.rotateMasterKey('k002');
      expect(oldKeyId).toBe('k001');
      expect(newKeyId).toBe('k002');

      // Attempting to encrypt with retired key k001 MUST throw
      expect(() => rotationService.assertCanEncrypt('k001')).toThrow(RetiredKeyEncryptionError);

      // Active key k002 is valid for encryption
      expect(() => rotationService.assertCanEncrypt('k002')).not.toThrow();

      // Read access to old key k001 MUST still work for decrypting historical files
      const oldKeyMaterial = await keyProvider.getKey('k001');
      expect(oldKeyMaterial.equals(initialKey)).toBe(true);
    });

    it('triggers rotation when key age threshold is exceeded', () => {
      const agedService = new KeyRotationService(keyProvider, {
        createdAt: Date.now() - 20_000,
        maxAgeMs: 10_000,
      });

      expect(agedService.isRotationDue()).toEqual({
        due: true,
        reason: 'AGE_EXCEEDED',
      });
    });
  });

  describe('Part G: Legacy CBC API-Key Migration Integrity', () => {
    it('validates provider key format plausibility beyond printable UTF-8', () => {
      // Valid provider keys
      expect(validateProviderKeyPlausibility('openai', 'sk-proj-valid-openai-key-long-enough-12345').plausible).toBe(true);
      expect(validateProviderKeyPlausibility('anthropic', 'sk-ant-valid-anthropic-key-long-enough-12345').plausible).toBe(true);
      expect(validateProviderKeyPlausibility('google', 'AIzaSyValidGoogleKeyLongEnough12345').plausible).toBe(true);

      // Ambiguous / invalid keys
      const invalidOpenAI = validateProviderKeyPlausibility('openai', 'random-not-sk-prefix-123456');
      expect(invalidOpenAI.plausible).toBe(false);
      expect(invalidOpenAI.reason).toContain('sk-... format');

      const controlChars = validateProviderKeyPlausibility('openai', 'sk-valid-prefix\x00corrupt-bytes-123');
      expect(controlChars.plausible).toBe(false);
      expect(controlChars.reason).toContain('control characters');
    });

    it('preserves ambiguous legacy ciphertexts and requires operator re-entry', () => {
      // Legacy CBC ciphertext containing random text not conforming to OpenAI format
      const ambiguousPlaintext = 'ambiguous-legacy-string-not-an-api-key';
      const legacyCiphertext = encryptLegacyCBC(ambiguousPlaintext);

      const result = migrateCiphertextString(legacyCiphertext, {
        providerId: 'openai',
        strictProviderValidation: true,
      });

      expect(result.wasMigrated).toBe(false);
      expect(result.isAmbiguous).toBe(true);
      expect(result.reason).toContain('sk-... format');
      // Original ciphertext is preserved
      expect(result.newCiphertext).toBe(legacyCiphertext);
    });

    it('masks secrets in audit trails with zero plaintext leakage', () => {
      const sensitive = 'sk-proj-super-secret-production-key-999';
      const masked = maskSecretForAudit(sensitive);
      expect(masked).toBe('sk-p...-999');
      expect(masked).not.toContain('super-secret');
    });

    it('supports full rollback of migrated records using preserved original ciphertexts', async () => {
      const recordsMap = new Map<string, string>([
        ['rec_1', 'v2:migrated_ciphertext_1'],
        ['rec_2', 'v2:migrated_ciphertext_2'],
      ]);

      const mockPrisma = {
        lLMProvider: {
          update: async ({ where, data }: { where: { id: string }; data: { apiKey: string } }) => {
            recordsMap.set(where.id, data.apiKey);
          },
        },
      };

      const backups = [
        { id: 'rec_1', originalCiphertext: 'legacy_cbc_1', status: 'migrated' as const },
        { id: 'rec_2', originalCiphertext: 'legacy_cbc_2', status: 'migrated' as const },
      ];

      const { restored, failed } = await rollbackLlmProviderMigrations(mockPrisma, backups);
      expect(restored).toBe(2);
      expect(failed).toBe(0);

      // Verified restored back to legacy CBC
      expect(recordsMap.get('rec_1')).toBe('legacy_cbc_1');
      expect(recordsMap.get('rec_2')).toBe('legacy_cbc_2');
    });
  });
});
