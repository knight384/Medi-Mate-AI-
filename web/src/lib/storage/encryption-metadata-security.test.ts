import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  LocalStorageDriver,
  StorageSecurityError,
  validateKeyId,
  MAGIC_HEADER_V2,
  MAGIC_HEADER_V3,
  HEADER_SIZE_V2,
  HEADER_SIZE_V3,
} from './local-driver';
import { generateStorageKey } from './naming';
import { Readable } from 'node:stream';

describe('Part F — Versioned Encryption Metadata & Security Verification (Checkpoint 5D.25)', () => {
  let testStorageDir: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    testStorageDir = path.join(os.tmpdir(), `medimate-meta-test-${crypto.randomUUID()}`);
    await fsp.mkdir(testStorageDir, { recursive: true, mode: 0o700 });
    driver = new LocalStorageDriver({ customStorageDir: testStorageDir });
    await driver.init();
  });

  afterEach(async () => {
    try {
      await fsp.rm(testStorageDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('validates key identifiers strictly and rejects path traversal, null bytes, and malicious lookup attempts', () => {
    // Valid identifiers
    expect(() => validateKeyId('k001')).not.toThrow();
    expect(() => validateKeyId('key_prod_2026')).not.toThrow();
    expect(() => validateKeyId('K-99-alpha')).not.toThrow();

    // Path traversal attempts
    expect(() => validateKeyId('../k001')).toThrow(StorageSecurityError);
    expect(() => validateKeyId('..\\k001')).toThrow(StorageSecurityError);
    expect(() => validateKeyId('/etc/passwd')).toThrow(StorageSecurityError);
    expect(() => validateKeyId('keys/sub/k001')).toThrow(StorageSecurityError);

    // Null bytes and control characters
    expect(() => validateKeyId('k001\x00evil')).toThrow(StorageSecurityError);
    expect(() => validateKeyId('k001\n')).toThrow(StorageSecurityError);
    expect(() => validateKeyId('')).toThrow(StorageSecurityError);
    expect(() => validateKeyId('   ')).toThrow(StorageSecurityError);
  });

  it('enforces exact header geometry: 12-byte nonce, 16-byte tag, 8-byte magic, 4-byte keyId for MM_ENC03', async () => {
    const storageKey = generateStorageKey('patient_geom_test', '.pdf');
    const content = Buffer.from('%PDF-1.4 Header Geometry Verification');

    await driver.writeStream(storageKey, Readable.from(content));

    const physicalPath = await driver.getValidatedDiskPath(storageKey);
    const fh = await fsp.open(physicalPath, 'r');
    const headerBuf = Buffer.alloc(HEADER_SIZE_V3);
    await fh.read(headerBuf, 0, HEADER_SIZE_V3, 0);
    await fh.close();

    // Magic: 8 bytes
    expect(headerBuf.subarray(0, 8).equals(MAGIC_HEADER_V3)).toBe(true);
    // KeyId: 4 bytes
    const keyId = headerBuf.subarray(8, 12).toString('ascii').trim();
    expect(keyId).toBe('k001');
    // Nonce: exactly 12 bytes
    const nonce = headerBuf.subarray(12, 24);
    expect(nonce.length).toBe(12);
    // Auth Tag: exactly 16 bytes
    const authTag = headerBuf.subarray(24, 40);
    expect(authTag.length).toBe(16);
  });

  it('fails closed on unknown key identifiers', async () => {
    const storageKey = generateStorageKey('patient_unknown_key', '.pdf');

    // Create file with unknown keyId in header
    const physicalPath = driver.resolveSecurePath(storageKey);
    await fsp.mkdir(path.dirname(physicalPath), { recursive: true });

    const keyIdBuf = Buffer.alloc(4);
    keyIdBuf.write('k999', 0, 4, 'ascii'); // Unknown key ID
    const fakeHeader = Buffer.concat([
      MAGIC_HEADER_V3,
      keyIdBuf,
      crypto.randomBytes(12),
      crypto.randomBytes(16),
      Buffer.from('CIPHERTEXT_BYTES'),
    ]);
    await fsp.writeFile(physicalPath, fakeHeader);

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
    await expect(driver.readStream(storageKey)).rejects.toThrow(/Unknown encryption key identifier/);
  });

  it('fails closed on malformed or truncated headers without releasing plaintext', async () => {
    const storageKey = generateStorageKey('patient_truncated_hdr', '.pdf');
    const physicalPath = driver.resolveSecurePath(storageKey);
    await fsp.mkdir(path.dirname(physicalPath), { recursive: true });

    // Truncated header (only 10 bytes)
    await fsp.writeFile(physicalPath, Buffer.from('MM_ENC0312'));

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('enforces storage key AAD binding: relocation attack produces authentication failure and zero plaintext', async () => {
    const keyAlice = generateStorageKey('alice_patient', '.pdf');
    const keyEve = generateStorageKey('eve_attacker', '.pdf');

    const sensitiveContent = Buffer.from('%PDF-1.4 Alice Highly Confidential Psychiatric Chart');
    await driver.writeStream(keyAlice, Readable.from(sensitiveContent));

    const pathAlice = await driver.getValidatedDiskPath(keyAlice);
    const pathEve = driver.resolveSecurePath(keyEve);

    // Eve copies Alice's encrypted file into Eve's path
    await fsp.mkdir(path.dirname(pathEve), { recursive: true });
    await fsp.copyFile(pathAlice, pathEve);

    // Reading under Eve's key MUST fail because storageKey was bound in AAD
    await expect(driver.readStream(keyEve)).rejects.toThrow(StorageSecurityError);
    await expect(driver.readStream(keyEve)).rejects.toThrow(/Cryptographic authentication failed/);
  });

  it('preserves backward-compatible reads for legacy MM_ENC02 documents', async () => {
    const storageKey = generateStorageKey('patient_v2_compat', '.pdf');
    const content = Buffer.from('%PDF-1.4 Legacy MM_ENC02 Historical Record');

    await driver.writeStream(storageKey, Readable.from(content), undefined, {
      version: 'MM_ENC02',
    });

    const physicalPath = await driver.getValidatedDiskPath(storageKey);
    const stat = await fsp.stat(physicalPath);
    expect(stat.size).toBeGreaterThanOrEqual(HEADER_SIZE_V2);

    const fh = await fsp.open(physicalPath, 'r');
    const magicBuf = Buffer.alloc(8);
    await fh.read(magicBuf, 0, 8, 0);
    await fh.close();
    expect(magicBuf.equals(MAGIC_HEADER_V2)).toBe(true);

    // Read stream must seamlessly decrypt MM_ENC02
    const readBack = await driver.readBuffer(storageKey);
    expect(readBack.equals(content)).toBe(true);
  });
});
