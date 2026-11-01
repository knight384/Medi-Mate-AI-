import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  LocalStorageDriver,
  StorageSecurityError,
  MAGIC_HEADER_V2,
  MAGIC_HEADER_V3,
  HEADER_SIZE_V2,
  HEADER_SIZE_V3,
} from '../local-driver';
import { logger } from '@/lib/logger';

export type StorageDocumentEncryptionStatus =
  | 'MM_ENC03'
  | 'MM_ENC02'
  | 'LEGACY_PLAINTEXT'
  | 'UNRECOGNIZED_CORRUPT'
  | 'MISSING';

export interface StorageDocumentMigrationItem {
  storageKey: string;
  recordId?: string;
  authorId?: string;
  originalStatus: StorageDocumentEncryptionStatus;
  targetVersion: 'MM_ENC03';
  sourceSha256?: string;
  migratedSha256?: string;
  bytes?: number;
  status: 'migrated' | 'already_v3' | 'upgraded_v2' | 'skipped' | 'failed' | 'rolled_back';
  error?: string;
  dryRun: boolean;
}

export interface StorageEncryptionMigrationSummary {
  totalScanned: number;
  alreadyV3: number;
  upgradedV2: number;
  migratedPlaintext: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
  items: StorageDocumentMigrationItem[];
}

/**
 * Inspects a physical storage key without releasing unauthenticated plaintext to determine its container format.
 */
export async function inspectStorageDocument(
  driver: LocalStorageDriver,
  storageKey: string
): Promise<StorageDocumentEncryptionStatus> {
  let targetPath: string;
  try {
    targetPath = driver.resolveSecurePath(storageKey);
  } catch {
    return 'UNRECOGNIZED_CORRUPT';
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(targetPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'MISSING';
    }
    return 'UNRECOGNIZED_CORRUPT';
  }

  if (!stat.isFile()) {
    return 'UNRECOGNIZED_CORRUPT';
  }

  if (stat.size < HEADER_SIZE_V2) {
    return 'LEGACY_PLAINTEXT';
  }

  const headerBuf = Buffer.alloc(HEADER_SIZE_V3);
  const fh = await fsp.open(targetPath, 'r');
  let bytesRead = 0;
  try {
    const res = await fh.read(headerBuf, 0, HEADER_SIZE_V3, 0);
    bytesRead = res.bytesRead;
  } finally {
    await fh.close();
  }

  if (bytesRead >= HEADER_SIZE_V3 && headerBuf.subarray(0, 8).equals(MAGIC_HEADER_V3)) {
    return 'MM_ENC03';
  }

  if (bytesRead >= HEADER_SIZE_V2 && headerBuf.subarray(0, 8).equals(MAGIC_HEADER_V2)) {
    return 'MM_ENC02';
  }

  return 'LEGACY_PLAINTEXT';
}

/**
 * Migrates a single stored document to authenticated AES-256-GCM MM_ENC03 format.
 * Guarantees round-trip cryptographic verification, atomic replacement, and backup protection.
 */
export async function migrateStorageDocumentFile(
  driver: LocalStorageDriver,
  storageKey: string,
  options: {
    dryRun?: boolean;
    recordId?: string;
    authorId?: string;
    preserveBackup?: boolean;
    targetKeyId?: string;
  } = {}
): Promise<StorageDocumentMigrationItem> {
  const dryRun = options.dryRun ?? false;
  const preserveBackup = options.preserveBackup ?? true;
  const originalStatus = await inspectStorageDocument(driver, storageKey);

  const item: StorageDocumentMigrationItem = {
    storageKey,
    recordId: options.recordId,
    authorId: options.authorId,
    originalStatus,
    targetVersion: 'MM_ENC03',
    status: 'migrated',
    dryRun,
  };

  if (originalStatus === 'MISSING') {
    item.status = 'failed';
    item.error = `File not found at storage key: ${storageKey}`;
    return item;
  }

  if (originalStatus === 'UNRECOGNIZED_CORRUPT') {
    item.status = 'failed';
    item.error = `Storage object at key ${storageKey} is corrupt or not a regular file`;
    return item;
  }

  if (originalStatus === 'MM_ENC03') {
    item.status = 'already_v3';
    return item;
  }

  const isUpgradingV2 = originalStatus === 'MM_ENC02';

  // 1. Read source plaintext securely
  let sourceStream: Readable;

  try {
    if (isUpgradingV2) {
      const readResult = await driver.readStream(storageKey);
      sourceStream = readResult.stream;
    } else {
      const readResult = await driver.readLegacyDocumentForMigration(storageKey);
      sourceStream = readResult.stream;
    }
  } catch (err) {
    item.status = 'failed';
    item.error = `Failed reading source document: ${err instanceof Error ? err.message : String(err)}`;
    return item;
  }

  // Collect source content and compute source SHA-256
  const chunks: Buffer[] = [];
  const sourceHash = crypto.createHash('sha256');

  try {
    for await (const chunk of sourceStream) {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      sourceHash.update(buf);
    }
  } catch (err) {
    item.status = 'failed';
    item.error = `Failed reading source stream chunks: ${err instanceof Error ? err.message : String(err)}`;
    return item;
  }

  const sourceBuffer = Buffer.concat(chunks);
  const sourceSha256 = sourceHash.digest('hex');
  item.sourceSha256 = sourceSha256;
  item.bytes = sourceBuffer.length;

  if (dryRun) {
    item.status = isUpgradingV2 ? 'upgraded_v2' : 'migrated';
    return item;
  }

  // 2. Perform Migration with Quarantine & Atomic Replacement
  await driver.init();
  const tempMigrationKey = `${crypto.randomUUID()}.migration.tmp`;
  const tempMigrationPath = path.join(driver.getStorageRoot(), '.tmp', tempMigrationKey);

  const targetPath = driver.resolveSecurePath(storageKey);
  const backupPath = `${targetPath}.bak`;

  const activeKeyId = options.targetKeyId || driver.getActiveKeyId();
  const activeKey = driver.getKey(activeKeyId);

  // Cryptographic initialization for MM_ENC03
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', activeKey, nonce);
  cipher.setAAD(Buffer.from(storageKey, 'utf8'));

  const keyIdBuf = Buffer.alloc(4);
  keyIdBuf.write(activeKeyId.padEnd(4, ' ').slice(0, 4), 0, 4, 'ascii');

  const headerPlaceholder = Buffer.concat([
    MAGIC_HEADER_V3,
    keyIdBuf,
    nonce,
    Buffer.alloc(16), // Placeholder for 16-byte auth tag
  ]);

  try {
    // Write header placeholder
    await fsp.writeFile(tempMigrationPath, headerPlaceholder, { mode: 0o600, flag: 'wx' });

    // Encrypt ciphertext
    const writeStream = fs.createWriteStream(tempMigrationPath, { flags: 'a', mode: 0o600 });
    const cipherText = Buffer.concat([cipher.update(sourceBuffer), cipher.final()]);
    await pipeline(Readable.from(cipherText), writeStream);

    // Patch authentication tag at offset 24
    const authTag = cipher.getAuthTag();
    const fh = await fsp.open(tempMigrationPath, 'r+');
    try {
      await fh.write(authTag, 0, 16, 24);
      await fh.sync();
    } finally {
      await fh.close();
    }

    // 3. Quarantine Round-Trip Verification
    // Decrypt the newly created temporary file to verify cryptographic round-trip fidelity
    const verifyHeader = Buffer.alloc(HEADER_SIZE_V3);
    const verifyFh = await fsp.open(tempMigrationPath, 'r');
    try {
      await verifyFh.read(verifyHeader, 0, HEADER_SIZE_V3, 0);
    } finally {
      await verifyFh.close();
    }

    const verifyNonce = verifyHeader.subarray(12, 24);
    const verifyTag = verifyHeader.subarray(24, 40);
    const decipher = crypto.createDecipheriv('aes-256-gcm', activeKey, verifyNonce);
    decipher.setAAD(Buffer.from(storageKey, 'utf8'));
    decipher.setAuthTag(verifyTag);

    const verifyCipherStream = fs.createReadStream(tempMigrationPath, { start: HEADER_SIZE_V3 });
    const verifyHash = crypto.createHash('sha256');

    await new Promise<void>((resolve, reject) => {
      verifyCipherStream
        .pipe(decipher)
        .on('data', (d: Buffer) => verifyHash.update(d))
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err));
    });

    const verifiedSha256 = verifyHash.digest('hex');
    item.migratedSha256 = verifiedSha256;

    if (verifiedSha256 !== sourceSha256) {
      throw new StorageSecurityError(
        `Cryptographic mismatch during migration verification: ${verifiedSha256} !== ${sourceSha256}`
      );
    }

    // 4. Atomic Publication with Backup
    // Backup existing file first
    await fsp.copyFile(targetPath, backupPath);

    // Atomically replace target file using rename
    await fsp.rename(tempMigrationPath, targetPath);

    // Unless preservation is requested, unlink the backup file
    if (!preserveBackup) {
      await fsp.unlink(backupPath).catch(() => {});
    }

    item.status = isUpgradingV2 ? 'upgraded_v2' : 'migrated';
    return item;
  } catch (migrationErr) {
    // Cleanup temporary migration file
    await fsp.unlink(tempMigrationPath).catch(() => {});

    // Rollback backup if target file was corrupted or partially replaced
    try {
      const backupExists = await fsp.stat(backupPath).then(() => true).catch(() => false);
      if (backupExists) {
        await fsp.copyFile(backupPath, targetPath);
        if (!preserveBackup) {
          await fsp.unlink(backupPath).catch(() => {});
        }
      }
    } catch (rollbackErr) {
      logger.error('Rollback failed during migration failure', {
        storageKey,
        error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    }

    item.status = 'failed';
    item.error = migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
    return item;
  }
}

/**
 * Recovers interrupted migrations by inspecting leftover .bak files.
 * If the primary file is valid MM_ENC03, removes the .bak file.
 * If the primary file is missing or corrupted, restores from the .bak file.
 */
export async function recoverInterruptedStorageMigrations(
  driver: LocalStorageDriver
): Promise<{ recovered: number; cleanedBackups: number }> {
  let recovered = 0;
  let cleanedBackups = 0;

  async function scanDir(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.tmp') {
          await scanDir(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.bak')) {
        const primaryPath = fullPath.slice(0, -4);
        const relativeKey = path.relative(driver.getStorageRoot(), primaryPath).replace(/\\/g, '/');

        const primaryStatus = await inspectStorageDocument(driver, relativeKey);
        if (primaryStatus === 'MM_ENC03') {
          // Migration completed before backup was unlinked; safe to delete backup
          await fsp.unlink(fullPath).catch(() => {});
          cleanedBackups++;
        } else {
          // Migration crashed or corrupted primary file; restore backup
          await fsp.copyFile(fullPath, primaryPath);
          await fsp.unlink(fullPath).catch(() => {});
          recovered++;
          logger.warn('Restored document from backup after interrupted migration', {
            storageKey: relativeKey,
          });
        }
      }
    }
  }

  try {
    await scanDir(driver.getStorageRoot());
  } catch (err) {
    logger.warn('Failed scanning for interrupted migration backups', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { recovered, cleanedBackups };
}

/**
 * Scans the entire private storage root and migrates all legacy unencrypted or MM_ENC02 documents.
 */
export async function migrateStorageDirectoryEncryption(
  driver: LocalStorageDriver,
  options: {
    dryRun?: boolean;
    preserveBackup?: boolean;
    targetKeyId?: string;
  } = {}
): Promise<StorageEncryptionMigrationSummary> {
  const summary: StorageEncryptionMigrationSummary = {
    totalScanned: 0,
    alreadyV3: 0,
    upgradedV2: 0,
    migratedPlaintext: 0,
    failed: 0,
    skipped: 0,
    dryRun: options.dryRun ?? false,
    items: [],
  };

  // Run recovery pass first
  await recoverInterruptedStorageMigrations(driver);

  // Recursively collect all stored document keys
  const storageKeys: string[] = [];

  async function collectFiles(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.tmp') {
          await collectFiles(fullPath);
        }
      } else if (entry.isFile() && !entry.name.endsWith('.bak') && !entry.name.endsWith('.tmp')) {
        const relativeKey = path.relative(driver.getStorageRoot(), fullPath).replace(/\\/g, '/');
        storageKeys.push(relativeKey);
      }
    }
  }

  await collectFiles(driver.getStorageRoot());

  for (const key of storageKeys) {
    summary.totalScanned++;
    const res = await migrateStorageDocumentFile(driver, key, options);
    summary.items.push(res);

    switch (res.status) {
      case 'already_v3':
        summary.alreadyV3++;
        break;
      case 'upgraded_v2':
        summary.upgradedV2++;
        break;
      case 'migrated':
        summary.migratedPlaintext++;
        break;
      case 'failed':
        summary.failed++;
        break;
      default:
        summary.skipped++;
        break;
    }
  }

  return summary;
}
