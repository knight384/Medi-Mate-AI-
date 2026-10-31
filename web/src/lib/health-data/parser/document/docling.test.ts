import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { DoclingDocumentParser } from './docling';
import { DocumentParserModel } from './base-document';
import fetch from 'node-fetch';

vi.mock('node-fetch', () => {
  return {
    default: vi.fn(),
  };
});

describe('Docling Document Parser — v1.x API Contract & Error Handling', () => {
  let tmpDir: string;
  let testPdfPath: string;
  const originalDoclingUrl = process.env.DOCLING_URL;
  const mockModel: DocumentParserModel = {
    id: 'document-parse',
    name: 'Document Parse',
  };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `docling-test-${crypto.randomUUID()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    testPdfPath = path.join(tmpDir, 'sample.pdf');
    await fsp.writeFile(testPdfPath, Buffer.from('%PDF-1.4 Mock Clinical Note'));
    process.env.DOCLING_URL = 'http://docling-serve:5001';
    vi.clearAllMocks();
  });

  afterEach(async () => {
    process.env.DOCLING_URL = originalDoclingUrl;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('calls official /v1/convert/file endpoint for markdown parsing and returns structured content', async () => {
    const mockV1Response = {
      status: 'success',
      document: {
        md_content: '# Medical Assessment\n\nPatient shows normal sinus rhythm.',
      },
    };

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockV1Response,
    });

    const parser = new DoclingDocumentParser();
    const result = await parser.parse({
      input: testPdfPath,
      model: mockModel,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, requestInit] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];

    // Must call official v1 endpoint, never deprecated /v1alpha/
    expect(calledUrl).toBe('http://docling-serve:5001/v1/convert/file');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers.accept).toBe('application/json');

    const parsedDoc = result.document as { content: { markdown: string } };
    expect(parsedDoc.content.markdown).toBe(mockV1Response.document.md_content);
  });

  it('calls official /v1/convert/file endpoint for OCR and converts JSON geometry coordinates', async () => {
    const mockV1OcrResponse = {
      status: 'success',
      document: {
        json_content: {
          pages: {
            '1': {
              size: { width: 612, height: 792 },
            },
          },
          texts: [
            {
              text: 'Platelet Count: 250k',
              prov: [
                {
                  page_no: 1,
                  bbox: { l: 50, t: 700, r: 200, b: 680 },
                },
              ],
            },
          ],
        },
      },
    };

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockV1OcrResponse,
    });

    const parser = new DoclingDocumentParser();
    const result = await parser.ocr({
      input: testPdfPath,
      model: mockModel,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe('http://docling-serve:5001/v1/convert/file');

    const ocrDoc = result.ocr as {
      text: string;
      pages: Array<{ words: Array<{ text: string }> }>;
    };
    expect(ocrDoc).toBeDefined();
    expect(ocrDoc.text).toBe('Platelet Count: 250k');
    expect(ocrDoc.pages[0].words[0].text).toBe('Platelet Count: 250k');
  });

  it('handles Docling Serve HTTP error responses with status and diagnostic details', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: async () => '{"detail":"Unsupported document structure"}',
    });

    const parser = new DoclingDocumentParser();
    await expect(
      parser.parse({
        input: testPdfPath,
        model: mockModel,
      })
    ).rejects.toThrow('Docling Serve API error (422)');
  });

  it('throws descriptive error if Docling v1 response is missing required document payload', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'partial_success', document: null }),
    });

    const parser = new DoclingDocumentParser();
    await expect(
      parser.ocr({
        input: testPdfPath,
        model: mockModel,
      })
    ).rejects.toThrow('Docling Serve v1 API response missing document.json_content');
  });
});
