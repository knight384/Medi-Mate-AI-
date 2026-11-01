import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createHealthData } from '@/app/api/health-data/route';
import { localStorageDriver } from './index';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { parseHealthData } from '@/lib/health-data/parser/pdf';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    healthData: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/health-data/parser/pdf', () => ({
  parseHealthData: vi.fn(),
}));

function buildMultipartBuffer(
  boundary: string,
  fields: Record<string, string>,
  files: Array<{ fieldname: string; filename: string; contentType: string; data: Buffer }> = []
): Buffer {
  const parts: Buffer[] = [];
  for (const [key, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
      )
    );
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

describe('Health Data Upload Route (POST /api/health-data) Integration', () => {
  const mockUserA = { id: 'user_A', username: 'alice' };
  const boundary = '----WebKitFormBoundaryTest7MA4YW';
  const validPdfHeader = Buffer.from('%PDF-1.4 Synthetic Test Medical Document Content\n%%EOF');
  const testStorageDir = path.join(os.tmpdir(), `medimate_upload_route_test_${crypto.randomUUID()}`);

  beforeAll(async () => {
    process.env.MEDIMATE_STORAGE_DIR = testStorageDir;
    await fsp.mkdir(testStorageDir, { recursive: true });
  });

  afterAll(async () => {
    delete process.env.MEDIMATE_STORAGE_DIR;
    await fsp.rm(testStorageDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated upload requests with HTTP 401', async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never);

    const body = buildMultipartBuffer(boundary, {}, [
      { fieldname: 'file', filename: 'report.pdf', contentType: 'application/pdf', data: validPdfHeader },
    ]);

    const req = new NextRequest('http://localhost/api/health-data', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    });

    const res = await createHealthData(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Unauthorized');
  });

  it('successfully uploads valid PDF, enforces authorId ownership, and writes to private storage', async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: mockUserA } as never);

    vi.mocked(prisma.healthData.create).mockResolvedValueOnce({
      id: 'hd_userA_01',
      type: 'FILE',
      status: 'PARSING',
      authorId: mockUserA.id,
      filePath: 'users/user_A/test.pdf',
      fileType: 'application/pdf',
      data: { fileName: 'report.pdf' },
    } as never);

    vi.mocked(parseHealthData).mockResolvedValueOnce({
      data: [{ test_result: { cholesterol: { value: '180' } } }],
      pages: [{ cholesterol: { page: 1 } }],
      ocrResults: ['OCR text'],
    } as never);

    vi.mocked(prisma.healthData.update).mockResolvedValueOnce({
      id: 'hd_userA_01',
      type: 'FILE',
      status: 'COMPLETED',
      authorId: mockUserA.id,
      data: { fileName: 'report.pdf', cholesterol: { value: '180' } },
    } as never);

    const body = buildMultipartBuffer(boundary, { id: 'hd_userA_01' }, [
      { fieldname: 'file', filename: 'my_lab_report.pdf', contentType: 'application/pdf', data: validPdfHeader },
    ]);

    const req = new NextRequest('http://localhost/api/health-data', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      },
      body: new Uint8Array(body),
    });

    const res = await createHealthData(req);
    expect(res.status).toBe(200);

    // Verify DB insertion was called with canonical authorId: mockUserA.id
    expect(prisma.healthData.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorId: mockUserA.id,
          type: 'FILE',
        }),
      })
    );

    // Verify no file was created under web/public/
    const publicPath = path.resolve(process.cwd(), 'public', 'uploads', 'my_lab_report.pdf');
    let publicFileExists = false;
    try {
      await fsp.access(publicPath);
      publicFileExists = true;
    } catch {
      publicFileExists = false;
    }
    expect(publicFileExists).toBe(false);
  });

  it('rejects upload containing more than one file with HTTP 400', async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: mockUserA } as never);

    const body = buildMultipartBuffer(boundary, {}, [
      { fieldname: 'file', filename: 'doc1.pdf', contentType: 'application/pdf', data: validPdfHeader },
      { fieldname: 'file2', filename: 'doc2.pdf', contentType: 'application/pdf', data: validPdfHeader },
    ]);

    const req = new NextRequest('http://localhost/api/health-data', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    });

    const res = await createHealthData(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Only a single document upload is allowed');
  });

  it('rejects file with invalid signature or spoofed MIME type with HTTP 400', async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: mockUserA } as never);

    // Hostile binary / text pretending to be a PDF
    const fakePdfBytes = Buffer.from('NOT A REAL PDF FILE HEADER -- RANDOM TEXT MALICIOUS SCRIPT');

    const body = buildMultipartBuffer(boundary, {}, [
      { fieldname: 'file', filename: 'exploit.pdf', contentType: 'application/pdf', data: fakePdfBytes },
    ]);

    const req = new NextRequest('http://localhost/api/health-data', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    });

    const res = await createHealthData(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid or prohibited MIME type/i);
  });

  it('rejects oversized Content-Length upfront with HTTP 413', async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: mockUserA } as never);

    const hugeSize = 25 * 1024 * 1024; // 25 MB > 20 MB limit
    const body = buildMultipartBuffer(boundary, {}, [
      { fieldname: 'file', filename: 'huge.pdf', contentType: 'application/pdf', data: validPdfHeader },
    ]);

    const req = new NextRequest('http://localhost/api/health-data', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(hugeSize),
      },
      body: new Uint8Array(body),
    });

    const res = await createHealthData(req);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects missing or deceptive Content-Length when streamed body exceeds 20 MB with HTTP 413', async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: mockUserA } as never);

    // Create a 21 MB streamed body
    const largeChunk = Buffer.alloc(1024 * 1024, 0x20); // 1 MB of whitespace
    const chunks: Buffer[] = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stream.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      validPdfHeader,
    ];
    for (let i = 0; i < 21; i++) {
      chunks.push(largeChunk);
    }
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const hugeBody = Buffer.concat(chunks);

    const req = new NextRequest('http://localhost/api/health-data', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        // Deceptive Content-Length
        'content-length': '100',
      },
      body: new Uint8Array(hugeBody),
    });

    const res = await createHealthData(req);
    expect(res.status).toBe(413);
  }, 15000);

  it('cleans up physical storage if database insertion fails after write', async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: mockUserA } as never);

    // Mock database creation failure
    vi.mocked(prisma.healthData.create).mockRejectedValueOnce(new Error('DB connection failed'));

    const deleteSpy = vi.spyOn(localStorageDriver, 'delete');

    const body = buildMultipartBuffer(boundary, {}, [
      { fieldname: 'file', filename: 'cleanup_test.pdf', contentType: 'application/pdf', data: validPdfHeader },
    ]);

    const req = new NextRequest('http://localhost/api/health-data', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    });

    const res = await createHealthData(req);
    expect(res.status).toBe(500);

    // Verify localStorageDriver.delete was invoked to prevent orphaned files
    expect(deleteSpy).toHaveBeenCalled();
    deleteSpy.mockRestore();
  });

  it('cleans up temporary files when upload request is aborted by client', async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: mockUserA } as never);

    const controller = new AbortController();
    controller.abort(); // Abort upfront

    const body = buildMultipartBuffer(boundary, {}, [
      { fieldname: 'file', filename: 'aborted.pdf', contentType: 'application/pdf', data: validPdfHeader },
    ]);

    const req = new NextRequest('http://localhost/api/health-data', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
      signal: controller.signal,
    });

    const res = await createHealthData(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('aborted');
  });
});
