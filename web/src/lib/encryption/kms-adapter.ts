import crypto from 'node:crypto';

/**
 * ARCHITECTURAL BOUNDARY SPECIFICATION (Part H):
 *
 * 1. LocalSyntheticKMSAdapter & Envelope Encryption:
 *    - Emulates cloud envelope encryption patterns (KMS DEK generation and wrapping with KEK).
 *    - Standalone cryptographic utility designed for future cloud HSM/KMS migrations.
 *    - Does NOT directly back LocalStorageDriver; LocalStorageDriver uses symmetric streaming
 *      AES-256-GCM containers (MM_ENC03/MM_ENC02) with internal keyring mapping for low-latency
 *      local file I/O.
 *
 * 2. Managed Cloud KMS (AWS KMS / GCP Cloud KMS):
 *    - Class: CloudKMSClient
 *    - Status: BLOCKED. Managed cloud KMS integrations require cloud IAM credentials,
 *      service account keys, and outbound VPC/HTTPS endpoints not available in local/sandbox environments.
 */

export interface DataKeyResult {
  plaintextKey: Buffer;
  encryptedKeyCiphertext: string;
  keyVersion: string;
}

export interface DecryptedDataKeyResult {
  plaintextKey: Buffer;
  keyVersion: string;
}

export interface KMSClient {
  readonly providerName: string;
  generateDataKey(keyId: string, context?: Record<string, string>): Promise<DataKeyResult>;
  decryptDataKey(encryptedKeyCiphertext: string, context?: Record<string, string>): Promise<DecryptedDataKeyResult>;
}

export interface EncryptedEnvelope {
  formatVersion: 'v1-envelope';
  keyId: string;
  keyVersion: string;
  encryptedDataKey: string; // Base64 DEK encrypted by KEK
  nonce: string;            // Base64 12-byte GCM nonce for payload
  authTag: string;          // Base64 16-byte GCM auth tag for payload
  ciphertext: string;       // Base64 payload encrypted by DEK
  context?: Record<string, string>;
}

/**
 * Local Synthetic KMS Adapter
 * Emulates Cloud KMS envelope encryption locally using a master Key Encryption Key (KEK).
 * Encrypts and decrypts per-document Data Encryption Keys (DEKs) using AES-256-GCM.
 */
export class LocalSyntheticKMSAdapter implements KMSClient {
  public readonly providerName = 'LocalSyntheticKMS';
  private masterKeys: Map<string, Buffer>;
  private activeVersion: string;

  constructor(initialMasterKey?: Buffer, initialVersion = 'kek-v1') {
    this.masterKeys = new Map();
    const key = initialMasterKey || crypto.randomBytes(32);
    if (key.length !== 32) {
      throw new Error('Master Key Encryption Key (KEK) must be exactly 32 bytes.');
    }
    this.activeVersion = initialVersion;
    this.masterKeys.set(this.activeVersion, key);
  }

  public rotateMasterKey(newMasterKey: Buffer, newVersion: string): void {
    if (newMasterKey.length !== 32) {
      throw new Error('New master KEK must be exactly 32 bytes.');
    }
    this.activeVersion = newVersion;
    this.masterKeys.set(newVersion, newMasterKey);
  }

  public async generateDataKey(
    _keyId: string,
    context?: Record<string, string>
  ): Promise<DataKeyResult> {
    const activeKek = this.masterKeys.get(this.activeVersion);
    if (!activeKek) {
      throw new Error(`Active master KEK not found for version: ${this.activeVersion}`);
    }

    // 1. Generate cryptographically random 256-bit DEK
    const plaintextDek = crypto.randomBytes(32);

    // 2. Encrypt DEK under active KEK using AES-256-GCM
    const kekNonce = crypto.randomBytes(12);
    const kekCipher = crypto.createCipheriv('aes-256-gcm', activeKek, kekNonce);

    if (context) {
      kekCipher.setAAD(Buffer.from(JSON.stringify(context), 'utf8'));
    }

    const encryptedDekBuffer = Buffer.concat([
      kekCipher.update(plaintextDek),
      kekCipher.final(),
    ]);
    const kekTag = kekCipher.getAuthTag();

    // Payload: version_len (1) + version_str + nonce (12) + tag (16) + encryptedDek (32)
    const versionBuf = Buffer.from(this.activeVersion, 'utf8');
    const envelopeBuffer = Buffer.concat([
      Buffer.from([versionBuf.length]),
      versionBuf,
      kekNonce,
      kekTag,
      encryptedDekBuffer,
    ]);

    return {
      plaintextKey: plaintextDek,
      encryptedKeyCiphertext: envelopeBuffer.toString('base64'),
      keyVersion: this.activeVersion,
    };
  }

  public async decryptDataKey(
    encryptedKeyCiphertext: string,
    context?: Record<string, string>
  ): Promise<DecryptedDataKeyResult> {
    const rawBuffer = Buffer.from(encryptedKeyCiphertext, 'base64');
    if (rawBuffer.length < 30) {
      throw new Error('Malformed encrypted DEK payload: buffer too short');
    }

    const versionLen = rawBuffer[0];
    const version = rawBuffer.subarray(1, 1 + versionLen).toString('utf8');
    const kek = this.masterKeys.get(version);
    if (!kek) {
      throw new Error(`KMS KEK version '${version}' is not known to this KMS instance (possible key rotation gap)`);
    }

    let offset = 1 + versionLen;
    const nonce = rawBuffer.subarray(offset, offset + 12);
    offset += 12;
    const tag = rawBuffer.subarray(offset, offset + 16);
    offset += 16;
    const ciphertext = rawBuffer.subarray(offset);

    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, nonce);
    if (context) {
      decipher.setAAD(Buffer.from(JSON.stringify(context), 'utf8'));
    }
    decipher.setAuthTag(tag);

    try {
      const plaintextDek = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return {
        plaintextKey: plaintextDek,
        keyVersion: version,
      };
    } catch {
      throw new Error('KMS KEK decryption failed: DEK ciphertext or context has been tampered with');
    }
  }
}

/**
 * Cloud KMS Client Stub
 * Formally documents the architectural requirements for AWS KMS / Google Cloud KMS
 * and enforces a safe fail-closed boundary with BLOCKED classification.
 */
export class CloudKMSClient implements KMSClient {
  public readonly providerName: 'AWS_KMS' | 'GCP_KMS';
  public readonly isBlocked = true;

  constructor(provider: 'AWS_KMS' | 'GCP_KMS' = 'AWS_KMS') {
    this.providerName = provider;
  }

  public async generateDataKey(): Promise<DataKeyResult> {
    throw new Error(
      `[BLOCKED] External ${this.providerName} integration is blocked: Cloud IAM credentials and VPC KMS endpoints are not available in this test environment.`
    );
  }

  public async decryptDataKey(): Promise<DecryptedDataKeyResult> {
    throw new Error(
      `[BLOCKED] External ${this.providerName} integration is blocked: Cloud IAM credentials and VPC KMS endpoints are not available in this test environment.`
    );
  }
}

/**
 * Performs envelope encryption on sensitive document or record data.
 * 1. Calls KMS to generate a fresh per-document Data Encryption Key (DEK).
 * 2. Encrypts the payload with the DEK using AES-256-GCM.
 * 3. Immediately wipes plaintext DEK from memory buffer.
 * 4. Returns complete EncryptedEnvelope containing encrypted DEK and encrypted payload.
 */
export async function encryptEnvelope(
  plaintext: Buffer | string,
  kms: KMSClient,
  keyId: string,
  context?: Record<string, string>
): Promise<EncryptedEnvelope> {
  const dataBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');

  // 1. Generate DEK via KMS
  const { plaintextKey, encryptedKeyCiphertext, keyVersion } = await kms.generateDataKey(keyId, context);

  // 2. Encrypt payload with DEK using AES-256-GCM
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', plaintextKey, nonce);

  if (context) {
    cipher.setAAD(Buffer.from(JSON.stringify(context), 'utf8'));
  }

  const ciphertextBuf = Buffer.concat([
    cipher.update(dataBuf),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // 3. Securely wipe the plaintext DEK from memory buffer
  plaintextKey.fill(0);

  return {
    formatVersion: 'v1-envelope',
    keyId,
    keyVersion,
    encryptedDataKey: encryptedKeyCiphertext,
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertextBuf.toString('base64'),
    context,
  };
}

/**
 * Decrypts an EncryptedEnvelope:
 * 1. Decrypts the DEK using KMS.
 * 2. Decrypts the payload using DEK and verifies authentication tag.
 * 3. Securely wipes plaintext DEK from memory.
 */
export async function decryptEnvelope(
  envelope: EncryptedEnvelope,
  kms: KMSClient
): Promise<Buffer> {
  // 1. Decrypt DEK via KMS
  const { plaintextKey } = await kms.decryptDataKey(envelope.encryptedDataKey, envelope.context);

  const nonce = Buffer.from(envelope.nonce, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', plaintextKey, nonce);
  if (envelope.context) {
    decipher.setAAD(Buffer.from(JSON.stringify(envelope.context), 'utf8'));
  }
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext;
  } finally {
    // Securely wipe plaintext DEK from memory buffer
    plaintextKey.fill(0);
  }
}

/**
 * Re-wraps an EncryptedEnvelope under a new KMS key or active KEK version.
 * This performs zero-downtime, O(1) key rotation without decrypting or re-encrypting the underlying data payload.
 */
export async function rewrapEnvelope(
  envelope: EncryptedEnvelope,
  kms: KMSClient,
  targetKeyId: string,
  newContext?: Record<string, string>
): Promise<EncryptedEnvelope> {
  // 1. Unwrap DEK using the historical or current key version
  const { plaintextKey } = await kms.decryptDataKey(envelope.encryptedDataKey, envelope.context);

  try {
    const effectiveContext = newContext !== undefined ? newContext : envelope.context;
    let newEncryptedKey: string;
    let newKeyVersion: string;

    if (kms instanceof LocalSyntheticKMSAdapter) {
      const activeKek = (kms as unknown as { masterKeys: Map<string, Buffer>; activeVersion: string }).masterKeys.get(
        (kms as unknown as { activeVersion: string }).activeVersion
      );
      if (!activeKek) {
        throw new Error('Active master KEK not found for rewrap');
      }
      const kekNonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', activeKek, kekNonce);
      if (effectiveContext) {
        cipher.setAAD(Buffer.from(JSON.stringify(effectiveContext), 'utf8'));
      }
      const enc = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
      const tag = cipher.getAuthTag();
      const versionBuf = Buffer.from((kms as unknown as { activeVersion: string }).activeVersion, 'utf8');
      const envelopeBuffer = Buffer.concat([
        Buffer.from([versionBuf.length]),
        versionBuf,
        kekNonce,
        tag,
        enc,
      ]);
      newEncryptedKey = envelopeBuffer.toString('base64');
      newKeyVersion = (kms as unknown as { activeVersion: string }).activeVersion;
    } else {
      const newKeyResult = await kms.generateDataKey(targetKeyId, effectiveContext);
      newEncryptedKey = newKeyResult.encryptedKeyCiphertext;
      newKeyVersion = newKeyResult.keyVersion;
    }

    return {
      ...envelope,
      keyId: targetKeyId,
      keyVersion: newKeyVersion,
      encryptedDataKey: newEncryptedKey,
      context: effectiveContext,
    };
  } finally {
    plaintextKey.fill(0);
  }
}

export { AWSKMSClient } from './aws-kms-client';
export type { AWSKMSConfig } from './aws-kms-client';

