import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FitbitConnector } from '../connectors/fitbit';
import { OuraConnector } from '../connectors/oura';
import { listSupportedProviders } from '../registry';

describe('Wearable Connector Contracts & Capability Profiles (Phase 7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers all required wearable providers in the central registry', () => {
    const providers = listSupportedProviders();
    const providerIds = providers.map((p) => p.providerId);

    expect(providerIds).toContain('fitbit');
    expect(providerIds).toContain('oura');
    expect(providerIds).toContain('apple_health');
    expect(providerIds).toContain('health_connect');
    expect(providerIds).toContain('garmin');
  });

  describe('Fitbit Connector', () => {
    const fitbit = new FitbitConnector({
      clientId: 'test_fitbit_client',
      clientSecret: 'test_fitbit_secret',
    });

    it('reports official capability profile with OAuth 2.0 PKCE support', () => {
      const caps = fitbit.getCapabilities();

      expect(caps.providerId).toBe('fitbit');
      expect(caps.platform).toBe('CLOUD_API');
      expect(caps.supportsOAuth).toBe(true);
      expect(caps.supportsPKCE).toBe(true);
      expect(caps.supportedCategories).toContain('HEART');
      expect(caps.supportedCategories).toContain('ACTIVITY');
      expect(caps.supportedCategories).toContain('SLEEP');
      expect(caps.supportedCategories).toContain('VITALS');
    });

    it('builds an authorization URL containing requested scopes, state, and PKCE challenge', async () => {
      const authUrl = await fitbit.getAuthorizationUrl({
        state: 'csrf_state_xyz_123',
        codeChallenge: 'pkce_challenge_abc_456',
        categories: ['HEART', 'ACTIVITY', 'SLEEP'],
        redirectUri: 'https://medimate.example.com/api/wearables/callback',
      });

      const parsed = new URL(authUrl);
      expect(parsed.origin).toBe('https://www.fitbit.com');
      expect(parsed.pathname).toBe('/oauth2/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('test_fitbit_client');
      expect(parsed.searchParams.get('state')).toBe('csrf_state_xyz_123');
      expect(parsed.searchParams.get('code_challenge')).toBe('pkce_challenge_abc_456');
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');

      const scope = parsed.searchParams.get('scope') || '';
      expect(scope).toContain('heartrate');
      expect(scope).toContain('activity');
      expect(scope).toContain('sleep');
    });

    it('exchanges authorization code for access and refresh tokens', async () => {
      const tokenResult = await fitbit.exchangeCode({
        code: 'mock_code_123',
        codeVerifier: 'mock_verifier_123',
        redirectUri: 'https://medimate.example.com/api/wearables/callback',
      });

      expect(tokenResult.accessToken).toBeDefined();
      expect(tokenResult.refreshToken).toBeDefined();
      expect(tokenResult.tokenType).toBe('Bearer');
      expect(tokenResult.expiresInSeconds).toBeGreaterThan(0);
    });

    it('refreshes expired access token safely', async () => {
      const refreshed = await fitbit.refreshToken('fitbit_refresh_mock_existing');
      expect(refreshed.accessToken).toBeDefined();
      expect(refreshed.tokenType).toBe('Bearer');
    });

    it('fetches calibrated synthetic observations in test environment', async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 86400000);

      const obs = await fitbit.fetchHistoricalData('user_fitbit_test', {
        accessToken: 'fitbit_access_mock_123',
        startDate: threeDaysAgo,
        endDate: now,
        categories: ['HEART', 'ACTIVITY', 'SLEEP', 'VITALS'],
      });

      expect(obs.length).toBeGreaterThan(0);
      const metrics = obs.map((o) => o.metric);
      expect(metrics).toContain('RESTING_HEART_RATE');
      expect(metrics).toContain('STEPS');
      expect(metrics).toContain('DISTANCE');
      expect(metrics).toContain('SLEEP_DURATION');
      expect(metrics).toContain('SPO2');
    });
  });

  describe('Oura Connector', () => {
    const oura = new OuraConnector({
      clientId: 'test_oura_client',
      clientSecret: 'test_oura_secret',
    });

    it('reports official Oura Cloud API v2 capability profile', () => {
      const caps = oura.getCapabilities();

      expect(caps.providerId).toBe('oura');
      expect(caps.platform).toBe('CLOUD_API');
      expect(caps.supportsOAuth).toBe(true);
      expect(caps.supportedCategories).toContain('HEART');
      expect(caps.supportedCategories).toContain('SLEEP');
      expect(caps.supportedMetrics).toContain('HRV');
      expect(caps.supportedMetrics).toContain('RESTING_HEART_RATE');
      expect(caps.supportedMetrics).toContain('SLEEP_DURATION');
      expect(caps.supportedMetrics).toContain('BODY_TEMPERATURE');
    });

    it('builds an authorization URL with Oura v2 scopes', async () => {
      const authUrl = await oura.getAuthorizationUrl({
        state: 'oura_state_123',
        categories: ['HEART', 'SLEEP'],
        redirectUri: 'https://medimate.example.com/api/wearables/callback',
      });

      const parsed = new URL(authUrl);
      expect(parsed.origin).toBe('https://cloud.ouraring.com');
      expect(parsed.pathname).toBe('/oauth/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('test_oura_client');
      expect(parsed.searchParams.get('state')).toBe('oura_state_123');
      expect(parsed.searchParams.get('scope')).toContain('daily');
    });

    it('fetches calibrated nighttime HRV and sleep duration observations', async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 86400000);

      const obs = await oura.fetchHistoricalData('user_oura_test', {
        accessToken: 'oura_access_mock_123',
        startDate: threeDaysAgo,
        endDate: now,
        categories: ['HEART', 'SLEEP', 'VITALS'],
      });

      expect(obs.length).toBeGreaterThan(0);
      const metrics = obs.map((o) => o.metric);
      expect(metrics).toContain('RESTING_HEART_RATE');
      expect(metrics).toContain('HRV');
      expect(metrics).toContain('SLEEP_DURATION');
      expect(metrics).toContain('SLEEP_EFFICIENCY');
      expect(metrics).toContain('BODY_TEMPERATURE');
    });
  });
});
