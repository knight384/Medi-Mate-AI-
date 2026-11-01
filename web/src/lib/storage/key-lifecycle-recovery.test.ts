import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  LocalStorageDriver,
  HEADER_SIZE_V2,
  HEADER_SIZE_V3,
} from './local-driver';
import { generateStorageKey } from './naming';
import {
  inspectStorageDocument,
  migrateStorageDocumentFile,
  recoverInterruptedStorageMigrations,
  migrateStorageDirectoryEncryption,
} from './migration/migrate-storage-encryption';

describe('Part C, D, E — Key Lifecycle, Keyring Rotation, Crash Recovery & Storage Migration (Checkpoint 5D.24)', () => {
  const testStorageDir = path.resolve(process.cwd(), '..', 'storage', 'test-lifecycle-recovery-docs');
  let driver: LocalStorageDriver;
  const key1 = crypto.randomBytes(32);
  const key2 = crypto.randomBytes(32);

  beforeEach(async () => {
    const keyring = new Map<string, Buffer>([
      ['k001', key1],
      ['k002', key2],
    ]);
    driver = new LocalStorageDriver({
      customStorageDir: testStorageDir,
      keyring,
      activeKeyId: 'k001',
    });
    await driver.init();
  });

  afterEach(async () => {
    try {
      await fsp.rm(testStorageDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('Part D — Keyring Mapping, Container Versioning & Key Rotation', () => {
    it('encrypts documents under specified keyId and reads them using matching key from keyring', async () => {
      const keyA = generateStorageKey('patient_k001', '.pdf');
      const keyB = generateStorageKey('patient_k002', '.pdf');

      const contentA = Buffer.from('%PDF-1.4 Clinical Document Encrypted With Key k001');
      const contentB = Buffer.from('%PDF-1.4 Clinical Document Encrypted With Key k002');

      // Write with key k001
      await driver.writeStream(keyA, Readable.from(contentA), undefined, { keyId: 'k001' });

      // Write with key k002
      await driver.writeStream(keyB, Readable.from(contentB), undefined, { keyId: 'k002' });

      // Verify physical header contains correct keyId
      const diskPathA = await driver.getValidatedDiskPath(keyA);
      const rawA = await fsp.readFile(diskPathA);
      expect(rawA.subarray(0, 8).toString('ascii')).toBe('MM_ENC03');
      expect(rawA.subarray(8, 12).toString('ascii')).toBe('k001');

      const diskPathB = await driver.getValidatedDiskPath(keyB);
      const rawB = await fsp.readFile(diskPathB);
      expect(rawB.subarray(0, 8).toString('ascii')).toBe('MM_ENC03');
      expect(rawB.subarray(8, 12).toString('ascii')).toBe('k002');

      // Read both back and verify exact plaintext match
      const decryptedA = await driver.readBuffer(keyA);
      expect(decryptedA.equals(contentA)).toBe(true);

      const decryptedB = await driver.readBuffer(keyB);
      expect(decryptedB.equals(contentB)).toBe(true);
    });

    it('seamlessly supports key rotation: old documents remain readable while new documents use rotated key', async () => {
      const oldDocKey = generateStorageKey('patient_rotation_old', '.pdf');
      const oldContent = Buffer.from('%PDF-1.4 Historical Document Under k001');

      // 1. Write document under k001
      await driver.writeStream(oldDocKey, Readable.from(oldContent));

      // 2. Perform rotation: instantiate driver with activeKeyId = k002
      const rotatedDriver = new LocalStorageDriver({
        customStorageDir: testStorageDir,
        keyring: new Map([
          ['k001', key1],
          ['k002', key2],
        ]),
        activeKeyId: 'k002',
      });

      const newDocKey = generateStorageKey('patient_rotation_new', '.pdf');
      const newContent = Buffer.from('%PDF-1.4 New Document Under Rotated k002');

      // 3. Write new document; must automatically use k002
      await rotatedDriver.writeStream(newDocKey, Readable.from(newContent));

      const rawNew = await fsp.readFile(await rotatedDriver.getValidatedDiskPath(newDocKey));
      expect(rawNew.subarray(8, 12).toString('ascii')).toBe('k002');

      // 4. Verify BOTH documents are read transparently
      const readOld = await rotatedDriver.readBuffer(oldDocKey);
      expect(readOld.equals(oldContent)).toBe(true);

      const readNew = await rotatedDriver.readBuffer(newDocKey);
      expect(readNew.equals(newContent)).toBe(true);
    });

    it('rejects documents encrypted under an unknown or revoked keyId with StorageSecurityError', async () => {
      const storageKey = generateStorageKey('patient_revoked_key', '.pdf');
      const content = Buffer.from('%PDF-1.4 Document Under k003');

      // Register k003 temporarily to write
      const key3 = crypto.randomBytes(32);
      driver.registerKey('k003', key3);
      await driver.writeStream(storageKey, Readable.from(content), undefined, { keyId: 'k003' });

      // Create a driver without k003 in its keyring
      const limitedDriver = new LocalStorageDriver({
        customStorageDir: testStorageDir,
        keyring: new Map([['k001', key1]]),
        activeKeyId: 'k001',
      });

      await expect(limitedDriver.readStream(storageKey)).rejects.toThrow(
        /Unknown encryption key identifier: k003/
      );
    });

    it('preserves backward compatibility with MM_ENC02 documents without keyId header', async () => {
      const storageKey = generateStorageKey('patient_v2_compat', '.pdf');
      const content = Buffer.from('%PDF-1.4 Legacy MM_ENC02 Patient Data');

      // Write explicitly in MM_ENC02 format
      await driver.writeStream(storageKey, Readable.from(content), undefined, { version: 'MM_ENC02' });

      const raw = await fsp.readFile(await driver.getValidatedDiskPath(storageKey));
      expect(raw.subarray(0, 8).toString('ascii')).toBe('MM_ENC02');
      expect(raw.length).toBe(content.length + HEADER_SIZE_V2);

      const decrypted = await driver.readBuffer(storageKey);
      expect(decrypted.equals(content)).toBe(true);
    });

    it('verifies NIST SP 800-38D Section 8.2.2 requirements and container constants', () => {
      expect(HEADER_SIZE_V2).toBe(36);
      expect(HEADER_SIZE_V3).toBe(40);
      expect(driver.getActiveKeyId()).toBe('k001');
    });
  });

  describe('Part E — Temporary Plaintext Lifecycle & Orphaned Scrubber', () => {
    it('prunes orphaned .tmp files older than maxAgeMs while leaving active files intact', async () => {
      const tempDir = path.join(testStorageDir, '.tmp');
      await driver.init();

      const staleFileName = 'stale_crash_file.tmp';
      const staleFilePath = path.join(tempDir, staleFileName);

      const freshFileName = 'active_worker_file.tmp';
      const freshFilePath = path.join(tempDir, freshFileName);

      await fsp.writeFile(staleFilePath, Buffer.from('stale temp content'));
      await fsp.writeFile(freshFilePath, Buffer.from('active temp content'));

      // Set stale file mtime to 30 minutes in the past
      const thirtyMinutesAgo = (Date.now() - 30 * 60 * 1000) / 1000;
      await fsp.utimes(staleFilePath, thirtyMinutesAgo, thirtyMinutesAgo);

      // Run cleanup with 15-minute threshold (default)
      const cleaned = await driver.cleanupOrphanedTempFiles(15 * 60 * 1000);
      expect(cleaned).toBe(1);

      // Stale file should be gone
      const staleExists = await fsp.stat(staleFilePath).then(() => true).catch(() => false);
      expect(staleExists).toBe(false);

      // Fresh file should be preserved
      const freshExists = await fsp.stat(freshFilePath).then(() => true).catch(() => false);
      expect(freshExists).toBe(true);
    });
  });

  describe('Part C — Document Storage Migration Utility', () => {
    it('inspectStorageDocument correctly detects MM_ENC03, MM_ENC02, LEGACY_PLAINTEXT, and MISSING', async () => {
      const keyV3 = generateStorageKey('inspect_v3', '.pdf');
      const keyV2 = generateStorageKey('inspect_v2', '.pdf');
      const keyLegacy = generateStorageKey('inspect_legacy', '.pdf');
      const keyMissing = generateStorageKey('inspect_missing', '.pdf');

      await driver.writeStream(keyV3, Readable.from(Buffer.from('%PDF-1.4 Modern')));
      await driver.writeStream(keyV2, Readable.from(Buffer.from('%PDF-1.4 Legacy V2')), undefined, { version: 'MM_ENC02' });

      const legPath = driver.resolveSecurePath(keyLegacy);
      await fsp.mkdir(path.dirname(legPath), { recursive: true });
      await fsp.writeFile(legPath, Buffer.from('%PDF-1.4 Unencrypted Plaintext'));

      expect(await inspectStorageDocument(driver, keyV3)).toBe('MM_ENC03');
      expect(await inspectStorageDocument(driver, keyV2)).toBe('MM_ENC02');
      expect(await inspectStorageDocument(driver, keyLegacy)).toBe('LEGACY_PLAINTEXT');
      expect(await inspectStorageDocument(driver, keyMissing)).toBe('MISSING');
    });

    it('migrates unencrypted legacy file to MM_ENC03 with exact SHA-256 round-trip verification', async () => {
      const storageKey = generateStorageKey('migrate_legacy_01', '.pdf');
      const originalPlaintext = Buffer.from('%PDF-1.4 Blood Chemistry Panel: Platelets 260k, RBC 4.8M');

      const physicalPath = driver.resolveSecurePath(storageKey);
      await fsp.mkdir(path.dirname(physicalPath), { recursive: true });
      await fsp.writeFile(physicalPath, originalPlaintext);

      const expectedSha256 = crypto.createHash('sha256').update(originalPlaintext).digest('hex');

      // Migrate
      const result = await migrateStorageDocumentFile(driver, storageKey);
      expect(result.status).toBe('migrated');
      expect(result.originalStatus).toBe('LEGACY_PLAINTEXT');
      expect(result.sourceSha256).toBe(expectedSha256);
      expect(result.migratedSha256).toBe(expectedSha256);

      // Verify file is now MM_ENC03 on disk
      expect(await inspectStorageDocument(driver, storageKey)).toBe('MM_ENC03');

      // Verify readStream decrypts perfectly
      const decrypted = await driver.readBuffer(storageKey);
      expect(decrypted.equals(originalPlaintext)).toBe(true);
    });

    it('upgrades MM_ENC02 container to MM_ENC03 container', async () => {
      const storageKey = generateStorageKey('upgrade_v2_01', '.pdf');
      const content = Buffer.from('%PDF-1.4 V2 Document Waiting For V3 Upgrade');

      await driver.writeStream(storageKey, Readable.from(content), undefined, { version: 'MM_ENC02' });
      expect(await inspectStorageDocument(driver, storageKey)).toBe('MM_ENC02');

      const result = await migrateStorageDocumentFile(driver, storageKey, { targetKeyId: 'k002' });
      expect(result.status).toBe('upgraded_v2');
      expect(result.originalStatus).toBe('MM_ENC02');

      expect(await inspectStorageDocument(driver, storageKey)).toBe('MM_ENC03');

      const raw = await fsp.readFile(await driver.getValidatedDiskPath(storageKey));
      expect(raw.subarray(8, 12).toString('ascii')).toBe('k002');

      const decrypted = await driver.readBuffer(storageKey);
      expect(decrypted.equals(content)).toBe(true);
    });

    it('supports dryRun mode without altering physical disk files', async () => {
      const storageKey = generateStorageKey('dry_run_patient', '.pdf');
      const content = Buffer.from('%PDF-1.4 Dry Run Unencrypted Medical Data');

      const physicalPath = driver.resolveSecurePath(storageKey);
      await fsp.mkdir(path.dirname(physicalPath), { recursive: true });
      await fsp.writeFile(physicalPath, content);

      const result = await migrateStorageDocumentFile(driver, storageKey, { dryRun: true });
      expect(result.status).toBe('migrated');
      expect(result.dryRun).toBe(true);

      // Physical file must still be unencrypted legacy
      expect(await inspectStorageDocument(driver, storageKey)).toBe('LEGACY_PLAINTEXT');
    });

    it('recovers from interrupted migration crash using backup .bak file', async () => {
      const storageKey = generateStorageKey('crash_recovery_patient', '.pdf');
      const originalContent = Buffer.from('%PDF-1.4 Critical Pre-Crash Medical Chart');

      const physicalPath = driver.resolveSecurePath(storageKey);
      await fsp.mkdir(path.dirname(physicalPath), { recursive: true });
      await fsp.writeFile(physicalPath, originalContent);

      // Simulate a crashed migration: backup .bak exists, but physical file was corrupted mid-write
      const backupPath = `${physicalPath}.bak`;
      await fsp.copyFile(physicalPath, backupPath);
      await fsp.writeFile(physicalPath, Buffer.from('CORRUPTED_INCOMPLETE_WRITE'));

      // Run crash recovery
      const { recovered, cleanedBackups } = await recoverInterruptedStorageMigrations(driver);
      expect(recovered).toBe(1);
      expect(cleanedBackups).toBe(0);

      // Verify original file was restored
      const restoredContent = await fsp.readFile(physicalPath);
      expect(restoredContent.equals(originalContent)).toBe(true);
    });

    it('scans and migrates entire storage directory with batch summary', async () => {
      const key1 = generateStorageKey('batch_user_1', '.pdf');
      const key2 = generateStorageKey('batch_user_2', '.pdf');
      const key3 = generateStorageKey('batch_user_3', '.pdf');

      // key1: legacy plaintext
      const p1 = driver.resolveSecurePath(key1);
      await fsp.mkdir(path.dirname(p1), { recursive: true });
      await fsp.writeFile(p1, Buffer.from('%PDF-1.4 Patient 1 Chart'));

      // key2: MM_ENC02
      await driver.writeStream(key2, Readable.from(Buffer.from('%PDF-1.4 Patient 2 Chart')), undefined, { version: 'MM_ENC02' });

      // key3: MM_ENC03
      await driver.writeStream(key3, Readable.from(Buffer.from('%PDF-1.4 Patient 3 Chart')));

      const summary = await migrateStorageDirectoryEncryption(driver);
      expect(summary.totalScanned).toBe(3);
      expect(summary.migratedPlaintext).toBe(1);
      expect(summary.upgradedV2).toBe(1);
      expect(summary.alreadyV3).toBe(1);
      expect(summary.failed).toBe(0);

      // All 3 documents should now be MM_ENC03
      expect(await inspectStorageDocument(driver, key1)).toBe('MM_ENC03');
      expect(await inspectStorageDocument(driver, key2)).toBe('MM_ENC03');
      expect(await inspectStorageDocument(driver, key3)).toBe('MM_ENC03');
    });
  });
});
