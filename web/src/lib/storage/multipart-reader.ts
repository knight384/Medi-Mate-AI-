import busboy from '@fastify/busboy';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { localStorageDriver } from './index';
import { safeBasename } from './naming';
import { isPermittedDocument } from './mime';
import { PayloadTooLargeError, ValidationError } from '@/lib/errors';

export const MAX_TOTAL_MULTIPART_BYTES = 20 * 1024 * 1024; // 20 MB total request ceiling
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file

export interface UploadedFileResult {
  originalFilename: string;
  safeName: string;
  detectedMime: string;
  tempPath: string;
  size: number;
  sha256: string;
}

export interface BoundedMultipartResult {
  fields: Record<string, string>;
  file: UploadedFileResult | null;
  cleanup: () => Promise<void>;
}

/**
 * Parses an incoming multipart/form-data request stream with strict byte and file counting.
 * Streams uploaded file data directly to a temporary file in private storage without full-body memory buffering.
 */
export async function readBoundedMultipart(
  request: Request,
  maxTotalBytes: number = MAX_TOTAL_MULTIPART_BYTES
): Promise<BoundedMultipartResult> {
  const contentType = request.headers.get('content-type');
  if (!contentType || !contentType.toLowerCase().includes('multipart/form-data')) {
    throw new ValidationError('Expected multipart/form-data content-type');
  }

  // Upfront Content-Length check
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > maxTotalBytes) {
      throw new PayloadTooLargeError(
        `Total request size ${contentLength} bytes exceeds limit of ${maxTotalBytes} bytes`
      );
    }
  }

  if (!request.body) {
    throw new ValidationError('Request body cannot be empty');
  }

  await localStorageDriver.init();
  const tempDir = path.join(localStorageDriver.getStorageRoot(), '.tmp');

  const fields: Record<string, string> = {};
  let fileResult: UploadedFileResult | null = null;
  let fileCount = 0;
  const tempFilesToClean: string[] = [];

  const cleanup = async () => {
    for (const f of tempFilesToClean) {
      try {
        await fsp.unlink(f);
      } catch {
        // Ignore errors during cleanup
      }
    }
  };

  try {
    if (request.signal?.aborted) {
      throw new ValidationError('Request was aborted by client before processing');
    }

    await new Promise<void>((resolve, reject) => {
      let isRejected = false;
      let activeWriteStream: fs.WriteStream | null = null;
      let activeFileStream: Readable | null = null;

      const fail = (err: Error) => {
        if (isRejected) return;
        isRejected = true;
        try {
          if (activeFileStream && !activeFileStream.destroyed) {
            activeFileStream.destroy();
          }
          if (activeWriteStream && !activeWriteStream.destroyed) {
            activeWriteStream.destroy();
          }
          nodeStream.destroy();
        } catch {
          // ignore
        }
        cleanup().catch(() => {}).finally(() => {
          reject(err);
        });
      };

      if (request.signal) {
        request.signal.addEventListener('abort', () => {
          fail(new ValidationError('Request aborted by client during upload'));
        });
      }

      const bb = busboy({
        headers: {
          'content-type': contentType,
        },
        limits: {
          fileSize: MAX_FILE_BYTES,
          files: 1,
          fields: 20,
          fieldNameSize: 100,
          fieldSize: 64 * 1024,
        },
      });

      let totalStreamBytes = 0;
      const nodeStream = (request.body instanceof Readable)
        ? request.body
        : Readable.fromWeb(request.body as import('node:stream/web').ReadableStream);

      nodeStream.on('data', (chunk: Buffer) => {
        totalStreamBytes += chunk.length;
        if (totalStreamBytes > maxTotalBytes) {
          nodeStream.destroy();
          fail(new PayloadTooLargeError(
            `Streamed request body exceeded limit of ${maxTotalBytes} bytes`
          ));
        }
      });

      nodeStream.on('error', (err: Error) => {
        fail(err);
      });

      bb.on('filesLimit', () => {
        fail(new ValidationError('Only a single document upload is allowed'));
      });

      bb.on('field', (name, val) => {
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
          fail(new ValidationError(`Prohibited multipart field name: ${name}`));
          return;
        }
        fields[name] = val;
      });

      let filePromise: Promise<void> | null = null;

      bb.on('file', (_fieldname, fileStream, filename) => {
        if (isRejected) {
          fileStream.resume();
          return;
        }

        fileCount++;
        if (fileCount > 1) {
          fileStream.resume(); // Discard extra files
          fail(new ValidationError('Only a single document upload is allowed'));
          return;
        }

        activeFileStream = fileStream;
        const safeName = safeBasename(filename) || 'uploaded_document.bin';
        const tempPath = path.join(tempDir, `upload_${crypto.randomUUID()}.tmp`);
        tempFilesToClean.push(tempPath);

        const writeStream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
        activeWriteStream = writeStream;
        let bytesWritten = 0;
        const hash = crypto.createHash('sha256');
        const firstChunks: Buffer[] = [];
        let firstChunkBytes = 0;

        filePromise = new Promise<void>((fileResolve, fileReject) => {
          fileStream.on('data', (chunk: Buffer) => {
            if (isRejected || writeStream.destroyed || writeStream.writableEnded) {
              return;
            }

            bytesWritten += chunk.length;
            if (bytesWritten > MAX_FILE_BYTES) {
              fileStream.destroy();
              writeStream.destroy();
              fileReject(new PayloadTooLargeError(`File size exceeds limit of ${MAX_FILE_BYTES} bytes`));
              return;
            }

            hash.update(chunk);

            if (firstChunkBytes < 4100) {
              firstChunks.push(chunk);
              firstChunkBytes += chunk.length;
            }

            writeStream.write(chunk);
          });

          fileStream.on('end', () => {
            if (!writeStream.destroyed && !writeStream.writableEnded) {
              writeStream.end();
            }
          });

          writeStream.on('finish', async () => {
            try {
              if (isRejected) return;
              const head = Buffer.concat(firstChunks);
              const fileType = await fileTypeFromBuffer(head);
              if (!fileType || !isPermittedDocument(safeName, fileType.mime)) {
                fileReject(new ValidationError(
                  `File '${safeName}' has invalid or prohibited MIME type '${fileType?.mime || 'unknown'}'`
                ));
                return;
              }

              fileResult = {
                originalFilename: filename,
                safeName,
                detectedMime: fileType.mime,
                tempPath,
                size: bytesWritten,
                sha256: hash.digest('hex'),
              };
              fileResolve();
            } catch (err: unknown) {
              fileReject(err instanceof Error ? err : new Error(String(err)));
            }
          });

          fileStream.on('error', (err: Error) => {
            if (!writeStream.destroyed) writeStream.destroy();
            fileReject(err);
          });

          writeStream.on('error', (err: Error) => {
            fileReject(err);
          });
        });
      });

      bb.on('finish', async () => {
        try {
          if (filePromise) {
            await filePromise;
          }
          if (!isRejected) resolve();
        } catch (err: unknown) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      });

      bb.on('error', (err: Error) => {
        fail(err);
      });

      nodeStream.pipe(bb);
    });

    return {
      fields,
      file: fileResult,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
