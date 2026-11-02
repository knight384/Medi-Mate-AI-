import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  LocalStorageDriver,
  CloudObjectStorageDriver,
  HybridStorageDriver,
  HybridStoragePolicy,
  CloudStorageBlockedError,
} from './index';
import { deploymentProfileManager } from '@/lib/deployment';
import { generateStorageKey } from './naming';

describe('Permanent Architecture — Document Storage Abstractions & Hybrid Storage Policy', () => {
  const testStorageDir = path.resolve(process.cwd(), '..', 'storage', 'test-hybrid-storage-docs');
  let localDriver: LocalStorageDriver;
  let cloudDriver: CloudObjectStorageDriver;
  let hybridDriver: HybridStorageDriver;

  beforeEach(async () => {
    deploymentProfileManager.resetOverride();
    localDriver = new LocalStorageDriver(testStorageDir);
    cloudDriver = new CloudObjectStorageDriver();
    hybridDriver = new HybridStorageDriver(localDriver, cloudDriver);
    await hybridDriver.init();
  });

  afterEach(async () => {
    deploymentProfileManager.resetOverride();
    try {
      await fsp.rm(testStorageDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('CloudObjectStorageDriver Fail-Safe Boundaries', () => {
    it('reports unconfigured state and fails safe with [BLOCKED] when cloud credentials are not provisioned', async () => {
      expect(cloudDriver.isConfigured()).toBe(false);

      const storageKey = generateStorageKey('patient_cloud_unconf', '.pdf');
      const content = Buffer.from('%PDF-1.4 Cloud Target Test');

      await expect(
        cloudDriver.writeStream(storageKey, Readable.from(content))
      ).rejects.toThrow(CloudStorageBlockedError);

      await expect(cloudDriver.readStream(storageKey)).rejects.toThrow(
        CloudStorageBlockedError
      );
    });

    it('successfully processes writes, reads, and deletes when provisioned with simulated store', async () => {
      const simulatedStore = new Map();
      const configuredCloudDriver = new CloudObjectStorageDriver({
        bucket: 'medimate-cloud-bucket',
        simulatedStorage: simulatedStore,
      });
      await configuredCloudDriver.init();
      expect(configuredCloudDriver.isConfigured()).toBe(true);

      const storageKey = generateStorageKey('patient_sim_cloud', '.pdf');
      const content = Buffer.from('%PDF-1.4 Simulated Cloud Document');

      const meta = await configuredCloudDriver.writeStream(storageKey, Readable.from(content));
      expect(meta.storageKey).toBe(storageKey);
      expect(meta.size).toBe(content.length);

      expect(await configuredCloudDriver.exists(storageKey)).toBe(true);

      const readBuffer = await configuredCloudDriver.readBuffer(storageKey);
      expect(readBuffer.equals(content)).toBe(true);

      const deleted = await configuredCloudDriver.delete(storageKey);
      expect(deleted).toBe(true);
      expect(await configuredCloudDriver.exists(storageKey)).toBe(false);
    });
  });

  describe('HybridStoragePolicy & HybridStorageDriver Enforcement', () => {
    it('HybridStoragePolicy routes PHI documents strictly to local driver in local and hybrid modes', () => {
      deploymentProfileManager.setOverrideMode('local');
      expect(
        HybridStoragePolicy.selectTargetDriver('users/patient_1/doc.pdf', 'PHI_CLINICAL_DOCUMENT')
      ).toBe('local');

      deploymentProfileManager.setOverrideMode('hybrid');
      expect(
        HybridStoragePolicy.selectTargetDriver('users/patient_1/doc.pdf', 'PHI_CLINICAL_DOCUMENT')
      ).toBe('local');

      // Non-sensitive assets in hybrid mode route to cloud
      expect(
        HybridStoragePolicy.selectTargetDriver('static/public_template.json', 'PUBLIC_STATIC_ASSET')
      ).toBe('cloud');
    });

    it('HybridStorageDriver writes sensitive patient document to local encrypted storage in hybrid mode', async () => {
      deploymentProfileManager.setOverrideMode('hybrid');
      const storageKey = generateStorageKey('patient_hybrid_write', '.pdf');
      const content = Buffer.from('%PDF-1.4 Hybrid Private Medical Record');

      // Write through unified hybrid driver
      const meta = await hybridDriver.writeStream(storageKey, Readable.from(content));
      expect(meta.size).toBe(content.length);

      // Verify physical document exists locally in local driver, NOT cloud
      expect(await localDriver.exists(storageKey)).toBe(true);
      expect(await cloudDriver.exists(storageKey)).toBe(false);

      // Read back transparently through hybrid driver
      const readBuf = await hybridDriver.readBuffer(storageKey);
      expect(readBuf.equals(content)).toBe(true);
    });

    it('HybridStorageDriver transparently delegates getValidatedDiskPath to local storage', async () => {
      const storageKey = generateStorageKey('patient_disk_path', '.pdf');
      const content = Buffer.from('%PDF-1.4 OCR Disk Path Target');

      await hybridDriver.writeStream(storageKey, Readable.from(content));

      const diskPath = await hybridDriver.getValidatedDiskPath(storageKey);
      expect(path.isAbsolute(diskPath)).toBe(true);
      expect(diskPath.includes('test-hybrid-storage-docs')).toBe(true);
    });
  });
});
