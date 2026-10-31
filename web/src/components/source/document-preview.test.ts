import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  getAuthenticatedDocumentUrl,
  fetchDocumentPreviewBlob,
} from '@/hooks/use-authenticated-document-preview';

describe('Document Preview Security & Authenticated Preview Verification', () => {
  let createdObjectUrls: string[] = [];
  let revokedObjectUrls: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    createdObjectUrls = [];
    revokedObjectUrls = [];

    let counter = 0;
    globalThis.URL.createObjectURL = vi.fn(() => {
      counter++;
      const url = `blob:http://localhost:3000/mock-uuid-${counter}`;
      createdObjectUrls.push(url);
      return url;
    });

    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      revokedObjectUrls.push(url);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies source-add-screen.tsx does not use healthData.filePath as an HTML src or Document file', async () => {
    const sourceFilePath = path.resolve(__dirname, 'source-add-screen.tsx');
    const sourceCode = await fsp.readFile(sourceFilePath, 'utf-8');

    // Confirm deprecated direct access patterns are completely removed
    expect(sourceCode).not.toContain('src={healthData.filePath}');
    expect(sourceCode).not.toContain('<Document file={healthData.filePath}');
    expect(sourceCode).not.toContain('<Document file={healthData?.filePath}');

    // Confirm secure authenticated preview wiring is present
    expect(sourceCode).toContain('useAuthenticatedDocumentPreview(healthData)');
    expect(sourceCode).toContain('<Document file={previewUrl}');
    expect(sourceCode).toContain('<img');
    expect(sourceCode).toContain('src={previewUrl}');
    expect(sourceCode).toContain('Download PDF');
    expect(sourceCode).toContain('Download image');
  });

  it('fetches authenticated endpoint with session for PDF documents and generates object URL', async () => {
    const mockBlob = new Blob(['%PDF-1.4 mock pdf content'], { type: 'application/pdf' });
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe('/api/health-data/doc_pdf_01/file');
      return {
        ok: true,
        status: 200,
        blob: async () => mockBlob,
      } as Response;
    });
    globalThis.fetch = fetchSpy as never;

    const healthData = {
      id: 'doc_pdf_01',
      type: 'FILE',
      fileType: 'application/pdf',
      filePath: 'users/user_123/456e4567-e89b-12d3-a456-426614174000.pdf',
      status: 'COMPLETED',
    };

    const downloadUrl = getAuthenticatedDocumentUrl(healthData);
    expect(downloadUrl).toBe('/api/health-data/doc_pdf_01/file');
    expect(downloadUrl).not.toContain(healthData.filePath);
    expect(downloadUrl).not.toContain('users/user_123');

    const result = await fetchDocumentPreviewBlob(healthData.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.blob).toBe(mockBlob);

    const objectUrl = URL.createObjectURL(result.blob!);
    expect(objectUrl).toBe('blob:http://localhost:3000/mock-uuid-1');
  });

  it('fetches authenticated endpoint for Image documents without leaking raw storage key', async () => {
    const mockBlob = new Blob(['mock-image-bytes'], { type: 'image/jpeg' });
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe('/api/health-data/doc_img_02/file');
      return {
        ok: true,
        status: 200,
        blob: async () => mockBlob,
      } as Response;
    });
    globalThis.fetch = fetchSpy as never;

    const healthData = {
      id: 'doc_img_02',
      type: 'FILE',
      fileType: 'image/jpeg',
      filePath: 'users/user_789/image_scan.jpg',
      status: 'COMPLETED',
    };

    const downloadUrl = getAuthenticatedDocumentUrl(healthData);
    expect(downloadUrl).toBe('/api/health-data/doc_img_02/file');
    expect(downloadUrl).not.toContain('image_scan.jpg');
    expect(downloadUrl).not.toContain('users/user_789');

    const result = await fetchDocumentPreviewBlob(healthData.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('correctly reports 401 Unauthorized and 403 Forbidden without crashing', async () => {
    const fetchSpy401 = vi.fn(async () => ({ ok: false, status: 401 } as Response));
    globalThis.fetch = fetchSpy401 as never;

    const res401 = await fetchDocumentPreviewBlob('doc_unauth');
    expect(res401.ok).toBe(false);
    expect(res401.status).toBe(401);
    expect(res401.error).toContain('Unauthorized: You do not have permission to view this document.');

    const fetchSpy403 = vi.fn(async () => ({ ok: false, status: 403 } as Response));
    globalThis.fetch = fetchSpy403 as never;

    const res403 = await fetchDocumentPreviewBlob('doc_forbidden');
    expect(res403.ok).toBe(false);
    expect(res403.status).toBe(403);
    expect(res403.error).toContain('Unauthorized: You do not have permission to view this document.');
  });

  it('correctly handles 404 Not Found and blocks DELETING records upfront', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404 } as Response));
    globalThis.fetch = fetchSpy as never;

    const res404 = await fetchDocumentPreviewBlob('doc_not_found');
    expect(res404.ok).toBe(false);
    expect(res404.status).toBe(404);
    expect(res404.error).toContain('Document not found or has been removed.');

    const deletingHealthData = {
      id: 'doc_deleting_04',
      type: 'FILE',
      fileType: 'application/pdf',
      filePath: 'users/alice/deleting.pdf',
      status: 'DELETING',
    };

    // Download URL must be suppressed for records undergoing deletion
    expect(getAuthenticatedDocumentUrl(deletingHealthData)).toBeNull();
  });

  it('revokes temporary object URLs when unmounting or switching documents', async () => {
    const blobA = new Blob(['pdf A']);
    const blobB = new Blob(['pdf B']);

    const urlA = URL.createObjectURL(blobA);
    const urlB = URL.createObjectURL(blobB);

    // Simulate cleanup
    URL.revokeObjectURL(urlA);
    URL.revokeObjectURL(urlB);

    expect(revokedObjectUrls).toContain(urlA);
    expect(revokedObjectUrls).toContain(urlB);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(urlA);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(urlB);
  });

  it('cancels active HTTP request via AbortController when switching documents', async () => {
    const controller = new AbortController();
    let aborted = false;

    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    });
    globalThis.fetch = fetchSpy as never;

    const pendingPromise = fetchDocumentPreviewBlob('doc_pending', controller.signal);
    controller.abort();

    const result = await pendingPromise;
    expect(aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request aborted');
  });

  it('ensures no public Vercel Blob URL is generated or accepted in preview state', () => {
    const healthDataWithPublicUrl = {
      id: 'doc_legacy_public',
      type: 'FILE',
      fileType: 'application/pdf',
      filePath: 'https://store123.public.blob.vercel-storage.com/Alice_Blood_Test.pdf',
      status: 'COMPLETED',
    };

    const downloadUrl = getAuthenticatedDocumentUrl(healthDataWithPublicUrl);

    // Download URL must only route through the authenticated API endpoint
    expect(downloadUrl).toBe('/api/health-data/doc_legacy_public/file');
    expect(downloadUrl).not.toContain('vercel-storage.com');
  });
});
