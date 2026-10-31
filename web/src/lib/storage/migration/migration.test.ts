import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalStorageDriver } from '../local-driver';
import { LegacyMigrationWorkflow } from './migration-workflow';
import { HealthDataRecord, MigrationDatabaseAdapter, MigrationMetadata } from './types';
import { isValidStorageKey, generateStorageKey, extractStorageKeyOwner, isValidPrivateDocumentKey } from '../naming';

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
      let recordedMetadata: MigrationMetadata | undefined;
      const mockDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath(recordId: string, newStorageKey: string, metadata?: MigrationMetadata) {
          dbUpdates[recordId] = newStorageKey;
          recordedMetadata = metadata;
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

      // Verify DB was updated with the new storage key and audit metadata
      expect(dbUpdates['rec_real_migration_01']).toBe(result.newStorageKey);
      expect(recordedMetadata).toBeDefined();
      expect(recordedMetadata?.sourceSha256).toBe(expectedSha256);
      expect(recordedMetadata?.destinationSha256).toBe(expectedSha256);
      expect(recordedMetadata?.originalFilePath).toBe(`/uploads/${legacyFileName}`);
      expect(recordedMetadata?.migratedBy).toBe(testUserId);
      expect(recordedMetadata?.bytesTransferred).toBe(syntheticPdf.length);

      // Verify idempotency on second run
      const updatedRecord: HealthDataRecord = {
        ...record,
        filePath: result.newStorageKey!,
      };
      const retryResult = await workflow.migrateRecord(updatedRecord, testUserId);
      expect(retryResult.status).toBe('SKIPPED_ALREADY_PRIVATE');
      expect(retryResult.newStorageKey).toBe(result.newStorageKey);
    });

    it('preserves storage file as potential orphan if database update fails', async () => {
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
      expect(result.error).toContain('Database transaction failed; storage file preserved');

      // Verify storage file was preserved as potential orphan for reconciliation rather than destroyed
      const expectedKey = generateStorageKey(testUserId, 'pdf', record.id);
      expect(await storageDriver.exists(expectedKey)).toBe(true);
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

    it('blocks directory escape via sibling directory using path.relative containment', async () => {
      // Create sibling directory "legacy-uploads-evil" next to "legacy-uploads"
      const siblingDir = path.join(testRootDir, 'legacy-uploads-evil');
      await fsp.mkdir(siblingDir, { recursive: true });
      const evilPdf = Buffer.from('%PDF-1.4 Exfiltrated Host File');
      await fsp.writeFile(path.join(siblingDir, 'stolen.pdf'), evilPdf);

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const record: HealthDataRecord = {
        id: 'rec_evil_sibling',
        authorId: testUserId,
        filePath: '/uploads/../legacy-uploads-evil/stolen.pdf',
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const result = await workflow.migrateRecord(record, testUserId);
      expect(result.status).toBe('FAILED_UNSUPPORTED_PATH');
    });

    it('reconciles crash recovery idempotently when file was written prior to crash', async () => {
      const syntheticPdf = Buffer.from('%PDF-1.4 Crash Recovery Reconciliation Test Document');
      const legacyFileName = 'crash_recovery.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, legacyFileName), syntheticPdf);

      let dbCalls = 0;
      const mockDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath() {
          dbCalls++;
        },
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: mockDbAdapter,
      });

      const record: HealthDataRecord = {
        id: 'rec_crash_recovery_101',
        authorId: testUserId,
        filePath: `/uploads/${legacyFileName}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      // 1. First run: normal migration
      const result1 = await workflow.migrateRecord(record, testUserId);
      expect(result1.status).toBe('SUCCESS');
      expect(dbCalls).toBe(1);

      // 2. Simulate worker crash before DB commit: DB was not updated in caller,
      // but physical file exists at deterministic key.
      // Re-running migration with the original filePath should detect existing file,
      // verify SHA-256 match, and successfully complete without throwing collision.
      const result2 = await workflow.migrateRecord(record, testUserId);
      expect(result2.status).toBe('SUCCESS');
      expect(result2.newStorageKey).toBe(result1.newStorageKey);
      expect(dbCalls).toBe(2);
    });
  });

  describe('Task D: Adversarial Concurrency & Crash Recovery (10 Synthetic Scenarios)', () => {
    // 1. Two workers process the same record simultaneously
    it('Scenario 1: allows two workers processing the same record simultaneously to converge safely', async () => {
      const content = Buffer.from('%PDF-1.4 Concurrent Test Document Content');
      const filename = 'concurrent_same_record.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const record: HealthDataRecord = {
        id: 'rec_concurrent_01',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const worker1 = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });
      const worker2 = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const [res1, res2] = await Promise.all([
        worker1.migrateRecord(record, testUserId),
        worker2.migrateRecord(record, testUserId),
      ]);

      expect(res1.status).toBe('SUCCESS');
      expect(res2.status).toBe('SUCCESS');
      expect(res1.newStorageKey).toBe(res2.newStorageKey);
      expect(await storageDriver.exists(res1.newStorageKey!)).toBe(true);

      const streamRes = await storageDriver.readStream(res1.newStorageKey!);
      const chunks: Buffer[] = [];
      for await (const chunk of streamRes.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe(content.toString());
    });

    // 2. Two workers derive the same destination key
    it('Scenario 2: confirms two workers derive the exact same destination key matching UUID format', () => {
      const recordId = 'rec_deterministic_key_02';
      const key1 = generateStorageKey(testUserId, 'pdf', recordId);
      const key2 = generateStorageKey(testUserId, 'pdf', recordId);

      expect(key1).toBe(key2);
      expect(isValidStorageKey(key1)).toBe(true);
      expect(key1).toMatch(/^users\/patient_auth_user_101\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}\.pdf$/);
    });

    // 3. Both workers attempt to write to the same destination
    it('Scenario 3: ensures both workers attempting to write to the same destination leave complete, uncorrupted content', async () => {
      const content = Buffer.from('%PDF-1.4 Identical Content for Write Race Verification');
      const filename = 'write_race.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const record: HealthDataRecord = {
        id: 'rec_write_race_03',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const workerA = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });
      const workerB = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const results = await Promise.all([
        workerA.migrateRecord(record, testUserId),
        workerB.migrateRecord(record, testUserId),
      ]);

      for (const res of results) {
        expect(res.status).toBe('SUCCESS');
        expect(res.sourceSha256).toBe(res.destinationSha256);
      }
    });

    // 4. One worker completes the file write before the other begins reconciliation
    it('Scenario 4: reconciles successfully when one worker completes file write prior to second worker starting', async () => {
      const content = Buffer.from('%PDF-1.4 Pre-existing File Write Reconciliation');
      const filename = 'staggered_workers.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const record: HealthDataRecord = {
        id: 'rec_staggered_04',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const worker1 = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });
      const worker2 = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const res1 = await worker1.migrateRecord(record, testUserId);
      expect(res1.status).toBe('SUCCESS');

      const res2 = await worker2.migrateRecord(record, testUserId);
      expect(res2.status).toBe('SUCCESS');
      expect(res2.newStorageKey).toBe(res1.newStorageKey);
    });

    // 5. Both workers attempt a database update
    it('Scenario 5: preserves consistent database state when both workers attempt database updates', async () => {
      const content = Buffer.from('%PDF-1.4 Concurrency DB Update Test Document');
      const filename = 'db_update_race.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const dbUpdates: Array<{ recordId: string; newKey: string }> = [];
      const mockDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath(recId, newKey) {
          dbUpdates.push({ recordId: recId, newKey });
        },
      };

      const record: HealthDataRecord = {
        id: 'rec_db_race_05',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const worker1 = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: mockDbAdapter,
      });
      const worker2 = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: mockDbAdapter,
      });

      const [res1, res2] = await Promise.all([
        worker1.migrateRecord(record, testUserId),
        worker2.migrateRecord(record, testUserId),
      ]);

      expect(res1.status).toBe('SUCCESS');
      expect(res2.status).toBe('SUCCESS');
      expect(dbUpdates.length).toBe(2);
      expect(dbUpdates[0].newKey).toBe(dbUpdates[1].newKey);
    });

    // 6. A worker fails after creating the destination
    it('Scenario 6: preserves destination file as potential orphan when worker database update fails', async () => {
      const content = Buffer.from('%PDF-1.4 Rollback on Worker Failure Document');
      const filename = 'fail_after_dest.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const mockFailingDb: MigrationDatabaseAdapter = {
        async updateFilePath() {
          throw new Error('Simulated database network timeout');
        },
      };

      const worker = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: mockFailingDb,
      });

      const record: HealthDataRecord = {
        id: 'rec_fail_06',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const res = await worker.migrateRecord(record, testUserId);
      expect(res.status).toBe('FAILED_DB_TRANSACTION');

      const expectedKey = generateStorageKey(testUserId, 'pdf', record.id);
      expect(await storageDriver.exists(expectedKey)).toBe(true);
    });

    // 7. A worker retries after the other worker succeeds
    it('Scenario 7: skips migration idempotently when worker retries against already updated record', async () => {
      const content = Buffer.from('%PDF-1.4 Worker Retry Test Content');
      const filename = 'retry_after_success.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const record: HealthDataRecord = {
        id: 'rec_retry_07',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const worker1 = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const res1 = await worker1.migrateRecord(record, testUserId);
      expect(res1.status).toBe('SUCCESS');

      // Update record in mock database to reflect worker 1 completion
      const updatedRecord: HealthDataRecord = {
        ...record,
        filePath: res1.newStorageKey ?? null,
      };

      const worker2 = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const res2 = await worker2.migrateRecord(updatedRecord, testUserId);
      expect(res2.status).toBe('SKIPPED_ALREADY_PRIVATE');
    });

    // 8. Two records from different users have different destination namespaces
    it('Scenario 8: isolates destination namespaces when two different users migrate files with identical names', async () => {
      const content = Buffer.from('%PDF-1.4 Shared Multi-tenant Document Content');
      const filename = 'common_report.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const userA = 'patient_alpha';
      const userB = 'patient_beta';

      const recA: HealthDataRecord = {
        id: 'rec_tenant_A',
        authorId: userA,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };
      const recB: HealthDataRecord = {
        id: 'rec_tenant_B',
        authorId: userB,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const [resA, resB] = await Promise.all([
        workflow.migrateRecord(recA, userA),
        workflow.migrateRecord(recB, userB),
      ]);

      expect(resA.status).toBe('SUCCESS');
      expect(resB.status).toBe('SUCCESS');
      expect(resA.newStorageKey!.startsWith(`users/${userA}/`)).toBe(true);
      expect(resB.newStorageKey!.startsWith(`users/${userB}/`)).toBe(true);
      expect(resA.newStorageKey).not.toBe(resB.newStorageKey);
    });

    // 9. Existing destination data has a different SHA-256 hash
    it('Scenario 9: refuses to overwrite existing destination data when existing SHA-256 hash conflicts', async () => {
      const sourceContent = Buffer.from('%PDF-1.4 Authentic Patient Health Record');
      const filename = 'patient_record.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), sourceContent);

      const record: HealthDataRecord = {
        id: 'rec_conflict_09',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const targetKey = generateStorageKey(testUserId, 'pdf', record.id);

      // Pre-seed the destination key with conflicting content
      const conflictingContent = Buffer.from('%PDF-1.4 Conflicting Pre-existing Content');
      await storageDriver.writeStream(targetKey, Readable.from(conflictingContent));

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
      });

      const result = await workflow.migrateRecord(record, testUserId);
      expect(result.status).toBe('FAILED_CORRUPT_CHECKSUM');
      expect(result.error).toContain('Storage key collision: destination object already exists with mismatched hash');

      // Crucial: verify pre-existing destination file was NOT overwritten or deleted
      const readRes = await storageDriver.readStream(targetKey);
      const chunks: Buffer[] = [];
      for await (const chunk of readRes.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe(conflictingContent.toString());
    });

    // 10. A database update is attempted more than once (idempotent DB update)
    it('Scenario 10: idempotently handles multiple database updates for the same migration target', async () => {
      const content = Buffer.from('%PDF-1.4 Idempotent Database Update Test Document');
      const filename = 'idempotent_db.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const dbMap = new Map<string, { key: string; metadata?: MigrationMetadata }>();
      const idempotentDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath(recId, newKey, metadata) {
          const current = dbMap.get(recId);
          if (current && current.key === newKey) {
            // Idempotent retry: already at target key
            return;
          }
          dbMap.set(recId, { key: newKey, metadata });
        },
      };

      const record: HealthDataRecord = {
        id: 'rec_idempotent_10',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: idempotentDbAdapter,
      });

      const res1 = await workflow.migrateRecord(record, testUserId);
      expect(res1.status).toBe('SUCCESS');
      expect(dbMap.get(record.id)?.key).toBe(res1.newStorageKey);

      // Re-run migration simulation (second attempt)
      const res2 = await workflow.migrateRecord(record, testUserId);
      expect(res2.status).toBe('SUCCESS');
      expect(dbMap.get(record.id)?.key).toBe(res1.newStorageKey);
    });
  });

  describe('Task A: Deterministic Key Generation & Identifier Uniqueness', () => {
    it('always generates identical keys for same user and record ID', () => {
      const key1 = generateStorageKey('user_alpha', 'pdf', 'rec_1001');
      const key2 = generateStorageKey('user_alpha', 'pdf', 'rec_1001');
      expect(key1).toBe(key2);
      expect(isValidStorageKey(key1)).toBe(true);
    });

    it('generates different keys for same user with different record IDs', () => {
      const key1 = generateStorageKey('user_alpha', 'pdf', 'rec_1001');
      const key2 = generateStorageKey('user_alpha', 'pdf', 'rec_1002');
      expect(key1).not.toBe(key2);
    });

    it('generates different keys for different users with same record ID', () => {
      const key1 = generateStorageKey('user_alpha', 'pdf', 'rec_1001');
      const key2 = generateStorageKey('user_beta', 'pdf', 'rec_1001');
      expect(key1).not.toBe(key2);
      expect(key1.startsWith('users/user_alpha/')).toBe(true);
      expect(key2.startsWith('users/user_beta/')).toBe(true);
    });

    it('rejects invalid or ambiguous user identifiers rather than silently colliding', () => {
      expect(() => generateStorageKey('user@hospital.com', 'pdf', 'rec_1')).toThrow('Invalid userId');
      expect(() => generateStorageKey('user/evil', 'pdf', 'rec_1')).toThrow('Invalid userId');
      expect(() => generateStorageKey('..', 'pdf', 'rec_1')).toThrow('Invalid userId');
      expect(() => generateStorageKey('user$admin', 'pdf', 'rec_1')).toThrow('Invalid userId');
    });

    it('confirms deterministic key passes isValidStorageKey and matches UUID-shaped format', () => {
      const key = generateStorageKey('patient_99', 'pdf', 'rec_99');
      expect(isValidStorageKey(key)).toBe(true);
      expect(extractStorageKeyOwner(key)).toBe('patient_99');
      expect(isValidPrivateDocumentKey(key, 'patient_99')).toBe(true);
      expect(isValidPrivateDocumentKey(key, 'different_user')).toBe(false);
      expect(key).toMatch(/^users\/patient_99\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}\.pdf$/);
    });
  });

  describe('Task B: Strict Already-Private Key Ownership & Path Safety (7 Scenarios)', () => {
    const userA = 'patient_Alice';
    const userB = 'patient_Bob';

    // 1. Record owned by A references users/A/...
    it('Scenario B1: accepts valid private path owned by author as already private', async () => {
      const validKeyA = `users/${userA}/11112222-3333-4444-a555-666677778888.pdf`;
      const record: HealthDataRecord = {
        id: 'rec_valid_own',
        authorId: userA,
        filePath: validKeyA,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, { legacyUploadsDir: testLegacyUploadsDir });
      const result = await workflow.migrateRecord(record, userA);

      expect(result.status).toBe('SKIPPED_ALREADY_PRIVATE');
      expect(result.newStorageKey).toBe(validKeyA);
    });

    // 2. Record owned by A references users/B/...
    it('Scenario B2: rejects record owned by A referencing users/B storage key', async () => {
      const validKeyB = `users/${userB}/11112222-3333-4444-a555-666677778888.pdf`;
      const record: HealthDataRecord = {
        id: 'rec_idor_cross',
        authorId: userA,
        filePath: validKeyB,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, { legacyUploadsDir: testLegacyUploadsDir });
      const result = await workflow.migrateRecord(record, userA);

      expect(result.status).toBe('FAILED_UNAUTHORIZED');
      expect(result.error).toContain(`Storage key ownership mismatch: key belongs to user '${userB}'`);
    });

    // 3. Record owned by B references users/A/...
    it('Scenario B3: rejects actor A accessing record owned by B', async () => {
      const validKeyA = `users/${userA}/11112222-3333-4444-a555-666677778888.pdf`;
      const record: HealthDataRecord = {
        id: 'rec_b_record',
        authorId: userB,
        filePath: validKeyA,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, { legacyUploadsDir: testLegacyUploadsDir });
      const result = await workflow.migrateRecord(record, userA);

      expect(result.status).toBe('FAILED_UNAUTHORIZED');
      expect(result.error).toContain(`record owner (${userB}) does not match actor (${userA})`);
    });

    // 4. Record references malformed users/... path
    it('Scenario B4: rejects malformed users/... path without complete structure', async () => {
      const malformedPaths = ['users/', 'users/patient_Alice', 'users/patient_Alice/missing_ext', 'users/patient_Alice/a/b/c.pdf'];
      const workflow = new LegacyMigrationWorkflow(storageDriver, { legacyUploadsDir: testLegacyUploadsDir });

      for (const p of malformedPaths) {
        const record: HealthDataRecord = {
          id: 'rec_malformed',
          authorId: userA,
          filePath: p,
          fileType: 'application/pdf',
          status: 'COMPLETED',
        };
        const result = await workflow.migrateRecord(record, userA);
        expect(result.status).toBe('FAILED_UNSUPPORTED_PATH');
      }
    });

    // 5. Record references users/../...
    it('Scenario B5: rejects path traversal attempt in users/../... path', async () => {
      const traversalPath = `users/${userA}/../../etc/passwd.pdf`;
      const record: HealthDataRecord = {
        id: 'rec_traversal_key',
        authorId: userA,
        filePath: traversalPath,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, { legacyUploadsDir: testLegacyUploadsDir });
      const result = await workflow.migrateRecord(record, userA);
      expect(result.status).toBe('FAILED_UNSUPPORTED_PATH');
    });

    // 6. Record references an invalid extension
    it('Scenario B6: rejects already-private path having an unpermitted file extension', async () => {
      const badExtKey = `users/${userA}/11112222-3333-4444-a555-666677778888.exe`;
      const record: HealthDataRecord = {
        id: 'rec_bad_ext',
        authorId: userA,
        filePath: badExtKey,
        fileType: 'application/x-msdownload',
        status: 'COMPLETED',
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, { legacyUploadsDir: testLegacyUploadsDir });
      const result = await workflow.migrateRecord(record, userA);
      expect(result.status).toBe('FAILED_INVALID_TYPE');
      expect(result.error).toContain("prohibited extension '.exe'");
    });

    // 7. Record references a valid-looking path that does not belong to expected owner
    it('Scenario B7: rejects valid-looking path belonging to unexpected user namespace', async () => {
      const victimKey = `users/patient_Victim/aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee.pdf`;
      const record: HealthDataRecord = {
        id: 'rec_imposter',
        authorId: userA,
        filePath: victimKey,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const workflow = new LegacyMigrationWorkflow(storageDriver, { legacyUploadsDir: testLegacyUploadsDir });
      const result = await workflow.migrateRecord(record, userA);
      expect(result.status).toBe('FAILED_UNAUTHORIZED');
    });
  });

  describe('Task C: Atomic Create-if-Absent Publication & Real Filesystem Race', () => {
    it('exclusively publishes via hard link and fails atomically when target already exists', async () => {
      const key = `users/${testUserId}/22223333-4444-4555-a666-777788889999.pdf`;
      const content1 = Buffer.from('%PDF-1.4 Winner Publication Content');
      const content2 = Buffer.from('%PDF-1.4 Loser Publication Content');

      // 1. First write succeeds
      const res1 = await storageDriver.writeStream(key, Readable.from(content1));
      expect(res1.storageKey).toBe(key);

      // 2. Second write to same key throws StorageSecurityError collision without overwriting
      await expect(
        storageDriver.writeStream(key, Readable.from(content2))
      ).rejects.toThrow('Storage collision: object already exists');

      // 3. Confirm target file retained original content from winner
      const readRes = await storageDriver.readStream(key);
      const chunks: Buffer[] = [];
      for await (const chunk of readRes.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe(content1.toString());
    });

    it('cleans up temporary file when publication fails closed on unexpected error', async () => {
      const key = `users/${testUserId}/33334444-5555-4666-a777-888899990000.pdf`;
      const content = Buffer.from('%PDF-1.4 Temporary File Cleanup Test');

      // Spy on fsp.link to simulate an unexpected filesystem failure
      const linkSpy = vi.spyOn(fsp, 'link').mockRejectedValueOnce(new Error('Simulated I/O disk failure'));

      await expect(
        storageDriver.writeStream(key, Readable.from(content))
      ).rejects.toThrow('Atomic storage publication failed');

      linkSpy.mockRestore();

      // Confirm temp directory is clean (no orphaned .tmp files remain)
      const tempDir = path.join(testStorageDir, '.tmp');
      const tempFiles = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : [];
      expect(tempFiles.length).toBe(0);
    });

    // Task B Controlled Race Tests:
    it('Task B: ensures Worker B committed document is preserved when Worker A database update fails', async () => {
      const content = Buffer.from('%PDF-1.4 Concurrency Interleaving Document');
      const filename = 'race_worker_a_fails.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const record: HealthDataRecord = {
        id: 'rec_race_interleaving_01',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      let workerADbCalled = false;
      let workerBDbCalled = false;

      // Worker A has a failing DB adapter
      const failingDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath() {
          workerADbCalled = true;
          throw new Error('Worker A DB deadlock');
        },
      };

      // Worker B has a succeeding DB adapter
      const successfulDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath() {
          workerBDbCalled = true;
        },
      };

      const workerA = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: failingDbAdapter,
      });

      const workerB = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: successfulDbAdapter,
      });

      // 1. Worker A creates destination file, then worker B reconciles and commits, while Worker A fails
      const [resA, resB] = await Promise.all([
        workerA.migrateRecord(record, testUserId),
        workerB.migrateRecord(record, testUserId),
      ]);

      expect(workerADbCalled).toBe(true);
      expect(workerBDbCalled).toBe(true);
      expect(resA.status).toBe('FAILED_DB_TRANSACTION');
      expect(resB.status).toBe('SUCCESS');

      // Crucial: Worker B committed the record; the target file MUST still exist and be intact!
      const targetKey = resB.newStorageKey!;
      expect(await storageDriver.exists(targetKey)).toBe(true);

      const streamRes = await storageDriver.readStream(targetKey);
      const chunks: Buffer[] = [];
      for await (const chunk of streamRes.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe(content.toString());
    });

    it('Task B (Reverse Ordering): ensures Worker A committed document is preserved when Worker B database update fails', async () => {
      const content = Buffer.from('%PDF-1.4 Reverse Interleaving Document');
      const filename = 'race_worker_b_fails.pdf';
      await fsp.writeFile(path.join(testLegacyUploadsDir, filename), content);

      const record: HealthDataRecord = {
        id: 'rec_race_interleaving_02',
        authorId: testUserId,
        filePath: `/uploads/${filename}`,
        fileType: 'application/pdf',
        status: 'COMPLETED',
      };

      const successfulDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath() {},
      };

      const failingDbAdapter: MigrationDatabaseAdapter = {
        async updateFilePath() {
          throw new Error('Worker B DB timeout');
        },
      };

      const workerA = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: successfulDbAdapter,
      });

      const workerB = new LegacyMigrationWorkflow(storageDriver, {
        legacyUploadsDir: testLegacyUploadsDir,
        dryRun: false,
        dbAdapter: failingDbAdapter,
      });

      const [resA, resB] = await Promise.all([
        workerA.migrateRecord(record, testUserId),
        workerB.migrateRecord(record, testUserId),
      ]);

      expect(resA.status).toBe('SUCCESS');
      expect(resB.status).toBe('FAILED_DB_TRANSACTION');

      // Target document committed by Worker A remains completely intact
      const targetKey = resA.newStorageKey!;
      expect(await storageDriver.exists(targetKey)).toBe(true);

      const streamRes = await storageDriver.readStream(targetKey);
      const chunks: Buffer[] = [];
      for await (const chunk of streamRes.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe(content.toString());
    });
  });
});
