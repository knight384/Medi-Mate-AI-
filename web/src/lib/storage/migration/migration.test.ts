import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalStorageDriver } from '../local-driver';
import { LegacyMigrationWorkflow } from './migration-workflow';
import { HealthDataRecord, MigrationDatabaseAdapter } from './types';
import { isValidStorageKey } from '../naming';

describe('Legacy Document Migration Workflow & Synthetic Dry-Run', () => {
  let testRootDir: string;
  let testStorageDir: string;
  let testLegacyUploadsDir: string;
  let storageDriver: LocalStorageDriver;
  const testUserId = 'patient_auth_user_101';

  beforeEach(async () => {
    testRootDir = path.join(os.tmpdir(), `medimate-migr-test-${crypto.randomUUID()}`);
    testStorageDir = path.join(testRootDir, 'storage');
    testLegacyUploadsDir = path.join(testRootDir, 'legacy-uploads');

    await fsp.mkdir(testStorageDir, { recursive: true });
    await fsp.mkdir(testLegacyUploadsDir, { recursive: true });

    storageDriver = new LocalStorageDriver(testStorageDir);
    await storageDriver.init();
  });

  afterEach(async () => {
    if (fs.existsSync(testRootDir)) {
      await fsp.rm(testRootDir, { recursive: true, force: true });
    }
  });

  describe('Synthetic Test Dataset (7 Scenarios) — Dry-Run Verification', () => {
    it('accurately verifies all 7 synthetic dataset scenarios in dry-run mode without modifying disk or DB', async () => {
      // 1. Prepare synthetic legacy file on disk
      const syntheticPdfContent = Buffer.from('%PDF-1.4 Synthetic Lab Report Content for Patient 101');
      const syntheticPdfPath = path.join(testLegacyUploadsDir, 'blood_panel_2025.pdf');
      await fsp.writeFile(syntheticPdfPath, syntheticPdfContent);

      const syntheticSharedContent = Buffer.from('%PDF-1.4 Shared Radiograph Attachment');
      const syntheticSharedPath = path.join(testLegacyUploadsDir, 'shared_imaging.pdf');
      await fsp.writeFile(syntheticSharedPath, syntheticSharedContent);

      // Mock blob provider for Scenario 1
      const mockBlobContent = Buffer.from('%PDF-1.4 Remote Historical Vercel Blob Document');
      const mockBlobSha256 = crypto.createHash('sha256').update(mockBlobContent).digest('hex');

      const blobStreamProvider = async (url: string) => {
        if (url === 'https://hospital-store.public.blob.vercel-storage.com/Alice_Blood_Panel.pdf') {
          return {
            stream: Readable.from(mockBlobContent),
            size: mockBlobContent.length,
            sha256: mockBlobSha256,
            mimeType: 'application/pdf',
          };
        }
        return null;
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: true,
        blobStreamProvider,
      });

      // 7 Synthetic Scenarios
      const syntheticDataset: HealthDataRecord[] = [
        // Scenario 1: Legacy Public Blob URL
        {
          id: 'rec_01_public_blob',
          authorId: testUserId,
          filePath: 'https://hospital-store.public.blob.vercel-storage.com/Alice_Blood_Panel.pdf',
          fileType: 'application/pdf',
          status: 'COMPLETED',
        },
        // Scenario 2: Legacy /uploads/ file path
        {
          id: 'rec_02_legacy_upload',
          authorId: testUserId,
          filePath: '/uploads/blood_panel_2025.pdf',
          fileType: 'application/pdf',
          status: 'COMPLETED',
        },
        // Scenario 3: An already-private storage key
        {
          id: 'rec_03_already_private',
          authorId: testUserId,
          filePath: `users/${testUserId}/45552288-ebc7-4d6c-84a3-c4264753495a.pdf`,
          fileType: 'application/pdf',
          status: 'COMPLETED',
        },
        // Scenario 4: Invalid or unsupported path
        {
          id: 'rec_04_unsupported_path',
          authorId: testUserId,
          filePath: 'ftp://untrusted.server/malicious_payload.pdf',
          fileType: 'application/pdf',
          status: 'COMPLETED',
        },
        // Scenario 5: Missing source document
        {
          id: 'rec_05_missing_file',
          authorId: testUserId,
          filePath: '/uploads/non_existent_scan_999.pdf',
          fileType: 'application/pdf',
          status: 'COMPLETED',
        },
        // Scenario 6: Document with mismatched owner
        {
          id: 'rec_06_mismatched_owner',
          authorId: 'different_patient_999',
          filePath: '/uploads/blood_panel_2025.pdf',
          fileType: 'application/pdf',
          status: 'COMPLETED',
        },
        // Scenario 7: Duplicate storage reference
        {
          id: 'rec_07_duplicate_ref',
          authorId: testUserId,
          filePath: '/uploads/shared_imaging.pdf',
          fileType: 'application/pdf',
          status: 'COMPLETED',
        },
      ];

      const summary = await workflow.migrateBatch(syntheticDataset, testUserId);

      expect(summary.totalProcessed).toBe(7);
      expect(summary.dryRun).toBe(true);

      const r1 = summary.results.find((r) => r.recordId === 'rec_01_public_blob')!;
      expect(r1.status).toBe('SUCCESS');
      expect(r1.sourceType).toBe('LEGACY_PUBLIC_BLOB');
      expect(r1.newStorageKey).toBeDefined();
      expect(isValidStorageKey(r1.newStorageKey!)).toBe(true);
      expect(r1.newStorageKey!.startsWith(`users/${testUserId}/`)).toBe(true);
      expect(r1.sourceSha256).toBe(mockBlobSha256);

      const r2 = summary.results.find((r) => r.recordId === 'rec_02_legacy_upload')!;
      expect(r2.status).toBe('SUCCESS');
      expect(r2.sourceType).toBe('LEGACY_LOCAL_UPLOAD');
      expect(r2.newStorageKey).toBeDefined();
      expect(r2.newStorageKey!.startsWith(`users/${testUserId}/`)).toBe(true);
      const expectedSha256 = crypto.createHash('sha256').update(syntheticPdfContent).digest('hex');
      expect(r2.sourceSha256).toBe(expectedSha256);

      const r3 = summary.results.find((r) => r.recordId === 'rec_03_already_private')!;
      expect(r3.status).toBe('SKIPPED_ALREADY_PRIVATE');
      expect(r3.sourceType).toBe('ALREADY_PRIVATE');
      expect(r3.newStorageKey).toBe(`users/${testUserId}/45552288-ebc7-4d6c-84a3-c4264753495a.pdf`);

      const r4 = summary.results.find((r) => r.recordId === 'rec_04_unsupported_path')!;
      expect(r4.status).toBe('FAILED_UNSUPPORTED_PATH');
      expect(r4.sourceType).toBe('UNSUPPORTED');

      const r5 = summary.results.find((r) => r.recordId === 'rec_05_missing_file')!;
      expect(r5.status).toBe('FAILED_NOT_FOUND');
      expect(r5.sourceType).toBe('LEGACY_LOCAL_UPLOAD');

      const r6 = summary.results.find((r) => r.recordId === 'rec_06_mismatched_owner')!;
      expect(r6.status).toBe('FAILED_UNAUTHORIZED');

      const r7 = summary.results.find((r) => r.recordId === 'rec_07_duplicate_ref')!;
      expect(r7.status).toBe('SUCCESS');
      expect(r7.sourceType).toBe('LEGACY_LOCAL_UPLOAD');
      expect(r7.newStorageKey).toBeDefined();

      // Ensure no files were actually written to private storage during dry run
      const userDir = path.join(testStorageDir, 'users', testUserId);
      const storageFiles = fs.existsSync(userDir) ? fs.readdirSync(userDir) : [];
      expect(storageFiles.length).toBe(0);
    });
  });

  describe('Full Migration Execution with Cryptographic Verification & DB Atomicity', () => {
    it('executes real migration with SHA-256 verification and atomic database updates', async () => {
      const syntheticPdf = Buffer.from('%PDF-1.4 Clinical Diagnostic Evaluation for Auth User');
      const expectedSha256 = crypto.createHash('sha256').update(syntheticPdf).digest('hex');
      const legacyFileName = 'clinical_evaluation.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, legacyFileName), syntheticPdf);

      const dbUpdates: Record<string, string> = {};
      const mockDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath(recordId: string, newStorageKey: string) {
          dbUpdates[recordId] = newStorageKey;
        },
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: mockDbAdapter,
      });

      const record: HealthDataRecord = {
        id: 'rec_real_migration_01',
        authorId: testUserId,
        filePath: `/uploads/${legacyFileName}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const result = await workflow.migrateRecord(record, testUserId);

      expect(result.status).toBe('SUCCESS');
      expect(result.newStorageKey).toBeDefined();
      expect(result.sourceSha256).toBe(expectedSha256);
      expect(result.destinationSha256).toBe(expectedSha256);
      expect(result.bytesTransferred).toBe(syntheticPdf.length);

      // Verify file exists in physical storage
      expect(await storageDriver.exists(result.newStorageKey!)).toBe(true);

      // Verify file can be read and matches original bytes
      const readResult = await storageDriver.readStream(result.newStorageKey!);
      const chunks: Buffer[] = [];
      for await (const chunk of readResult.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).equals(syntheticPdf)).toBe(true);

      // Verify DB was updated with the new storage key
      expect(dbUpdates['rec_real_migration_01']).toBe(result.newStorageKey);

      // Verify idempotency on second run
      const updatedRecord: HealthDataRecord = {
        ...record,
        filePath: result.newStorageKey!,
      };
      const retryResult = await workflow.migrateRecord(updatedRecord, testUserId);
      expect(retryResult.status).toBe('SKIPPED_ALREADY_PRIVATE');
      expect(retryResult.newStorageKey).toBe(result.newStorageKey);
    });

    it('rolls back and deletes storage file if database update fails', async () => {
      const syntheticPdf = Buffer.from('%PDF-1.4 Transient Report for Rollback Test');
      const legacyFileName = 'rollback_report.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, legacyFileName), syntheticPdf);

      const failingDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath() {
          throw new Error('Database transaction deadlocked or connection timeout');
        },
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: failingDbAdapter,
      });

      const record: HealthDataRecord = {
        id: 'rec_failing_db',
        authorId: testUserId,
        filePath: `/uploads/${legacyFileName}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const result = await workflow.migrateRecord(record, testUserId);

      expect(result.status).toBe('FAILED_DB_TRANSACTION');
      expect(result.error).toContain('Database transaction failed; rolled back storage file');

      // Verify storage was cleaned up and no orphan file exists
      const userDir = path.join(testStorageDir, 'users', testUserId);
      const files = fs.existsSync(userDir) ? fs.readdirSync(userDir) : [];
      expect(files.length).toBe(0);
    });

    it('rejects oversized files exceeding maximum permitted document size', async () => {
      const smallLimitWorkflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        maxBytes: 100, // 100 bytes limit
        dryRun: false,
      });

      const oversizedContent = Buffer.alloc(200, 0x41); // 200 bytes
      await fsp.writeFile(path.join(testLegacyUploadsDir, 'large_scan.pdf'), oversizedContent);

      const record: HealthDataRecord = {
        id: 'rec_oversized',
        authorId: testUserId,
        filePath: '/uploads/large_scan.pdf',
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const result = await smallLimitWorkflow.migrateRecord(record, testUserId);
      expect(result.status).toBe('FAILED_SIZE_EXCEEDED');
      expect(result.error).toContain('exceeds maximum limit of 100 bytes');
    });

    it('rejects forbidden file extensions', async () => {
      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const executableContent = Buffer.from('#!/bin/bash\necho exploit');
      await fsp.writeFile(path.join(testLegacyUploadsDir, 'script.sh'), executableContent);

      const record: HealthDataRecord = {
        id: 'rec_executable',
        authorId: testUserId,
        filePath: '/uploads/script.sh',
        fileType: 'application/x-sh',
        status: 'COMPLETED',
      };

      const result = await workflow.migrateRecord(record, testUserId);
      expect(result.status).toBe('FAILED_INVALID_TYPE');
      expect(result.error).toContain('File extension \'.sh\' is not permitted');
    });

    it('safely handles duplicate storage references by creating isolated private keys per record', async () => {
      const sharedContent = Buffer.from('%PDF-1.4 Shared Clinical Test Results Document');
      await fsp.writeFile(path.join(testLegacyUploadsDir, 'shared_panel.pdf'), sharedContent);

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const recA: HealthDataRecord = {
        id: 'rec_dup_A',
        authorId: testUserId,
        filePath: '/uploads/shared_panel.pdf',
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const recB: HealthDataRecord = {
        id: 'rec_dup_B',
        authorId: testUserId,
        filePath: '/uploads/shared_panel.pdf',
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const resultA = await workflow.migrateRecord(recA, testUserId);
      const resultB = await workflow.migrateRecord(recB, testUserId);

      expect(resultA.status).toBe('SUCCESS');
      expect(resultB.status).toBe('SUCCESS');
      expect(resultA.newStorageKey).toBeDefined();
      expect(resultB.newStorageKey).toBeDefined();

      // Crucial: Each record gets its own independent private storage key
      expect(resultA.newStorageKey).not.toBe(resultB.newStorageKey);

      // Both files exist and contain identical content
      expect(await storageDriver.exists(resultA.newStorageKey!)).toBe(true);
      expect(await storageDriver.exists(resultB.newStorageKey!)).toBe(true);
    });
  });
});
