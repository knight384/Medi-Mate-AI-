import crypto from 'crypto';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

// Encryption algorithms
const ALGORITHM_GCM = 'aes-256-gcm';
const ALGORITHM_LEGACY_CBC = 'aes-256-cbc';
const VERSION_PREFIX_V2 = 'v2:';
const VERSION_PREFIX_V1 = 'v1:';

export class EncryptionError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'ENCRYPTION_ERROR') {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

/**
 * Retrieves the validated Base64-encoded 32-byte encryption key.
 */
export function getEncryptionKey(): Buffer {
  const keyBase64 = process.env.ENCRYPTION_KEY;
  if (!keyBase64) {
    if (process.env.NODE_ENV !== 'production') {
      // Deterministic 32-byte key for local development and test runner suites
      return Buffer.from('QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=', 'base64');
    }
    throw new EncryptionError(
      'The ENCRYPTION_KEY environment variable is not set.',
      'KEY_NOT_SET'
    );
  }

  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new EncryptionError(
      'ENCRYPTION_KEY must be a Base64-encoded 32-byte key.',
      'INVALID_KEY_LENGTH'
    );
  }

  return key;
}

export interface EncryptOptions {
  aad?: string | Buffer;
}

/**
 * Encrypts plaintext string using authenticated AES-256-GCM.
 * Generates a cryptographically random 12-byte nonce and 16-byte authentication tag.
 * Returns versioned ciphertext: "v2:<base64(nonce_12 + authTag_16 + ciphertext)>"
 *
 * @param text - Plaintext string to encrypt.
 * @param aadOrOptions - Optional Additional Authenticated Data (AAD) string/Buffer or options.
 */
export function encrypt(
  text: string,
  aadOrOptions?: string | Buffer | EncryptOptions
): string {
  if (typeof text !== 'string') {
    throw new EncryptionError('Plaintext input must be a string', 'INVALID_INPUT');
  }

  const key = getEncryptionKey();
  // 12-byte random nonce for AES-GCM (NIST SP 800-38D recommendation)
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM_GCM, key, nonce);

  // Bind Additional Authenticated Data (AAD) if provided
  let aad: Buffer | undefined;
  if (aadOrOptions) {
    if (typeof aadOrOptions === 'string') {
      aad = Buffer.from(aadOrOptions, 'utf8');
    } else if (Buffer.isBuffer(aadOrOptions)) {
      aad = aadOrOptions;
    } else if (aadOrOptions.aad) {
      aad = typeof aadOrOptions.aad === 'string'
        ? Buffer.from(aadOrOptions.aad, 'utf8')
        : aadOrOptions.aad;
    }
  }

  if (aad) {
    cipher.setAAD(aad);
  }

  const encryptedBuffer = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Serialized binary payload: Nonce (12) + AuthTag (16) + Ciphertext (N)
  const combinedBuffer = Buffer.concat([nonce, authTag, encryptedBuffer]);
  return `${VERSION_PREFIX_V2}${combinedBuffer.toString('base64')}`;
}

/**
 * Decrypts ciphertext, automatically recognizing version (v2: AES-256-GCM vs v1/legacy AES-256-CBC).
 * For v2: strictly verifies 16-byte authentication tag and optional AAD before returning plaintext.
 * Legacy CBC is supported in decrypt-only mode for backward compatibility during migration.
 *
 * @param data - Versioned or legacy ciphertext string.
 * @param aadOrOptions - Optional Additional Authenticated Data (AAD) that was bound during encryption.
 */
export function decrypt(
  data: string,
  aadOrOptions?: string | Buffer | EncryptOptions
): string {
  if (!data || typeof data !== 'string') {
    throw new EncryptionError('Ciphertext input must be a non-empty string', 'INVALID_INPUT');
  }

  const key = getEncryptionKey();

  let aad: Buffer | undefined;
  if (aadOrOptions) {
    if (typeof aadOrOptions === 'string') {
      aad = Buffer.from(aadOrOptions, 'utf8');
    } else if (Buffer.isBuffer(aadOrOptions)) {
      aad = aadOrOptions;
    } else if (aadOrOptions.aad) {
      aad = typeof aadOrOptions.aad === 'string'
        ? Buffer.from(aadOrOptions.aad, 'utf8')
        : aadOrOptions.aad;
    }
  }

  // Version 2: Authenticated AES-256-GCM
  if (data.startsWith(VERSION_PREFIX_V2)) {
    const rawBase64 = data.slice(VERSION_PREFIX_V2.length);
    const combinedBuffer = Buffer.from(rawBase64, 'base64');

    // Minimum payload: 12-byte nonce + 16-byte auth tag = 28 bytes
    if (combinedBuffer.length < 28) {
      throw new EncryptionError(
        'Malformed ciphertext: payload is too short for AES-256-GCM',
        'MALFORMED_CIPHERTEXT'
      );
    }

    const nonce = combinedBuffer.subarray(0, 12);
    const authTag = combinedBuffer.subarray(12, 28);
    const ciphertext = combinedBuffer.subarray(28);

    const decipher = crypto.createDecipheriv(ALGORITHM_GCM, key, nonce);

    if (aad) {
      decipher.setAAD(aad);
    }

    decipher.setAuthTag(authTag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      throw new EncryptionError(
        'Authentication tag verification failed: ciphertext or AAD has been tampered with or corrupted.',
        'AUTHENTICATION_FAILED'
      );
    }
  }

  // Version 1 or un-prefixed legacy: Decrypt-only AES-256-CBC backward compatibility
  const rawBase64 = data.startsWith(VERSION_PREFIX_V1)
    ? data.slice(VERSION_PREFIX_V1.length)
    : data;

  const combinedBuffer = Buffer.from(rawBase64, 'base64');

  if (combinedBuffer.length < 16) {
    throw new EncryptionError(
      'Malformed legacy ciphertext: payload is too short for AES-256-CBC IV',
      'MALFORMED_CIPHERTEXT'
    );
  }

  const iv = combinedBuffer.subarray(0, 16);
  const ciphertext = combinedBuffer.subarray(16);

  const decipher = crypto.createDecipheriv(ALGORITHM_LEGACY_CBC, key, iv);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new EncryptionError(
      'Failed to decrypt legacy ciphertext: invalid padding or incorrect key.',
      'LEGACY_DECRYPT_FAILED'
    );
  }
}

/**
 * Legacy encryption generator (AES-256-CBC) strictly for migration test fixtures
 * and backward-compatibility validation. Never use for newly created data.
 */
export function encryptLegacyCBC(text: string, withV1Prefix = false): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM_LEGACY_CBC, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const combined = Buffer.concat([iv, encrypted]).toString('base64');
  return withV1Prefix ? `${VERSION_PREFIX_V1}${combined}` : combined;
}

/**
 * Detects the ciphertext version format.
 */
export function getCiphertextVersion(data: string): 'v2' | 'v1' | 'legacy' | 'unrecognized' {
  if (!data || typeof data !== 'string') return 'unrecognized';
  if (data.startsWith(VERSION_PREFIX_V2)) return 'v2';
  if (data.startsWith(VERSION_PREFIX_V1)) return 'v1';
  try {
    const buf = Buffer.from(data, 'base64');
    if (buf.length >= 16) return 'legacy';
  } catch {
    // fall through
  }
  return 'unrecognized';
}

// Check if the encryption key is available when not in production build phase
if (process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) {
  try {
    getEncryptionKey();
  } catch {
    // Allows importing in environments where process.env is configured per-test
  }
}
