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

export interface VerifiedAssertion {
  userId: string;
  tenantId: string;
  operation: string;
  resourceId?: string | null;
  purpose?: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Validates and decodes an internal HMAC-SHA256 service assertion token.
 * Rejects expired, tampered, or invalid tokens fail-closed.
 */
export function verifyInternalServiceAssertion(
  token: string,
  secret?: string
): VerifiedAssertion {
  const env = getEnv();
  const effectiveSecret = secret || env.INTERNAL_SERVICE_SECRET;
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid assertion token format');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const hmac = crypto.createHmac('sha256', effectiveSecret);
  hmac.update(signingInput);
  const expectedSigB64 = base64UrlEncode(hmac.digest());

  if (!crypto.timingSafeEqual(Buffer.from(signatureB64), Buffer.from(expectedSigB64))) {
    throw new Error('Assertion signature verification failed');
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('Assertion token expired');
  }

  return {
    userId: payload.sub,
    tenantId: payload.tenantId || payload.sub,
    operation: payload.op,
    resourceId: payload.resourceId,
    purpose: payload.purpose,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}
