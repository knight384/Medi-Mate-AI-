/**
 * Types and Interfaces for Legacy Document Migration
 *
 * Designed for MediMate AI to verify and simulate migration from
 * historical public Vercel Blob and static upload paths to private LocalStorageDriver.
 */

export interface HealthDataRecord {
  id: string;
  authorId: string | null;
  filePath: string | null;
  fileType: string | null;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type LegacySourceType =
  | 'ALREADY_PRIVATE'
  | 'LEGACY_LOCAL_UPLOAD'
  | 'LEGACY_PUBLIC_BLOB'
  | 'UNSUPPORTED'
  | 'EMPTY';

export type MigrationStatusCode =
  | 'SUCCESS'
  | 'SKIPPED_ALREADY_PRIVATE'
  | 'FAILED_UNAUTHORIZED'
  | 'FAILED_NOT_FOUND'
  | 'FAILED_INVALID_TYPE'
  | 'FAILED_SIZE_EXCEEDED'
  | 'FAILED_CORRUPT_CHECKSUM'
  | 'FAILED_DB_TRANSACTION'
  | 'FAILED_UNSUPPORTED_PATH';

export interface MigrationItemResult {
  recordId: string;
  authorId: string | null;
  originalFilePath: string | null;
  sourceType: LegacySourceType;
  status: MigrationStatusCode;
  newStorageKey?: string;
  sourceSha256?: string;
  destinationSha256?: string;
  bytesTransferred?: number;
  error?: string;
  dryRun: boolean;
}

export interface MigrationBatchSummary {
  totalProcessed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  totalBytesTransferred: number;
  results: MigrationItemResult[];
  dryRun: boolean;
}

export interface MigrationMetadata {
  originalFilePath: string;
  sourceType: LegacySourceType;
  sourceSha256: string;
  destinationSha256: string;
  migratedAt: string;
  migratedBy: string;
  bytesTransferred: number;
}

export interface MigrationDatabaseAdapter {
  updateFilePath(
    recordId: string,
    newStorageKey: string,
    metadata?: MigrationMetadata
  ): Promise<void>;
}
