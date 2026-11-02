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
  sessionToken?: string;
  /** In-memory simulated storage map for test suites */
  simulatedStorage?: Map<string, { buffer: Buffer; metadata: StoredObjectMetadata }>;
  /** Optional custom fetch implementation for testing */
  fetchFn?: typeof fetch;
}

export class CloudStorageBlockedError extends AppError {
  constructor(message = '[BLOCKED] Cloud Object Storage is not configured or cloud credentials are not provisioned') {
    super(message, 503, 'CLOUD_STORAGE_BLOCKED');
    this.name = 'CloudStorageBlockedError';
  }
}

/**
 * Validates that a storage key enforces strict multi-tenant isolation.
 * Prohibits global or root-level object placement.
 */
export function assertTenantKey(storageKey: string): void {
  if (!isValidStorageKey(storageKey)) {
    throw new StorageSecurityError(`Invalid storage key format: ${storageKey}`);
  }
  const parts = storageKey.split('/');
  if (parts.length < 3 || (!['users', 'tenants'].includes(parts[0]))) {
    throw new StorageSecurityError(
      `Tenant isolation violation: storageKey "${storageKey}" must follow "users/<userId>/..." or "tenants/<tenantId>/..." hierarchy`
    );
  }
  const tenantId = parts[1];
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
    throw new StorageSecurityError(`Invalid tenant identifier in storage key: ${tenantId}`);
  }
}

/**
 * Enterprise Cloud Object Storage Driver (AWS S3 Compatible)
 *
 * Implements private object storage, tenant isolation, SHA-256 upload integrity checks,
 * application-level encryption preservation, and fail-closed security.
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
      (this.config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID) &&
      (this.config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY)
    );
  }

  public async init(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info('CloudObjectStorageDriver initialized in unconfigured/standby state');
      return;
    }
    logger.info('CloudObjectStorageDriver initialized with bucket target', {
      bucket: this.config?.bucket,
      region: this.config?.region || 'us-east-1',
    });
  }

  private assertReady(operation: string): void {
    if (!this.isConfigured()) {
      logger.warn('Blocked cloud storage operation: credentials unconfigured', { operation });
      throw new CloudStorageBlockedError(
        `[BLOCKED] Cloud Object Storage operation "${operation}" rejected: S3 credentials and endpoints are not configured in this environment.`
      );
    }
  }

  /**
   * Generates a signed canonical URL for temporary authorized client download.
   */
  public async generatePresignedDownloadUrl(storageKey: string, expiresInSeconds = 900): Promise<string> {
    this.assertReady('generatePresignedDownloadUrl');
    assertTenantKey(storageKey);

    const region = this.config?.region || process.env.AWS_REGION || 'us-east-1';
    const bucket = this.config?.bucket || process.env.MEDIMATE_CLOUD_STORAGE_BUCKET || 'medimate-bucket';

    if (this.simulatedStore) {
      // Mock pre-signed URL for test environments
      const token = crypto.randomBytes(16).toString('hex');
      return `https://${bucket}.s3.${region}.amazonaws.com/${storageKey}?X-Amz-Expires=${expiresInSeconds}&X-Amz-Signature=${token}`;
    }

    const accessKeyId = this.config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID!;
    const secretAccessKey = this.config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY!;

    const date = new Date();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': 'host',
    };

    const sortedQuery = Object.keys(queryParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
      .join('&');

    const host = `${bucket}.s3.${region}.amazonaws.com`;
    const canonicalRequest = [
      'GET',
      `/${storageKey}`,
      sortedQuery,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    return `https://${host}/${storageKey}?${sortedQuery}&X-Amz-Signature=${signature}`;
  }

  public async writeStream(
    storageKey: string,
    sourceStream: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array> | Buffer | Uint8Array,
    maxBytes?: number
  ): Promise<StoredObjectMetadata> {
    this.assertReady('writeStream');
    assertTenantKey(storageKey);

    // Convert stream to Buffer
    let nodeReadable: Readable;
    if (Buffer.isBuffer(sourceStream) || sourceStream instanceof Uint8Array) {
      nodeReadable = Readable.from([Buffer.from(sourceStream)]);
    } else if (sourceStream instanceof Readable) {
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
      return metadata;
    }

    // Real S3 PutObject with SigV4 and retries
    const bucket = this.config?.bucket || process.env.MEDIMATE_CLOUD_STORAGE_BUCKET!;
    const region = this.config?.region || process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = this.config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID!;
    const secretAccessKey = this.config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY!;
    const endpointStr = this.config?.endpoint || `https://${bucket}.s3.${region}.amazonaws.com/${storageKey}`;
    const endpoint = new URL(endpointStr);
    const fetchImpl = this.config?.fetchFn || fetch;

    const date = new Date();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);
    const payloadHash = sha256;

    const headers: Record<string, string> = {
      'content-type': mimeType,
      'content-length': String(bytesWritten),
      host: endpoint.host,
      'x-amz-acl': 'private',
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };

    if (this.config?.kmsKeyId) {
      headers['x-amz-server-side-encryption'] = 'aws:kms';
      headers['x-amz-server-side-encryption-aws-kms-key-id'] = this.config.kmsKeyId;
    }

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k.toLowerCase()}:${headers[k].trim()}\n`).join('');
    const signedHeaders = sortedKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalRequest = [
      'PUT',
      endpoint.pathname,
      endpoint.search.replace(/^\?/, ''),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    // Retry loop with exponential backoff
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        const res = await fetchImpl(endpoint.toString(), {
          method: 'PUT',
          headers,
          body: fullBuffer,
        });

        if (res.ok) {
          return metadata;
        }

        if (res.status >= 400 && res.status < 500) {
          // Client error - do not retry
          throw new StorageSecurityError(`Cloud storage rejected upload with HTTP ${res.status}`);
        }
      } catch (err) {
        if (err instanceof StorageSecurityError) throw err;
        if (attempts >= maxAttempts) {
          logger.error('S3 PutObject upload failed after max retries', {
            storageKey,
            attempts,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new AppError('Cloud storage upload network error', 502, 'S3_NETWORK_ERROR');
        }
        await new Promise((r) => setTimeout(r, Math.pow(2, attempts) * 50));
      }
    }

    throw new AppError('Cloud storage upload failed', 502, 'S3_UPLOAD_FAILED');
  }

  public async readStream(storageKey: string): Promise<StorageReadResult> {
    this.assertReady('readStream');
    assertTenantKey(storageKey);

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

    const bucket = this.config?.bucket || process.env.MEDIMATE_CLOUD_STORAGE_BUCKET!;
    const region = this.config?.region || process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = this.config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID!;
    const secretAccessKey = this.config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY!;
    const endpointStr = this.config?.endpoint || `https://${bucket}.s3.${region}.amazonaws.com/${storageKey}`;
    const endpoint = new URL(endpointStr);
    const fetchImpl = this.config?.fetchFn || fetch;

    const date = new Date();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);
    const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // empty payload

    const headers: Record<string, string> = {
      host: endpoint.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k.toLowerCase()}:${headers[k].trim()}\n`).join('');
    const signedHeaders = sortedKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalRequest = [
      'GET',
      endpoint.pathname,
      endpoint.search.replace(/^\?/, ''),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetchImpl(endpoint.toString(), {
      method: 'GET',
      headers,
    });

    if (res.status === 404) {
      throw new AppError('Storage document not found in cloud storage', 404, 'NOT_FOUND');
    }
    if (!res.ok) {
      throw new StorageSecurityError(`Cloud storage read rejected with HTTP ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const mimeType = res.headers.get('content-type') || guessMime(storageKey);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    return {
      stream: Readable.from(buf),
      size: buf.length,
      mimeType,
      sha256,
      isEncrypted: true,
    };
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
    assertTenantKey(storageKey);

    if (this.simulatedStore) {
      return this.simulatedStore.delete(storageKey);
    }

    const bucket = this.config?.bucket || process.env.MEDIMATE_CLOUD_STORAGE_BUCKET!;
    const region = this.config?.region || process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = this.config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID!;
    const secretAccessKey = this.config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY!;
    const endpointStr = this.config?.endpoint || `https://${bucket}.s3.${region}.amazonaws.com/${storageKey}`;
    const endpoint = new URL(endpointStr);
    const fetchImpl = this.config?.fetchFn || fetch;

    const date = new Date();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);
    const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const headers: Record<string, string> = {
      host: endpoint.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k.toLowerCase()}:${headers[k].trim()}\n`).join('');
    const signedHeaders = sortedKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalRequest = [
      'DELETE',
      endpoint.pathname,
      endpoint.search.replace(/^\?/, ''),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetchImpl(endpoint.toString(), {
      method: 'DELETE',
      headers,
    });

    return res.status === 204 || res.status === 200;
  }

  public async exists(storageKey: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    if (!isValidStorageKey(storageKey)) return false;

    if (this.simulatedStore) {
      return this.simulatedStore.has(storageKey);
    }

    try {
      await this.readStream(storageKey);
      return true;
    } catch {
      return false;
    }
  }
}
