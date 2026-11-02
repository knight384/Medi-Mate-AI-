import { Readable } from 'node:stream';
import { StorageDriver } from './storage-driver.interface';
import { LocalStorageDriver, StoredObjectMetadata, StorageReadResult, StorageSecurityError } from './local-driver';
import { CloudObjectStorageDriver } from './cloud-driver';
import { deploymentProfileManager } from '@/lib/deployment';

export type DocumentSensitivityClass =
  | 'PHI_CLINICAL_DOCUMENT' // Patient records, blood tests, clinical PDF summaries
  | 'PUBLIC_STATIC_ASSET'   // System icons, static assets
  | 'ANONYMIZED_EXPORT';    // Explicitly de-identified exports with consent

export class HybridStoragePolicy {
  /**
   * Evaluates where an object must be stored based on key, sensitivity, and active deployment profile.
   *
   * STRICT ARCHITECTURAL INVARIANT:
   * In Local and Hybrid deployment modes, PHI_CLINICAL_DOCUMENT must ALWAYS be stored locally.
   * Silent routing of raw patient health records to public cloud is permanently forbidden.
   */
  public static selectTargetDriver(
    storageKey: string,
    sensitivity: DocumentSensitivityClass = 'PHI_CLINICAL_DOCUMENT'
  ): 'local' | 'cloud' {
    const profile = deploymentProfileManager.getActiveMode();

    if (profile === 'local') {
      return 'local';
    }

    if (profile === 'hybrid') {
      // Hybrid mode: Clinical documents stay strictly local. Only non-sensitive assets can use cloud.
      if (sensitivity === 'PHI_CLINICAL_DOCUMENT' || storageKey.startsWith('users/')) {
        return 'local';
      }
      return 'cloud';
    }

    // Cloud deployment mode
    return 'cloud';
  }
}

/**
 * Hybrid Storage Driver
 *
 * Implements the unified StorageDriver interface by intelligently routing
 * read/write operations between LocalStorageDriver (for private PHI)
 * and CloudObjectStorageDriver (for cloud or static resources).
 */
export class HybridStorageDriver implements StorageDriver {
  public readonly driverType = 'hybrid' as const;
  private readonly localDriver: LocalStorageDriver;
  private readonly cloudDriver: CloudObjectStorageDriver;

  constructor(localDriver: LocalStorageDriver, cloudDriver: CloudObjectStorageDriver) {
    this.localDriver = localDriver;
    this.cloudDriver = cloudDriver;
  }

  public async init(): Promise<void> {
    await this.localDriver.init();
    await this.cloudDriver.init();
  }

  public getLocalDriver(): LocalStorageDriver {
    return this.localDriver;
  }

  public getCloudDriver(): CloudObjectStorageDriver {
    return this.cloudDriver;
  }

  public async writeStream(
    storageKey: string,
    sourceStream: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxBytes?: number,
    sensitivity: DocumentSensitivityClass = 'PHI_CLINICAL_DOCUMENT'
  ): Promise<StoredObjectMetadata> {
    const target = HybridStoragePolicy.selectTargetDriver(storageKey, sensitivity);

    if (target === 'local') {
      return this.localDriver.writeStream(storageKey, sourceStream, maxBytes);
    } else {
      deploymentProfileManager.assertCloudEgressPermitted(`Cloud document write: ${storageKey}`);
      deploymentProfileManager.assertRawDocumentStorageAllowed('cloud');
      return this.cloudDriver.writeStream(storageKey, sourceStream, maxBytes);
    }
  }

  public async readStream(storageKey: string): Promise<StorageReadResult> {
    // In hybrid mode, inspect local driver first (where PHI documents reside)
    if (await this.localDriver.exists(storageKey)) {
      return this.localDriver.readStream(storageKey);
    }

    if (await this.cloudDriver.exists(storageKey)) {
      deploymentProfileManager.assertCloudEgressPermitted(`Cloud document read: ${storageKey}`);
      return this.cloudDriver.readStream(storageKey);
    }

    // Default to localDriver to let it throw standard NotFoundError
    return this.localDriver.readStream(storageKey);
  }

  public async readBuffer(storageKey: string): Promise<Buffer> {
    if (await this.localDriver.exists(storageKey)) {
      return this.localDriver.readBuffer(storageKey);
    }
    if (await this.cloudDriver.exists(storageKey)) {
      deploymentProfileManager.assertCloudEgressPermitted(`Cloud buffer read: ${storageKey}`);
      return this.cloudDriver.readBuffer(storageKey);
    }
    return this.localDriver.readBuffer(storageKey);
  }

  public async delete(storageKey: string): Promise<boolean> {
    let deleted = false;
    if (await this.localDriver.exists(storageKey)) {
      deleted = (await this.localDriver.delete(storageKey)) || deleted;
    }
    if (await this.cloudDriver.exists(storageKey)) {
      deleted = (await this.cloudDriver.delete(storageKey)) || deleted;
    }
    return deleted;
  }

  public async exists(storageKey: string): Promise<boolean> {
    const localExists = await this.localDriver.exists(storageKey);
    if (localExists) return true;
    return this.cloudDriver.exists(storageKey);
  }

  public async getValidatedDiskPath(storageKey: string): Promise<string> {
    // Local disk paths are exclusively provided by the private LocalStorageDriver
    if (await this.localDriver.exists(storageKey)) {
      return this.localDriver.getValidatedDiskPath(storageKey);
    }
    throw new StorageSecurityError(
      `Cannot get local physical disk path: document is not stored in local storage (${storageKey})`
    );
  }

  public async withDecryptedTempFile<T>(
    storageKey: string,
    fn: (tempPlaintextPath: string) => Promise<T>
  ): Promise<T> {
    if (await this.localDriver.exists(storageKey)) {
      return this.localDriver.withDecryptedTempFile(storageKey, fn);
    }
    throw new StorageSecurityError(
      `withDecryptedTempFile is only supported for local storage objects (${storageKey})`
    );
  }
}
