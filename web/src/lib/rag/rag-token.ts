import crypto from 'node:crypto';
import { getEnv } from '@/lib/config/env';

export interface ServiceAssertionOptions {
  userId: string;
  tenantId?: string;
  operation: 'INGEST' | 'QUERY' | 'DELETE' | 'READINESS';
  resourceId?: string;
  purpose?: string;
  expiresInSeconds?: number;
  secret?: string;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * Generates an internal cryptographic service assertion token (HMAC-SHA256).
 * Establishes the authenticated internal trust boundary between Next.js and the Python RAG microservice.
 */
export function createInternalServiceAssertion(options: ServiceAssertionOptions): string {
  const env = getEnv();
  const secret = options.secret || env.INTERNAL_SERVICE_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 60;

  const header = {
    alg: 'HS256',
    typ: 'INTERNAL_ASSERTION',
  };

  const payload = {
    sub: options.userId,
    tenantId: options.tenantId || options.userId,
    op: options.operation,
    resourceId: options.resourceId ?? null,
    purpose: options.purpose || 'CLINICAL_RAG_RETRIEVAL',
    iss: 'medimate-web',
    aud: 'medimate-rag',
    iat: now,
    exp: now + expiresIn,
    nonce: crypto.randomBytes(16).toString('hex'),
  };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf-8'));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const signingInput = `${headerB64}.${payloadB64}`;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(signingInput);
  const signatureB64 = base64UrlEncode(hmac.digest());

  return `${signingInput}.${signatureB64}`;
}
