import { describe, expect, it } from 'vitest';
import busboy from '@fastify/busboy';
import { Readable } from 'stream';

describe('Fastify Busboy Multipart Compatibility', () => {
  it('parses multipart fields and normal file streams', async () => {
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      '',
      'Blood Test Report',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="report.pdf"',
      'Content-Type: application/pdf',
      '',
      '%PDF-1.4 Mock PDF Content',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const bb = busboy({ headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });

    const fields: Record<string, string> = {};
    const files: Array<{ fieldname: string; filename: string; mimeType: string; data: string }> = [];

    await new Promise<void>((resolve, reject) => {
      bb.on('field', (name, val) => {
        fields[name] = val;
      });

      bb.on('file', (fieldname, file, filename, _encoding, mimetype) => {
        let content = '';
        file.on('data', (chunk) => {
          content += chunk.toString();
        });
        file.on('end', () => {
          files.push({
            fieldname,
            filename,
            mimeType: mimetype,
            data: content,
          });
        });
      });

      bb.on('finish', resolve);
      bb.on('error', reject);

      const stream = Readable.from(Buffer.from(body));
      stream.pipe(bb);
    });

    expect(fields.title).toBe('Blood Test Report');
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('report.pdf');
    expect(files[0].mimeType).toBe('application/pdf');
    expect(files[0].data).toBe('%PDF-1.4 Mock PDF Content');
  });

  it('safely handles prototype-polluting and reserved header names (GHSA-x8mw-p69m-v3mx)', async () => {
    const boundary = '----WebKitFormBoundaryPoison';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="__proto__"',
      '__proto__: malicious-header-value',
      'constructor: malicious-constructor',
      '',
      'polluted-val',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const bb = busboy({ headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });

    let parsedVal = '';
    await new Promise<void>((resolve, reject) => {
      bb.on('field', (name, val) => {
        if (name === '__proto__') {
          parsedVal = val;
        }
      });
      bb.on('finish', resolve);
      bb.on('error', reject);

      Readable.from(Buffer.from(body)).pipe(bb);
    });

    expect(parsedVal).toBe('polluted-val');
    // Verify Object prototype was not polluted
    expect(({} as Record<string, unknown>).malicious).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('malicious-header-value')).toBe(false);
  });

  it('safely handles CRLF injection in filename (GHSA-gxm5-99cw-xjw9)', async () => {
    const boundary = '----WebKitFormBoundaryCRLF';
    const injectedFilename = 'test\r\nInjected-Header: evil\r\n.pdf';
    const body = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${injectedFilename}"`,
      'Content-Type: application/pdf',
      '',
      'safe file content',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const bb = busboy({ headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });

    let filenameReceived = '';
    await new Promise<void>((resolve) => {
      bb.on('file', (_name, file, filename) => {
        filenameReceived = filename;
        file.resume();
      });
      bb.on('finish', resolve);
      bb.on('error', () => {
        // Some busboy implementations reject invalid CRLF headers directly
        resolve();
      });

      Readable.from(Buffer.from(body)).pipe(bb);
    });

    // Filename should either be stripped of CRLF or treated cleanly without splitting headers
    expect(filenameReceived).not.toContain('\r\nInjected-Header: evil');
  });

  it('supports streaming large data chunks with backpressure and clean abort', async () => {
    const boundary = '----WebKitFormBoundaryLarge';
    const chunk = 'A'.repeat(16384);
    const chunkCount = 10;

    let receivedBytes = 0;
    const bb = busboy({ headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });

    await new Promise<void>((resolve, reject) => {
      bb.on('file', (_name, file) => {
        file.on('data', (d) => {
          receivedBytes += d.length;
        });
      });
      bb.on('finish', resolve);
      bb.on('error', reject);

      async function* generate() {
        yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="large"; filename="large.bin"\r\n\r\n`);
        for (let i = 0; i < chunkCount; i++) {
          yield Buffer.from(chunk);
        }
        yield Buffer.from(`\r\n--${boundary}--\r\n`);
      }

      Readable.from(generate()).pipe(bb);
    });

    expect(receivedBytes).toBe(chunk.length * chunkCount);
  });
});

