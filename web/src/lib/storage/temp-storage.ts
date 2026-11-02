import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from '@/lib/logger';

export interface ScratchFileLease {
  leaseId: string;
  workerId: string;
  pid: number;
  host: string;
  filePath: string;
  createdAt: number;
  lastHeartbeat: number;
  ttlMs: number;
  purpose: string;
}

export interface ScratchStorageOptions {
  customScratchDir?: string;
  workerId?: string;
  defaultLeaseTtlMs?: number;
  heartbeatIntervalMs?: number;
}

/**
 * Checks if a process with the given PID is alive on the local machine.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    // EPERM means process exists but we lack permission to signal it (still alive)
    if (error.code === 'EPERM') return true;
    // ESRCH means no such process (dead)
    if (error.code === 'ESRCH') return false;
    return false;
  }
}

/**
 * Protected Scratch Storage Service
 *
 * Implements RAM-backed / ephemeral temporary plaintext isolation with
 * per-worker directory partitioning, exclusive file creation, active lease heartbeats,
 * and race-safe orphan scrubbing.
 */
export class ProtectedScratchStorage {
  private readonly scratchRoot: string;
  private readonly workerId: string;
  private readonly defaultLeaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly activeHeartbeats = new Map<string, NodeJS.Timeout>();
  private isInitialized = false;

  constructor(options: ScratchStorageOptions = {}) {
    this.workerId =
      options.workerId ||
      process.env.MEDIMATE_WORKER_ID ||
      `${os.hostname()}_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    this.defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 60_000; // 1 minute default TTL
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000; // 15s heartbeats

    this.scratchRoot = this.resolveScratchRoot(options.customScratchDir);
  }

  /**
   * Resolves the protected scratch directory:
   * 1. Explicitly configured directory via constructor or MEDIMATE_SCRATCH_DIR / MEDIMATE_TEMP_DIR.
   * 2. Linux/Docker RAM-backed tmpfs (/dev/shm) if accessible and writable.
   * 3. Ephemeral OS temp directory (os.tmpdir()/medimate-scratch), isolated from persistent volumes.
   */
  private resolveScratchRoot(customDir?: string): string {
    if (customDir) {
      return path.resolve(customDir);
    }
    if (process.env.MEDIMATE_SCRATCH_DIR) {
      return path.resolve(process.env.MEDIMATE_SCRATCH_DIR);
    }
    if (process.env.MEDIMATE_TEMP_DIR) {
      return path.resolve(process.env.MEDIMATE_TEMP_DIR);
    }

    // Check for RAM-backed /dev/shm on Linux/container environments
    if (process.platform === 'linux') {
      try {
        if (fs.existsSync('/dev/shm')) {
          fs.accessSync('/dev/shm', fs.constants.W_OK);
          return path.resolve('/dev/shm/medimate-scratch');
        }
      } catch {
        // Fall back to os.tmpdir() if /dev/shm is unwritable
      }
    }

    // Default: OS ephemeral temp directory, completely separated from persistent storage volumes
    return path.join(os.tmpdir(), 'medimate-scratch');
  }

  public getScratchRoot(): string {
    return this.scratchRoot;
  }

  public getWorkerId(): string {
    return this.workerId;
  }

  public getWorkerDir(): string {
    return path.join(this.scratchRoot, 'workers', this.workerId);
  }

  public getLeasesDir(): string {
    return path.join(this.scratchRoot, 'leases');
  }

  /**
   * Initializes scratch storage with restrictive permissions (0700).
   */
  public async init(): Promise<void> {
    if (this.isInitialized) return;

    await fsp.mkdir(this.scratchRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.getLeasesDir(), { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.getWorkerDir(), { recursive: true, mode: 0o700 });

    this.isInitialized = true;
  }

  /**
   * Allocates an exclusive temporary plaintext file under worker isolation with an active lease.
   */
  public async allocateFile(
    prefix = 'scratch',
    extension = '.plain.tmp',
    purpose = 'temporary_decryption',
    leaseTtlMs?: number
  ): Promise<{
    filePath: string;
    leaseId: string;
    release: () => Promise<void>;
  }> {
    await this.init();

    const opId = crypto.randomUUID();
    const fileName = `${prefix}_${opId}${extension}`;
    const filePath = path.join(this.getWorkerDir(), fileName);
    const leaseId = `lease_${opId}`;
    const ttl = leaseTtlMs ?? this.defaultLeaseTtlMs;

    const lease: ScratchFileLease = {
      leaseId,
      workerId: this.workerId,
      pid: process.pid,
      host: os.hostname(),
      filePath,
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      ttlMs: ttl,
      purpose,
    };

    const leasePath = path.join(this.getLeasesDir(), `${leaseId}.lease.json`);
    await fsp.writeFile(leasePath, JSON.stringify(lease, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });

    // Start lease heartbeat to keep file active during long operations
    const timer = setInterval(async () => {
      try {
        lease.lastHeartbeat = Date.now();
        await fsp.writeFile(leasePath, JSON.stringify(lease, null, 2));
      } catch {
        // Ignore background heartbeat write failures
      }
    }, this.heartbeatIntervalMs);

    // Unref timer so it does not prevent node process exit
    if (timer.unref) {
      timer.unref();
    }
    this.activeHeartbeats.set(leaseId, timer);

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;

      const activeTimer = this.activeHeartbeats.get(leaseId);
      if (activeTimer) {
        clearInterval(activeTimer);
        this.activeHeartbeats.delete(leaseId);
      }

      // 1. Delete temporary plaintext file
      try {
        await fsp.unlink(filePath);
      } catch {
        // File may have already been cleaned or moved
      }

      // 2. Delete lease file
      try {
        await fsp.unlink(leasePath);
      } catch {
        // Ignore if lease already deleted
      }
    };

    return { filePath, leaseId, release };
  }

  /**
   * Allocates an exclusive isolated directory for multi-file operations (e.g., OCR page images).
   */
  public async allocateDir(
    prefix = 'ocr_scratch',
    purpose = 'ocr_page_processing',
    leaseTtlMs?: number
  ): Promise<{
    dirPath: string;
    leaseId: string;
    release: () => Promise<void>;
  }> {
    await this.init();

    const opId = crypto.randomUUID();
    const dirName = `${prefix}_${opId}`;
    const dirPath = path.join(this.getWorkerDir(), dirName);
    await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });

    const leaseId = `lease_${opId}`;
    const ttl = leaseTtlMs ?? this.defaultLeaseTtlMs;

    const lease: ScratchFileLease = {
      leaseId,
      workerId: this.workerId,
      pid: process.pid,
      host: os.hostname(),
      filePath: dirPath,
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      ttlMs: ttl,
      purpose,
    };

    const leasePath = path.join(this.getLeasesDir(), `${leaseId}.lease.json`);
    await fsp.writeFile(leasePath, JSON.stringify(lease, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });

    const timer = setInterval(async () => {
      try {
        lease.lastHeartbeat = Date.now();
        await fsp.writeFile(leasePath, JSON.stringify(lease, null, 2));
      } catch {
        // Ignore background heartbeat write failures
      }
    }, this.heartbeatIntervalMs);

    if (timer.unref) {
      timer.unref();
    }
    this.activeHeartbeats.set(leaseId, timer);

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;

      const activeTimer = this.activeHeartbeats.get(leaseId);
      if (activeTimer) {
        clearInterval(activeTimer);
        this.activeHeartbeats.delete(leaseId);
      }

      try {
        await fsp.rm(dirPath, { recursive: true, force: true });
      } catch {
        // Ignore if already deleted
      }

      try {
        await fsp.unlink(leasePath);
      } catch {
        // Ignore if lease already deleted
      }
    };

    return { dirPath, leaseId, release };
  }

  /**
   * Heartbeats a lease directly (e.g. called manually by streaming downloads or OCR loops).
   */
  public async touchLease(leaseId: string): Promise<boolean> {
    const leasePath = path.join(this.getLeasesDir(), `${leaseId}.lease.json`);
    try {
      const data = await fsp.readFile(leasePath, 'utf8');
      const lease = JSON.parse(data) as ScratchFileLease;
      lease.lastHeartbeat = Date.now();
      await fsp.writeFile(leasePath, JSON.stringify(lease, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Race-Safe Orphan Scrubber:
   *
   * Cleans up orphaned plaintext files and stale leases without deleting active files.
   *
   * An object is considered genuinely orphaned ONLY IF:
   * 1. It is tracked by a lease whose owning process is confirmed dead on the local host, OR
   * 2. Its lease heartbeat has lapsed past its TTL (indicating a crash or network partition), OR
   * 3. An unleased file exists that is older than gracePeriodMs (defaults to 60s).
   *
   * Active files whose heartbeat is fresh or worker is alive are NEVER deleted, even if > 15 minutes old.
   *
   * @param gracePeriodMs Grace period for unleased files (default 60,000 ms)
   * @returns Number of orphaned resources cleaned
   */
  public async cleanupOrphanedScratch(gracePeriodMs = 60_000): Promise<{
    cleanedLeases: number;
    cleanedFiles: number;
  }> {
    await this.init();

    let cleanedLeases = 0;
    let cleanedFiles = 0;
    const now = Date.now();
    const activeLeasedPaths = new Set<string>();

    // 1. Scan and inspect all lease files
    const leasesDir = this.getLeasesDir();
    let leaseEntries: fs.Dirent[] = [];
    try {
      leaseEntries = await fsp.readdir(leasesDir, { withFileTypes: true });
    } catch {
      return { cleanedLeases: 0, cleanedFiles: 0 };
    }

    for (const entry of leaseEntries) {
      if (entry.isFile() && entry.name.endsWith('.lease.json')) {
        const leasePath = path.join(leasesDir, entry.name);
        try {
          const content = await fsp.readFile(leasePath, 'utf8');
          const lease = JSON.parse(content) as ScratchFileLease;

          const isLocalHost = lease.host === os.hostname();
          const isAlive = isLocalHost ? isProcessAlive(lease.pid) : true;
          const heartbeatAge = now - lease.lastHeartbeat;
          const isExpired = heartbeatAge > lease.ttlMs;

          if (!isAlive || isExpired) {
            // Owning process is dead or heartbeat expired -> Clean up orphaned resource
            logger.warn('Cleaning up orphaned scratch file from dead/expired lease', {
              leaseId: lease.leaseId,
              workerId: lease.workerId,
              pid: lease.pid,
              isAlive,
              heartbeatAgeMs: heartbeatAge,
              filePath: lease.filePath,
            });

            try {
              const stat = await fsp.stat(lease.filePath);
              if (stat.isDirectory()) {
                await fsp.rm(lease.filePath, { recursive: true, force: true });
              } else {
                await fsp.unlink(lease.filePath);
              }
              cleanedFiles++;
            } catch {
              // File already removed
            }

            await fsp.unlink(leasePath).catch(() => {});
            cleanedLeases++;
          } else {
            // Lease is active and healthy -> Protect file from deletion
            activeLeasedPaths.add(path.resolve(lease.filePath));
          }
        } catch {
          // Corrupted or unreadable lease file -> remove lease
          await fsp.unlink(leasePath).catch(() => {});
          cleanedLeases++;
        }
      }
    }

    // 2. Scan workers directory for unleased/abandoned temporary files
    const workersDir = path.join(this.scratchRoot, 'workers');
    try {
      const workerEntries = await fsp.readdir(workersDir, { withFileTypes: true });
      for (const workerEntry of workerEntries) {
        if (workerEntry.isDirectory()) {
          const workerPath = path.join(workersDir, workerEntry.name);
          const files = await fsp.readdir(workerPath, { withFileTypes: true });

          for (const file of files) {
            const fullPath = path.join(workerPath, file.name);
            const resolvedPath = path.resolve(fullPath);

            if (activeLeasedPaths.has(resolvedPath)) {
              // File has an active lease -> Never delete!
              continue;
            }

            try {
              const stat = await fsp.stat(fullPath);
              if (now - stat.mtimeMs > gracePeriodMs) {
                // Unleased file older than grace period -> delete orphan
                if (file.isDirectory()) {
                  await fsp.rm(fullPath, { recursive: true, force: true });
                } else {
                  await fsp.unlink(fullPath);
                }
                cleanedFiles++;
                logger.info('Cleaned up unleased orphaned scratch file', {
                  filePath: fullPath,
                  ageMs: now - stat.mtimeMs,
                });
              }
            } catch {
              // File disappeared concurrently
            }
          }

          // If worker directory is empty and not our own worker, remove it
          if (workerEntry.name !== this.workerId) {
            try {
              const remaining = await fsp.readdir(workerPath);
              if (remaining.length === 0) {
                await fsp.rmdir(workerPath);
              }
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Ignore directory scan errors
    }

    return { cleanedLeases, cleanedFiles };
  }

  /**
   * Closes active resources and stops all background heartbeats.
   */
  public destroy(): void {
    for (const timer of this.activeHeartbeats.values()) {
      clearInterval(timer);
    }
    this.activeHeartbeats.clear();
  }
}

// Global default singleton
export const protectedScratchStorage = new ProtectedScratchStorage();
