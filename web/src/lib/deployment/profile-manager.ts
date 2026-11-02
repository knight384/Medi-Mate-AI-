import { getDeploymentEnv } from '@/lib/config/env';
import {
  DeploymentMode,
  DeploymentProfile,
  DeploymentFeatureMatrix,
  DeploymentSecurityError,
  LocalDeploymentProfile,
  CloudDeploymentProfile,
  HybridDeploymentProfile,
} from './types';
import { logger } from '@/lib/logger';

export class DeploymentProfileManager {
  private static instance: DeploymentProfileManager;
  private overrideMode?: DeploymentMode;

  private constructor() {}

  public static getInstance(): DeploymentProfileManager {
    if (!DeploymentProfileManager.instance) {
      DeploymentProfileManager.instance = new DeploymentProfileManager();
    }
    return DeploymentProfileManager.instance;
  }

  /**
   * Resets any test override.
   */
  public resetOverride(): void {
    this.overrideMode = undefined;
  }

  /**
   * For testing profile transitions.
   */
  public setOverrideMode(mode: DeploymentMode): void {
    this.overrideMode = mode;
  }

  /**
   * Resolves active deployment mode from environment or test override.
   * Fail-safe default: 'local'.
   */
  public getActiveMode(): DeploymentMode {
    if (this.overrideMode) {
      return this.overrideMode;
    }
    try {
      const envVal = getDeploymentEnv();
      if (envVal === 'cloud' || envVal === 'hybrid') {
        return envVal;
      }
      return 'local';
    } catch {
      return 'local';
    }
  }

  /**
   * Returns complete profile contract for active deployment mode.
   */
  public getProfile(): DeploymentProfile {
    const mode = this.getActiveMode();

    switch (mode) {
      case 'cloud': {
        const profile: CloudDeploymentProfile = {
          mode: 'cloud',
          storageDriver: 'cloud_object_storage',
          databaseLocation: 'managed_cloud',
          cacheLocation: 'managed_cloud',
          documentParser: 'cloud_docling',
          aiInference: 'hosted_cloud',
          cloudEgressAllowed: true,
          offlineOperationSupported: false,
          kmsProvider: 'cloud_kms',
        };
        return profile;
      }
      case 'hybrid': {
        const profile: HybridDeploymentProfile = {
          mode: 'hybrid',
          storageDriver: 'hybrid_policy',
          databaseLocation: 'private_onprem',
          cacheLocation: 'private_onprem',
          documentParser: 'local_docling',
          aiInference: 'hybrid_policy_routed',
          cloudEgressAllowed: 'conditional_with_consent',
          offlineOperationSupported: true,
          kmsProvider: 'hybrid_keyring',
        };
        return profile;
      }
      case 'local':
      default: {
        const profile: LocalDeploymentProfile = {
          mode: 'local',
          storageDriver: 'local',
          databaseLocation: 'local_onprem',
          cacheLocation: 'local_onprem',
          documentParser: 'local_docling',
          aiInference: 'local_only',
          cloudEgressAllowed: false,
          offlineOperationSupported: true,
          kmsProvider: 'local_keyring',
        };
        return profile;
      }
    }
  }

  /**
   * Returns authoritative security feature matrix for the active deployment.
   */
  public getFeatureMatrix(): DeploymentFeatureMatrix {
    const mode = this.getActiveMode();

    return {
      allowLocalInference: true, // Always supported in all modes
      allowCloudInferenceWithConsent: mode === 'cloud' || mode === 'hybrid',
      allowRawDocumentCloudEgress: mode === 'cloud', // In hybrid, raw documents NEVER egress
      requireLocalDatabase: mode === 'local' || mode === 'hybrid',
      requireLocalDocumentStorage: mode === 'local' || mode === 'hybrid',
      requireExplicitConsentForCloudAI: mode === 'hybrid',
      silentFallbackToCloudAllowed: false, // Strict architectural invariant: NEVER allowed
    };
  }

  /**
   * Asserts that cloud egress is allowed for a specified operation.
   * Throws DeploymentSecurityError if egress violates profile boundary.
   */
  public assertCloudEgressPermitted(operationDescription: string): void {
    const mode = this.getActiveMode();
    if (mode === 'local') {
      logger.warn('Blocked cloud egress attempt in local self-hosted mode', {
        operation: operationDescription,
      });
      throw new DeploymentSecurityError(
        `Cloud egress is strictly blocked in Local Self-Hosted mode: ${operationDescription}`
      );
    }
  }

  /**
   * Asserts that raw medical documents remain on private infrastructure in hybrid mode.
   */
  public assertRawDocumentStorageAllowed(storageDestination: 'local' | 'cloud'): void {
    const mode = this.getActiveMode();
    if (mode === 'hybrid' && storageDestination === 'cloud') {
      throw new DeploymentSecurityError(
        'Hybrid architecture directive: Raw medical documents must remain in private encrypted storage and cannot be stored in public cloud.'
      );
    }
    if (mode === 'local' && storageDestination === 'cloud') {
      throw new DeploymentSecurityError(
        'Local self-hosted directive: Cloud storage driver is disabled.'
      );
    }
  }
}

export const deploymentProfileManager = DeploymentProfileManager.getInstance();
