/**
 * MediMate AI — Wearable Integration & Continuous Health Data Intelligence Types
 * Provider-agnostic interfaces, normalized metric definitions, and capability contracts.
 */

export type WearableProviderId =
  | 'fitbit'
  | 'oura'
  | 'whoop'
  | 'garmin'
  | 'apple_health'
  | 'health_connect';

export type HealthDataCategory =
  | 'HEART'
  | 'ACTIVITY'
  | 'SLEEP'
  | 'VITALS'
  | 'BODY';

export type HealthMetricType =
  // Heart
  | 'HEART_RATE'
  | 'RESTING_HEART_RATE'
  | 'HRV'
  | 'ECG_RECORDING'
  // Activity
  | 'STEPS'
  | 'DISTANCE'
  | 'ACTIVE_CALORIES'
  | 'ACTIVITY_DURATION'
  | 'EXERCISE_SESSION'
  // Sleep
  | 'SLEEP_DURATION'
  | 'SLEEP_STAGE'
  | 'SLEEP_EFFICIENCY'
  | 'SLEEP_RESPIRATORY_RATE'
  // Vitals & Physiological
  | 'SPO2'
  | 'BLOOD_PRESSURE_SYSTOLIC'
  | 'BLOOD_PRESSURE_DIASTOLIC'
  | 'BODY_TEMPERATURE'
  | 'RESPIRATORY_RATE'
  // Body
  | 'WEIGHT'
  | 'BMI';

export type DataQualityClassification =
  | 'MEASURED'      // Directly measured by hardware sensor
  | 'DERIVED'       // Computed or algorithmic aggregate from provider
  | 'MANUAL'        // User self-reported entry
  | 'QUESTIONABLE';  // Out of physiological boundary or flagged

export type IntegrationStatus =
  | 'IMPLEMENTED'     // Fully implemented with mock & contract tests
  | 'MOCK-TESTED'     // Validated against simulated provider responses
  | 'LIVE-VERIFIED'   // Validated against live developer environment with real credentials
  | 'BLOCKED'         // Blocked due to platform requirements (e.g. native mobile app needed)
  | 'NOT-IMPLEMENTED'; // Planned for future phase

export interface ProviderCapabilities {
  providerId: WearableProviderId;
  displayName: string;
  platform: 'CLOUD_API' | 'NATIVE_MOBILE' | 'PARTNER_REST';
  supportsOAuth: boolean;
  supportsPKCE: boolean;
  supportsWebhooks: boolean;
  supportsHistoricalBackfill: boolean;
  supportsIncrementalSync: boolean;
  supportedCategories: HealthDataCategory[];
  supportedMetrics: HealthMetricType[];
  integrationStatus: IntegrationStatus;
  statusReason?: string;
  requiredCredentials: string[];
  rateLimits?: {
    requestsPerMinute?: number;
    requestsPerHour?: number;
    dailyCap?: number;
  };
}

export interface NormalizedObservation {
  id: string; // Deterministic sha256 or cuid
  userId: string;
  tenantId?: string;
  providerId: WearableProviderId;
  externalRecordId: string;
  metric: HealthMetricType;
  category: HealthDataCategory;
  value: number;
  unit: string;
  rawSourceValue?: number;
  rawSourceUnit?: string;
  startTime: string; // ISO 8601 UTC
  endTime: string;   // ISO 8601 UTC
  timezoneOffsetMinutes?: number;
  dataQuality: DataQualityClassification;
  deviceModel?: string;
  metadata?: Record<string, any>;
  syncedAt: string; // ISO 8601 UTC
}

export interface MetricAggregation {
  metric: HealthMetricType;
  unit: string;
  count: number;
  avg?: number;
  min?: number;
  max?: number;
  total?: number;
  latest?: number;
  latestTimestamp?: string;
  dataQuality: DataQualityClassification;
}

export interface WearableSummary {
  id: string;
  userId: string;
  tenantId?: string;
  providerId: WearableProviderId;
  period: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  metrics: Record<string, MetricAggregation>;
  totalObservations: number;
  dataQuality: DataQualityClassification;
  calculationMethod: string;
  missingDataNotes?: string[];
  provenance: {
    provider: WearableProviderId;
    deviceModel?: string;
    generatedAt: string;
    underlyingObservationIds: string[];
  };
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  tokenType: string;
  scope: string;
  externalUserId?: string;
}

export interface SyncResult {
  providerId: WearableProviderId;
  userId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  recordsIngested: number;
  duplicatesSkipped: number;
  errorsCount: number;
  nextCursor?: string;
  syncTimestamp: string;
  errorDetails?: string;
}
