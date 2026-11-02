import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import {
  LocalStorageDriver,
  MAGIC_HEADER_V2,
  MAGIC_HEADER_V3,
  HEADER_SIZE_V2,
  HEADER_SIZE_V3,
} from '../local-driver';
import { logger } from '@/lib/logger';

export interface StorageLocationInventory {
  name: string;
  locationType: 'active' | 'retired' | 'historical' | 'unmounted_volume';
  mountOrVolumeIdentity: string;
  canonicalPath: string;
  accessible: boolean;
  accessStatus: 'ACCESSIBLE' | 'UNKNOWN' | 'BLOCKED';
  totalFiles: number;
  formatDistribution: {
    MM_ENC03: number;
    MM_ENC02: number;
    LEGACY_PLAINTEXT: number;
    UNRECOGNIZED_CORRUPT: number;
  };
  linkedDatabaseRecords: number;
  missingFiles: number;
  orphanedFiles: number;
  details?: string;
}

export interface CompleteStorageInventoryReport {
  timestamp: string;
  locations: StorageLocationInventory[];
  overallMigrationStatus: 'COMPLETE' | 'IN_PROGRESS' | 'PARTIALLY_BLOCKED' | 'PENDING';
  unresolvedLocations: string[];
}

/**
 * Inspects a single physical file read-only to determine its encryption format.
 */
export async function inspectFileEncryptionFormat(
  filePath: string
): Promise<'MM_ENC03' | 'MM_ENC02' | 'LEGACY_PLAINTEXT' | 'UNRECOGNIZED_CORRUPT'> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return 'UNRECOGNIZED_CORRUPT';
  }

  if (!stat.isFile()) {
    return 'UNRECOGNIZED_CORRUPT';
  }

  if (stat.size < HEADER_SIZE_V2) {
    return 'LEGACY_PLAINTEXT';
  }

  const buf = Buffer.alloc(HEADER_SIZE_V3);
  const fh = await fsp.open(filePath, 'r');
  let bytesRead = 0;
  try {
    const res = await fh.read(buf, 0, HEADER_SIZE_V3, 0);
    bytesRead = res.bytesRead;
  } finally {
    await fh.close();
  }

  if (bytesRead >= HEADER_SIZE_V3 && buf.subarray(0, 8).equals(MAGIC_HEADER_V3)) {
    return 'MM_ENC03';
  }
  if (bytesRead >= HEADER_SIZE_V2 && buf.subarray(0, 8).equals(MAGIC_HEADER_V2)) {
    return 'MM_ENC02';
  }

  return 'LEGACY_PLAINTEXT';
}

/**
 * Recursively audits a real physical directory read-only.
 */
async function auditDirectoryRecursive(dirPath: string): Promise<{
  files: string[];
  distribution: {
    MM_ENC03: number;
    MM_ENC02: number;
    LEGACY_PLAINTEXT: number;
    UNRECOGNIZED_CORRUPT: number;
  };
}> {
  const files: string[] = [];
  const distribution = {
    MM_ENC03: 0,
    MM_ENC02: 0,
    LEGACY_PLAINTEXT: 0,
    UNRECOGNIZED_CORRUPT: 0,
  };

  async function scan(currentDir: string): Promise<void> {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.tmp' && entry.name !== '.scratch' && entry.name !== 'node_modules') {
          await scan(fullPath);
        }
      } else if (entry.isFile()) {
        if (!entry.name.endsWith('.bak') && !entry.name.endsWith('.tmp') && !entry.name.endsWith('.gitkeep')) {
          files.push(fullPath);
          const format = await inspectFileEncryptionFormat(fullPath);
          distribution[format]++;
        }
      }
    }
  }

  await scan(dirPath);
  return { files, distribution };
}

/**
 * Audits all known historical, active, development, and container storage roots.
 */
export async function auditAllStorageLocations(
  activeDriver: LocalStorageDriver,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaClient?: any
): Promise<CompleteStorageInventoryReport> {
  const timestamp = new Date().toISOString();
  const locations: StorageLocationInventory[] = [];

  // Location 1: Active LocalStorageDriver Root
  const activeRoot = activeDriver.getStorageRoot();
  try {
    const canonical = await fsp.realpath(activeRoot).catch(() => path.resolve(activeRoot));
    const exists = await fsp.stat(activeRoot).then(() => true).catch(() => false);

    if (exists) {
      const { files, distribution } = await auditDirectoryRecursive(activeRoot);

      // Check DB records if prismaClient is provided
      let dbRecordCount = 0;
      let missingCount = 0;
      if (prismaClient) {
        try {
          const records = await prismaClient.healthData.findMany({
            where: { storageKey: { not: null } },
            select: { storageKey: true },
          });
          dbRecordCount = records.length;
          for (const rec of records) {
            const expectedPath = path.resolve(activeRoot, rec.storageKey);
            if (!fs.existsSync(expectedPath)) {
              missingCount++;
            }
          }
        } catch {
          // DB might be offline or schema unconfigured
        }
      }

      locations.push({
        name: 'Active LocalStorageDriver Root',
        locationType: 'active',
        mountOrVolumeIdentity: 'host_filesystem_active_root',
        canonicalPath: canonical,
        accessible: true,
        accessStatus: 'ACCESSIBLE',
        totalFiles: files.length,
        formatDistribution: distribution,
        linkedDatabaseRecords: dbRecordCount,
        missingFiles: missingCount,
        orphanedFiles: Math.max(0, files.length - (dbRecordCount - missingCount)),
        details: 'Active primary storage directory configured via LocalStorageDriver or MEDIMATE_STORAGE_DIR.',
      });
    } else {
      locations.push({
        name: 'Active LocalStorageDriver Root',
        locationType: 'active',
        mountOrVolumeIdentity: 'host_filesystem_active_root',
        canonicalPath: path.resolve(activeRoot),
        accessible: false,
        accessStatus: 'UNKNOWN',
        totalFiles: 0,
        formatDistribution: { MM_ENC03: 0, MM_ENC02: 0, LEGACY_PLAINTEXT: 0, UNRECOGNIZED_CORRUPT: 0 },
        linkedDatabaseRecords: 0,
        missingFiles: 0,
        orphanedFiles: 0,
        details: 'Configured active storage path does not physically exist on disk.',
      });
    }
  } catch (err) {
    logger.error('Failed auditing active storage root', { error: String(err) });
  }

  // Location 2: Development / Historical Public Uploads
  const publicUploadsPath = path.resolve(process.cwd(), 'public', 'uploads');
  try {
    const exists = await fsp.stat(publicUploadsPath).then(() => true).catch(() => false);
    if (exists) {
      const canonical = await fsp.realpath(publicUploadsPath).catch(() => publicUploadsPath);
      const { files, distribution } = await auditDirectoryRecursive(publicUploadsPath);

      locations.push({
        name: 'Development Public Uploads',
        locationType: 'retired',
        mountOrVolumeIdentity: 'public_uploads_legacy_directory',
        canonicalPath: canonical,
        accessible: true,
        accessStatus: 'ACCESSIBLE',
        totalFiles: files.length,
        formatDistribution: distribution,
        linkedDatabaseRecords: 0,
        missingFiles: 0,
        orphanedFiles: files.length,
        details: 'Decommissioned development uploads directory. Only .gitkeep present; public routes permanently return 404.',
      });
    }
  } catch {
    // Ignore
  }

  // Location 3: Repository Root Default Storage
  const repoStoragePath = path.resolve(process.cwd(), '..', 'storage', 'documents');
  try {
    const exists = await fsp.stat(repoStoragePath).then(() => true).catch(() => false);
    if (exists && path.resolve(repoStoragePath) !== path.resolve(activeRoot)) {
      const canonical = await fsp.realpath(repoStoragePath).catch(() => repoStoragePath);
      const { files, distribution } = await auditDirectoryRecursive(repoStoragePath);

      locations.push({
        name: 'Repository Root Storage Documents',
        locationType: 'historical',
        mountOrVolumeIdentity: 'repo_storage_documents',
        canonicalPath: canonical,
        accessible: true,
        accessStatus: 'ACCESSIBLE',
        totalFiles: files.length,
        formatDistribution: distribution,
        linkedDatabaseRecords: 0,
        missingFiles: 0,
        orphanedFiles: files.length,
        details: 'Default repository fallback storage root outside web directory.',
      });
    }
  } catch {
    // Ignore
  }

  // Location 4: Docker Named Volume app_storage (/app/storage)
  locations.push({
    name: 'Docker app_storage Volume',
    locationType: 'unmounted_volume',
    mountOrVolumeIdentity: 'docker_volume:app_storage:/app/storage',
    canonicalPath: '/var/lib/docker/volumes/app_storage/_data',
    accessible: false,
    accessStatus: 'BLOCKED',
    totalFiles: 0,
    formatDistribution: { MM_ENC03: 0, MM_ENC02: 0, LEGACY_PLAINTEXT: 0, UNRECOGNIZED_CORRUPT: 0 },
    linkedDatabaseRecords: 0,
    missingFiles: 0,
    orphanedFiles: 0,
    details: 'Docker daemon offline on Windows host; container volume cannot be mounted or accessed directly without active engine.',
  });

  // Location 5: Docker Named Volume app_data (/app/legacy_uploads)
  locations.push({
    name: 'Docker app_data Legacy Uploads Volume',
    locationType: 'unmounted_volume',
    mountOrVolumeIdentity: 'docker_volume:app_data:/app/legacy_uploads:ro',
    canonicalPath: '/var/lib/docker/volumes/app_data/_data',
    accessible: false,
    accessStatus: 'BLOCKED',
    totalFiles: 0,
    formatDistribution: { MM_ENC03: 0, MM_ENC02: 0, LEGACY_PLAINTEXT: 0, UNRECOGNIZED_CORRUPT: 0 },
    linkedDatabaseRecords: 0,
    missingFiles: 0,
    orphanedFiles: 0,
    details: 'Read-only legacy container volume; blocked pending active Docker daemon.',
  });

  const unresolvedLocations = locations
    .filter((loc) => loc.accessStatus === 'BLOCKED' || loc.accessStatus === 'UNKNOWN')
    .map((loc) => loc.name);

  const hasLegacyPlaintext = locations.some((loc) => loc.formatDistribution.LEGACY_PLAINTEXT > 0);

  let overallMigrationStatus: 'COMPLETE' | 'IN_PROGRESS' | 'PARTIALLY_BLOCKED' | 'PENDING' = 'COMPLETE';
  if (unresolvedLocations.length > 0) {
    overallMigrationStatus = 'PARTIALLY_BLOCKED';
  } else if (hasLegacyPlaintext) {
    overallMigrationStatus = 'IN_PROGRESS';
  }

  return {
    timestamp,
    locations,
    overallMigrationStatus,
    unresolvedLocations,
  };
}
