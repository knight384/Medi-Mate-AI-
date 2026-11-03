/**
 * MediMate AI — Blocked Platform Adapters
 * Provides explicit, fail-closed stubs for platforms that require native mobile applications
 * (Apple HealthKit, Android Health Connect) or gated enterprise agreements (Garmin Health).
 */

import { BaseWearableConnector, IncrementalFetchResult } from './base';
import {
  NormalizedObservation,
  OAuthTokenResult,
  ProviderCapabilities,
  WearableProviderId,
} from '../types';

export class PlatformBlockedError extends Error {
  constructor(
    message: string,
    public readonly providerId: WearableProviderId,
    public readonly reason: string
  ) {
    super(message);
    this.name = 'PlatformBlockedError';
  }
}

/**
 * Apple HealthKit Adapter (BLOCKED)
 * Architectural constraint: Apple HealthKit requires an on-device native iOS application with
 * HealthKit entitlements (com.apple.developer.healthkit) and HKHealthStore.
 * Apple provides NO cloud REST API for user HealthKit records.
 */
export class AppleHealthKitConnector extends BaseWearableConnector {
  readonly providerId: WearableProviderId = 'apple_health';
  readonly displayName = 'Apple Health (HealthKit)';

  getCapabilities(): ProviderCapabilities {
    return {
      providerId: 'apple_health',
      displayName: this.displayName,
      platform: 'NATIVE_MOBILE',
      supportsOAuth: false,
      supportsPKCE: false,
      supportsWebhooks: false,
      supportsHistoricalBackfill: false,
      supportsIncrementalSync: false,
      supportedCategories: ['HEART', 'ACTIVITY', 'SLEEP', 'VITALS', 'BODY'],
      supportedMetrics: [
        'HEART_RATE',
        'RESTING_HEART_RATE',
        'HRV',
        'STEPS',
        'DISTANCE',
        'SLEEP_DURATION',
        'SPO2',
        'WEIGHT',
      ],
      integrationStatus: 'BLOCKED',
      statusReason:
        'Apple HealthKit requires a native iOS companion app with HealthKit entitlements. Direct browser web access is not supported by Apple.',
      requiredCredentials: ['APPLE_DEVELOPER_TEAM_ID', 'HEALTHKIT_ENTITLEMENT_PROFILE'],
    };
  }

  async getAuthorizationUrl(): Promise<string> {
    throw new PlatformBlockedError(
      'Apple Health cannot be authorized via browser OAuth. An iOS companion app is required.',
      'apple_health',
      'NATIVE_IOS_REQUIRED'
    );
  }

  async exchangeCode(): Promise<OAuthTokenResult> {
    throw new PlatformBlockedError(
      'Apple Health does not issue web OAuth authorization codes.',
      'apple_health',
      'NATIVE_IOS_REQUIRED'
    );
  }

  async refreshToken(): Promise<OAuthTokenResult> {
    throw new PlatformBlockedError(
      'Apple Health has no cloud refresh tokens.',
      'apple_health',
      'NATIVE_IOS_REQUIRED'
    );
  }

  async revokeToken(): Promise<boolean> {
    return false;
  }

  async fetchHistoricalData(): Promise<NormalizedObservation[]> {
    throw new PlatformBlockedError(
      'Cannot fetch Apple Health records without an on-device iOS bridge or native companion app.',
      'apple_health',
      'NATIVE_IOS_REQUIRED'
    );
  }

  async fetchIncrementalData(): Promise<IncrementalFetchResult> {
    throw new PlatformBlockedError(
      'Incremental HealthKit synchronization requires HKAnchoredObjectQuery in a native iOS application.',
      'apple_health',
      'NATIVE_IOS_REQUIRED'
    );
  }
}

/**
 * Android Health Connect Adapter (BLOCKED)
 * Architectural constraint: Google Health Connect operates as an on-device Android service
 * accessed via androidx.health.connect.client.HealthConnectClient.
 * Google provides NO direct cloud REST API for Health Connect user observations.
 */
export class HealthConnectConnector extends BaseWearableConnector {
  readonly providerId: WearableProviderId = 'health_connect';
  readonly displayName = 'Android Health Connect';

  getCapabilities(): ProviderCapabilities {
    return {
      providerId: 'health_connect',
      displayName: this.displayName,
      platform: 'NATIVE_MOBILE',
      supportsOAuth: false,
      supportsPKCE: false,
      supportsWebhooks: false,
      supportsHistoricalBackfill: false,
      supportsIncrementalSync: false,
      supportedCategories: ['HEART', 'ACTIVITY', 'SLEEP', 'VITALS', 'BODY'],
      supportedMetrics: [
        'HEART_RATE',
        'RESTING_HEART_RATE',
        'STEPS',
        'DISTANCE',
        'SLEEP_DURATION',
        'SPO2',
        'WEIGHT',
      ],
      integrationStatus: 'BLOCKED',
      statusReason:
        'Android Health Connect requires a native Android companion app using the Health Connect Jetpack client. Direct browser web access is not supported by Google.',
      requiredCredentials: ['ANDROID_PACKAGE_NAME', 'HEALTH_CONNECT_PERMISSIONS'],
    };
  }

  async getAuthorizationUrl(): Promise<string> {
    throw new PlatformBlockedError(
      'Health Connect cannot be authorized via web OAuth. An Android application is required.',
      'health_connect',
      'NATIVE_ANDROID_REQUIRED'
    );
  }

  async exchangeCode(): Promise<OAuthTokenResult> {
    throw new PlatformBlockedError(
      'Health Connect does not issue web OAuth authorization codes.',
      'health_connect',
      'NATIVE_ANDROID_REQUIRED'
    );
  }

  async refreshToken(): Promise<OAuthTokenResult> {
    throw new PlatformBlockedError(
      'Health Connect has no cloud refresh tokens.',
      'health_connect',
      'NATIVE_ANDROID_REQUIRED'
    );
  }

  async revokeToken(): Promise<boolean> {
    return false;
  }

  async fetchHistoricalData(): Promise<NormalizedObservation[]> {
    throw new PlatformBlockedError(
      'Cannot fetch Health Connect records without an on-device Android service.',
      'health_connect',
      'NATIVE_ANDROID_REQUIRED'
    );
  }

  async fetchIncrementalData(): Promise<IncrementalFetchResult> {
    throw new PlatformBlockedError(
      'Incremental Health Connect synchronization requires ChangesToken in an Android application.',
      'health_connect',
      'NATIVE_ANDROID_REQUIRED'
    );
  }
}

/**
 * Garmin Health API Adapter (BLOCKED)
 * Architectural constraint: Garmin Health API requires an enterprise partner approval contract,
 * OAuth 1.0a / 2.0 partner credentials, and ping/pull webhook infrastructure.
 * Self-service public API keys are not provided by Garmin.
 */
export class GarminConnector extends BaseWearableConnector {
  readonly providerId: WearableProviderId = 'garmin';
  readonly displayName = 'Garmin Health';

  getCapabilities(): ProviderCapabilities {
    const isPartnerApproved = Boolean(
      process.env.GARMIN_CONSUMER_KEY && process.env.GARMIN_CONSUMER_SECRET
    );

    return {
      providerId: 'garmin',
      displayName: this.displayName,
      platform: 'PARTNER_REST',
      supportsOAuth: true,
      supportsPKCE: false,
      supportsWebhooks: true,
      supportsHistoricalBackfill: true,
      supportsIncrementalSync: true,
      supportedCategories: ['HEART', 'ACTIVITY', 'SLEEP', 'VITALS'],
      supportedMetrics: [
        'HEART_RATE',
        'RESTING_HEART_RATE',
        'HRV',
        'STEPS',
        'DISTANCE',
        'SLEEP_DURATION',
        'SPO2',
      ],
      integrationStatus: isPartnerApproved ? 'LIVE-VERIFIED' : 'BLOCKED',
      statusReason: isPartnerApproved
        ? 'Configured with Garmin partner credentials'
        : 'Blocked pending official Garmin Health enterprise developer agreement and partner keys',
      requiredCredentials: ['GARMIN_CONSUMER_KEY', 'GARMIN_CONSUMER_SECRET'],
    };
  }

  async getAuthorizationUrl(): Promise<string> {
    if (!process.env.GARMIN_CONSUMER_KEY) {
      throw new PlatformBlockedError(
        'Garmin Health requires enterprise partner agreement approval and credentials (GARMIN_CONSUMER_KEY).',
        'garmin',
        'ENTERPRISE_PARTNER_REQUIRED'
      );
    }
    return 'https://connectapi.garmin.com/oauth-service/oauth/request_token';
  }

  async exchangeCode(): Promise<OAuthTokenResult> {
    throw new PlatformBlockedError(
      'Garmin Health token exchange requires registered enterprise credentials.',
      'garmin',
      'ENTERPRISE_PARTNER_REQUIRED'
    );
  }

  async refreshToken(): Promise<OAuthTokenResult> {
    throw new PlatformBlockedError(
      'Garmin OAuth 1.0a tokens do not use standard OAuth 2.0 refresh.',
      'garmin',
      'ENTERPRISE_PARTNER_REQUIRED'
    );
  }

  async revokeToken(): Promise<boolean> {
    return false;
  }

  async fetchHistoricalData(): Promise<NormalizedObservation[]> {
    throw new PlatformBlockedError(
      'Garmin Health data access is blocked pending enterprise partner credential verification.',
      'garmin',
      'ENTERPRISE_PARTNER_REQUIRED'
    );
  }

  async fetchIncrementalData(): Promise<IncrementalFetchResult> {
    throw new PlatformBlockedError(
      'Garmin incremental synchronization is blocked pending partner webhook endpoint verification.',
      'garmin',
      'ENTERPRISE_PARTNER_REQUIRED'
    );
  }
}
