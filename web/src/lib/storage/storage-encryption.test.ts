import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalStorageDriver, StorageSecurityError } from './local-driver';
import { generateStorageKey } from './naming';

describe('Part C — Medical Document Bytes-at-Rest Encryption & Authenticity Verification', () => {
  const testStorageDir = path.resolve(process.cwd(), '..', 'storage', 'test-encryption-docs');
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    driver = new LocalStorageDriver(testStorageDir);
    await driver.init();
  });

  afterEach(async () => {
    try {
      await fsp.rm(testStorageDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('verifies physical bytes written to disk are encrypted ciphertext and contain NO plaintext', async () => {
    const userId = 'patient_alpha_123';
    const storageKey = generateStorageKey(userId, '.pdf');

    const syntheticMedicalPdf = Buffer.from(
      '%PDF-1.4\n' +
      '1 0 obj << /Title (CONFIDENTIAL MEDICAL REPORT) /Author (Dr. Smith) >> endobj\n' +
      '2 0 obj << /Length 68 >> stream\n' +
      'Patient: Jane Doe, DOB: 1980-05-12, Diagnosis: Severe Acute Hypertension.\n' +
      'endstream endobj\n' +
      '%%EOF'
    );

    // Write stream through storage driver
    const metadata = await driver.writeStream(storageKey, Readable.from(syntheticMedicalPdf));
    expect(metadata.storageKey).toBe(storageKey);
    expect(metadata.size).toBe(syntheticMedicalPdf.length);

    // Inspect the actual physical file on disk directly via filesystem
    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const rawDiskBytes = await fsp.readFile(diskPath);

    // 1. Magic bytes header check: MUST start with MM_ENC03 (Checkpoint 5D.24 container version)
    const magic = rawDiskBytes.subarray(0, 8).toString('utf8');
    expect(magic).toBe('MM_ENC03');

    // 2. Physical file size MUST be 40 bytes larger than plaintext (8 magic + 4 keyId + 12 nonce + 16 tag)
    expect(rawDiskBytes.length).toBe(syntheticMedicalPdf.length + 40);

    // 3. CRITICAL: Plaintext PDF headers and medical text MUST NEVER appear in raw disk bytes
    const rawDiskString = rawDiskBytes.toString('binary');
    expect(rawDiskString).not.toContain('%PDF-1.4');
    expect(rawDiskString).not.toContain('Jane Doe');
    expect(rawDiskString).not.toContain('Hypertension');
    expect(rawDiskString).not.toContain('CONFIDENTIAL MEDICAL REPORT');

    // 4. Decrypt via readStream and verify exact round-trip fidelity
    const { stream, size, isEncrypted } = await driver.readStream(storageKey);
    expect(isEncrypted).toBe(true);
    expect(size).toBe(syntheticMedicalPdf.length);

    const decryptedChunks: Buffer[] = [];
    for await (const chunk of stream) {
      decryptedChunks.push(Buffer.from(chunk));
    }
    const decryptedPayload = Buffer.concat(decryptedChunks);
    expect(decryptedPayload.equals(syntheticMedicalPdf)).toBe(true);
  });

  it('reads decrypted buffer via readBuffer helper with cryptographic authentication', async () => {
    const userId = 'patient_beta_456';
    const storageKey = generateStorageKey(userId, '.pdf');
    const content = Buffer.from('%PDF-1.7 Synthetic Blood Work: Cholesterol 240 mg/dL');

    await driver.writeStream(storageKey, Readable.from(content));

    const decryptedBuffer = await driver.readBuffer(storageKey);
    expect(decryptedBuffer.equals(content)).toBe(true);
  });

  it('manages short-lived plaintext in withDecryptedTempFile and cleans up immediately', async () => {
    const userId = 'patient_gamma_789';
    const storageKey = generateStorageKey(userId, '.pdf');
    const content = Buffer.from('%PDF-1.4 OCR Target Document: Clinical Narrative Analysis');

    await driver.writeStream(storageKey, Readable.from(content));

    let observedTempPath = '';
    const executionResult = await driver.withDecryptedTempFile(storageKey, async (tempPath) => {
      observedTempPath = tempPath;

      // Verify temp file exists and has plaintext content during callback
      const stat = await fsp.stat(tempPath);
      expect(stat.isFile()).toBe(true);

      const plaintext = await fsp.readFile(tempPath);
      expect(plaintext.equals(content)).toBe(true);

      return 'ocr-processing-complete';
    });

    expect(executionResult).toBe('ocr-processing-complete');

    // CRITICAL: Immediately after callback returns, temp plaintext file MUST be deleted
    await expect(fsp.stat(observedTempPath)).rejects.toThrow();
  });

  it('cleans up temporary file even when worker callback throws an error', async () => {
    const storageKey = generateStorageKey('patient_delta', '.pdf');
    await driver.writeStream(storageKey, Readable.from(Buffer.from('temporary-data')));

    let capturedTempPath = '';
    await expect(
      driver.withDecryptedTempFile(storageKey, async (tempPath) => {
        capturedTempPath = tempPath;
        throw new Error('Simulated parser crash');
      })
    ).rejects.toThrow('Simulated parser crash');

    // Temp file must still be unlinked
    await expect(fsp.stat(capturedTempPath)).rejects.toThrow();
  });

  it('fails decryption with cryptographic error when physical ciphertext is tampered with', async () => {
    const storageKey = generateStorageKey('patient_tamper', '.pdf');
    await driver.writeStream(storageKey, Readable.from(Buffer.from('%PDF-1.4 Important clinical lab result')));

    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);

    // Tamper with ciphertext byte past 36-byte header
    diskBytes[40] ^= 0xff;
    await fsp.writeFile(diskPath, diskBytes);

    // Attempting to read tampered file must fail authentication
    await expect(driver.readBuffer(storageKey)).rejects.toThrow(/Cryptographic authentication failed/);
  });

  it('fails decryption with cryptographic error when physical authentication tag is altered', async () => {
    const storageKey = generateStorageKey('patient_tag_tamper', '.pdf');
    await driver.writeStream(storageKey, Readable.from(Buffer.from('%PDF-1.4 Lab values')));

    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);

    // Auth tag is bytes 20..35
    diskBytes[25] ^= 0x55;
    await fsp.writeFile(diskPath, diskBytes);

    await expect(driver.readBuffer(storageKey)).rejects.toThrow(/Cryptographic authentication failed/);
  });

  it('prevents document relocation / swapping attacks via storageKey AAD binding', async () => {
    const userA = 'patient_alice';
    const userB = 'patient_mallory';

    const keyA = generateStorageKey(userA, '.pdf');
    const keyB = generateStorageKey(userB, '.pdf');

    const aliceDoc = Buffer.from('%PDF-1.4 Alice Confidential Medical File');
    await driver.writeStream(keyA, Readable.from(aliceDoc));

    const pathA = await driver.getValidatedDiskPath(keyA);
    const pathB = driver.resolveSecurePath(keyB);

    // Mallory copies Alice's encrypted file into her own folder
    await fsp.mkdir(path.dirname(pathB), { recursive: true });
    await fsp.copyFile(pathA, pathB);

    // When Mallory attempts to read the file under her storage key (keyB),
    // GCM decipher fails because AAD (storageKey) does not match the bound keyA!
    await expect(driver.readBuffer(keyB)).rejects.toThrow(/Cryptographic authentication failed/);
  });

  it('rejects unencrypted legacy documents in production readStream but allows readLegacyDocumentForMigration', async () => {
    const storageKey = generateStorageKey('legacy_patient', '.pdf');
    const legacyPlaintext = Buffer.from('%PDF-1.3 Legacy Unencrypted Document from Before 5D.23');

    // Write file directly without container header (simulating historical pre-encryption disk state)
    const securePath = driver.resolveSecurePath(storageKey);
    await fsp.mkdir(path.dirname(securePath), { recursive: true });
    await fsp.writeFile(securePath, legacyPlaintext);

    // Standard production readStream rejects unauthenticated legacy file
    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);

    // Dedicated migration utility reader successfully reads legacy document
    const { stream, size, isEncrypted } = await driver.readLegacyDocumentForMigration(storageKey);
    expect(isEncrypted).toBe(false);
    expect(size).toBe(legacyPlaintext.length);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(legacyPlaintext)).toBe(true);
  });

  it('maintains full backward-compatible decryption for MM_ENC02 legacy encrypted documents', async () => {
    const storageKey = generateStorageKey('v2_patient', '.pdf');
    const content = Buffer.from('%PDF-1.5 Confidential Patient Record in MM_ENC02 format');

    // Write file explicitly using MM_ENC02 container version
    await driver.writeStream(storageKey, Readable.from(content), undefined, { version: 'MM_ENC02' });

    // Verify physical header is MM_ENC02 and size is content + 36
    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const rawBytes = await fsp.readFile(diskPath);
    expect(rawBytes.subarray(0, 8).toString('utf8')).toBe('MM_ENC02');
    expect(rawBytes.length).toBe(content.length + 36);

    // Read via standard readStream and verify transparent decryption
    const { stream, size, isEncrypted } = await driver.readStream(storageKey);
    expect(isEncrypted).toBe(true);
    expect(size).toBe(content.length);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(content)).toBe(true);
  });
});
