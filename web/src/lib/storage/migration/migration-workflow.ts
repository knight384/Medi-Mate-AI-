import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalStorageDriver } from '../local-driver';
import { generateStorageKey, isValidStorageKey } from '../naming';
import {
  HealthDataRecord,
  LegacySourceType,
  MigrationItemResult,
  MigrationBatchSummary,
  MigrationDatabaseAdapter,
  MigrationMetadata,
} from './types';
import { logger } from '@/lib/logger';

export interface MigrationOptions {
  legacyUploadsDir?: string;
  maxBytes?: number;
  dryRun?: boolean;
  dbAdapter?: MigrationDatabaseAdapter;
  /**
   * Mock / test-only provider for historical blob streams.
   * In production or dry-run, live external HTTP requests are never made.
   */
  blobStreamProvider?: (url: string) => Promise<{
    stream: Readable;
    size: number;
    sha256?: string;
    mimeType?: string;
  } | null>;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB ceiling
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

export class LegacyMigrationWorkflow {
  private readonly storageDriver: LocalStorageDriver;
  private readonly legacyUploadsDir: string;
  private readonly maxBytes: number;
  private readonly dryRun: boolean;
  private readonly dbAdapter?: MigrationDatabaseAdapter;
  private readonly blobStreamProvider?: MigrationOptions['blobStreamProvider'];

  constructor(storageDriver: LocalStorageDriver, options: MigrationOptions = {}) {
    this.storageDriver = storageDriver;
    this.legacyUploadsDir = options.legacyUploadsDir
      ? path.resolve(options.legacyUploadsDir)
      : path.resolve(process.cwd(), 'public', 'uploads');
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.dryRun = options.dryRun ?? false;
    this.dbAdapter = options.dbAdapter;
    this.blobStreamProvider = options.blobStreamProvider;
  }

  /**
   * Classifies a health data filePath into its storage category.
   */
  public classifyPath(filePath: string | null | undefined): LegacySourceType {
    if (!filePath || filePath.trim() === '') {
      return 'EMPTY';
    }

    const trimmed = filePath.trim();

    // Already-private storage key: users/<userId>/<uuid>.<ext>
    if (isValidStorageKey(trimmed)) {
      return 'ALREADY_PRIVATE';
    }

    // Historical public Vercel Blob URL
    if (
      trimmed.startsWith('https://') &&
      trimmed.includes('.public.blob.vercel-storage.com')
    ) {
      return 'LEGACY_PUBLIC_BLOB';
    }

    // Legacy static upload path: /uploads/... or uploads/...
    if (
      trimmed.startsWith('/uploads/') ||
      trimmed.startsWith('uploads/') ||
      trimmed.startsWith('/public/uploads/')
    ) {
      // Reject traversal attempts in legacy path
      if (trimmed.includes('..') || trimmed.includes('\\')) {
        return 'UNSUPPORTED';
      }
      return 'LEGACY_LOCAL_UPLOAD';
    }

    // Disallowed protocols or arbitrary paths
    return 'UNSUPPORTED';
  }

  /**
   * Migrates a single HealthData record to private storage.
   */
  public async migrateRecord(
    record: HealthDataRecord,
    actorId: string
  ): Promise<MigrationItemResult> {
    const originalPath = record.filePath;
    const sourceType = this.classifyPath(originalPath);

    const baseResult: MigrationItemResult = {
      recordId: record.id,
      authorId: record.authorId,
      originalFilePath: originalPath,
      sourceType,
      status: 'FAILED_UNSUPPORTED_PATH',
      dryRun: this.dryRun,
    };

    // 1. Author / Ownership Verification
    if (!record.authorId || record.authorId !== actorId) {
      return {
        ...baseResult,
        status: 'FAILED_UNAUTHORIZED',
        error: `Authorization failure: record owner (${record.authorId || 'none'}) does not match actor (${actorId})`,
      };
    }

    // 2. Handle Empty / Missing path
    if (sourceType === 'EMPTY') {
      return {
        ...baseResult,
        status: 'FAILED_NOT_FOUND',
        error: 'Record does not contain an attached file path',
      };
    }

    // 3. Handle Already-Private Key (Idempotent safe skip)
    if (sourceType === 'ALREADY_PRIVATE') {
      if (originalPath && originalPath.startsWith(`users/${actorId}/`)) {
        return {
          ...baseResult,
          status: 'SKIPPED_ALREADY_PRIVATE',
          newStorageKey: originalPath,
          bytesTransferred: 0,
        };
      } else {
        return {
          ...baseResult,
          status: 'FAILED_UNAUTHORIZED',
          error: `Storage key ownership mismatch: key is not owned by user ${actorId}`,
        };
      }
    }

    // 4. Handle Unsupported Path
    if (sourceType === 'UNSUPPORTED') {
      return {
        ...baseResult,
        status: 'FAILED_UNSUPPORTED_PATH',
        error: `Path format '${originalPath}' is unsupported or contains illegal characters`,
      };
    }

    // 5. Resolve source stream, extension, size, and source SHA-256
    let sourceStream: Readable;
    let sourceSize: number;
    let sourceSha256: string;
    let extension: string;

    if (sourceType === 'LEGACY_LOCAL_UPLOAD') {
      const normalizedSubpath = originalPath!
        .replace(/^\/?(public\/)?uploads\//, '')
        .replace(/\\/g, '/');

      const resolvedLocalPath = path.resolve(this.legacyUploadsDir, normalizedSubpath);

      // Lexical path traversal check
      const uploadsDirWithSep = this.legacyUploadsDir.endsWith(path.sep)
        ? this.legacyUploadsDir
        : this.legacyUploadsDir + path.sep;

      if (!resolvedLocalPath.startsWith(uploadsDirWithSep) && resolvedLocalPath !== this.legacyUploadsDir) {
        return {
          ...baseResult,
          status: 'FAILED_UNSUPPORTED_PATH',
          error: 'Directory traversal attempt in legacy local path',
        };
      }

      if (!fs.existsSync(resolvedLocalPath)) {
        return {
          ...baseResult,
          status: 'FAILED_NOT_FOUND',
          error: 'Source file does not exist in legacy uploads directory',
        };
      }

      // Canonical realpath boundary check (prevents symlink and junction escape)
      try {
        const realUploadsDir = await fsp.realpath(this.legacyUploadsDir);
        const realLocalPath = await fsp.realpath(resolvedLocalPath);
        const realUploadsWithSep = realUploadsDir.endsWith(path.sep)
          ? realUploadsDir
          : realUploadsDir + path.sep;

        if (!realLocalPath.startsWith(realUploadsWithSep)) {
          return {
            ...baseResult,
            status: 'FAILED_UNSUPPORTED_PATH',
            error: 'Symlink boundary escape attempt in legacy local path',
          };
        }
      } catch {
        return {
          ...baseResult,
          status: 'FAILED_NOT_FOUND',
          error: 'Failed to resolve canonical path for legacy file',
        };
      }

      const stat = await fsp.stat(resolvedLocalPath);
      if (!stat.isFile()) {
        return {
          ...baseResult,
          status: 'FAILED_NOT_FOUND',
          error: 'Legacy upload target is not a regular file',
        };
      }

      sourceSize = stat.size;
      extension = path.extname(resolvedLocalPath).toLowerCase();

      // Compute source SHA-256
      const fileBuffer = await fsp.readFile(resolvedLocalPath);
      sourceSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      sourceStream = Readable.from(fileBuffer);
    } else {
      // LEGACY_PUBLIC_BLOB
      if (!this.blobStreamProvider) {
        return {
          ...baseResult,
          status: 'FAILED_NOT_FOUND',
          error: 'External cloud fetching is disabled in offline dry-run mode without a verified mock provider',
        };
      }

      const blobData = await this.blobStreamProvider(originalPath!);
      if (!blobData) {
        return {
          ...baseResult,
          status: 'FAILED_NOT_FOUND',
          error: 'Source object not found in historical blob storage',
        };
      }

      sourceSize = blobData.size;
      const parsedUrl = new URL(originalPath!);
      extension = path.extname(parsedUrl.pathname).toLowerCase();

      if (blobData.sha256) {
        sourceSha256 = blobData.sha256;
        sourceStream = blobData.stream;
      } else {
        // Collect stream to compute SHA-256 if not pre-computed
        const chunks: Buffer[] = [];
        const hash = crypto.createHash('sha256');
        for await (const chunk of blobData.stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(buf);
          hash.update(buf);
        }
        const fullBuffer = Buffer.concat(chunks);
        sourceSha256 = hash.digest('hex');
        sourceSize = fullBuffer.length;
        sourceStream = Readable.from(fullBuffer);
      }
    }

    // 6. Validate Extension & File Type
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return {
        ...baseResult,
        status: 'FAILED_INVALID_TYPE',
        error: `File extension '${extension}' is not permitted for medical documents`,
      };
    }

    // 7. Enforce Size Limit
    if (sourceSize > this.maxBytes) {
      return {
        ...baseResult,
        status: 'FAILED_SIZE_EXCEEDED',
        error: `File size ${sourceSize} bytes exceeds maximum limit of ${this.maxBytes} bytes`,
      };
    }

    // 8. Generate Target Private Key (preserves ownership)
    const targetKey = generateStorageKey(actorId, extension);

    // 9. Dry Run Exit: Validate everything, simulate key, but do not write to disk or DB
    if (this.dryRun) {
      return {
        ...baseResult,
        status: 'SUCCESS',
        newStorageKey: targetKey,
        sourceSha256,
        destinationSha256: sourceSha256, // Simulated match
        bytesTransferred: sourceSize,
      };
    }

    // 10. Write to Private Storage via LocalStorageDriver
    let destinationSha256: string;
    try {
      const stored = await this.storageDriver.writeStream(targetKey, sourceStream, this.maxBytes);
      destinationSha256 = stored.sha256;

      // Verify checksum
      if (destinationSha256 !== sourceSha256) {
        await this.storageDriver.delete(targetKey);
        return {
          ...baseResult,
          status: 'FAILED_CORRUPT_CHECKSUM',
          error: `Checksum mismatch: source (${sourceSha256}) !== destination (${destinationSha256})`,
        };
      }
    } catch (writeError) {
      return {
        ...baseResult,
        status: 'FAILED_NOT_FOUND',
        error: `Storage driver write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
      };
    }

    // 11. Transactional Database Update Simulation with Durable Audit Trail
    if (this.dbAdapter) {
      const migrationMetadata: MigrationMetadata = {
        originalFilePath: originalPath!,
        sourceType,
        sourceSha256,
        destinationSha256,
        migratedAt: new Date().toISOString(),
        migratedBy: actorId,
        bytesTransferred: sourceSize,
      };

      try {
        await this.dbAdapter.updateFilePath(record.id, targetKey, migrationMetadata);
      } catch (dbError) {
        // Atomic cleanup on DB failure: delete written file to prevent orphan storage
        try {
          await this.storageDriver.delete(targetKey);
        } catch (cleanupErr) {
          logger.error('Failed to cleanup storage after database rollback', { targetKey, error: cleanupErr });
        }

        return {
          ...baseResult,
          status: 'FAILED_DB_TRANSACTION',
          error: `Database transaction failed; rolled back storage file: ${
            dbError instanceof Error ? dbError.message : String(dbError)
          }`,
        };
      }
    }

    return {
      ...baseResult,
      status: 'SUCCESS',
      newStorageKey: targetKey,
      sourceSha256,
      destinationSha256,
      bytesTransferred: sourceSize,
    };
  }

  /**
   * Processes a batch of records sequentially with atomic error isolation.
   */
  public async migrateBatch(
    records: HealthDataRecord[],
    actorId: string
  ): Promise<MigrationBatchSummary> {
    const results: MigrationItemResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let totalBytesTransferred = 0;

    for (const record of records) {
      const itemResult = await this.migrateRecord(record, actorId);
      results.push(itemResult);

      if (itemResult.status === 'SUCCESS') {
        succeeded++;
        totalBytesTransferred += itemResult.bytesTransferred || 0;
      } else if (itemResult.status === 'SKIPPED_ALREADY_PRIVATE') {
        skipped++;
      } else {
        failed++;
      }
    }

    return {
      totalProcessed: records.length,
      succeeded,
      skipped,
      failed,
      totalBytesTransferred,
      results,
      dryRun: this.dryRun,
    };
  }
}
