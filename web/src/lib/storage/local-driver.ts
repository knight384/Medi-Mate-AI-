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

// Magic bytes identifier for authenticated AES-256-GCM encrypted document container
const MAGIC_HEADER = Buffer.from('MM_ENC02'); // 8 bytes
const HEADER_SIZE = 36; // 8 bytes magic + 12 bytes nonce + 16 bytes auth tag

export class LocalStorageDriver {
  private readonly customStorageDir?: string;

  constructor(customStorageDir?: string) {
    this.customStorageDir = customStorageDir;
    this.validateRoot(this.getStorageRoot());
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
   * Initializes storage directories with restrictive permissions (0700).
   */
  public async init(): Promise<void> {
    await fsp.mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Writes a stream to private storage atomically using authenticated AES-256-GCM encryption at rest.
   * Stored format: [8-byte MAGIC "MM_ENC02"] + [12-byte Nonce] + [16-byte AuthTag] + [Ciphertext]
   * Decouples client filenames, enforces boundary checks, and ensures no plaintext is ever written to disk.
   */
  public async writeStream(
    storageKey: string,
    sourceStream: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxBytes?: number
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

    // Cryptographic initialization
    const key = getEncryptionKey();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    // Bind storage key as AAD to prevent document swapping/relocation attacks
    cipher.setAAD(Buffer.from(storageKey, 'utf8'));

    // Write header placeholder: MAGIC (8) + Nonce (12) + AuthTag placeholder (16)
    const headerPlaceholder = Buffer.concat([
      MAGIC_HEADER,
      nonce,
      Buffer.alloc(16), // Placeholder for 16-byte GCM auth tag
    ]);
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

      // Extract authentication tag and patch it into header at offset 20
      const authTag = cipher.getAuthTag();
      const fileHandle = await fsp.open(tempFilePath, 'r+');
      try {
        await fileHandle.write(authTag, 0, 16, 20);
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
   * Reads an existing private document stream, authenticating and decrypting AES-256-GCM ciphertext on the fly.
   * Backward-compatible with legacy unencrypted objects during migration.
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

    // Read header to check for authenticated encrypted container
    if (stat.size >= HEADER_SIZE) {
      const headerBuf = Buffer.alloc(HEADER_SIZE);
      const fh = await fsp.open(realPath, 'r');
      let bytesRead = 0;
      try {
        const res = await fh.read(headerBuf, 0, HEADER_SIZE, 0);
        bytesRead = res.bytesRead;
      } finally {
        await fh.close();
      }

      if (bytesRead >= HEADER_SIZE && headerBuf.subarray(0, 8).equals(MAGIC_HEADER)) {
        const nonce = headerBuf.subarray(8, 20);
        const authTag = headerBuf.subarray(20, 36);

        const key = getEncryptionKey();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(Buffer.from(storageKey, 'utf8'));
        decipher.setAuthTag(authTag);

        const cipherStream = fs.createReadStream(realPath, { start: HEADER_SIZE });
        const decryptedStream = cipherStream.pipe(decipher);

        return {
          stream: decryptedStream,
          size: stat.size - HEADER_SIZE,
          mimeType,
          isEncrypted: true,
        };
      }
    }

    // Legacy unencrypted stream backward compatibility
    const stream = fs.createReadStream(realPath);
    return {
      stream,
      size: stat.size,
      mimeType,
      isEncrypted: false,
    };
  }

  /**
   * Reads and decrypts an entire document into memory as a plaintext Buffer.
   * Verifies GCM authentication tag before resolving.
   */
  public async readBuffer(storageKey: string): Promise<Buffer> {
    const { stream } = await this.readStream(storageKey);
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err: Error) => {
        reject(
          new StorageSecurityError(
            `Cryptographic authentication failed: document ciphertext on disk has been tampered with or corrupted (${err.message})`
          )
        );
      });
    });
  }

  /**
   * Decrypts document stream to a short-lived temporary file with restrictive permissions (0600)
   * within private storage .tmp directory, executes the provided worker callback, and cleans up
   * the temporary plaintext file deterministically in a finally block.
   */
  public async withDecryptedTempFile<T>(
    storageKey: string,
    fn: (tempPlaintextPath: string) => Promise<T>
  ): Promise<T> {
    await this.init();
    const tempFileName = `${crypto.randomUUID()}_plain.tmp`;
    const tempPlaintextPath = path.join(this.tempDir, tempFileName);

    const { stream } = await this.readStream(storageKey);
    const writeStream = fs.createWriteStream(tempPlaintextPath, {
      flags: 'wx',
      mode: 0o600,
    });

    try {
      await pipeline(stream, writeStream);
      return await fn(tempPlaintextPath);
    } finally {
      try {
        await fsp.unlink(tempPlaintextPath);
      } catch {
        // Ignore deletion error if file does not exist
      }
    }
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
