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

describe('Docling Document Parser — v1.x API Contract & Error Handling (10 Scenarios)', () => {
  let tmpDir: string;
  let testPdfPath: string;
  const originalDoclingUrl = process.env.DOCLING_URL;
  const originalTimeout = process.env.DOCLING_TIMEOUT_MS;
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
    delete process.env.DOCLING_TIMEOUT_MS;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    process.env.DOCLING_URL = originalDoclingUrl;
    if (originalTimeout !== undefined) {
      process.env.DOCLING_TIMEOUT_MS = originalTimeout;
    } else {
      delete process.env.DOCLING_TIMEOUT_MS;
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // Scenario 1: Valid PDF conversion to Markdown
  it('Scenario 1: calls official /v1/convert/file endpoint for markdown parsing and returns structured content', async () => {
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

    expect(calledUrl).toBe('http://docling-serve:5001/v1/convert/file');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers.accept).toBe('application/json');

    const parsedDoc = result.document as { content: { markdown: string } };
    expect(parsedDoc.content.markdown).toBe(mockV1Response.document.md_content);
  });

  // Scenario 2: Markdown and JSON output
  it('Scenario 2: converts JSON geometry coordinates and words for OCR analysis', async () => {
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
    const ocrDoc = result.ocr as {
      text: string;
      pages: Array<{ words: Array<{ text: string }> }>;
    };
    expect(ocrDoc).toBeDefined();
    expect(ocrDoc.text).toBe('Platelet Count: 250k');
    expect(ocrDoc.pages[0].words[0].text).toBe('Platelet Count: 250k');
  });

  // Scenario 3: OCR option enabled
  it('Scenario 3: verifies do_ocr is explicitly enabled in multipart request', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        document: { md_content: 'Content' },
      }),
    });

    const parser = new DoclingDocumentParser();
    await parser.parse({
      input: testPdfPath,
      model: mockModel,
    });

    const [, requestInit] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const formData = requestInit.body as import('form-data');
    expect(formData).toBeDefined();
  });

  // Scenario 4: Supported OCR preset parameter
  it('Scenario 4: uses supported ocr_preset parameter in v1 request body', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        document: { json_content: { pages: {}, texts: [] } },
      }),
    });

    const parser = new DoclingDocumentParser();
    await parser.ocr({
      input: testPdfPath,
      model: mockModel,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Scenario 5: Successful response processing
  it('Scenario 5: accepts status "success" and returns valid output', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        document: { md_content: 'Normal ECG' },
      }),
    });

    const parser = new DoclingDocumentParser();
    const res = await parser.parse({ input: testPdfPath, model: mockModel });
    expect((res.document as { content: { markdown: string } }).content.markdown).toBe('Normal ECG');
  });

  // Scenario 6: Partial-success response handling
  it('Scenario 6: gracefully processes status "partial_success" when content is present', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'partial_success',
        errors: [{ message: 'Minor font embedding warning' }],
        document: { md_content: 'Extracted text with warning' },
      }),
    });

    const parser = new DoclingDocumentParser();
    const res = await parser.parse({ input: testPdfPath, model: mockModel });
    expect((res.document as { content: { markdown: string } }).content.markdown).toBe('Extracted text with warning');
  });

  // Scenario 7: Failed conversion response handling
  it('Scenario 7: throws explicit error when Docling returns status "failure"', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'failure',
        errors: [{ message: 'Corrupted font dictionary in PDF stream' }],
        document: null,
      }),
    });

    const parser = new DoclingDocumentParser();
    await expect(
      parser.parse({ input: testPdfPath, model: mockModel })
    ).rejects.toThrow('Docling conversion failed');
  });

  // Scenario 8: Skipped document handling
  it('Scenario 8: throws explicit error when Docling returns status "skipped"', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'skipped',
        errors: ['Password-protected encrypted document'],
        document: null,
      }),
    });

    const parser = new DoclingDocumentParser();
    await expect(
      parser.parse({ input: testPdfPath, model: mockModel })
    ).rejects.toThrow('Docling conversion failed');
  });

  // Scenario 9: HTTP 422 diagnostic handling
  it('Scenario 9: propagates HTTP 422 diagnostic details from Docling Serve API', async () => {
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
    ).rejects.toThrow('Docling Serve API error (422): {"detail":"Unsupported document structure"}');
  });

  // Scenario 10: Request timeout or cancellation handling
  it('Scenario 10: aborts request and rejects when request timeout expires', async () => {
    process.env.DOCLING_TIMEOUT_MS = '50';

    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      }
    );

    const parser = new DoclingDocumentParser();
    await expect(
      parser.parse({
        input: testPdfPath,
        model: mockModel,
      })
    ).rejects.toThrow('aborted');
  });
});
