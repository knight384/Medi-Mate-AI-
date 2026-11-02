import { getEncryptionKey, EncryptionError } from './index';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { AWSKMSClient, AWSKMSConfig } from './aws-kms-client';
import { KMSClient } from './kms-adapter';

export interface KeyProvider {
  readonly providerType: 'local' | 'cloud_kms';
  getActiveKeyId(): string;
  getKey(keyId?: string): Promise<Buffer>;
  rotateKey?(newKey: Buffer, newKeyId: string): void;
}

export class CloudKMSBlockedError extends AppError {
  constructor(message = '[BLOCKED] Cloud KMS is not configured: cloud IAM credentials and VPC endpoints are not provisioned in this environment.') {
    super(message, 503, 'CLOUD_KMS_BLOCKED');
    this.name = 'CloudKMSBlockedError';
  }
}

/**
 * Local Key Provider
 *
 * Backs local self-hosted and hybrid on-premises deployments.
 * Stores master symmetric keys in memory with keyring mapping.
 */
export class LocalKeyProvider implements KeyProvider {
  public readonly providerType = 'local' as const;
  private readonly keyring: Map<string, Buffer>;
  private activeKeyId: string;

  constructor(initialKey?: Buffer, activeKeyId = 'k001') {
    this.keyring = new Map();
    this.activeKeyId = activeKeyId;

    if (initialKey) {
      if (initialKey.length !== 32) {
        throw new EncryptionError('Initial key must be exactly 32 bytes', 'INVALID_KEY_LENGTH');
      }
      this.keyring.set(this.activeKeyId, initialKey);
    } else {
      try {
        const envKey = getEncryptionKey();
        this.keyring.set(this.activeKeyId, envKey);
      } catch {
        // Fallback deterministic dev key for testing
        this.keyring.set(
          this.activeKeyId,
          Buffer.from('QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=', 'base64')
        );
      }
    }
  }

  public getActiveKeyId(): string {
    return this.activeKeyId;
  }

  public async getKey(keyId?: string): Promise<Buffer> {
    const id = (keyId || this.activeKeyId).trim();
    const key = this.keyring.get(id);
    if (!key) {
      throw new EncryptionError(`Unknown encryption key identifier: ${id}`, 'UNKNOWN_KEY_ID');
    }
    return key;
  }

  public rotateKey(newKey: Buffer, newKeyId: string): void {
    if (newKey.length !== 32) {
      throw new EncryptionError('Rotated key must be exactly 32 bytes', 'INVALID_KEY_LENGTH');
    }
    const cleanId = newKeyId.trim();
    this.keyring.set(cleanId, newKey);
    this.activeKeyId = cleanId;
    logger.info('Rotated master local encryption key', { activeKeyId: cleanId });
  }

  public registerHistoricalKey(keyId: string, key: Buffer): void {
    if (key.length !== 32) {
      throw new EncryptionError('Historical key must be exactly 32 bytes', 'INVALID_KEY_LENGTH');
    }
    this.keyring.set(keyId.trim(), key);
  }
}

/**
 * Cloud KMS Key Provider (AWS KMS / GCP Cloud KMS)
 *
 * Implements cloud-managed master keys backed by AWS KMS client.
 * Unconfigured by default in local/on-prem sandbox; operations are fail-safe.
 */
export class CloudKMSKeyProvider implements KeyProvider {
  public readonly providerType = 'cloud_kms' as const;
  private readonly kmsClient: AWSKMSClient;
  private readonly kmsKeyArn?: string;
  private readonly region?: string;
  private readonly isConfiguredState: boolean;

  constructor(options?: AWSKMSConfig & { kmsKeyArn?: string }) {
    this.kmsKeyArn = options?.kmsKeyArn || options?.keyArn || process.env.AWS_KMS_KEY_ARN || process.env.MEDIMATE_CLOUD_KMS_KEY_ARN;
    this.region = options?.region || process.env.AWS_REGION;
    this.kmsClient = new AWSKMSClient({
      keyArn: this.kmsKeyArn,
      region: this.region,
      accessKeyId: options?.accessKeyId,
      secretAccessKey: options?.secretAccessKey,
      sessionToken: options?.sessionToken,
      endpoint: options?.endpoint,
      fetchFn: options?.fetchFn,
    });
    this.isConfiguredState = this.kmsClient.isConfigured();
  }

  public isConfigured(): boolean {
    return this.isConfiguredState;
  }

  public getKmsClient(): KMSClient {
    return this.kmsClient;
  }

  public getActiveKeyId(): string {
    return this.kmsKeyArn || 'cloud-kms-default';
  }

  public getRegion(): string | undefined {
    return this.region;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getKey(_keyId?: string): Promise<Buffer> {
    if (!this.isConfiguredState) {
      throw new CloudKMSBlockedError();
    }
    // Direct plaintext key extraction from Cloud KMS is forbidden by cloud HSM design;
    // Cloud KMS only provides encrypt/decrypt or generateDataKey operations.
    throw new EncryptionError(
      'Cloud KMS master keys cannot be exported as raw bytes; use EnvelopeEncryptionService instead.',
      'KMS_EXPORT_NOT_SUPPORTED'
    );
  }
}
