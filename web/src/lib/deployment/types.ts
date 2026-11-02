import { z } from 'zod';
import { AppError } from '@/lib/errors';

export type DeploymentMode = 'local' | 'cloud' | 'hybrid';

export class DeploymentSecurityError extends AppError {
  constructor(message = 'Deployment security policy violation') {
    super(message, 403, 'DEPLOYMENT_SECURITY_VIOLATION');
    this.name = 'DeploymentSecurityError';
  }
}

export interface LocalDeploymentProfile {
  mode: 'local';
  storageDriver: 'local';
  databaseLocation: 'local_onprem';
  cacheLocation: 'local_onprem';
  documentParser: 'local_docling';
  aiInference: 'local_only';
  cloudEgressAllowed: false;
  offlineOperationSupported: true;
  kmsProvider: 'local_keyring';
}

export interface CloudDeploymentProfile {
  mode: 'cloud';
  storageDriver: 'cloud_object_storage';
  databaseLocation: 'managed_cloud';
  cacheLocation: 'managed_cloud';
  documentParser: 'cloud_docling';
  aiInference: 'hosted_cloud';
  cloudEgressAllowed: true;
  offlineOperationSupported: false;
  kmsProvider: 'cloud_kms';
}

export interface HybridDeploymentProfile {
  mode: 'hybrid';
  storageDriver: 'hybrid_policy';
  databaseLocation: 'private_onprem';
  cacheLocation: 'private_onprem';
  documentParser: 'local_docling';
  aiInference: 'hybrid_policy_routed';
  cloudEgressAllowed: 'conditional_with_consent';
  offlineOperationSupported: true;
  kmsProvider: 'hybrid_keyring';
}

export type DeploymentProfile =
  | LocalDeploymentProfile
  | CloudDeploymentProfile
  | HybridDeploymentProfile;

export const deploymentModeSchema = z.enum(['local', 'cloud', 'hybrid']);

export interface DeploymentFeatureMatrix {
  allowLocalInference: boolean;
  allowCloudInferenceWithConsent: boolean;
  allowRawDocumentCloudEgress: boolean;
  requireLocalDatabase: boolean;
  requireLocalDocumentStorage: boolean;
  requireExplicitConsentForCloudAI: boolean;
  silentFallbackToCloudAllowed: false; // Invariant: ALWAYS false across all modes
}
