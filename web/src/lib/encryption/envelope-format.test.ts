import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  MAGIC_HEADER_V4,
  KMSProviderType,
  serializeEnvelopeHeaderV4,
  parseEnvelopeHeaderV4,
  computeEnvelopeAAD,
  getAuthTagOffsetV4,
} from './envelope-format';
import { LocalStorageDriver, StorageSecurityError } from '@/lib/storage/local-driver';
import { LocalSyntheticKMSAdapter } from './kms-adapter';
import { generateStorageKey } from '@/lib/storage/naming';

describe('Envelope Encryption MM_ENC04 & Multi-Format Compatibility', () => {
  let tempDir: string;
  let driver: LocalStorageDriver;
  let syntheticKms: LocalSyntheticKMSAdapter;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mm_enc04_test_'));
    syntheticKms = new LocalSyntheticKMSAdapter();
    driver = new LocalStorageDriver({
      customStorageDir: tempDir,
      kmsClient: syntheticKms,
    });
    await driver.init();
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('serializes and parses MM_ENC04 header correctly', () => {
    const wrappedDek = crypto.randomBytes(64);
    const nonce = crypto.randomBytes(12);
    const authTag = crypto.randomBytes(16);
    const keyId = 'arn:aws:kms:us-east-1:123456789012:key/test-key-uuid';

    const headerBuf = serializeEnvelopeHeaderV4(
      KMSProviderType.AWS_KMS,
      keyId,
      wrappedDek,
      nonce,
      authTag
    );

    expect(headerBuf.subarray(0, 8)).toEqual(MAGIC_HEADER_V4);

    const parsed = parseEnvelopeHeaderV4(headerBuf);
    expect(parsed.magic).toBe('MM_ENC04');
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.providerType).toBe(KMSProviderType.AWS_KMS);
    expect(parsed.keyId).toBe(keyId);
    expect(parsed.wrappedDek).toEqual(wrappedDek);
    expect(parsed.nonce).toEqual(nonce);
    expect(parsed.authTag).toEqual(authTag);
    expect(parsed.headerLength).toBe(headerBuf.length);
  });

  it('calculates correct auth tag offset for arbitrary key and DEK lengths', () => {
    const keyIdLen = 45;
    const dekLen = 72;
    const offset = getAuthTagOffsetV4(keyIdLen, dekLen);

    // Header layout: 8 (magic) + 1 (ver) + 1 (pid) + 2 (klen) + keyIdLen + 2 (wlen) + dekLen + 12 (nonce)
    expect(offset).toBe(8 + 1 + 1 + 2 + 45 + 2 + 72 + 12);
  });

  it('fails parsing if MM_ENC04 header is truncated or has invalid magic', () => {
    const tooSmall = Buffer.from('SHORT');
    expect(() => parseEnvelopeHeaderV4(tooSmall)).toThrow(StorageSecurityError);

    const badMagic = Buffer.alloc(50);
    badMagic.write('BADMAGIC', 0);
    expect(() => parseEnvelopeHeaderV4(badMagic)).toThrow('Invalid header: magic mismatch for MM_ENC04');
  });

  it('computes canonical AAD binding storage key, provider, and keyId', () => {
    const aad1 = computeEnvelopeAAD('users/patient_1/chart.pdf', KMSProviderType.AWS_KMS, 'arn:key1');
    const aad2 = computeEnvelopeAAD('users/patient_2/chart.pdf', KMSProviderType.AWS_KMS, 'arn:key1');
    const aad3 = computeEnvelopeAAD('users/patient_1/chart.pdf', KMSProviderType.LOCAL_SYNTHETIC, 'arn:key1');

    expect(aad1.toString('utf8')).toBe('MM_ENC04|PID:1|KID:arn:key1|KEY:users/patient_1/chart.pdf');
    expect(aad1.equals(aad2)).toBe(false);
    expect(aad1.equals(aad3)).toBe(false);
  });

  it('writes and reads MM_ENC04 envelope document using LocalStorageDriver', async () => {
    const storageKey = generateStorageKey('patient_v4', '.pdf');
    const originalData = Buffer.from('%PDF-1.7 Clinical Lab Panel with Sensitive CBC Details');

    const meta = await driver.writeStream(storageKey, originalData, undefined, {
      version: 'MM_ENC04',
      keyId: 'kek-v1',
    });

    expect(meta.storageKey).toBe(storageKey);
    expect(meta.size).toBe(originalData.length);

    // Verify written file starts with MM_ENC04 magic
    const diskPath = driver.resolveSecurePath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);
    expect(diskBytes.subarray(0, 8).toString('ascii')).toBe('MM_ENC04');

    // Read back through verified pipeline
    const readResult = await driver.readStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of readResult.stream) {
      chunks.push(Buffer.from(chunk));
    }
    const readPlaintext = Buffer.concat(chunks);
    expect(readPlaintext.equals(originalData)).toBe(true);
  });

  it('rejects relocation attack: moving an MM_ENC04 file to another key fails authentication', async () => {
    const key1 = generateStorageKey('patient_alice', '.pdf');
    const key2 = generateStorageKey('patient_bob', '.pdf');
    const sensitiveData = Buffer.from('Patient Alice Confidential Oncology Report');

    await driver.writeStream(key1, sensitiveData, undefined, {
      version: 'MM_ENC04',
      keyId: 'kek-v1',
    });

    // Adversary copies Alice's encrypted file to Bob's path
    const alicePath = driver.resolveSecurePath(key1);
    const bobPath = driver.resolveSecurePath(key2);
    await fsp.mkdir(path.dirname(bobPath), { recursive: true });
    await fsp.copyFile(alicePath, bobPath);

    // Reading Bob's path must fail authentication because AAD binds key1, not key2!
    await expect(driver.readStream(key2)).rejects.toThrow(StorageSecurityError);
  });

  it('rejects tampered ciphertext in MM_ENC04 document without releasing plaintext', async () => {
    const storageKey = generateStorageKey('patient_tamper', '.pdf');
    const originalData = Buffer.from('Genuine Uncompromised Patient Blood Chemistry');

    await driver.writeStream(storageKey, originalData, undefined, {
      version: 'MM_ENC04',
      keyId: 'kek-v1',
    });

    const diskPath = driver.resolveSecurePath(storageKey);
    const diskBytes = await fsp.readFile(diskPath);

    // Flip bits in the ciphertext portion (after header)
    diskBytes[diskBytes.length - 5] ^= 0xff;
    await fsp.writeFile(diskPath, diskBytes);

    await expect(driver.readStream(storageKey)).rejects.toThrow(StorageSecurityError);
  });

  it('seamlessly preserves backward compatibility reading MM_ENC03 and MM_ENC02 documents', async () => {
    const keyV3 = generateStorageKey('patient_v3', '.pdf');
    const keyV2 = generateStorageKey('patient_v2', '.pdf');
    const dataV3 = Buffer.from('Document written in MM_ENC03 format');
    const dataV2 = Buffer.from('Document written in MM_ENC02 format');

    await driver.writeStream(keyV3, dataV3, undefined, { version: 'MM_ENC03' });
    await driver.writeStream(keyV2, dataV2, undefined, { version: 'MM_ENC02' });

    // Read back MM_ENC03
    const resV3 = await driver.readStream(keyV3);
    const chunksV3: Buffer[] = [];
    for await (const chunk of resV3.stream) chunksV3.push(Buffer.from(chunk));
    expect(Buffer.concat(chunksV3).equals(dataV3)).toBe(true);

    // Read back MM_ENC02
    const resV2 = await driver.readStream(keyV2);
    const chunksV2: Buffer[] = [];
    for await (const chunk of resV2.stream) chunksV2.push(Buffer.from(chunk));
    expect(Buffer.concat(chunksV2).equals(dataV2)).toBe(true);
  });
});
