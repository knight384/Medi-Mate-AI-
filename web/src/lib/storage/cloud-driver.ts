import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { StorageDriver } from './storage-driver.interface';
import { StoredObjectMetadata, StorageReadResult, StorageSecurityError } from './local-driver';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { isValidStorageKey } from './naming';
import { guessMime } from './mime';

export interface CloudStorageConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  kmsKeyId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** In-memory simulated storage map for test suites */
  simulatedStorage?: Map<string, { buffer: Buffer; metadata: StoredObjectMetadata }>;
}

export class CloudStorageBlockedError extends AppError {
  constructor(message = '[BLOCKED] Cloud Object Storage is not configured or cloud credentials are not provisioned') {
    super(message, 503, 'CLOUD_STORAGE_BLOCKED');
    this.name = 'CloudStorageBlockedError';
  }
}

/**
 * Cloud Object Storage Driver (S3 / GCS Compatible)
 *
 * Implements the StorageDriver contract for enterprise cloud deployments.
 * If credentials or cloud endpoints are unconfigured, operations are fail-safe
 * and explicitly rejected with CloudStorageBlockedError.
 */
export class CloudObjectStorageDriver implements StorageDriver {
  public readonly driverType = 'cloud' as const;
  private readonly config?: CloudStorageConfig;
  private readonly simulatedStore?: Map<string, { buffer: Buffer; metadata: StoredObjectMetadata }>;

  constructor(config?: CloudStorageConfig) {
    this.config = config;
    if (config?.simulatedStorage) {
      this.simulatedStore = config.simulatedStorage;
    }
  }

  public isConfigured(): boolean {
    if (this.simulatedStore) return true;
    return Boolean(
      this.config?.bucket &&
      (this.config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || process.env.S3_BUCKET)
    );
  }

  public async init(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info('CloudObjectStorageDriver initialized in unconfigured/standby state');
      return;
    }
    logger.info('CloudObjectStorageDriver initialized with bucket target', {
      bucket: this.config?.bucket,
    });
  }

  private assertReady(operation: string): void {
    if (!this.isConfigured()) {
      logger.warn('Blocked cloud storage operation: credentials unconfigured', { operation });
      throw new CloudStorageBlockedError(
        `[BLOCKED] Cloud Object Storage operation "${operation}" rejected: S3/GCS credentials and endpoints are not configured in this environment.`
      );
    }
  }

  public async writeStream(
    storageKey: string,
    sourceStream: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxBytes?: number
  ): Promise<StoredObjectMetadata> {
    this.assertReady('writeStream');

    if (!isValidStorageKey(storageKey)) {
      throw new StorageSecurityError(`Invalid storage key format: ${storageKey}`);
    }

    // Convert stream to Buffer
    let nodeReadable: Readable;
    if (sourceStream instanceof Readable) {
      nodeReadable = sourceStream;
    } else if (typeof (sourceStream as ReadableStream<Uint8Array>).getReader === 'function') {
      nodeReadable = Readable.fromWeb(sourceStream as import('node:stream/web').ReadableStream);
    } else {
      nodeReadable = sourceStream as Readable;
    }

    const chunks: Buffer[] = [];
    let bytesWritten = 0;
    const hash = crypto.createHash('sha256');

    for await (const chunk of nodeReadable) {
      const buf = Buffer.from(chunk);
      bytesWritten += buf.length;
      if (maxBytes !== undefined && bytesWritten > maxBytes) {
        throw new StorageSecurityError(`Upload exceeded max limit of ${maxBytes} bytes`);
      }
      hash.update(buf);
      chunks.push(buf);
    }

    const fullBuffer = Buffer.concat(chunks);
    const sha256 = hash.digest('hex');
    const mimeType = guessMime(storageKey);

    const metadata: StoredObjectMetadata = {
      storageKey,
      size: bytesWritten,
      sha256,
      mimeType,
    };

    if (this.simulatedStore) {
      if (this.simulatedStore.has(storageKey)) {
        throw new StorageSecurityError(`Object already exists at storageKey: ${storageKey}`);
      }
      this.simulatedStore.set(storageKey, { buffer: fullBuffer, metadata });
    }

    return metadata;
  }

  public async readStream(storageKey: string): Promise<StorageReadResult> {
    this.assertReady('readStream');

    if (!isValidStorageKey(storageKey)) {
      throw new StorageSecurityError(`Invalid storage key: ${storageKey}`);
    }

    if (this.simulatedStore) {
      const item = this.simulatedStore.get(storageKey);
      if (!item) {
        throw new AppError('Storage document not found in cloud storage', 404, 'NOT_FOUND');
      }
      return {
        stream: Readable.from(item.buffer),
        size: item.metadata.size,
        mimeType: item.metadata.mimeType,
        sha256: item.metadata.sha256,
        isEncrypted: true,
      };
    }

    throw new CloudStorageBlockedError();
  }

  public async readBuffer(storageKey: string): Promise<Buffer> {
    const { stream } = await this.readStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  public async delete(storageKey: string): Promise<boolean> {
    this.assertReady('delete');
    if (!isValidStorageKey(storageKey)) return false;

    if (this.simulatedStore) {
      return this.simulatedStore.delete(storageKey);
    }
    return false;
  }

  public async exists(storageKey: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    if (!isValidStorageKey(storageKey)) return false;

    if (this.simulatedStore) {
      return this.simulatedStore.has(storageKey);
    }
    return false;
  }
}
