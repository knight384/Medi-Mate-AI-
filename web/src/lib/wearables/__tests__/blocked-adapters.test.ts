import { describe, it, expect } from 'vitest';
import {
  AppleHealthKitConnector,
  HealthConnectConnector,
  GarminConnector,
  PlatformBlockedError,
} from '../connectors/blocked-adapters';

describe('Blocked Platform Adapters & Boundary Enforcement (Phase 7)', () => {
  it('classifies Apple HealthKit as BLOCKED due to native iOS requirement', async () => {
    const apple = new AppleHealthKitConnector();
    const caps = apple.getCapabilities();

    expect(caps.integrationStatus).toBe('BLOCKED');
    expect(caps.platform).toBe('NATIVE_MOBILE');
    expect(caps.statusReason).toContain('native iOS companion app');

    await expect(apple.getAuthorizationUrl()).rejects.toThrow(PlatformBlockedError);
    await expect(apple.getAuthorizationUrl()).rejects.toMatchObject({
      providerId: 'apple_health',
      reason: 'NATIVE_IOS_REQUIRED',
    });

    await expect(apple.fetchHistoricalData()).rejects.toThrow(PlatformBlockedError);
    await expect(apple.fetchIncrementalData()).rejects.toThrow(PlatformBlockedError);
  });

  it('classifies Android Health Connect as BLOCKED due to native Android requirement', async () => {
    const healthConnect = new HealthConnectConnector();
    const caps = healthConnect.getCapabilities();

    expect(caps.integrationStatus).toBe('BLOCKED');
    expect(caps.platform).toBe('NATIVE_MOBILE');
    expect(caps.statusReason).toContain('native Android companion app');

    await expect(healthConnect.getAuthorizationUrl()).rejects.toThrow(PlatformBlockedError);
    await expect(healthConnect.getAuthorizationUrl()).rejects.toMatchObject({
      providerId: 'health_connect',
      reason: 'NATIVE_ANDROID_REQUIRED',
    });

    await expect(healthConnect.fetchHistoricalData()).rejects.toThrow(PlatformBlockedError);
    await expect(healthConnect.fetchIncrementalData()).rejects.toThrow(PlatformBlockedError);
  });

  it('classifies Garmin Health as BLOCKED when partner credentials are unconfigured', async () => {
    const garmin = new GarminConnector();
    const caps = garmin.getCapabilities();

    expect(caps.integrationStatus).toBe('BLOCKED');
    expect(caps.platform).toBe('PARTNER_REST');
    expect(caps.statusReason).toContain('Garmin Health enterprise developer agreement');

    await expect(garmin.getAuthorizationUrl()).rejects.toThrow(PlatformBlockedError);
    await expect(garmin.getAuthorizationUrl()).rejects.toMatchObject({
      providerId: 'garmin',
      reason: 'ENTERPRISE_PARTNER_REQUIRED',
    });

    await expect(garmin.fetchHistoricalData()).rejects.toThrow(PlatformBlockedError);
  });
});
