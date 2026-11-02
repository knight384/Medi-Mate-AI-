import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deploymentProfileManager,
  DeploymentSecurityError,
} from './index';

describe('Permanent Architecture — Deployment Profiles & Boundary Enforcement', () => {
  beforeEach(() => {
    deploymentProfileManager.resetOverride();
  });

  afterEach(() => {
    deploymentProfileManager.resetOverride();
  });

  it('Profile 1: Local Self-Hosted Configuration contracts and boundaries', () => {
    deploymentProfileManager.setOverrideMode('local');
    const profile = deploymentProfileManager.getProfile();

    expect(profile.mode).toBe('local');
    expect(profile.storageDriver).toBe('local');
    expect(profile.databaseLocation).toBe('local_onprem');
    expect(profile.cacheLocation).toBe('local_onprem');
    expect(profile.documentParser).toBe('local_docling');
    expect(profile.aiInference).toBe('local_only');
    expect(profile.cloudEgressAllowed).toBe(false);
    expect(profile.offlineOperationSupported).toBe(true);

    const matrix = deploymentProfileManager.getFeatureMatrix();
    expect(matrix.allowLocalInference).toBe(true);
    expect(matrix.allowCloudInferenceWithConsent).toBe(false);
    expect(matrix.allowRawDocumentCloudEgress).toBe(false);
    expect(matrix.requireLocalDatabase).toBe(true);
    expect(matrix.requireLocalDocumentStorage).toBe(true);
    expect(matrix.silentFallbackToCloudAllowed).toBe(false);

    // Strictly blocks any cloud egress in local mode
    expect(() => {
      deploymentProfileManager.assertCloudEgressPermitted('Dispatch to OpenAI');
    }).toThrow(DeploymentSecurityError);
  });

  it('Profile 2: Cloud-Hosted Configuration contracts and capabilities', () => {
    deploymentProfileManager.setOverrideMode('cloud');
    const profile = deploymentProfileManager.getProfile();

    expect(profile.mode).toBe('cloud');
    expect(profile.storageDriver).toBe('cloud_object_storage');
    expect(profile.databaseLocation).toBe('managed_cloud');
    expect(profile.cacheLocation).toBe('managed_cloud');
    expect(profile.documentParser).toBe('cloud_docling');
    expect(profile.aiInference).toBe('hosted_cloud');
    expect(profile.cloudEgressAllowed).toBe(true);
    expect(profile.offlineOperationSupported).toBe(false);

    const matrix = deploymentProfileManager.getFeatureMatrix();
    expect(matrix.allowCloudInferenceWithConsent).toBe(true);
    expect(matrix.allowRawDocumentCloudEgress).toBe(true);
    expect(matrix.silentFallbackToCloudAllowed).toBe(false);

    // Allows cloud egress when in cloud profile
    expect(() => {
      deploymentProfileManager.assertCloudEgressPermitted('Cloud API query');
    }).not.toThrow();
  });

  it('Profile 3: Hybrid Configuration contracts, consent boundaries, and local PHI retention', () => {
    deploymentProfileManager.setOverrideMode('hybrid');
    const profile = deploymentProfileManager.getProfile();

    expect(profile.mode).toBe('hybrid');
    expect(profile.storageDriver).toBe('hybrid_policy');
    expect(profile.databaseLocation).toBe('private_onprem');
    expect(profile.cacheLocation).toBe('private_onprem');
    expect(profile.documentParser).toBe('local_docling');
    expect(profile.aiInference).toBe('hybrid_policy_routed');
    expect(profile.cloudEgressAllowed).toBe('conditional_with_consent');
    expect(profile.offlineOperationSupported).toBe(true);

    const matrix = deploymentProfileManager.getFeatureMatrix();
    expect(matrix.allowLocalInference).toBe(true);
    expect(matrix.allowCloudInferenceWithConsent).toBe(true);
    expect(matrix.allowRawDocumentCloudEgress).toBe(false); // In hybrid, raw documents NEVER egress
    expect(matrix.requireLocalDatabase).toBe(true);
    expect(matrix.requireLocalDocumentStorage).toBe(true);
    expect(matrix.requireExplicitConsentForCloudAI).toBe(true);
    expect(matrix.silentFallbackToCloudAllowed).toBe(false);

    // Rejects raw medical document cloud storage in hybrid mode
    expect(() => {
      deploymentProfileManager.assertRawDocumentStorageAllowed('cloud');
    }).toThrow(DeploymentSecurityError);

    // Allows local private storage in hybrid mode
    expect(() => {
      deploymentProfileManager.assertRawDocumentStorageAllowed('local');
    }).not.toThrow();
  });

  it('Fail-safe default: unconfigured or empty deployment environment safely defaults to local mode', () => {
    delete process.env.DEPLOYMENT_ENV;
    delete process.env.NEXT_PUBLIC_DEPLOYMENT_ENV;
    deploymentProfileManager.resetOverride();

    const mode = deploymentProfileManager.getActiveMode();
    expect(mode).toBe('local');

    const matrix = deploymentProfileManager.getFeatureMatrix();
    expect(matrix.allowRawDocumentCloudEgress).toBe(false);
    expect(matrix.silentFallbackToCloudAllowed).toBe(false);
  });
});
