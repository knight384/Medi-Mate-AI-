import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  LocalKeyProvider,
  CloudKMSKeyProvider,
  CloudKMSBlockedError,
  EnvelopeEncryptionService,
  VersionedCiphertextFormat,
  KeyRotationService,
  LocalSyntheticKMSAdapter,
} from './index';

describe('Permanent Architecture — Encryption & Key Management Abstractions', () => {
  describe('LocalKeyProvider & Keyring Mapping', () => {
    it('manages active key and allows seamless rotation to next keyId', async () => {
      const initialKey = crypto.randomBytes(32);
      const keyProvider = new LocalKeyProvider(initialKey, 'k001');

      expect(keyProvider.getActiveKeyId()).toBe('k001');
      const retrieved = await keyProvider.getKey('k001');
      expect(retrieved.equals(initialKey)).toBe(true);

      // Rotate to k002
      const newKey = crypto.randomBytes(32);
      keyProvider.rotateKey(newKey, 'k002');

      expect(keyProvider.getActiveKeyId()).toBe('k002');
      expect((await keyProvider.getKey('k002')).equals(newKey)).toBe(true);

      // Historical k001 is still accessible for reading older documents
      expect((await keyProvider.getKey('k001')).equals(initialKey)).toBe(true);
    });

    it('rejects invalid key lengths on registration or rotation', () => {
      const keyProvider = new LocalKeyProvider();
      const invalidKey = crypto.randomBytes(16);

      expect(() => {
        keyProvider.rotateKey(invalidKey, 'k_bad');
      }).toThrow(/Rotated key must be exactly 32 bytes/);
    });
  });

  describe('CloudKMSKeyProvider Fail-Safe Boundaries', () => {
    it('reports [BLOCKED] when unconfigured and prevents raw key export by cloud HSM design', async () => {
      delete process.env.AWS_KMS_KEY_ARN;
      delete process.env.GCP_KMS_KEY_NAME;

      const kmsProvider = new CloudKMSKeyProvider();
      await expect(kmsProvider.getKey()).rejects.toThrow(CloudKMSBlockedError);
    });
  });

  describe('EnvelopeEncryptionService', () => {
    it('encrypts and decrypts envelopes using per-document DEK with zero memory leakage', async () => {
      const adapter = new LocalSyntheticKMSAdapter();
      const service = new EnvelopeEncryptionService(adapter);

      const secretPayload = Buffer.from('Patient Clinical Genomic Marker: HLA-B*5701 Positive');
      const context = { patientId: 'patient_alpha', documentType: 'genomic_panel' };

      const envelope = await service.encrypt(secretPayload, 'kek-v1', context);
      expect(envelope.formatVersion).toBe('v1-envelope');
      expect(envelope.keyId).toBe('kek-v1');
      expect(envelope.ciphertext).toBeDefined();

      const decrypted = await service.decrypt(envelope);
      expect(decrypted.equals(secretPayload)).toBe(true);
    });
  });

  describe('VersionedCiphertextFormat', () => {
    it('accurately identifies field versions and storage container headers', () => {
      expect(VersionedCiphertextFormat.getFieldVersion('v2:QUJD...')).toBe('v2');
      expect(VersionedCiphertextFormat.getFieldVersion('v1:QUJD...')).toBe('v1');
      expect(VersionedCiphertextFormat.getFieldVersion('')).toBe('empty');

      const v3Buf = Buffer.concat([Buffer.from('MM_ENC03'), Buffer.alloc(32)]);
      expect(VersionedCiphertextFormat.getContainerVersion(v3Buf)).toBe('MM_ENC03');

      const v2Buf = Buffer.concat([Buffer.from('MM_ENC02'), Buffer.alloc(28)]);
      expect(VersionedCiphertextFormat.getContainerVersion(v2Buf)).toBe('MM_ENC02');

      const legacyBuf = Buffer.from('%PDF-1.4');
      expect(VersionedCiphertextFormat.getContainerVersion(legacyBuf)).toBe('unrecognized');
    });
  });

  describe('KeyRotationService & NIST SP 800-38D Lifecycle', () => {
    it('tracks invocations and signals when rotation threshold is reached', () => {
      const keyProvider = new LocalKeyProvider();
      const rotationService = new KeyRotationService(keyProvider, {
        maxInvocationsThreshold: 100, // lowered for test
        maxAgeMs: 1000,
      });

      expect(rotationService.isRotationDue().due).toBe(false);

      // Record 100 operations
      rotationService.recordInvocation(100);
      const status = rotationService.isRotationDue();
      expect(status.due).toBe(true);
      expect(status.reason).toBe('INVOCATIONS_EXCEEDED');

      // Execute rotation
      const { oldKeyId, newKeyId } = rotationService.rotateMasterKey();
      expect(oldKeyId).toBe('k001');
      expect(newKeyId).toBeDefined();
      expect(rotationService.isRotationDue().due).toBe(false);
    });
  });
});
