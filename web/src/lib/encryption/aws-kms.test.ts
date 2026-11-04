import { describe, it, expect } from 'vitest';
import { AWSKMSClient, computeAwsSigV4Headers } from './aws-kms-client';
import { CloudKMSBlockedError } from './key-providers';
import { LocalSyntheticKMSAdapter, encryptEnvelope, decryptEnvelope, rewrapEnvelope } from './kms-adapter';

describe('AWS KMS Integration & Envelope Key Lifecycle', () => {
  it('computes compliant AWS Signature Version 4 headers', () => {
    const fixedDate = new Date('2026-11-02T12:00:00Z');
    const endpoint = new URL('https://kms.us-east-1.amazonaws.com/');

    const headers = computeAwsSigV4Headers({
      method: 'POST',
      endpoint,
      region: 'us-east-1',
      service: 'kms',
      accessKeyId: 'TEST_MOCK_AWS_ACCESS_KEY_ID_01',
      secretAccessKey: 'TEST_MOCK_AWS_SECRET_KEY_FOR_SIGV4_CALCULATION',
      amzTarget: 'TrentService.GenerateDataKey',
      body: JSON.stringify({ KeyId: 'test-arn', KeySpec: 'AES_256' }),
      date: fixedDate,
    });

    expect(headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(headers['host']).toBe('kms.us-east-1.amazonaws.com');
    expect(headers['x-amz-date']).toBe('20261102T120000Z');
    expect(headers['x-amz-target']).toBe('TrentService.GenerateDataKey');
    expect(headers.Authorization).toContain('AWS4-HMAC-SHA256');
    expect(headers.Authorization).toContain('Credential=TEST_MOCK_AWS_ACCESS_KEY_ID_01/20261102/us-east-1/kms/aws4_request');
    expect(headers.Authorization).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-target');
  });

  it('fails closed with CloudKMSBlockedError when AWS KMS credentials are unconfigured', async () => {
    const client = new AWSKMSClient({
      keyArn: undefined,
      accessKeyId: undefined,
      secretAccessKey: undefined,
    });

    expect(client.isConfigured()).toBe(false);
    await expect(client.generateDataKey('test-key')).rejects.toThrow(CloudKMSBlockedError);
    await expect(client.decryptDataKey('cipher-blob')).rejects.toThrow(CloudKMSBlockedError);
  });

  it('successfully generates and decrypts DEKs using mocked AWS KMS endpoint', async () => {
    let capturedTarget = '';
    const mockFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      capturedTarget = headers['x-amz-target'];

      if (capturedTarget === 'TrentService.GenerateDataKey') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Plaintext: Buffer.alloc(32, 0x42).toString('base64'),
            CiphertextBlob: Buffer.from('ENCRYPTED_DEK_BLOB').toString('base64'),
            KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-uuid',
          }),
        } as unknown as Response;
      }

      if (capturedTarget === 'TrentService.Decrypt') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Plaintext: Buffer.alloc(32, 0x42).toString('base64'),
            KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-uuid',
          }),
        } as unknown as Response;
      }

      return { ok: false, status: 400, text: async () => 'Error' } as unknown as Response;
    };

    const client = new AWSKMSClient({
      keyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-uuid',
      region: 'us-east-1',
      accessKeyId: 'MOCK_KEY_ID',
      secretAccessKey: 'MOCK_SECRET_KEY',
      fetchFn: mockFetch,
    });

    expect(client.isConfigured()).toBe(true);

    const generated = await client.generateDataKey();
    expect(generated.plaintextKey.length).toBe(32);
    expect(generated.encryptedKeyCiphertext).toBe(Buffer.from('ENCRYPTED_DEK_BLOB').toString('base64'));

    const decrypted = await client.decryptDataKey(generated.encryptedKeyCiphertext);
    expect(decrypted.plaintextKey.length).toBe(32);
    expect(decrypted.plaintextKey.equals(generated.plaintextKey)).toBe(true);
  });

  it('performs zero-downtime KEK envelope rotation using rewrapEnvelope', async () => {
    const syntheticKms = new LocalSyntheticKMSAdapter();
    const payload = Buffer.from('Sensitive Clinical Cardiology Assessment');

    // 1. Initial envelope encryption under kek-v1
    const envelope = await encryptEnvelope(payload, syntheticKms, 'kek-v1', { tenant: 'hospital_a' });
    expect(envelope.keyVersion).toBe('kek-v1');

    // 2. Rotate master KEK in KMS
    syntheticKms.rotateMasterKey(Buffer.alloc(32, 0x99), 'kek-v2');

    // 3. Re-wrap the existing envelope without decrypting or re-encrypting the payload data
    const rewrapped = await rewrapEnvelope(envelope, syntheticKms, 'kek-v2', { tenant: 'hospital_a' });
    expect(rewrapped.keyVersion).toBe('kek-v2');
    expect(rewrapped.ciphertext).toBe(envelope.ciphertext); // Payload ciphertext untouched!
    expect(rewrapped.nonce).toBe(envelope.nonce);
    expect(rewrapped.authTag).toBe(envelope.authTag);
    expect(rewrapped.encryptedDataKey).not.toBe(envelope.encryptedDataKey); // DEK re-wrapped!

    // 4. Decrypt rewrapped envelope and verify exact data matches original
    const decryptedPayload = await decryptEnvelope(rewrapped, syntheticKms);
    expect(decryptedPayload.equals(payload)).toBe(true);
  });
});
