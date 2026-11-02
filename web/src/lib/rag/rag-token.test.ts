import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createInternalServiceAssertion } from './rag-token';

describe('RAG Service Assertion Token Generator', () => {
  it('generates a valid 3-part HMAC-SHA256 assertion token', () => {
    const token = createInternalServiceAssertion({
      userId: 'usr_test_101',
      tenantId: 'tenant_clinic_a',
      operation: 'QUERY',
      purpose: 'CLINICAL_RAG_RETRIEVAL',
      secret: 'secret-key-at-least-32-chars-long!',
    });

    expect(token).toBeDefined();
    const parts = token.split('.');
    expect(parts.length).toBe(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('INTERNAL_ASSERTION');

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    expect(payload.sub).toBe('usr_test_101');
    expect(payload.tenantId).toBe('tenant_clinic_a');
    expect(payload.op).toBe('QUERY');
    expect(payload.iss).toBe('medimate-web');
    expect(payload.aud).toBe('medimate-rag');
    expect(payload.nonce).toBeDefined();
    expect(payload.exp).toBeGreaterThan(payload.iat);

    // Cryptographic signature check
    const signingInput = `${parts[0]}.${parts[1]}`;
    const expectedSig = crypto
      .createHmac('sha256', 'secret-key-at-least-32-chars-long!')
      .update(signingInput)
      .digest('base64url');
    expect(parts[2]).toBe(expectedSig);
  });

  it('binds resourceId when provided', () => {
    const token = createInternalServiceAssertion({
      userId: 'usr_test_101',
      operation: 'INGEST',
      resourceId: 'doc_sample_77',
      secret: 'secret-key-at-least-32-chars-long!',
    });
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    expect(payload.resourceId).toBe('doc_sample_77');
    expect(payload.op).toBe('INGEST');
  });
});
