import { StorageSecurityError } from '@/lib/storage/local-driver';

/**
 * MM_ENC04 Binary Envelope Format Specification
 *
 * Designed for enterprise two-level envelope encryption:
 * Master Key Encryption Key (KEK) in KMS wraps per-document Data Encryption Key (DEK).
 *
 * Binary Layout:
 * +-----------------------------------------------------------------------------+
 * | Field               | Offset            | Size        | Encoding            |
 * +-----------------------------------------------------------------------------+
 * | Magic Header        | 0                 | 8 bytes     | ASCII 'MM_ENC04'    |
 * | Format Version      | 8                 | 1 byte      | uint8 = 0x01        |
 * | KMS Provider ID     | 9                 | 1 byte      | uint8 (1=AWS,4=LOC) |
 * | KeyId Length (K_LEN)| 10                | 2 bytes     | uint16BE            |
 * | KeyId               | 12                | K_LEN bytes | UTF-8 String        |
 * | Wrapped DEK Len (W) | 12 + K_LEN        | 2 bytes     | uint16BE            |
 * | Wrapped DEK         | 14 + K_LEN        | W bytes     | Binary Ciphertext   |
 * | Payload Nonce       | 14 + K_LEN + W    | 12 bytes    | Binary GCM Nonce    |
 * | Payload AuthTag     | 26 + K_LEN + W    | 16 bytes    | Binary GCM Tag      |
 * | Payload Ciphertext  | 42 + K_LEN + W    | Remainder   | AES-256-GCM Stream  |
 * +-----------------------------------------------------------------------------+
 */

export const MAGIC_HEADER_V4 = Buffer.from('MM_ENC04'); // 8 bytes
export const FORMAT_VERSION_V4 = 0x01;

export enum KMSProviderType {
  AWS_KMS = 0x01,
  GCP_KMS = 0x02,
  AZURE_KV = 0x03,
  LOCAL_SYNTHETIC = 0x04,
}

export interface EncryptedHeaderV4 {
  magic: 'MM_ENC04';
  formatVersion: number;
  providerType: KMSProviderType;
  keyId: string;
  wrappedDek: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  headerLength: number;
}

/**
 * Computes canonical Authenticated Additional Data (AAD) for MM_ENC04.
 * Cryptographically binds the document storage key, KMS provider, and KeyId,
 * preventing relocation attacks (copying ciphertext to another user/path)
 * or metadata tampering.
 */
export function computeEnvelopeAAD(
  storageKey: string,
  providerType: KMSProviderType,
  keyId: string
): Buffer {
  if (!storageKey || typeof storageKey !== 'string') {
    throw new StorageSecurityError('Storage key must be a valid non-empty string for AAD computation');
  }
  const cleanKey = storageKey.trim();
  const canonicalString = `MM_ENC04|PID:${providerType}|KID:${keyId}|KEY:${cleanKey}`;
  return Buffer.from(canonicalString, 'utf8');
}

/**
 * Serializes the MM_ENC04 header into a binary Buffer.
 */
export function serializeEnvelopeHeaderV4(
  providerType: KMSProviderType,
  keyId: string,
  wrappedDek: Buffer,
  nonce: Buffer,
  authTagPlaceholder?: Buffer
): Buffer {
  if (nonce.length !== 12) {
    throw new StorageSecurityError(`Payload nonce must be exactly 12 bytes; got ${nonce.length}`);
  }
  const keyIdBuf = Buffer.from(keyId, 'utf8');
  if (keyIdBuf.length > 2048) {
    throw new StorageSecurityError('Key identifier exceeds maximum allowed length of 2048 bytes');
  }
  if (wrappedDek.length > 65535) {
    throw new StorageSecurityError('Wrapped DEK exceeds maximum allowed length of 65535 bytes');
  }

  const tag = authTagPlaceholder || Buffer.alloc(16, 0);
  if (tag.length !== 16) {
    throw new StorageSecurityError('Authentication tag must be exactly 16 bytes');
  }

  const totalHeaderLen = 8 + 1 + 1 + 2 + keyIdBuf.length + 2 + wrappedDek.length + 12 + 16;
  const headerBuf = Buffer.alloc(totalHeaderLen);

  let offset = 0;
  MAGIC_HEADER_V4.copy(headerBuf, offset);
  offset += 8;

  headerBuf.writeUInt8(FORMAT_VERSION_V4, offset);
  offset += 1;

  headerBuf.writeUInt8(providerType, offset);
  offset += 1;

  headerBuf.writeUInt16BE(keyIdBuf.length, offset);
  offset += 2;

  keyIdBuf.copy(headerBuf, offset);
  offset += keyIdBuf.length;

  headerBuf.writeUInt16BE(wrappedDek.length, offset);
  offset += 2;

  wrappedDek.copy(headerBuf, offset);
  offset += wrappedDek.length;

  nonce.copy(headerBuf, offset);
  offset += 12;

  tag.copy(headerBuf, offset);
  offset += 16;

  return headerBuf;
}

/**
 * Parses and validates an MM_ENC04 binary header from the start of a buffer.
 */
export function parseEnvelopeHeaderV4(buffer: Buffer): EncryptedHeaderV4 {
  if (buffer.length < 42) {
    throw new StorageSecurityError('Buffer too small to contain valid MM_ENC04 header');
  }

  const magic = buffer.subarray(0, 8);
  if (!magic.equals(MAGIC_HEADER_V4)) {
    throw new StorageSecurityError('Invalid header: magic mismatch for MM_ENC04');
  }

  let offset = 8;
  const formatVersion = buffer.readUInt8(offset);
  offset += 1;
  if (formatVersion !== FORMAT_VERSION_V4) {
    throw new StorageSecurityError(`Unsupported MM_ENC04 format version: ${formatVersion}`);
  }

  const providerType = buffer.readUInt8(offset) as KMSProviderType;
  offset += 1;
  if (![KMSProviderType.AWS_KMS, KMSProviderType.GCP_KMS, KMSProviderType.AZURE_KV, KMSProviderType.LOCAL_SYNTHETIC].includes(providerType)) {
    throw new StorageSecurityError(`Unknown KMS provider type in MM_ENC04 header: 0x${providerType.toString(16)}`);
  }

  const keyIdLen = buffer.readUInt16BE(offset);
  offset += 2;
  if (buffer.length < offset + keyIdLen + 2) {
    throw new StorageSecurityError('Truncated MM_ENC04 header: incomplete keyId');
  }

  const keyId = buffer.subarray(offset, offset + keyIdLen).toString('utf8');
  offset += keyIdLen;

  const wrappedDekLen = buffer.readUInt16BE(offset);
  offset += 2;
  if (buffer.length < offset + wrappedDekLen + 12 + 16) {
    throw new StorageSecurityError('Truncated MM_ENC04 header: incomplete wrapped DEK or cryptographic tags');
  }

  const wrappedDek = Buffer.from(buffer.subarray(offset, offset + wrappedDekLen));
  offset += wrappedDekLen;

  const nonce = Buffer.from(buffer.subarray(offset, offset + 12));
  offset += 12;

  const authTag = Buffer.from(buffer.subarray(offset, offset + 16));
  offset += 16;

  return {
    magic: 'MM_ENC04',
    formatVersion,
    providerType,
    keyId,
    wrappedDek,
    nonce,
    authTag,
    headerLength: offset,
  };
}

/**
 * Returns the offset in bytes where the 16-byte AuthTag starts in the file.
 */
export function getAuthTagOffsetV4(keyIdLength: number, wrappedDekLength: number): number {
  return 8 + 1 + 1 + 2 + keyIdLength + 2 + wrappedDekLength + 12;
}
