import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalStorageDriver, StorageSecurityError } from './local-driver';
import { generateStorageKey } from './naming';

describe('Part A — Zero-Plaintext Streaming Authentication & Quarantine Verification (Checkpoint 5D.24)', () => {
  const testStorageDir = path.resolve(process.cwd(), '..', 'storage', 'test-stream-auth-docs');
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

  /**
   * Helper that collects bytes from a stream and counts emitted bytes.
   */
  async function streamToBufferWithByteCounter(
    stream: Readable
  ): Promise<{ buffer: Buffer; emittedBytes: number }> {
    const chunks: Buffer[] = [];
    let emittedBytes = 0;

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        emittedBytes += chunk.length;
        chunks.push(chunk);
      });
      stream.on('end', () => {
        resolve({ buffer: Buffer.concat(chunks), emittedBytes });
      });
      stream.on('error', (err) => {
        reject(err);
      });
    });
  }

  it('Scenario 1: valid ciphertext with authentic tag releases all plaintext bytes faithfully', async () => {
    const storageKey = generateStorageKey('patient_valid_01', '.pdf');
    const content = Buffer.from('%PDF-1.4 Clinical Chemistry Report: Glucose 95 mg/dL, HbA1c 5.4%');

    await driver.writeStream(storageKey, Readable.from(content));

    const { stream, size, isEncrypted } = await driver.readStream(storageKey);
    expect(isEncrypted).toBe(true);
    expect(size).toBe(content.length);

    const { buffer, emittedBytes } = await streamToBufferWithByteCounter(stream);
    expect(emittedBytes).toBe(content.length);
    expect(buffer.equals(content)).toBe(true);
  });

  it('Scenario 2: modified first ciphertext block emits ZERO plaintext bytes to consumer', async () => {
    const storageKey = generateStorageKey('patient_tamper_first', '.pdf');
    const content = Buffer.from('%PDF-1.4 Confidential Patient Narrative with Extensive Lab Notes');

    await driver.writeStream(storageKey, Readable.from(content));

    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);

    // Header size for MM_ENC03 is 40 bytes. Offset 40 is the first ciphertext byte.
    diskBytes[40] ^= 0xff;
    await fsp.writeFile(diskPath, diskBytes);

    // CRITICAL: readStream must reject BEFORE returning a stream, ensuring 0 bytes delivered!
    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('Scenario 3: modified middle ciphertext block emits ZERO plaintext bytes to consumer', async () => {
    const storageKey = generateStorageKey('patient_tamper_mid', '.pdf');
    const largeContent = Buffer.alloc(16384, 'A'); // 16 KB payload across multiple cipher blocks
    largeContent.write('%PDF-1.4 Sensitive Medical Record', 0);

    await driver.writeStream(storageKey, Readable.from(largeContent));

    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);

    // Corrupt byte in the middle of ciphertext payload (offset 40 + 8192)
    diskBytes[40 + 8192] ^= 0xaa;
    await fsp.writeFile(diskPath, diskBytes);

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('Scenario 4: modified final ciphertext block emits ZERO plaintext bytes to consumer', async () => {
    const storageKey = generateStorageKey('patient_tamper_final', '.pdf');
    const largeContent = Buffer.alloc(16384, 'B');
    largeContent.write('%PDF-1.4 Oncology Biopsy Results', 0);

    await driver.writeStream(storageKey, Readable.from(largeContent));

    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);

    // Corrupt the very last byte of ciphertext
    diskBytes[diskBytes.length - 1] ^= 0x55;
    await fsp.writeFile(diskPath, diskBytes);

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('Scenario 5: modified authentication tag emits ZERO plaintext bytes to consumer', async () => {
    const storageKey = generateStorageKey('patient_tamper_tag', '.pdf');
    const content = Buffer.from('%PDF-1.4 Cardiology Echocardiogram');

    await driver.writeStream(storageKey, Readable.from(content));

    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);

    // MM_ENC03 auth tag is at bytes 24..39
    diskBytes[30] ^= 0x12;
    await fsp.writeFile(diskPath, diskBytes);

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('Scenario 6: truncated ciphertext payload emits ZERO plaintext bytes to consumer', async () => {
    const storageKey = generateStorageKey('patient_truncated', '.pdf');
    const content = Buffer.from('%PDF-1.4 Genomic Sequencing Report - 5000 lines');

    await driver.writeStream(storageKey, Readable.from(content));

    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);

    // Truncate the file by 10 bytes
    const truncatedBytes = diskBytes.subarray(0, diskBytes.length - 10);
    await fsp.writeFile(diskPath, truncatedBytes);

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('Scenario 7: truncated container header throws StorageSecurityError before processing', async () => {
    const storageKey = generateStorageKey('patient_bad_header', '.pdf');
    const content = Buffer.from('MM_ENC03k001'); // Only 12 bytes, less than header size

    const securePath = driver.resolveSecurePath(storageKey);
    await fsp.mkdir(path.dirname(securePath), { recursive: true });
    await fsp.writeFile(securePath, content);

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('Scenario 8: mismatched AAD (storage key relocation attack) emits ZERO plaintext bytes', async () => {
    const userA = 'patient_victim_aad';
    const userB = 'patient_attacker_aad';

    const keyA = generateStorageKey(userA, '.pdf');
    const keyB = generateStorageKey(userB, '.pdf');

    const contentA = Buffer.from('%PDF-1.4 Victim Highly Sensitive Psychiatric History');
    await driver.writeStream(keyA, Readable.from(contentA));

    const pathA = await driver.getValidatedDiskPath(keyA);
    const pathB = driver.resolveSecurePath(keyB);

    // Attacker copies Victim's ciphertext file into Attacker's path
    await fsp.mkdir(path.dirname(pathB), { recursive: true });
    await fsp.copyFile(pathA, pathB);

    // Attempting to read under keyB must fail GCM authentication because storageKey is bound in AAD
    await expect(driver.readStream(keyB)).rejects.toThrow(StorageSecurityError);
  });

  it('Scenario 9: unknown or wrong encryption key emits ZERO plaintext bytes', async () => {
    const storageKey = generateStorageKey('patient_wrong_key', '.pdf');
    const content = Buffer.from('%PDF-1.4 Encrypted under primary key');

    await driver.writeStream(storageKey, Readable.from(content));

    // Create a new driver instance with a completely different encryption key
    const differentKey = crypto.randomBytes(32);
    const foreignDriver = new LocalStorageDriver({
      customStorageDir: testStorageDir,
      keyring: new Map([['k001', differentKey]]),
      activeKeyId: 'k001',
    });

    await expect(foreignDriver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('Scenario 10: quarantine files are cleaned up immediately on authentication failure or stream end', async () => {
    const tempDir = path.join(testStorageDir, '.tmp');
    const storageKey = generateStorageKey('patient_quarantine_test', '.pdf');
    const content = Buffer.from('%PDF-1.4 Epinephrine Dose Response Study');

    await driver.writeStream(storageKey, Readable.from(content));

    // Check tempDir before read
    const beforeEntries = await fsp.readdir(tempDir);
    expect(beforeEntries.filter((f) => f.includes('quarantine')).length).toBe(0);

    // Read and fully consume verified stream
    const { stream } = await driver.readStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(content)).toBe(true);

    // Wait a brief tick for stream close cleanup
    await new Promise((r) => setTimeout(r, 50));

    // Verify quarantine file was unlinked
    const afterEntries = await fsp.readdir(tempDir);
    expect(afterEntries.filter((f) => f.includes('quarantine')).length).toBe(0);

    // Now corrupt file and verify quarantine file is deleted immediately on error
    const diskPath = await driver.getValidatedDiskPath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);
    diskBytes[45] ^= 0x99;
    await fsp.writeFile(diskPath, diskBytes);

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);

    const afterFailEntries = await fsp.readdir(tempDir);
    expect(afterFailEntries.filter((f) => f.includes('quarantine')).length).toBe(0);
  });
});
