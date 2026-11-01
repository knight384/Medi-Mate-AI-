import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  LocalSyntheticKMSAdapter,
  CloudKMSClient,
  encryptEnvelope,
  decryptEnvelope,
} from './kms-adapter';

describe('Part D — Cloud KMS & Envelope Encryption Readiness (src/lib/encryption/kms-adapter)', () => {
  const masterKeyV1 = crypto.randomBytes(32);
  const kms = new LocalSyntheticKMSAdapter(masterKeyV1, 'kek-v1');

  it('generates per-document DEKs, encrypts payload, and successfully round-trips via envelope', async () => {
    const medicalReportPlaintext = 'PATIENT CLINICAL SUMMARY: Blood glucose 110 mg/dL, HbA1c 5.7%';
    const context = {
      tenantId: 'user_alpha_554',
      documentId: 'doc_clinical_001',
    };

    const envelope = await encryptEnvelope(
      medicalReportPlaintext,
      kms,
      'key-medimate-prod',
      context
    );

    expect(envelope.formatVersion).toBe('v1-envelope');
    expect(envelope.keyVersion).toBe('kek-v1');
    expect(envelope.encryptedDataKey).toBeDefined();
    expect(envelope.nonce).toBeDefined();
    expect(envelope.authTag).toBeDefined();
    expect(envelope.ciphertext).toBeDefined();

    // Plaintext medical report must NOT appear in any envelope field
    expect(envelope.ciphertext).not.toContain('PATIENT CLINICAL SUMMARY');
    expect(envelope.encryptedDataKey).not.toContain('PATIENT CLINICAL SUMMARY');

    // Decrypt envelope
    const decryptedBuf = await decryptEnvelope(envelope, kms);
    expect(decryptedBuf.toString('utf8')).toBe(medicalReportPlaintext);
  });

  it('fails decryption cleanly when envelope ciphertext or auth tag is tampered with', async () => {
    const data = 'confidential-genomic-sequence-data';
    const envelope = await encryptEnvelope(data, kms, 'key-medimate-prod');

    // Tamper with payload ciphertext
    const rawCipher = Buffer.from(envelope.ciphertext, 'base64');
    rawCipher[rawCipher.length - 1] ^= 0xff;
    envelope.ciphertext = rawCipher.toString('base64');

    await expect(decryptEnvelope(envelope, kms)).rejects.toThrow();
  });

  it('fails decryption when tenant encryption context is altered (AAD integrity)', async () => {
    const data = 'sensitive-clinical-lab-test';
    const originalContext = { tenantId: 'tenant_patient_123' };
    const envelope = await encryptEnvelope(data, kms, 'key-medimate-prod', originalContext);

    // Swap tenant context in envelope
    envelope.context = { tenantId: 'tenant_attacker_999' };

    await expect(decryptEnvelope(envelope, kms)).rejects.toThrow();
  });

  it('supports Key Encryption Key (KEK) rotation while maintaining backward compatibility', async () => {
    const originalData = 'medical-record-created-under-kek-v1';
    const envelope = await encryptEnvelope(originalData, kms, 'key-medimate-prod');
    expect(envelope.keyVersion).toBe('kek-v1');

    // Rotate master KEK to v2
    const masterKeyV2 = crypto.randomBytes(32);
    kms.rotateMasterKey(masterKeyV2, 'kek-v2');

    // New encryption uses kek-v2
    const newEnvelope = await encryptEnvelope('data-under-kek-v2', kms, 'key-medimate-prod');
    expect(newEnvelope.keyVersion).toBe('kek-v2');

    // Old envelope created under kek-v1 can still be decrypted because previous KEK is preserved
    const decryptedOld = await decryptEnvelope(envelope, kms);
    expect(decryptedOld.toString('utf8')).toBe(originalData);

    const decryptedNew = await decryptEnvelope(newEnvelope, kms);
    expect(decryptedNew.toString('utf8')).toBe('data-under-kek-v2');
  });

  it('formally classifies external Cloud KMS execution as BLOCKED without cloud credentials', async () => {
    const awsKms = new CloudKMSClient('AWS_KMS');
    expect(awsKms.providerName).toBe('AWS_KMS');
    expect(awsKms.isBlocked).toBe(true);

    await expect(awsKms.generateDataKey()).rejects.toThrow(/\[BLOCKED\]/);
    await expect(awsKms.decryptDataKey()).rejects.toThrow(/\[BLOCKED\]/);

    const gcpKms = new CloudKMSClient('GCP_KMS');
    expect(gcpKms.providerName).toBe('GCP_KMS');
    expect(gcpKms.isBlocked).toBe(true);

    await expect(gcpKms.generateDataKey()).rejects.toThrow(/\[BLOCKED\]/);
  });
});
