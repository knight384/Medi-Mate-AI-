import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as downloadFile } from '@/app/api/health-data/[id]/file/route';
import { GET as staticUploadFilenameGet } from '@/app/api/static/uploads/[filename]/route';
import { POST as staticUploadPost } from '@/app/api/static/uploads/route';
import { GET as getHealthData, PATCH as patchHealthData, DELETE as deleteHealthData } from '@/app/api/health-data/[id]/route';
import { localStorageDriver, generateStorageKey } from './index';
import { Readable } from 'node:stream';
import prisma from '@/lib/prisma';
import { requireAuth } from '@/lib/api/auth-helpers';
import { ForbiddenError, UnauthorizedError } from '@/lib/errors';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';

// Mock auth helpers directly to avoid next-auth / next/server loading in test environment
vi.mock('@/lib/api/auth-helpers', () => ({
  requireAuth: vi.fn(),
  assertResourceOwner: vi.fn((resourceAuthorId: string | null | undefined, userId: string) => {
    if (!resourceAuthorId || resourceAuthorId !== userId) {
      throw new ForbiddenError('You do not have access to this resource');
    }
  }),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    healthData: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/redis', () => ({
  cacheService: {
    delete: vi.fn(),
    getOrSet: vi.fn(async (_key: string, factory: () => Promise<unknown>) => factory()),
  },
}));

describe('Document Access Control & Decommission Verification', () => {
  const mockUserA = { id: 'user_A', username: 'alice' };
  const mockUserB = { id: 'user_B', username: 'bob' };
  const testStorageDir = path.join(os.tmpdir(), `medimate_doc_access_test_${crypto.randomUUID()}`);

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

  it('rejects unauthenticated document downloads with HTTP 401', async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new UnauthorizedError());

    const req = new NextRequest('http://localhost/api/health-data/doc_123/file');
    const params = Promise.resolve({ id: 'doc_123' });

    const response = await downloadFile(req, { params });
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe('Unauthorized');
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('rejects non-owner document access with HTTP 403 (IDOR prevention)', async () => {
    // Session is User B
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserB });

    // Document belongs to User A (canonical field: authorId)
    vi.mocked(prisma.healthData.findUnique).mockResolvedValueOnce({
      id: 'doc_123',
      type: 'FILE',
      status: 'COMPLETED',
      authorId: mockUserA.id,
      filePath: 'users/user_A/file_uuid.pdf',
      fileType: 'application/pdf',
      data: { fileName: 'confidential_report.pdf' },
    } as never);

    const req = new NextRequest('http://localhost/api/health-data/doc_123/file');
    const params = Promise.resolve({ id: 'doc_123' });

    const response = await downloadFile(req, { params });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toContain('You do not have access to this resource');
    expect(body.code).toBe('FORBIDDEN');
  });

  it('allows document owner to download private file with safe attachment headers', async () => {
    // Session is User A
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserA });

    const storageKey = generateStorageKey(mockUserA.id, '.pdf');
    const syntheticPdfContent = '%PDF-1.4 Patient Blood Test Results for Alice';
    const contentBuffer = Buffer.from(syntheticPdfContent, 'utf-8');

    // Create the physical test file in private storage
    await localStorageDriver.writeStream(storageKey, Readable.from(contentBuffer));

    // Database record points to this private storage key
    vi.mocked(prisma.healthData.findUnique).mockResolvedValueOnce({
      id: 'doc_alice_01',
      type: 'FILE',
      status: 'COMPLETED',
      authorId: mockUserA.id,
      filePath: storageKey,
      fileType: 'application/pdf',
      data: { fileName: 'blood panel (alice).pdf' },
    } as never);

    const req = new NextRequest('http://localhost/api/health-data/doc_alice_01/file');
    const params = Promise.resolve({ id: 'doc_alice_01' });

    const response = await downloadFile(req, { params });
    expect(response.status).toBe(200);

    // Verify safe security headers and RFC attachment disposition
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-disposition')).toContain('filename*=UTF-8\'\'');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0, must-revalidate');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-length')).toBe(String(contentBuffer.length));

    // Verify downloaded byte contents and SHA-256 match exactly
    const downloadedText = await response.text();
    expect(downloadedText).toBe(syntheticPdfContent);

    const crypto = await import('node:crypto');
    const originalSha = crypto.createHash('sha256').update(contentBuffer).digest('hex');
    const downloadedSha = crypto.createHash('sha256').update(Buffer.from(downloadedText, 'utf-8')).digest('hex');
    expect(downloadedSha).toBe(originalSha);

    // Clean up test file
    await localStorageDriver.delete(storageKey);
  });

  it('rejects document download when record has no attached file with HTTP 404', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserA });

    vi.mocked(prisma.healthData.findUnique).mockResolvedValueOnce({
      id: 'doc_no_file',
      type: 'PERSONAL_INFO',
      status: 'COMPLETED',
      authorId: mockUserA.id,
      filePath: null,
      fileType: null,
      data: {},
    } as never);

    const req = new NextRequest('http://localhost/api/health-data/doc_no_file/file');
    const params = Promise.resolve({ id: 'doc_no_file' });

    const response = await downloadFile(req, { params });
    expect(response.status).toBe(404);
  });

  it('blocks path traversal attempt in stored filePath during document download with HTTP 403', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserA });

    vi.mocked(prisma.healthData.findUnique).mockResolvedValueOnce({
      id: 'doc_traversal',
      type: 'FILE',
      status: 'COMPLETED',
      authorId: mockUserA.id,
      filePath: 'users/user_A/../../../../windows/win.ini',
      fileType: 'application/pdf',
      data: { fileName: 'win.ini' },
    } as never);

    const req = new NextRequest('http://localhost/api/health-data/doc_traversal/file');
    const params = Promise.resolve({ id: 'doc_traversal' });

    const response = await downloadFile(req, { params });
    expect(response.status).toBe(403);
  });

  it('rejects document download if status is DELETING (HTTP 404)', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserA });

    vi.mocked(prisma.healthData.findUnique).mockResolvedValueOnce({
      id: 'doc_deleting',
      type: 'FILE',
      status: 'DELETING',
      authorId: mockUserA.id,
      filePath: 'users/user_A/pending.pdf',
      fileType: 'application/pdf',
      data: { fileName: 'pending.pdf' },
    } as never);

    const req = new NextRequest('http://localhost/api/health-data/doc_deleting/file');
    const params = Promise.resolve({ id: 'doc_deleting' });

    const response = await downloadFile(req, { params });
    expect(response.status).toBe(404);
  });

  it('rejects unauthenticated document deletion with HTTP 401', async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new UnauthorizedError());

    const req = new NextRequest('http://localhost/api/health-data/doc_123', { method: 'DELETE' });
    const params = Promise.resolve({ id: 'doc_123' });

    const response = await deleteHealthData(req, { params });
    expect(response.status).toBe(401);
  });

  it('rejects non-owner deletion attempt with HTTP 403 (IDOR check on DELETE)', async () => {
    // Session is User B attempting to delete User A's record
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserB });

    vi.mocked(prisma.healthData.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'doc_user_a',
      authorId: mockUserA.id,
      filePath: 'users/user_A/report.pdf',
    } as never);

    const req = new NextRequest('http://localhost/api/health-data/doc_user_a', { method: 'DELETE' });
    const params = Promise.resolve({ id: 'doc_user_a' });

    const response = await deleteHealthData(req, { params });
    expect(response.status).toBe(403);
    expect(prisma.healthData.delete).not.toHaveBeenCalled();
  });

  it('executes recoverable deletion lifecycle: marks DELETING, deletes file, finalizes DB record', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserA });

    const storageKey = generateStorageKey(mockUserA.id, '.pdf');
    await localStorageDriver.writeStream(storageKey, Readable.from(Buffer.from('recoverable delete content')));
    expect(await localStorageDriver.exists(storageKey)).toBe(true);

    vi.mocked(prisma.healthData.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'doc_recoverable',
      authorId: mockUserA.id,
      status: 'COMPLETED',
      filePath: storageKey,
    } as never);

    vi.mocked(prisma.healthData.update).mockResolvedValueOnce({} as never);
    vi.mocked(prisma.healthData.delete).mockResolvedValueOnce({} as never);

    const req = new NextRequest('http://localhost/api/health-data/doc_recoverable', { method: 'DELETE' });
    const params = Promise.resolve({ id: 'doc_recoverable' });

    const response = await deleteHealthData(req, { params });
    expect(response.status).toBe(200);

    // 1. Verify marked as DELETING first
    expect(prisma.healthData.update).toHaveBeenCalledWith({
      where: { id: 'doc_recoverable' },
      data: { status: 'DELETING' },
    });

    // 2. Verify physical file was removed from private storage
    expect(await localStorageDriver.exists(storageKey)).toBe(false);

    // 3. Verify final DB delete
    expect(prisma.healthData.delete).toHaveBeenCalledWith({ where: { id: 'doc_recoverable' } });
  });

  it('halts database deletion and preserves DELETING state if physical file deletion fails', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserA });

    const storageKey = generateStorageKey(mockUserA.id, '.pdf');
    vi.mocked(prisma.healthData.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'doc_failing_storage',
      authorId: mockUserA.id,
      status: 'COMPLETED',
      filePath: storageKey,
    } as never);

    vi.mocked(prisma.healthData.update).mockResolvedValueOnce({} as never);

    // Spy on localStorageDriver.delete to simulate filesystem failure
    const deleteSpy = vi.spyOn(localStorageDriver, 'delete').mockRejectedValueOnce(new Error('Disk I/O error'));

    const req = new NextRequest('http://localhost/api/health-data/doc_failing_storage', { method: 'DELETE' });
    const params = Promise.resolve({ id: 'doc_failing_storage' });

    const response = await deleteHealthData(req, { params });
    expect(response.status).toBe(500);

    // Verify record was marked DELETING
    expect(prisma.healthData.update).toHaveBeenCalledWith({
      where: { id: 'doc_failing_storage' },
      data: { status: 'DELETING' },
    });

    // Verify DB record was NOT deleted, keeping it recoverable for subsequent retry
    expect(prisma.healthData.delete).not.toHaveBeenCalled();

    deleteSpy.mockRestore();
  });

  it('blocks GET and PATCH operations when health data record is in DELETING status', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ user: mockUserA });

    const params = Promise.resolve({ id: 'doc_deleting_status' });

    // Test GET /api/health-data/[id]
    vi.mocked(prisma.healthData.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'doc_deleting_status',
      authorId: mockUserA.id,
      status: 'DELETING',
      type: 'FILE',
      data: {},
    } as never);

    const getReq = new NextRequest('http://localhost/api/health-data/doc_deleting_status');
    const getRes = await getHealthData(getReq, { params });
    expect(getRes.status).toBe(404);

    // Test PATCH /api/health-data/[id]
    vi.mocked(prisma.healthData.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'doc_deleting_status',
      authorId: mockUserA.id,
      status: 'DELETING',
    } as never);

    const patchReq = new NextRequest('http://localhost/api/health-data/doc_deleting_status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { updated: true } }),
    });
    const patchRes = await patchHealthData(patchReq, { params });
    expect(patchRes.status).toBe(404);
  });

  it('preserves DELETING state and allows retry if database finalization fails after storage deletion', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ user: mockUserA });

    const storageKey = generateStorageKey(mockUserA.id, '.pdf');
    await localStorageDriver.writeStream(storageKey, Readable.from(Buffer.from('retryable test data')));
    expect(await localStorageDriver.exists(storageKey)).toBe(true);

    vi.mocked(prisma.healthData.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'doc_db_fail',
      authorId: mockUserA.id,
      status: 'COMPLETED',
      filePath: storageKey,
    } as never);

    vi.mocked(prisma.healthData.update).mockResolvedValueOnce({} as never);
    vi.mocked(prisma.healthData.delete).mockRejectedValueOnce(new Error('Database transaction timeout'));

    const req = new NextRequest('http://localhost/api/health-data/doc_db_fail', { method: 'DELETE' });
    const params = Promise.resolve({ id: 'doc_db_fail' });

    const response = await deleteHealthData(req, { params });
    expect(response.status).toBe(500);

    // Physical storage was cleaned up
    expect(await localStorageDriver.exists(storageKey)).toBe(false);

    // Record was marked DELETING before storage removal
    expect(prisma.healthData.update).toHaveBeenCalledWith({
      where: { id: 'doc_db_fail' },
      data: { status: 'DELETING' },
    });
  });

  it('verifies public static upload routes are permanently decommissioned (HTTP 404)', async () => {
    // 1. GET /api/static/uploads/[filename]
    const filenameRes = await staticUploadFilenameGet();
    expect(filenameRes.status).toBe(404);
    const bodyFilename = await filenameRes.json();
    expect(bodyFilename.code).toBe('PUBLIC_ACCESS_DECOMMISSIONED');

    // 2. POST /api/static/uploads (former Vercel Blob client token generator)
    const postRes = await staticUploadPost();
    expect(postRes.status).toBe(404);
    const bodyPost = await postRes.json();
    expect(bodyPost.code).toBe('PUBLIC_ACCESS_DECOMMISSIONED');
  });
});
