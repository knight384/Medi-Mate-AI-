/**
 * MediMate AI — Base Wearable Connector Interface
 * All wearable integrations inherit this unified contract.
 */

import {
  HealthDataCategory,
  NormalizedObservation,
  OAuthTokenResult,
  ProviderCapabilities,
  WearableProviderId,
} from '../types';

export interface ConnectorFetchOptions {
  accessToken: string;
  startDate: Date;
  endDate: Date;
  categories: HealthDataCategory[];
  cursor?: string;
}

export interface IncrementalFetchResult {
  observations: NormalizedObservation[];
  nextCursor?: string;
  hasMore: boolean;
}

export abstract class BaseWearableConnector {
  abstract readonly providerId: WearableProviderId;
  abstract readonly displayName: string;

  /**
   * Returns metadata and capability profile of the connector.
   */
  abstract getCapabilities(): ProviderCapabilities;

  /**
   * Constructs the provider's OAuth 2.0 authorization URL with requested scopes and PKCE challenge.
   */
  abstract getAuthorizationUrl(params: {
    state: string;
    codeChallenge?: string;
    categories: HealthDataCategory[];
    redirectUri: string;
  }): Promise<string>;

  /**
   * Exchanges an authorization code for access and refresh tokens.
   */
  abstract exchangeCode(params: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
  }): Promise<OAuthTokenResult>;

  /**
   * Refreshes an expired access token using the stored refresh token.
   */
  abstract refreshToken(refreshToken: string): Promise<OAuthTokenResult>;

  /**
   * Revokes access credentials with the upstream provider.
   */
  abstract revokeToken(accessToken: string): Promise<boolean>;

  /**
   * Fetches historical observations across requested categories for a date range.
   */
  abstract fetchHistoricalData(
    userId: string,
    options: ConnectorFetchOptions
  ): Promise<NormalizedObservation[]>;

  /**
   * Fetches incremental observations since the last recorded synchronization cursor.
   */
  abstract fetchIncrementalData(
    userId: string,
    options: ConnectorFetchOptions
  ): Promise<IncrementalFetchResult>;
}
