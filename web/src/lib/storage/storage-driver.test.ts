import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  LocalStorageDriver,
  StorageSecurityError,
  safeBasename,
  generateStorageKey,
  isValidStorageKey,
  isPermittedDocument,
} from './index';
import { NotFoundError } from '@/lib/errors';

describe('LocalStorageDriver & Storage Security Boundaries', () => {
  const testStorageDir = path.resolve(process.cwd(), '..', 'storage', 'test-documents');
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

  it('generates opaque random storage keys decoupled from client filenames', () => {
    const userId = 'user_abc123';
    const key1 = generateStorageKey(userId, '.pdf');
    const key2 = generateStorageKey(userId, '.pdf');

    expect(key1).not.toBe(key2);
    expect(isValidStorageKey(key1)).toBe(true);
    expect(isValidStorageKey(key2)).toBe(true);
    expect(key1).toMatch(/^users\/user_abc123\/[a-f0-9-]+\.pdf$/);
  });

  it('sanitizes client filenames and strips traversal characters (safeBasename)', () => {
    expect(safeBasename('../../../etc/passwd')).toBe('passwd');
    expect(safeBasename('..\\..\\windows\\win.ini')).toBe('win.ini');
    expect(safeBasename('valid-report.pdf')).toBe('valid-report.pdf');
    expect(safeBasename('   spaced-name.pdf   ')).toBe('spaced-name.pdf');
    expect(safeBasename('..')).toBe('');
    expect(safeBasename('.')).toBe('');
    expect(safeBasename(null)).toBe('');
  });

  it('rejects path traversal attempts in storage keys', () => {
    const maliciousKeys = [
      'users/user_1/../../etc/passwd',
      'users/user_1/..\\windows\\calc.exe',
      '/etc/shadow',
      '..',
      'users/user_1/test/nested/file.pdf',
    ];

    for (const key of maliciousKeys) {
      expect(isValidStorageKey(key)).toBe(false);
      expect(() => driver.resolveSecurePath(key)).toThrow(StorageSecurityError);
    }
  });

  it('fails closed if storage root is configured inside the public directory', () => {
    const publicDir = path.resolve(process.cwd(), 'public', 'uploads');
    expect(() => new LocalStorageDriver(publicDir)).toThrow(StorageSecurityError);
  });

  it('writes streams atomically and computes accurate SHA-256 and size', async () => {
    const content = '%PDF-1.4 Synthetic Medical Report Content for Testing';
    const contentBuffer = Buffer.from(content, 'utf-8');
    const expectedSha256 = crypto.createHash('sha256').update(contentBuffer).digest('hex');

    const storageKey = generateStorageKey('patient_01', '.pdf');
    const stream = Readable.from(contentBuffer);

    const metadata = await driver.writeStream(storageKey, stream);

    expect(metadata.storageKey).toBe(storageKey);
    expect(metadata.size).toBe(contentBuffer.length);
    expect(metadata.sha256).toBe(expectedSha256);
    expect(metadata.mimeType).toBe('application/pdf');

    // Verify file exists on disk
    expect(await driver.exists(storageKey)).toBe(true);

    // Read back stream and verify exact bytes
    const readResult = await driver.readStream(storageKey);
    expect(readResult.size).toBe(contentBuffer.length);
    expect(readResult.mimeType).toBe('application/pdf');

    const chunks: Buffer[] = [];
    for await (const chunk of readResult.stream) {
      chunks.push(chunk);
    }
    const readBuffer = Buffer.concat(chunks);
    expect(readBuffer.toString('utf-8')).toBe(content);
  });

  it('cleans up temporary files when write stream exceeds maximum size', async () => {
    const storageKey = generateStorageKey('patient_02', '.pdf');
    const largeChunk = Buffer.alloc(1024, 'a');
    const stream = new Readable({
      read() {
        this.push(largeChunk);
      },
    });

    // Max 500 bytes allowed
    await expect(
      driver.writeStream(storageKey, stream, 500)
    ).rejects.toThrow(/Upload size exceeded/);

    // File must not exist in destination
    expect(await driver.exists(storageKey)).toBe(false);

    // Temp directory must not have orphaned files
    const tempDir = path.join(testStorageDir, '.tmp');
    const tempFiles = await fsp.readdir(tempDir);
    expect(tempFiles).toHaveLength(0);
  });

  it('deletes files idempotently and handles missing files safely', async () => {
    const storageKey = generateStorageKey('patient_03', '.pdf');
    const stream = Readable.from(Buffer.from('temporary report', 'utf-8'));
    await driver.writeStream(storageKey, stream);

    expect(await driver.exists(storageKey)).toBe(true);

    // First delete returns true
    expect(await driver.delete(storageKey)).toBe(true);
    expect(await driver.exists(storageKey)).toBe(false);

    // Second delete returns false without throwing
    expect(await driver.delete(storageKey)).toBe(false);
  });

  it('throws NotFoundError when reading non-existent storage keys', async () => {
    const nonExistentKey = generateStorageKey('patient_99', '.pdf');
    await expect(driver.readStream(nonExistentKey)).rejects.toThrow(NotFoundError);
  });

  it('validates permitted medical document MIME types and blocks hostile files', () => {
    expect(isPermittedDocument('report.pdf', 'application/pdf')).toBe(true);
    expect(isPermittedDocument('scan.png', 'image/png')).toBe(true);
    expect(isPermittedDocument('photo.jpg', 'image/jpeg')).toBe(true);
    expect(isPermittedDocument('xray.webp', 'image/webp')).toBe(true);

    // Blocked extensions
    expect(isPermittedDocument('exploit.exe', 'application/x-msdownload')).toBe(false);
    expect(isPermittedDocument('script.sh', 'application/x-sh')).toBe(false);
    expect(isPermittedDocument('malicious.js', 'application/javascript')).toBe(false);
    expect(isPermittedDocument('vector.svg', 'image/svg+xml')).toBe(false);
  });

  it('prevents silent overwrite and throws StorageSecurityError on collision', async () => {
    const storageKey = generateStorageKey('patient_04', '.pdf');
    await driver.writeStream(storageKey, Readable.from(Buffer.from('first write')));
    await expect(
      driver.writeStream(storageKey, Readable.from(Buffer.from('second write overwrite attempt')))
    ).rejects.toThrow(StorageSecurityError);
  });

  it('fails closed in production environment if persistent storage is not explicitly configured', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDir = process.env.MEDIMATE_STORAGE_DIR;
    const envObj = process.env as Record<string, string | undefined>;
    try {
      envObj.NODE_ENV = 'production';
      delete process.env.MEDIMATE_STORAGE_DIR;
      const unconfiguredDriver = new LocalStorageDriver();
      const storageKey = generateStorageKey('patient_prod', '.pdf');
      await expect(
        unconfiguredDriver.writeStream(storageKey, Readable.from(Buffer.from('data')))
      ).rejects.toThrow(/Production deployment requires an explicitly configured MEDIMATE_STORAGE_DIR/);
    } finally {
      envObj.NODE_ENV = originalEnv;
      if (originalDir) process.env.MEDIMATE_STORAGE_DIR = originalDir;
    }
  });
});
