import { describe, expect, it, vi } from 'vitest';
import { readBoundedBody, readBoundedJson } from './request-boundary';
import { PayloadTooLargeError, ValidationError } from '@/lib/errors';
import { POST as registerPost } from '@/app/api/auth/register/route';

describe('Request Boundary Stream Protection', () => {
  it('rejects oversized HTTP bodies early when Content-Length exceeds limit', async () => {
    const bodyStream = new ReadableStream({
      pull() {},
    });
    const getReaderSpy = vi.spyOn(bodyStream, 'getReader');

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '2000',
      },
      body: bodyStream,
      duplex: 'half',
    } as RequestInit & { duplex: string });

    getReaderSpy.mockClear();

    await expect(
      readBoundedBody(request, { maxBytes: 1000 })
    ).rejects.toThrow(PayloadTooLargeError);

    expect(getReaderSpy).not.toHaveBeenCalled();
  });

  it('bounds chunked requests without Content-Length as soon as streamed bytes exceed limit', async () => {
    let streamCancelled = false;
    const chunks = [
      new Uint8Array(500),
      new Uint8Array(600), // Exceeds 1000 bytes
      new Uint8Array(500),
    ];

    const bodyStream = new ReadableStream({
      pull(controller) {
        if (chunks.length > 0) {
          controller.enqueue(chunks.shift());
        } else {
          controller.close();
        }
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // No content-length header
      },
      body: bodyStream,
      duplex: 'half',
    } as RequestInit & { duplex: string });

    await expect(
      readBoundedBody(request, { maxBytes: 1000 })
    ).rejects.toThrow(PayloadTooLargeError);

    expect(streamCancelled).toBe(true);
  });

  it('ensures inaccurate or deceptive Content-Length does not bypass stream byte counter', async () => {
    let streamCancelled = false;
    const chunks = [
      new Uint8Array(400),
      new Uint8Array(400),
      new Uint8Array(400), // Total 1200 bytes > 1000 maxBytes
    ];

    const bodyStream = new ReadableStream({
      pull(controller) {
        if (chunks.length > 0) {
          controller.enqueue(chunks.shift());
        } else {
          controller.close();
        }
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '50', // Deceptive header claims only 50 bytes
      },
      body: bodyStream,
      duplex: 'half',
    } as RequestInit & { duplex: string });

    await expect(
      readBoundedBody(request, { maxBytes: 1000 })
    ).rejects.toThrow(PayloadTooLargeError);

    expect(streamCancelled).toBe(true);
  });

  it('safely handles aborted or errored streams', async () => {
    const bodyStream = new ReadableStream({
      start(controller) {
        const error = new Error('Stream aborted');
        error.name = 'AbortError';
        controller.error(error);
      },
    });

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyStream,
      duplex: 'half',
    } as RequestInit & { duplex: string });

    await expect(
      readBoundedBody(request, { maxBytes: 1000 })
    ).rejects.toThrow(ValidationError);
  });

  it('parses valid JSON within byte limit', async () => {
    const payload = JSON.stringify({ message: 'safe payload', count: 42 });
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    const data = await readBoundedJson<{ message: string; count: number }>(request, {
      maxBytes: 1024,
    });
    expect(data.message).toBe('safe payload');
    expect(data.count).toBe(42);
  });

  it('rejects invalid JSON syntax with ValidationError', async () => {
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not a valid json string {',
    });

    await expect(
      readBoundedJson(request, { maxBytes: 1024 })
    ).rejects.toThrow(ValidationError);
  });

  it('enforces 64 KB route ceiling on /api/auth/register with HTTP 413', async () => {
    // Generate synthetic payload > 64 KB
    const oversizedString = 'a'.repeat(70 * 1024);
    const payload = JSON.stringify({
      username: 'testuser',
      password: oversizedString,
    });

    const request = new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      body: payload,
    });

    const response = await registerPost(request);
    expect(response.status).toBe(413);

    const body = await response.json();
    expect(body.error).toContain('exceeds limit of 65536 bytes');
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

