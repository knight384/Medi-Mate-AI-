/**
 * MediMate AI — Wearable Provider Registry
 * Central factory and capability directory for all wearable connectors.
 */

import { BaseWearableConnector } from './connectors/base';
import { FitbitConnector } from './connectors/fitbit';
import { OuraConnector } from './connectors/oura';
import {
  AppleHealthKitConnector,
  HealthConnectConnector,
  GarminConnector,
} from './connectors/blocked-adapters';
import { ProviderCapabilities, WearableProviderId } from './types';

class WearableRegistry {
  private connectors: Map<WearableProviderId, BaseWearableConnector> = new Map();

  constructor() {
    this.registerConnector(new FitbitConnector());
    this.registerConnector(new OuraConnector());
    this.registerConnector(new AppleHealthKitConnector());
    this.registerConnector(new HealthConnectConnector());
    this.registerConnector(new GarminConnector());
  }

  registerConnector(connector: BaseWearableConnector): void {
    this.connectors.set(connector.providerId, connector);
  }

  getConnector(providerId: WearableProviderId): BaseWearableConnector {
    const connector = this.connectors.get(providerId);
    if (!connector) {
      throw new Error(`Unsupported wearable provider: '${providerId}'`);
    }
    return connector;
  }

  listCapabilities(): ProviderCapabilities[] {
    return Array.from(this.connectors.values()).map((c) => c.getCapabilities());
  }

  isProviderSupported(providerId: WearableProviderId): boolean {
    return this.connectors.has(providerId);
  }

  isProviderActive(providerId: WearableProviderId): boolean {
    const caps = this.connectors.get(providerId)?.getCapabilities();
    return caps?.integrationStatus === 'IMPLEMENTED' || caps?.integrationStatus === 'MOCK-TESTED' || caps?.integrationStatus === 'LIVE-VERIFIED';
  }
}

export const wearableRegistry = new WearableRegistry();

export function getWearableConnector(providerId: WearableProviderId): BaseWearableConnector {
  return wearableRegistry.getConnector(providerId);
}

export function listSupportedProviders(): ProviderCapabilities[] {
  return wearableRegistry.listCapabilities();
}
