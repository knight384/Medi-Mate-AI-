import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  ProtectedScratchStorage,
  ScratchFileLease,
} from './temp-storage';

describe('Part A & B — Protected Scratch Storage, Active Lease Tracking & Race-Safe Orphan Scrubber (Checkpoint 5D.25)', () => {
  let testScratchRoot: string;

  beforeEach(async () => {
    testScratchRoot = path.join(os.tmpdir(), `medimate-scratch-test-${crypto.randomUUID()}`);
    await fsp.mkdir(testScratchRoot, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    try {
      await fsp.rm(testScratchRoot, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('Scenario 1: keeps active temporary file older than 15 minutes intact due to active lease and fresh heartbeat', async () => {
    const storage = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'worker_alpha',
      defaultLeaseTtlMs: 60_000,
    });

    const { filePath, release } = await storage.allocateFile(
      'active_doc',
      '.plain.tmp',
      'long_running_ocr'
    );

    // Write synthetic document
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4 Active Long-Running Clinical Doc'));

    // Artificially age the temporary file to 25 minutes ago (> 15 minutes)
    const twentyFiveMinutesAgo = new Date(Date.now() - 25 * 60 * 1000);
    fs.utimesSync(filePath, twentyFiveMinutesAgo, twentyFiveMinutesAgo);

    // Verify mtime is indeed > 15 minutes old
    const agedStat = await fsp.stat(filePath);
    expect(Date.now() - agedStat.mtimeMs).toBeGreaterThan(15 * 60 * 1000);

    // Another worker runs cleanup
    const cleanerWorker = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'cleaner_worker',
    });

    const cleanupResult = await cleanerWorker.cleanupOrphanedScratch();
    expect(cleanupResult.cleanedFiles).toBe(0);
    expect(cleanupResult.cleanedLeases).toBe(0);

    // CRITICAL: The active file MUST NOT be deleted because its lease is alive and current!
    const fileStillExists = await fsp
      .stat(filePath)
      .then(() => true)
      .catch(() => false);
    expect(fileStillExists).toBe(true);

    await release();
    storage.destroy();
    cleanerWorker.destroy();
  });

  it('Scenario 2: keeps file active during slow streaming download via lease touch', async () => {
    const storage = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'download_worker',
      defaultLeaseTtlMs: 30_000,
    });

    const { filePath, leaseId, release } = await storage.allocateFile(
      'download_buffer',
      '.plain.tmp',
      'slow_http_download'
    );

    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4 Chunk 1'));

    // Simulate slow download chunk arrival with periodic touches
    await storage.touchLease(leaseId);
    await fsp.appendFile(filePath, Buffer.from(' Chunk 2'));

    const cleaner = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'cleaner_worker',
    });

    const cleanup = await cleaner.cleanupOrphanedScratch();
    expect(cleanup.cleanedFiles).toBe(0);

    const exists = await fsp.stat(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    await release();
    storage.destroy();
    cleaner.destroy();
  });

  it('Scenario 3: protects multi-file temporary directory for long-running Docling operation', async () => {
    const storage = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'docling_worker',
    });

    const { dirPath, release } = await storage.allocateDir(
      'docling_job',
      'docling_multipage_ocr'
    );

    const page1 = path.join(dirPath, 'page_1.png');
    const page2 = path.join(dirPath, 'page_2.png');
    await fsp.writeFile(page1, Buffer.from('PAGE_1_IMAGE_DATA'));
    await fsp.writeFile(page2, Buffer.from('PAGE_2_IMAGE_DATA'));

    const cleaner = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'cleaner_worker',
    });

    // Cleanup should not touch active Docling directory
    const cleanup = await cleaner.cleanupOrphanedScratch();
    expect(cleanup.cleanedFiles).toBe(0);

    expect(await fsp.stat(page1).then(() => true)).toBe(true);
    expect(await fsp.stat(page2).then(() => true)).toBe(true);

    // Release cleans entire directory
    await release();
    expect(await fsp.stat(dirPath).catch(() => false)).toBe(false);

    storage.destroy();
    cleaner.destroy();
  });

  it('Scenario 4: multiple application instances sharing scratch directory do not delete each other active files', async () => {
    const instanceA = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'worker_instance_A',
    });
    const instanceB = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'worker_instance_B',
    });

    const fileA = await instanceA.allocateFile('fileA');
    const fileB = await instanceB.allocateFile('fileB');

    await fsp.writeFile(fileA.filePath, Buffer.from('DATA_A'));
    await fsp.writeFile(fileB.filePath, Buffer.from('DATA_B'));

    // Instance A runs cleanup
    await instanceA.cleanupOrphanedScratch();

    // Instance B's file MUST be intact
    expect(await fsp.stat(fileB.filePath).then(() => true)).toBe(true);

    // Instance B runs cleanup
    await instanceB.cleanupOrphanedScratch();

    // Instance A's file MUST be intact
    expect(await fsp.stat(fileA.filePath).then(() => true)).toBe(true);

    await fileA.release();
    await fileB.release();
    instanceA.destroy();
    instanceB.destroy();
  });

  it('Scenario 5: restarting instance cleans up only expired leases while active peer is unharmed', async () => {
    const activePeer = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'active_peer',
      defaultLeaseTtlMs: 60_000,
    });

    const peerFile = await activePeer.allocateFile('peer_processing');
    await fsp.writeFile(peerFile.filePath, Buffer.from('PEER_DATA'));

    // Simulate an abandoned lease from an old crashed instance with dead PID 999999
    const deadLeaseId = 'lease_crashed_worker_888';
    const deadFilePath = path.join(testScratchRoot, 'workers', 'dead_worker', 'abandoned.plain.tmp');
    await fsp.mkdir(path.dirname(deadFilePath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(deadFilePath, Buffer.from('ABANDONED_PLAINTEXT_SECRET'));

    const deadLease: ScratchFileLease = {
      leaseId: deadLeaseId,
      workerId: 'crashed_worker',
      pid: 999999, // Dead PID
      host: os.hostname(),
      filePath: deadFilePath,
      createdAt: Date.now() - 100_000,
      lastHeartbeat: Date.now() - 100_000,
      ttlMs: 30_000, // Expired
      purpose: 'crashed_operation',
    };
    await fsp.writeFile(
      path.join(testScratchRoot, 'leases', `${deadLeaseId}.lease.json`),
      JSON.stringify(deadLease, null, 2)
    );

    // Restarted instance initializes and scrubs
    const restartedInstance = new ProtectedScratchStorage({
      customScratchDir: testScratchRoot,
      workerId: 'restarted_instance',
    });

    const cleanup = await restartedInstance.cleanupOrphanedScratch();
    expect(cleanup.cleanedLeases).toBe(1);
    expect(cleanup.cleanedFiles).toBe(1);

    // Dead worker abandoned file removed
    expect(await fsp.stat(deadFilePath).catch(() => false)).toBe(false);

    // Active peer file MUST remain untouched
    expect(await fsp.stat(peerFile.filePath).then(() => true)).toBe(true);

    await peerFile.release();
    activePeer.destroy();
    restartedInstance.destroy();
  });

  it('Scenario 6: cleans up process termination during plaintext generation when heartbeat stops and lease expires', async () => {
    const leaseId = 'lease_terminated_proc';
    const deadWorkerDir = path.join(testScratchRoot, 'workers', 'dead_proc_worker');
    await fsp.mkdir(deadWorkerDir, { recursive: true });

    const orphanFile = path.join(deadWorkerDir, 'mid_generation.plain.tmp');
    await fsp.writeFile(orphanFile, Buffer.from('PARTIAL_PLAINTEXT_STREAM'));

    const expiredLease: ScratchFileLease = {
      leaseId,
      workerId: 'dead_proc_worker',
      pid: 999998,
      host: os.hostname(),
      filePath: orphanFile,
      createdAt: Date.now() - 50_000,
      lastHeartbeat: Date.now() - 40_000,
      ttlMs: 20_000, // Expired 20 seconds ago
      purpose: 'unhandled_termination',
    };

    await fsp.mkdir(path.join(testScratchRoot, 'leases'), { recursive: true });
    await fsp.writeFile(
      path.join(testScratchRoot, 'leases', `${leaseId}.lease.json`),
      JSON.stringify(expiredLease, null, 2)
    );

    const cleaner = new ProtectedScratchStorage({ customScratchDir: testScratchRoot });
    const result = await cleaner.cleanupOrphanedScratch();

    expect(result.cleanedFiles).toBe(1);
    expect(result.cleanedLeases).toBe(1);
    expect(await fsp.stat(orphanFile).catch(() => false)).toBe(false);

    cleaner.destroy();
  });

  it('Scenario 7: cleans unleased abandoned files older than grace period', async () => {
    const workerDir = path.join(testScratchRoot, 'workers', 'untracked_worker');
    await fsp.mkdir(workerDir, { recursive: true });

    const unleasedOldFile = path.join(workerDir, 'old_untracked.plain.tmp');
    await fsp.writeFile(unleasedOldFile, Buffer.from('UNTRACKED_OLD_FILE'));

    // Set mtime to 2 minutes ago
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(unleasedOldFile, twoMinutesAgo, twoMinutesAgo);

    const cleaner = new ProtectedScratchStorage({ customScratchDir: testScratchRoot });
    const result = await cleaner.cleanupOrphanedScratch(60_000); // 1 minute grace period

    expect(result.cleanedFiles).toBe(1);
    expect(await fsp.stat(unleasedOldFile).catch(() => false)).toBe(false);

    cleaner.destroy();
  });
});
