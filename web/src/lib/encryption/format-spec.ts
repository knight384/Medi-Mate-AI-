/**
 * Versioned Ciphertext and Storage Container Specification
 *
 * MediMate AI Cryptographic Formats:
 *
 * 1. Database Fields (e.g. LLMProvider.apiKey, sensitive clinical attributes):
 *    - Modern format (v2): "v2:<base64(12-byte Nonce + 16-byte AuthTag + Ciphertext)>"
 *      Algorithm: AES-256-GCM authenticated encryption.
 *    - Legacy format (v1): "v1:<base64(16-byte IV + Ciphertext)>" or raw un-prefixed Base64.
 *      Algorithm: AES-256-CBC (decrypt-only during migration).
 *
 * 2. Document Containers (Storage at rest):
 *    - Modern format (MM_ENC03): 40-byte container header:
 *      Bytes 0..7:   ASCII "MM_ENC03"
 *      Bytes 8..11:  ASCII Key Identifier (e.g. "k001")
 *      Bytes 12..23: 12-byte Nonce / IV
 *      Bytes 24..39: 16-byte GCM Authentication Tag
 *      Offset 40+:   AES-256-GCM Ciphertext payload
 *    - Backward-compatible format (MM_ENC02): 36-byte container header:
 *      Bytes 0..7:   ASCII "MM_ENC02"
 *      Bytes 8..19:  12-byte Nonce / IV
 *      Bytes 20..35: 16-byte GCM Authentication Tag
 *      Offset 36+:   AES-256-GCM Ciphertext payload (defaults to key "k001")
 */
export class VersionedCiphertextFormat {
  public static readonly FIELD_PREFIX_V2 = 'v2:';
  public static readonly FIELD_PREFIX_V1 = 'v1:';

  public static readonly CONTAINER_MAGIC_V3 = 'MM_ENC03';
  public static readonly CONTAINER_MAGIC_V2 = 'MM_ENC02';

  public static readonly CONTAINER_HEADER_SIZE_V3 = 40;
  public static readonly CONTAINER_HEADER_SIZE_V2 = 36;

  public static getFieldVersion(ciphertext: string): 'v2' | 'v1' | 'legacy_raw' | 'empty' | 'unrecognized' {
    if (!ciphertext || ciphertext.trim() === '') return 'empty';
    if (ciphertext.startsWith(this.FIELD_PREFIX_V2)) return 'v2';
    if (ciphertext.startsWith(this.FIELD_PREFIX_V1)) return 'v1';

    // Check if valid Base64
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    if (base64Regex.test(ciphertext) && ciphertext.length >= 24) {
      return 'legacy_raw';
    }
    return 'unrecognized';
  }

  public static getContainerVersion(headerBuffer: Buffer): 'MM_ENC03' | 'MM_ENC02' | 'unrecognized' {
    if (headerBuffer.length < this.CONTAINER_HEADER_SIZE_V2) return 'unrecognized';
    const magic = headerBuffer.subarray(0, 8).toString('ascii');
    if (magic === this.CONTAINER_MAGIC_V3 && headerBuffer.length >= this.CONTAINER_HEADER_SIZE_V3) {
      return 'MM_ENC03';
    }
    if (magic === this.CONTAINER_MAGIC_V2) {
      return 'MM_ENC02';
    }
    return 'unrecognized';
  }
}
