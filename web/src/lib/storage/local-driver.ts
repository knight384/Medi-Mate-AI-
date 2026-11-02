import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isValidStorageKey } from './naming';
import { guessMime } from './mime';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getEncryptionKey } from '@/lib/encryption';

import { StorageDriver } from './storage-driver.interface';
import { ProtectedScratchStorage, protectedScratchStorage } from './temp-storage';

export interface StoredObjectMetadata {
  storageKey: string;
  size: number;
  sha256: string;
  mimeType: string;
}

export interface StorageReadResult {
  stream: Readable;
  size: number;
  mimeType: string;
  sha256?: string;
  isEncrypted?: boolean;
}

export class StorageSecurityError extends AppError {
  constructor(message = 'Storage security boundary violation') {
    super(message, 403, 'STORAGE_SECURITY_VIOLATION');
    this.name = 'StorageSecurityError';
  }
}

/**
 * Container Header Formats & Constants:
 *
 * MM_ENC03 (Modern, 40 bytes):
 * - Bytes 0..7:   Magic ASCII "MM_ENC03" (8 bytes)
 * - Bytes 8..11:  Key Identifier (4 bytes ASCII, e.g. "k001")
 * - Bytes 12..23: Nonce / IV (12 bytes)
 * - Bytes 24..39: GCM Authentication Tag (16 bytes)
 * - Offset 40+:   AES-256-GCM Ciphertext payload
 *
 * MM_ENC02 (Backward Compatible, 36 bytes):
 * - Bytes 0..7:   Magic ASCII "MM_ENC02" (8 bytes)
 * - Bytes 8..19:  Nonce / IV (12 bytes)
 * - Bytes 20..35: GCM Authentication Tag (16 bytes)
 * - Offset 36+:   AES-256-GCM Ciphertext payload (defaults to primary key "k001")
 *
 * Cryptographic Nonce & Key Lifecycle Notice (NIST SP 800-38D Section 8.2.2):
 * A 96-bit random nonce does NOT guarantee collision-free uniqueness across infinite invocations.
 * Under birthday paradox bounds, collision probability P is bounded by q^2 / 2^97.
 * NIST SP 800-38D mandates that total invocations under a single key SHALL NOT exceed 2^32,
 * bounding collision probability below 2^-32 (~2.33e-10).
 * Operational recommendation: Rotate master encryption keys every 2^24 encryptions or 90 days.
 */
export const MAGIC_HEADER_V2 = Buffer.from('MM_ENC02'); // 8 bytes
export const MAGIC_HEADER_V3 = Buffer.from('MM_ENC03'); // 8 bytes
export const HEADER_SIZE_V2 = 36;
export const HEADER_SIZE_V3 = 40;
export const DEFAULT_KEY_ID = 'k001';

/**
 * Validates encryption key identifier against path traversal and malicious lookup characters.
 */
export function validateKeyId(keyId: string): void {
  if (!keyId || typeof keyId !== 'string') {
    throw new StorageSecurityError('Key identifier must be a non-empty string');
  }
  if (keyId !== keyId.trim() || !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)) {
    throw new StorageSecurityError(`Invalid encryption key identifier format: ${keyId}`);
  }
}

export interface LocalStorageDriverOptions {
  customStorageDir?: string;
  keyring?: Map<string, Buffer>;
  activeKeyId?: string;
  scratchStorage?: ProtectedScratchStorage;
}

export interface WriteStreamOptions {
  version?: 'MM_ENC02' | 'MM_ENC03';
  keyId?: string;
  bindVersionAndKeyIdInAAD?: boolean;
}

export class LocalStorageDriver implements StorageDriver {
  public readonly driverType = 'local' as const;
  private readonly customStorageDir?: string;
  private readonly keyring: Map<string, Buffer>;
  private readonly activeKeyId: string;
  private readonly scratchStorage: ProtectedScratchStorage;

  constructor(
    optionsOrDir?: string | LocalStorageDriverOptions,
    keyringArg?: Map<string, Buffer>,
    activeKeyIdArg = DEFAULT_KEY_ID
  ) {
    let customStorageDir: string | undefined;
    let customScratch: ProtectedScratchStorage | undefined;

    if (typeof optionsOrDir === 'string') {
      customStorageDir = optionsOrDir;
      this.keyring = keyringArg ? new Map(keyringArg) : new Map();
      this.activeKeyId = activeKeyIdArg;
    } else if (optionsOrDir && typeof optionsOrDir === 'object') {
      customStorageDir = optionsOrDir.customStorageDir;
      this.keyring = optionsOrDir.keyring ? new Map(optionsOrDir.keyring) : new Map();
      this.activeKeyId = optionsOrDir.activeKeyId || DEFAULT_KEY_ID;
      customScratch = optionsOrDir.scratchStorage;
    } else {
      this.keyring = new Map();
      this.activeKeyId = DEFAULT_KEY_ID;
    }

    validateKeyId(this.activeKeyId);

    // Ensure active key is populated in keyring
    if (!this.keyring.has(this.activeKeyId)) {
      try {
        this.keyring.set(this.activeKeyId, getEncryptionKey());
      } catch {
        // In build or test contexts where key might be lazily provided
      }
    }

    this.customStorageDir = customStorageDir;
    this.scratchStorage =
      customScratch ||
      (customStorageDir
        ? new ProtectedScratchStorage({
            customScratchDir: path.join(customStorageDir, '.scratch'),
          })
        : protectedScratchStorage);

    this.validateRoot(this.getStorageRoot());
  }

  public getScratchStorage(): ProtectedScratchStorage {
    return this.scratchStorage;
  }

  /**
   * Retrieves an encryption key from keyring by identifier.
   */
  public getKey(keyId: string): Buffer {
    const trimmedId = keyId.trim();
    validateKeyId(trimmedId);
    let key = this.keyring.get(trimmedId);
    if (!key && (trimmedId === DEFAULT_KEY_ID || trimmedId === '')) {
      key = getEncryptionKey();
      this.keyring.set(DEFAULT_KEY_ID, key);
    }
    if (!key) {
      throw new StorageSecurityError(`Unknown encryption key identifier: ${trimmedId}`);
    }
    return key;
  }

  public getActiveKeyId(): string {
    return this.activeKeyId;
  }

  public registerKey(keyId: string, key: Buffer): void {
    validateKeyId(keyId);
    if (key.length !== 32) {
      throw new StorageSecurityError(`Invalid encryption key length: expected 32 bytes, got ${key.length}`);
    }
    this.keyring.set(keyId.trim(), key);
  }

  private validateRoot(root: string): void {
    const publicDir = path.resolve(process.cwd(), 'public');
    if (root === publicDir || root.startsWith(publicDir + path.sep)) {
      throw new StorageSecurityError(
        `Critical misconfiguration: MEDIMATE_STORAGE_DIR cannot be inside the public web directory (${root})`
      );
    }
  }

  /**
   * Returns whether storage was explicitly configured rather than relying on development fallbacks.
   */
  public isExplicitlyConfigured(): boolean {
    return Boolean(this.customStorageDir || process.env.MEDIMATE_STORAGE_DIR);
  }

  /**
   * Returns the absolute, verified base storage directory.
   */
  public getStorageRoot(): string {
    const configuredDir = this.customStorageDir ||
      process.env.MEDIMATE_STORAGE_DIR ||
      path.resolve(process.cwd(), '..', 'storage', 'documents');
    const root = path.resolve(configuredDir);
    this.validateRoot(root);
    return root;
  }

  private get storageRoot(): string {
    return this.getStorageRoot();
  }

  private get tempDir(): string {
    return path.join(this.getStorageRoot(), '.tmp');
  }

  /**
   * Resolves and verifies an opaque storage key against path traversal and symlinks.
   */
  public resolveSecurePath(storageKey: string): string {
    if (!isValidStorageKey(storageKey)) {
      throw new StorageSecurityError(`Invalid storage key format: ${storageKey}`);
    }

    const fullPath = path.resolve(this.storageRoot, storageKey);
    const rootWithSep = this.storageRoot.endsWith(path.sep)
      ? this.storageRoot
      : this.storageRoot + path.sep;

    if (!fullPath.startsWith(rootWithSep)) {
      throw new StorageSecurityError(`Path traversal attempt blocked for storage key: ${storageKey}`);
    }

    return fullPath;
  }

  /**
   * Scrubs orphaned temporary files (> maxAgeMs old) resulting from process crashes or ungraceful terminations.
   * Active temporary files (< maxAgeMs) are untouched, avoiding race conditions with concurrent workers.
   *
   * @param maxAgeMs Maximum age in milliseconds (defaults to 15 minutes = 900,000 ms)
   * @returns Number of orphaned temporary files deleted
   */
  public async cleanupOrphanedTempFiles(maxAgeMs: number = 15 * 60 * 1000): Promise<number> {
    let cleanedCount = 0;
    try {
      const scratchResult = await this.scratchStorage.cleanupOrphanedScratch();
      cleanedCount += scratchResult.cleanedFiles;
    } catch {
      // Ignore scratch cleanup error
    }

    try {
      const entries = await fsp.readdir(this.tempDir, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith('.tmp') || entry.name.includes('.quarantine'))) {
          const fullPath = path.join(this.tempDir, entry.name);
          try {
            const stat = await fsp.stat(fullPath);
            if (now - stat.mtimeMs >= maxAgeMs) {
              await fsp.unlink(fullPath);
              cleanedCount++;
              logger.info('Cleaned up orphaned temporary storage file', {
                file: entry.name,
                ageMs: now - stat.mtimeMs,
              });
            }
          } catch {
            // Concurrently unlinked or inaccessible
          }
        }
      }
      return cleanedCount;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return cleanedCount;
      }
      logger.warn('Failed to clean up orphaned temporary files in storage', {
        error: err instanceof Error ? err.message : String(err),
      });
      return cleanedCount;
    }
  }

  /**
   * Initializes storage directories with restrictive permissions (0700) and purges stale temp files.
   */
  public async init(): Promise<void> {
    await fsp.mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    await this.cleanupOrphanedTempFiles();
  }

  /**
   * Writes a stream to private storage atomically using authenticated AES-256-GCM encryption at rest.
   * Default stored format (MM_ENC03):
   * [8-byte MAGIC "MM_ENC03"] + [4-byte KeyId] + [12-byte Nonce] + [16-byte AuthTag] + [Ciphertext]
   *
   * Decouples client filenames, enforces boundary checks, and ensures no plaintext is ever written to disk.
   */
  public async writeStream(
    storageKey: string,
    sourceStream: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxBytes?: number,
    options?: WriteStreamOptions
  ): Promise<StoredObjectMetadata> {
    if (process.env.NODE_ENV === 'production' && !this.isExplicitlyConfigured()) {
      throw new StorageSecurityError(
        'Production deployment requires an explicitly configured MEDIMATE_STORAGE_DIR persistent storage path.'
      );
    }

    await this.init();

    const targetPath = this.resolveSecurePath(storageKey);
    if (await this.exists(storageKey)) {
      throw new StorageSecurityError(`Storage collision: object already exists at key ${storageKey}`);
    }

    const targetDir = path.dirname(targetPath);
    await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });

    const tempFileName = `${crypto.randomUUID()}.tmp`;
    const tempFilePath = path.join(this.tempDir, tempFileName);

    const version = options?.version || 'MM_ENC03';
    const keyId = (options?.keyId || this.activeKeyId).padEnd(4, ' ').slice(0, 4);
    const key = this.getKey(keyId);

    // Cryptographic initialization (NIST SP 800-38D: 12-byte nonce)
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    // Bind storage key as AAD to prevent document swapping/relocation attacks
    cipher.setAAD(Buffer.from(storageKey, 'utf8'));

    // Construct header placeholder
    let headerPlaceholder: Buffer;
    let tagOffset: number;

    if (version === 'MM_ENC02') {
      // Legacy V2 container: 8 bytes magic + 12 bytes nonce + 16 bytes tag placeholder
      headerPlaceholder = Buffer.concat([
        MAGIC_HEADER_V2,
        nonce,
        Buffer.alloc(16),
      ]);
      tagOffset = 20;
    } else {
      // Modern V3 container: 8 bytes magic + 4 bytes keyId + 12 bytes nonce + 16 bytes tag placeholder
      const keyIdBuf = Buffer.alloc(4);
      keyIdBuf.write(keyId, 0, 4, 'ascii');
      headerPlaceholder = Buffer.concat([
        MAGIC_HEADER_V3,
        keyIdBuf,
        nonce,
        Buffer.alloc(16),
      ]);
      tagOffset = 24;
    }

    await fsp.writeFile(tempFilePath, headerPlaceholder, { mode: 0o600, flag: 'wx' });

    let bytesWritten = 0;
    const hash = crypto.createHash('sha256');

    // Convert Web ReadableStream to Node Readable if needed
    let nodeReadable: Readable;
    if (sourceStream instanceof Readable) {
      nodeReadable = sourceStream;
    } else if (typeof (sourceStream as ReadableStream<Uint8Array>).getReader === 'function') {
      nodeReadable = Readable.fromWeb(sourceStream as import('node:stream/web').ReadableStream);
    } else {
      nodeReadable = sourceStream as Readable;
    }

    // Open append stream for ciphertext payload
    const writeCipherStream = fs.createWriteStream(tempFilePath, {
      flags: 'a',
      mode: 0o600,
    });

    const encryptTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.length;
        if (maxBytes !== undefined && bytesWritten > maxBytes) {
          callback(new ValidationError(`Upload size exceeded maximum allowed limit of ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        try {
          const enc = cipher.update(chunk);
          callback(null, enc);
        } catch (err) {
          callback(err as Error);
        }
      },
      flush(callback) {
        try {
          const finalChunk = cipher.final();
          callback(null, finalChunk);
        } catch (err) {
          callback(err as Error);
        }
      },
    });

    try {
      await pipeline(nodeReadable, encryptTransform, writeCipherStream);

      // Extract authentication tag and patch it into header at designated offset
      const authTag = cipher.getAuthTag();
      const fileHandle = await fsp.open(tempFilePath, 'r+');
      try {
        await fileHandle.write(authTag, 0, 16, tagOffset);
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }

      // Verify file is a regular file
      const stat = await fsp.stat(tempFilePath);
      if (!stat.isFile()) {
        throw new StorageSecurityError('Uploaded object is not a regular file');
      }

      // Atomically publish the temporary file exclusively (create-if-absent)
      try {
        await fsp.link(tempFilePath, targetPath);
        await fsp.unlink(tempFilePath);
      } catch (linkErr: unknown) {
        const err = linkErr as NodeJS.ErrnoException;
        if (err.code === 'EEXIST') {
          throw new StorageSecurityError(`Storage collision: object already exists at key ${storageKey}`);
        }
        throw new StorageSecurityError(
          `Atomic storage publication failed: hard-link create-if-absent is not supported by underlying storage medium (${err.code || String(linkErr)})`
        );
      }

      const sha256 = hash.digest('hex');
      const mimeType = guessMime(targetPath);

      return {
        storageKey,
        size: bytesWritten,
        sha256,
        mimeType,
      };
    } catch (error) {
      try {
        await fsp.unlink(tempFilePath);
      } catch {
        // Ignore deletion error if temp file wasn't created
      }
      throw error;
    }
  }

  /**
   * Reads an existing private document stream, authenticating and decrypting AES-256-GCM ciphertext.
   *
   * SECURITY DIRECTIVE (Zero Plaintext Invariant):
   * Node.js decipher.update() emits chunks before decipher.final() verifies the authentication tag.
   * To prevent unauthenticated plaintext from reaching HTTP responses, callers, or parsers,
   * this method decrypts into a private quarantine file (.tmp/<id>.quarantine.tmp, mode 0600)
   * and verifies decipher.final() to completion. Only if authentication succeeds is a verified stream
   * returned, with automated unlink on stream closure.
   *
   * Unauthenticated or headerless legacy files are rejected with StorageSecurityError.
   */
  public async readStream(storageKey: string): Promise<StorageReadResult> {
    const targetPath = this.resolveSecurePath(storageKey);

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(targetPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError('Storage document not found');
      }
      throw err;
    }

    if (!stat.isFile()) {
      throw new StorageSecurityError('Requested storage resource is not a regular file');
    }

    // Symlink escape defense: verify canonical path matches storage root
    const realPath = await fsp.realpath(targetPath);
    const rootWithSep = this.storageRoot.endsWith(path.sep)
      ? this.storageRoot
      : this.storageRoot + path.sep;

    if (!realPath.startsWith(rootWithSep)) {
      throw new StorageSecurityError('Symlink destination outside storage root blocked');
    }

    const mimeType = guessMime(realPath);

    // Validate container header
    if (stat.size < HEADER_SIZE_V2) {
      throw new StorageSecurityError(
        'Legacy plaintext or unauthenticated document format rejected in standard pipeline'
      );
    }

    const maxHeaderBuf = Buffer.alloc(HEADER_SIZE_V3);
    const fh = await fsp.open(realPath, 'r');
    let bytesRead = 0;
    try {
      const res = await fh.read(maxHeaderBuf, 0, HEADER_SIZE_V3, 0);
      bytesRead = res.bytesRead;
    } finally {
      await fh.close();
    }

    let keyId = DEFAULT_KEY_ID;
    let nonce: Buffer;
    let authTag: Buffer;
    let cipherStartOffset: number;

    if (bytesRead >= HEADER_SIZE_V3 && maxHeaderBuf.subarray(0, 8).equals(MAGIC_HEADER_V3)) {
      // Modern MM_ENC03 container
      keyId = maxHeaderBuf.subarray(8, 12).toString('ascii').trim();
      nonce = maxHeaderBuf.subarray(12, 24);
      authTag = maxHeaderBuf.subarray(24, 40);
      cipherStartOffset = HEADER_SIZE_V3;
    } else if (bytesRead >= HEADER_SIZE_V2 && maxHeaderBuf.subarray(0, 8).equals(MAGIC_HEADER_V2)) {
      // Backward-compatible MM_ENC02 container
      keyId = DEFAULT_KEY_ID;
      nonce = maxHeaderBuf.subarray(8, 20);
      authTag = maxHeaderBuf.subarray(20, 36);
      cipherStartOffset = HEADER_SIZE_V2;
    } else {
      // Rejection of unauthenticated / headerless legacy files in production
      throw new StorageSecurityError(
        'Legacy plaintext or unauthenticated document format rejected in standard pipeline'
      );
    }

    const key = this.getKey(keyId);
    await this.init();

    // Quarantine Decryption: decrypt into private isolated scratch storage
    const { filePath: quarantinePath, release: releaseQuarantine } =
      await this.scratchStorage.allocateFile('quarantine', '.quarantine.tmp', 'stream_verification');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(storageKey, 'utf8'));
    decipher.setAuthTag(authTag);

    const cipherStream = fs.createReadStream(realPath, { start: cipherStartOffset });
    const quarantineWriteStream = fs.createWriteStream(quarantinePath, {
      flags: 'wx',
      mode: 0o600,
    });

    try {
      await pipeline(cipherStream, decipher, quarantineWriteStream);
    } catch (pipelineErr) {
      // Immediately purge quarantine file on any authentication error
      await releaseQuarantine().catch(() => {});
      throw new StorageSecurityError(
        `Cryptographic authentication failed: document ciphertext on disk has been tampered with or corrupted (${(pipelineErr as Error).message})`
      );
    }

    // Authentication succeeded! Stat the verified quarantine file for exact size
    const qStat = await fsp.stat(quarantinePath);
    const verifiedStream = fs.createReadStream(quarantinePath);

    // Automatic cleanup of quarantine file once stream finishes or errors
    let unlinked = false;
    const cleanupQuarantine = () => {
      if (!unlinked) {
        unlinked = true;
        releaseQuarantine().catch(() => {});
      }
    };
    verifiedStream.on('close', cleanupQuarantine);
    verifiedStream.on('error', cleanupQuarantine);

    return {
      stream: verifiedStream,
      size: qStat.size,
      mimeType,
      isEncrypted: true,
    };
  }

  /**
   * Reads and decrypts an entire document into memory as a plaintext Buffer.
   * Strictly enforces GCM authentication verification before resolving.
   */
  public async readBuffer(storageKey: string): Promise<Buffer> {
    const { stream } = await this.readStream(storageKey);
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Decrypts document stream to a short-lived temporary file with restrictive permissions (0600)
   * within protected scratch storage, executes the provided worker callback, and cleans up
   * the temporary plaintext file deterministically in a finally block.
   *
   * Plaintext file is ONLY created and passed to fn after GCM authentication completes successfully.
   */
  public async withDecryptedTempFile<T>(
    storageKey: string,
    fn: (tempPlaintextPath: string) => Promise<T>
  ): Promise<T> {
    await this.init();
    const { filePath: tempPlaintextPath, release } = await this.scratchStorage.allocateFile(
      'decrypted',
      '_plain.tmp',
      'withDecryptedTempFile'
    );

    const { stream } = await this.readStream(storageKey);
    const writeStream = fs.createWriteStream(tempPlaintextPath, {
      flags: 'wx',
      mode: 0o600,
    });

    try {
      await pipeline(stream, writeStream);
      return await fn(tempPlaintextPath);
    } finally {
      await release();
    }
  }

  /**
   * Dedicated isolated legacy document reader strictly for the migration utility.
   * Standard production pipelines reject unauthenticated legacy documents.
   */
  public async readLegacyDocumentForMigration(storageKey: string): Promise<StorageReadResult> {
    const targetPath = this.resolveSecurePath(storageKey);

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(targetPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError('Storage document not found');
      }
      throw err;
    }

    if (!stat.isFile()) {
      throw new StorageSecurityError('Requested storage resource is not a regular file');
    }

    const realPath = await fsp.realpath(targetPath);
    const rootWithSep = this.storageRoot.endsWith(path.sep)
      ? this.storageRoot
      : this.storageRoot + path.sep;

    if (!realPath.startsWith(rootWithSep)) {
      throw new StorageSecurityError('Symlink destination outside storage root blocked');
    }

    logger.warn('Reading unauthenticated legacy document for migration', { storageKey });
    const mimeType = guessMime(realPath);

    return {
      stream: fs.createReadStream(realPath),
      size: stat.size,
      mimeType,
      isEncrypted: false,
    };
  }

  /**
   * Deletes a stored file idempotently. Returns true if deleted, false if file did not exist.
   */
  public async delete(storageKey: string): Promise<boolean> {
    if (!isValidStorageKey(storageKey)) {
      return false;
    }

    try {
      const targetPath = this.resolveSecurePath(storageKey);
      await fsp.unlink(targetPath);
      logger.info('Private document deleted from storage', { storageKey });
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      logger.error('Failed to delete storage file', {
        storageKey,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      throw err;
    }
  }

  /**
   * Checks whether a storage key exists as a regular file.
   */
  public async exists(storageKey: string): Promise<boolean> {
    if (!isValidStorageKey(storageKey)) return false;
    try {
      const targetPath = this.resolveSecurePath(storageKey);
      const stat = await fsp.stat(targetPath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Returns verified absolute physical disk path for local OCR processing.
   */
  public async getValidatedDiskPath(storageKey: string): Promise<string> {
    const targetPath = this.resolveSecurePath(storageKey);
    const stat = await fsp.stat(targetPath);
    if (!stat.isFile()) {
      throw new StorageSecurityError('Target is not a regular file');
    }
    const realPath = await fsp.realpath(targetPath);
    const rootWithSep = this.storageRoot.endsWith(path.sep)
      ? this.storageRoot
      : this.storageRoot + path.sep;
    if (!realPath.startsWith(rootWithSep)) {
      throw new StorageSecurityError('Symlink path outside storage root blocked');
    }
    return realPath;
  }
}
