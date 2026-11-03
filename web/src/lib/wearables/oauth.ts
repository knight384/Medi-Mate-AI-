/**
 * MediMate AI — Wearable OAuth Security & Token Management
 * State verification, PKCE generation, SSRF validation, and AES-256-GCM token encryption at rest.
 */

import crypto from 'crypto';
import { encrypt, decrypt } from '@/lib/encryption';
import { validateOutboundUrl, SSRFProtectionError } from '@/lib/security/ssrf-protection';
import { WearableProviderId } from './types';

export class OAuthSecurityError extends Error {
  constructor(message: string, public readonly code = 'OAUTH_SECURITY_ERROR') {
    super(message);
    this.name = 'OAuthSecurityError';
  }
}

// In-memory state registry with automatic expiration for CSRF state validation
interface StateMetadata {
  userId: string;
  providerId: WearableProviderId;
  codeVerifier?: string;
  redirectUri: string;
  expiresAt: number;
}

const stateStore = new Map<string, StateMetadata>();

/**
 * Generates cryptographically secure random state (32 bytes hex) and stores it with a 10-minute TTL.
 */
export function generateOAuthState(params: {
  userId: string;
  providerId: WearableProviderId;
  redirectUri: string;
  codeVerifier?: string;
  ttlSeconds?: number;
}): string {
  const state = crypto.randomBytes(32).toString('hex');
  const ttl = (params.ttlSeconds || 600) * 1000;

  stateStore.set(state, {
    userId: params.userId,
    providerId: params.providerId,
    codeVerifier: params.codeVerifier,
    redirectUri: params.redirectUri,
    expiresAt: Date.now() + ttl,
  });

  return state;
}

/**
 * Validates and consumes an OAuth state parameter. Throws if invalid or expired (single-use anti-CSRF).
 */
export function consumeOAuthState(
  state: string,
  expectedUserId: string,
  expectedProviderId: WearableProviderId
): StateMetadata {
  const metadata = stateStore.get(state);

  if (!metadata) {
    throw new OAuthSecurityError('Invalid or expired OAuth state parameter', 'INVALID_STATE');
  }

  // Remove immediately (single-use token)
  stateStore.delete(state);

  if (Date.now() > metadata.expiresAt) {
    throw new OAuthSecurityError('OAuth state parameter has expired', 'STATE_EXPIRED');
  }

  if (metadata.userId !== expectedUserId) {
    throw new OAuthSecurityError('OAuth state user mismatch', 'USER_MISMATCH');
  }

  if (metadata.providerId !== expectedProviderId) {
    throw new OAuthSecurityError('OAuth state provider mismatch', 'PROVIDER_MISMATCH');
  }

  return metadata;
}

/**
 * Generates a PKCE code_verifier (random 43-128 chars) and SHA-256 base64url code_challenge.
 */
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // 64 random bytes -> ~86 chars base64url
  const verifierBuffer = crypto.randomBytes(64);
  const codeVerifier = verifierBuffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const challengeHash = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest();
  const codeChallenge = challengeHash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return { codeVerifier, codeChallenge };
}

/**
 * Encrypts an access or refresh token using AES-256-GCM, cryptographically binding AAD to userId + providerId.
 */
export function encryptOAuthToken(params: {
  token: string;
  userId: string;
  providerId: WearableProviderId;
}): string {
  const aad = `${params.userId}:${params.providerId}`;
  return encrypt(params.token, { aad });
}

/**
 * Decrypts a stored token, strictly verifying authenticated AES-256-GCM tag and AAD binding.
 */
export function decryptOAuthToken(params: {
  encryptedToken: string;
  userId: string;
  providerId: WearableProviderId;
}): string {
  const aad = `${params.userId}:${params.providerId}`;
  return decrypt(params.encryptedToken, { aad });
}

/**
 * Validates external redirect URIs and provider endpoints against SSRF rules.
 */
export function validateProviderUrl(urlStr: string): string {
  try {
    const parsed = validateOutboundUrl(urlStr);
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      throw new OAuthSecurityError('OAuth endpoints must use HTTPS', 'INSECURE_PROTOCOL');
    }
    return parsed.toString();
  } catch (err: any) {
    if (err instanceof OAuthSecurityError) throw err;
    if (err instanceof SSRFProtectionError) {
      throw new OAuthSecurityError(err.message, 'SSRF_BLOCKED');
    }
    throw new OAuthSecurityError(`Malformed URL: ${err.message}`, 'MALFORMED_URL');
  }
}
