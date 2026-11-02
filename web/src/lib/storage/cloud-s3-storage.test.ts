import { describe, it, expect } from 'vitest';
import { CloudObjectStorageDriver, CloudStorageBlockedError, assertTenantKey } from './cloud-driver';
import { StorageSecurityError } from './local-driver';

describe('Enterprise Cloud Object Storage Driver (AWS S3 Compatible)', () => {
  it('enforces multi-tenant isolation via assertTenantKey', () => {
    // Valid tenant keys
    expect(() => assertTenantKey('users/user_101/doc.pdf')).not.toThrow();
    expect(() => assertTenantKey('tenants/clinic_west/patient_42.pdf')).not.toThrow();

    // Prohibited root-level and non-isolated keys
    expect(() => assertTenantKey('doc.pdf')).toThrow(StorageSecurityError);
    expect(() => assertTenantKey('public/doc.pdf')).toThrow(StorageSecurityError);
    expect(() => assertTenantKey('storage/documents/doc.pdf')).toThrow(StorageSecurityError);
    expect(() => assertTenantKey('users/../etc/passwd')).toThrow(StorageSecurityError);
  });

  it('fails closed when S3 credentials are not configured', async () => {
    const unconfiguredDriver = new CloudObjectStorageDriver({
      bucket: 'unconfigured-bucket',
    });

    expect(unconfiguredDriver.isConfigured()).toBe(false);
    await expect(
      unconfiguredDriver.writeStream('users/patient_1/chart.pdf', Buffer.from('data'))
    ).rejects.toThrow(CloudStorageBlockedError);

    await expect(unconfiguredDriver.readStream('users/patient_1/chart.pdf')).rejects.toThrow(
      CloudStorageBlockedError
    );

    await expect(unconfiguredDriver.delete('users/patient_1/chart.pdf')).rejects.toThrow(
      CloudStorageBlockedError
    );
  });

  it('manages complete document lifecycle in simulated cloud storage', async () => {
    const simulatedStore = new Map();
    const driver = new CloudObjectStorageDriver({
      bucket: 'test-medimate-cloud',
      region: 'us-east-1',
      simulatedStorage: simulatedStore,
    });

    await driver.init();
    expect(driver.isConfigured()).toBe(true);

    const storageKey = 'users/patient_s3_test/report.pdf';
    const originalBytes = Buffer.from('%PDF-1.7 Simulated Encrypted Cloud Object Payload');

    // 1. Write stream
    const metadata = await driver.writeStream(storageKey, originalBytes);
    expect(metadata.storageKey).toBe(storageKey);
    expect(metadata.size).toBe(originalBytes.length);
    expect(metadata.mimeType).toBe('application/pdf');

    // 2. Exists
    expect(await driver.exists(storageKey)).toBe(true);
    expect(await driver.exists('users/patient_s3_test/nonexistent.pdf')).toBe(false);

    // 3. Read stream
    const readResult = await driver.readStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of readResult.stream) {
      chunks.push(Buffer.from(chunk));
    }
    const retrievedBytes = Buffer.concat(chunks);
    expect(retrievedBytes.equals(originalBytes)).toBe(true);

    // 4. Read buffer
    const buffer = await driver.readBuffer(storageKey);
    expect(buffer.equals(originalBytes)).toBe(true);

    // 5. Presigned URL generation
    const url = await driver.generatePresignedDownloadUrl(storageKey, 300);
    expect(url).toContain('https://test-medimate-cloud.s3.us-east-1.amazonaws.com/');
    expect(url).toContain('X-Amz-Expires=300');

    // 6. Delete
    const deleted = await driver.delete(storageKey);
    expect(deleted).toBe(true);
    expect(await driver.exists(storageKey)).toBe(false);
  });

  it('handles simulated S3 HTTP network retries on 500 errors', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount < 2) {
        return { ok: false, status: 500, statusText: 'InternalServerError' } as Response;
      }
      return { ok: true, status: 200 } as Response;
    };

    const driver = new CloudObjectStorageDriver({
      bucket: 'retry-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'SECRET_TEST',
      fetchFn: mockFetch,
    });

    const meta = await driver.writeStream('users/patient_retry/file.pdf', Buffer.from('test-content'));
    expect(meta.size).toBe(12);
    expect(callCount).toBe(2); // Retried once on 500 error
  });
});
