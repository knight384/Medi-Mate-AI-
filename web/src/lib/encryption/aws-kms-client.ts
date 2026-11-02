import crypto from 'node:crypto';
import { KMSClient, DataKeyResult, DecryptedDataKeyResult } from './kms-adapter';
import { CloudKMSBlockedError } from './key-providers';
import { EncryptionError } from './index';
import { logger } from '@/lib/logger';

export interface AWSKMSConfig {
  keyArn?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
  /** Optional custom fetch implementation for unit testing and offline simulation */
  fetchFn?: typeof fetch;
}

/**
 * Generates an AWS Signature Version 4 Authorization Header and signed headers.
 */
export function computeAwsSigV4Headers(params: {
  method: string;
  endpoint: URL;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  amzTarget: string;
  body: string;
  date?: Date;
}): Record<string, string> {
  const {
    method,
    endpoint,
    region,
    service,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    amzTarget,
    body,
    date = new Date(),
  } = params;

  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  const payloadHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host: endpoint.host,
    'x-amz-date': amzDate,
    'x-amz-target': amzTarget,
  };

  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken;
  }

  // Canonical headers (lowercase and sorted)
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k.toLowerCase()}:${headers[k].trim()}\n`)
    .join('');
  const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    endpoint.pathname || '/',
    endpoint.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  // Derive signing key
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();

  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...headers,
    Authorization: authorizationHeader,
  };
}

/**
 * Enterprise AWS Key Management Service (KMS) Client
 *
 * Implements real envelope encryption using AWS KMS (TrentService.GenerateDataKey and TrentService.Decrypt).
 * Adheres to zero-credential-leakage principles with sanitized logging and fail-closed security.
 */
export class AWSKMSClient implements KMSClient {
  public readonly providerName = 'AWS_KMS';
  private readonly config: AWSKMSConfig;
  private readonly isConfiguredState: boolean;

  constructor(config?: AWSKMSConfig) {
    const keyArn = config?.keyArn || process.env.AWS_KMS_KEY_ARN || process.env.MEDIMATE_CLOUD_KMS_KEY_ARN;
    const region = config?.region || process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = config?.sessionToken || process.env.AWS_SESSION_TOKEN;
    const endpoint = config?.endpoint || process.env.AWS_KMS_ENDPOINT;

    this.config = {
      keyArn,
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      endpoint,
      fetchFn: config?.fetchFn,
    };

    this.isConfiguredState = Boolean(keyArn && accessKeyId && secretAccessKey);
  }

  public isConfigured(): boolean {
    return this.isConfiguredState;
  }

  public getActiveKeyArn(): string {
    return this.config.keyArn || 'unconfigured-kms-arn';
  }

  private assertReady(operation: string): void {
    if (!this.isConfigured()) {
      logger.warn('AWS KMS operation blocked: cloud credentials or key ARN unconfigured', { operation });
      throw new CloudKMSBlockedError(
        `[BLOCKED] AWS KMS operation "${operation}" rejected: AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) and AWS_KMS_KEY_ARN are not configured in this environment.`
      );
    }
  }

  private getEndpoint(): URL {
    if (this.config.endpoint) {
      return new URL(this.config.endpoint);
    }
    return new URL(`https://kms.${this.config.region}.amazonaws.com/`);
  }

  /**
   * Generates a unique 256-bit Data Encryption Key (DEK) via AWS KMS.
   * KMS returns both the plaintext key (for in-memory encryption) and the wrapped ciphertext.
   */
  public async generateDataKey(
    keyId?: string,
    context?: Record<string, string>
  ): Promise<DataKeyResult> {
    this.assertReady('generateDataKey');

    const effectiveKeyId = keyId || this.config.keyArn!;
    const endpoint = this.getEndpoint();
    const fetchImpl = this.config.fetchFn || fetch;

    const requestBodyObj: Record<string, unknown> = {
      KeyId: effectiveKeyId,
      KeySpec: 'AES_256',
    };

    if (context && Object.keys(context).length > 0) {
      requestBodyObj.EncryptionContext = context;
    }

    const bodyStr = JSON.stringify(requestBodyObj);

    const headers = computeAwsSigV4Headers({
      method: 'POST',
      endpoint,
      region: this.config.region || 'us-east-1',
      service: 'kms',
      accessKeyId: this.config.accessKeyId!,
      secretAccessKey: this.config.secretAccessKey!,
      sessionToken: this.config.sessionToken,
      amzTarget: 'TrentService.GenerateDataKey',
      body: bodyStr,
    });

    try {
      const response = await fetchImpl(endpoint.toString(), {
        method: 'POST',
        headers,
        body: bodyStr,
      });

      if (!response.ok) {
        await response.text().catch(() => '');
        logger.error('AWS KMS GenerateDataKey failed', {
          status: response.status,
          statusText: response.statusText,
          // Never log raw error body if it contains sensitive tokens
        });
        throw new EncryptionError(
          `AWS KMS GenerateDataKey rejected with HTTP ${response.status}`,
          'KMS_GENERATE_KEY_ERROR'
        );
      }

      const data = (await response.json()) as {
        Plaintext: string;
        CiphertextBlob: string;
        KeyId: string;
      };

      if (!data.Plaintext || !data.CiphertextBlob) {
        throw new EncryptionError('AWS KMS response missing expected key components', 'MALFORMED_KMS_RESPONSE');
      }

      const plaintextKey = Buffer.from(data.Plaintext, 'base64');
      if (plaintextKey.length !== 32) {
        throw new EncryptionError(`Unexpected DEK length from AWS KMS: ${plaintextKey.length}`, 'INVALID_DEK_LENGTH');
      }

      return {
        plaintextKey,
        encryptedKeyCiphertext: data.CiphertextBlob,
        keyVersion: data.KeyId || effectiveKeyId,
      };
    } catch (err: unknown) {
      if (err instanceof EncryptionError || err instanceof CloudKMSBlockedError) {
        throw err;
      }
      logger.error('AWS KMS GenerateDataKey network error', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new EncryptionError('Failed to communicate with AWS KMS endpoint', 'KMS_NETWORK_ERROR');
    }
  }

  /**
   * Decrypts/Unwraps an encrypted Data Encryption Key (DEK) via AWS KMS.
   */
  public async decryptDataKey(
    encryptedKeyCiphertext: string | Buffer,
    context?: Record<string, string>
  ): Promise<DecryptedDataKeyResult> {
    this.assertReady('decryptDataKey');

    const ciphertextBlob = Buffer.isBuffer(encryptedKeyCiphertext)
      ? encryptedKeyCiphertext.toString('base64')
      : encryptedKeyCiphertext;

    const endpoint = this.getEndpoint();
    const fetchImpl = this.config.fetchFn || fetch;

    const requestBodyObj: Record<string, unknown> = {
      CiphertextBlob: ciphertextBlob,
    };

    if (context && Object.keys(context).length > 0) {
      requestBodyObj.EncryptionContext = context;
    }

    const bodyStr = JSON.stringify(requestBodyObj);

    const headers = computeAwsSigV4Headers({
      method: 'POST',
      endpoint,
      region: this.config.region || 'us-east-1',
      service: 'kms',
      accessKeyId: this.config.accessKeyId!,
      secretAccessKey: this.config.secretAccessKey!,
      sessionToken: this.config.sessionToken,
      amzTarget: 'TrentService.Decrypt',
      body: bodyStr,
    });

    try {
      const response = await fetchImpl(endpoint.toString(), {
        method: 'POST',
        headers,
        body: bodyStr,
      });

      if (!response.ok) {
        logger.error('AWS KMS Decrypt failed', {
          status: response.status,
          statusText: response.statusText,
        });
        throw new EncryptionError(
          `AWS KMS Decrypt rejected with HTTP ${response.status}`,
          'KMS_DECRYPT_KEY_ERROR'
        );
      }

      const data = (await response.json()) as {
        Plaintext: string;
        KeyId: string;
      };

      if (!data.Plaintext) {
        throw new EncryptionError('AWS KMS response missing plaintext key', 'MALFORMED_KMS_RESPONSE');
      }

      const plaintextKey = Buffer.from(data.Plaintext, 'base64');
      if (plaintextKey.length !== 32) {
        throw new EncryptionError(`Unexpected decrypted DEK length: ${plaintextKey.length}`, 'INVALID_DEK_LENGTH');
      }

      return {
        plaintextKey,
        keyVersion: data.KeyId || this.config.keyArn!,
      };
    } catch (err: unknown) {
      if (err instanceof EncryptionError || err instanceof CloudKMSBlockedError) {
        throw err;
      }
      logger.error('AWS KMS Decrypt network error', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new EncryptionError('Failed to communicate with AWS KMS endpoint', 'KMS_NETWORK_ERROR');
    }
  }
}
