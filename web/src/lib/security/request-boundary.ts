import { PayloadTooLargeError, ValidationError } from '@/lib/errors';

export interface BoundedStreamOptions {
  /** Maximum allowed payload size in bytes */
  maxBytes: number;
}

/**
 * Reads a Request body as a Buffer while strictly enforcing a maximum byte limit.
 *
 * Guarantees:
 * 1. Rejects early if Content-Length exceeds maxBytes before streaming any chunks.
 * 2. Counts actual incoming chunks; terminates and cancels the stream immediately
 *    if streamed bytes exceed maxBytes (protects against missing, inaccurate, or chunked transfer).
 * 3. Does NOT buffer the whole body before checking size.
 * 4. Handles aborted or empty streams safely.
 */
export async function readBoundedBody(
  request: Request,
  options: BoundedStreamOptions
): Promise<Buffer> {
  const { maxBytes } = options;

  // 1. Upfront header check if Content-Length is provided
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      throw new PayloadTooLargeError(
        `Request body size ${contentLength} bytes exceeds limit of ${maxBytes} bytes`
      );
    }
  }

  // 2. If request has no body stream
  if (!request.body) {
    return Buffer.alloc(0);
  }

  // 3. Stream reader with strict running byte counter
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          // Immediately cancel the stream to stop upstream transmission and free sockets
          try {
            await reader.cancel('payload_too_large');
          } catch {
            // Ignore cancel errors if stream already closed/aborted
          }
          throw new PayloadTooLargeError(
            `Request body exceeded maximum size limit of ${maxBytes} bytes`
          );
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw error;
    }
    // Re-throw if already aborted or connection error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ValidationError('Request was aborted by the client');
    }
    throw error;
  }

  return Buffer.concat(chunks, totalBytes);
}

/**
 * Reads and parses a JSON request body with strict size bounds.
 */
export async function readBoundedJson<T = unknown>(
  request: Request,
  options: BoundedStreamOptions
): Promise<T> {
  const buffer = await readBoundedBody(request, options);
  if (buffer.length === 0) {
    throw new ValidationError('Request body cannot be empty');
  }

  try {
    return JSON.parse(buffer.toString('utf8')) as T;
  } catch (error) {
    throw new ValidationError(
      `Invalid JSON payload: ${error instanceof Error ? error.message : 'Syntax error'}`
    );
  }
}

