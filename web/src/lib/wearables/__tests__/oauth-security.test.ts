import { describe, it, expect } from 'vitest';
import {
  generateOAuthState,
  consumeOAuthState,
  generatePKCE,
  encryptOAuthToken,
  decryptOAuthToken,
  validateProviderUrl,
  OAuthSecurityError,
} from '../oauth';

describe('Wearable OAuth Security & Token Lifecycle (Phase 7)', () => {
  describe('State Generation & Single-Use Anti-CSRF Consumption', () => {
    it('generates a 64-character hex state and validates it successfully', () => {
      const state = generateOAuthState({
        userId: 'user_oauth_01',
        providerId: 'fitbit',
        redirectUri: 'https://medimate.example.com/api/wearables/callback',
        codeVerifier: 'verifier_secret_123',
      });

      expect(state).toHaveLength(64);

      const meta = consumeOAuthState(state, 'user_oauth_01', 'fitbit');
      expect(meta.userId).toBe('user_oauth_01');
      expect(meta.providerId).toBe('fitbit');
      expect(meta.codeVerifier).toBe('verifier_secret_123');
    });

    it('rejects replaying a consumed state parameter (single-use anti-CSRF)', () => {
      const state = generateOAuthState({
        userId: 'user_replay_test',
        providerId: 'fitbit',
        redirectUri: 'https://medimate.example.com/api/wearables/callback',
      });

      // First consumption succeeds
      consumeOAuthState(state, 'user_replay_test', 'fitbit');

      // Second consumption must fail
      expect(() => consumeOAuthState(state, 'user_replay_test', 'fitbit')).toThrow(
        OAuthSecurityError
      );
    });

    it('rejects state if expected user or provider does not match', () => {
      const state = generateOAuthState({
        userId: 'user_legitimate',
        providerId: 'fitbit',
        redirectUri: 'https://medimate.example.com/api/wearables/callback',
      });

      expect(() => consumeOAuthState(state, 'user_attacker', 'fitbit')).toThrow(
        OAuthSecurityError
      );
    });
  });

  describe('PKCE Generation (RFC 7636)', () => {
    it('generates URL-safe code_verifier and SHA-256 code_challenge', () => {
      const { codeVerifier, codeChallenge } = generatePKCE();

      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(codeChallenge).toBeDefined();
      expect(codeChallenge).not.toContain('+');
      expect(codeChallenge).not.toContain('/');
      expect(codeChallenge).not.toContain('=');
    });
  });

  describe('Token Encryption at Rest (AES-256-GCM with AAD)', () => {
    it('encrypts token using authenticated AES-256-GCM bound to user and provider', () => {
      const rawToken = 'ya29.a0AfH6SMD_fitbit_secret_token_12345';
      const encrypted = encryptOAuthToken({
        token: rawToken,
        userId: 'patient_42',
        providerId: 'fitbit',
      });

      expect(encrypted).toMatch(/^v2:/);
      expect(encrypted).not.toContain(rawToken);

      const decrypted = decryptOAuthToken({
        encryptedToken: encrypted,
        userId: 'patient_42',
        providerId: 'fitbit',
      });

      expect(decrypted).toBe(rawToken);
    });

    it('fails closed if an attacker attempts to decrypt a token using a different user ID (AAD mismatch)', () => {
      const rawToken = 'secret_access_token_patient_A';
      const encrypted = encryptOAuthToken({
        token: rawToken,
        userId: 'patient_A',
        providerId: 'fitbit',
      });

      // Attempting to decrypt as patient_B must fail authenticated tag verification
      expect(() =>
        decryptOAuthToken({
          encryptedToken: encrypted,
          userId: 'patient_B',
          providerId: 'fitbit',
        })
      ).toThrow();
    });
  });

  describe('SSRF & URL Boundaries', () => {
    it('allows valid HTTPS provider destinations', () => {
      expect(validateProviderUrl('https://api.fitbit.com/oauth2/token')).toBe(
        'https://api.fitbit.com/oauth2/token'
      );
      expect(validateProviderUrl('https://api.ouraring.com/v2/usercollection')).toBe(
        'https://api.ouraring.com/v2/usercollection'
      );
    });

    it('blocks dangerous loopback or non-HTTP destinations', () => {
      expect(() => validateProviderUrl('http://169.254.169.254/latest/meta-data')).toThrow(
        OAuthSecurityError
      );
      expect(() => validateProviderUrl('file:///etc/passwd')).toThrow(OAuthSecurityError);
    });
  });
});
