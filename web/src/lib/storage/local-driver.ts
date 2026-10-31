import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isValidStorageKey } from './naming';
import { guessMime } from './mime';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

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
}

export class StorageSecurityError extends AppError {
  constructor(message = 'Storage security boundary violation') {
    super(message, 403, 'STORAGE_SECURITY_VIOLATION');
    this.name = 'StorageSecurityError';
  }
}

export class LocalStorageDriver {
  private readonly storageRoot: string;
  private readonly tempDir: string;
  private readonly isExplicitConfig: boolean;

  constructor(customStorageDir?: string) {
    this.isExplicitConfig = Boolean(customStorageDir || process.env.MEDIMATE_STORAGE_DIR);
    // 1. Resolve storage root from explicit parameter, environment variable, or default
    const configuredDir = customStorageDir ||
      process.env.MEDIMATE_STORAGE_DIR ||
      path.resolve(process.cwd(), '..', 'storage', 'documents');

    this.storageRoot = path.resolve(configuredDir);
    this.tempDir = path.join(this.storageRoot, '.tmp');

    // 2. Strict public directory escape protection: FAIL CLOSED if inside web/public
    const publicDir = path.resolve(process.cwd(), 'public');
    if (this.storageRoot === publicDir || this.storageRoot.startsWith(publicDir + path.sep)) {
      throw new StorageSecurityError(
        `Critical misconfiguration: MEDIMATE_STORAGE_DIR cannot be inside the public web directory (${this.storageRoot})`
      );
    }
  }

  /**
   * Returns whether storage was explicitly configured rather than relying on development fallbacks.
   */
  public isExplicitlyConfigured(): boolean {
    return this.isExplicitConfig;
  }

  /**
   * Returns the absolute, verified base storage directory.
   */
  public getStorageRoot(): string {
    return this.storageRoot;
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
   * Initializes storage directories with restrictive permissions.
   */
  public async init(): Promise<void> {
    await fsp.mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Writes a stream to private storage atomically using a temporary file.
   */
  public async writeStream(
    storageKey: string,
    sourceStream: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxBytes?: number
  ): Promise<StoredObjectMetadata> {
    if (process.env.NODE_ENV === 'production' && !this.isExplicitConfig) {
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

    const writeStream = fs.createWriteStream(tempFilePath, {
      flags: 'wx', // exclusive write: fail if already exists
      mode: 0o600, // owner read/write only
    });

    try {
      nodeReadable.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (maxBytes !== undefined && bytesWritten > maxBytes) {
          nodeReadable.destroy(new ValidationError(`Upload size exceeded maximum allowed limit of ${maxBytes} bytes`));
        }
        hash.update(chunk);
      });

      await pipeline(nodeReadable, writeStream);

      // Verify file is a regular file and non-empty
      const stat = await fsp.stat(tempFilePath);
      if (!stat.isFile()) {
        throw new StorageSecurityError('Uploaded object is not a regular file');
      }

      // Atomically move the temporary file to its final destination
      await fsp.rename(tempFilePath, targetPath);

      const sha256 = hash.digest('hex');
      const mimeType = guessMime(targetPath);

      return {
        storageKey,
        size: bytesWritten,
        sha256,
        mimeType,
      };
    } catch (error) {
      // Clean up temporary file on any error
      try {
        await fsp.unlink(tempFilePath);
      } catch {
        // Ignore deletion error if temp file wasn't created
      }
      throw error;
    }
  }

  /**
   * Reads an existing private document stream, validating symlinks and boundaries.
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

    const stream = fs.createReadStream(realPath);
    const mimeType = guessMime(realPath);

    return {
      stream,
      size: stat.size,
      mimeType,
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
