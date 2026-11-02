export type TaskType =
  | 'clinical_query'
  | 'triage_assessment'
  | 'medication_review'
  | 'general_chat'
  | 'document_qa'
  | 'translation'
  | 'administrative';

export type DataSensitivity =
  | 'HIGHLY_SENSITIVE_PHI' // Unredacted medical histories, lab results, diagnoses
  | 'CLINICAL_SUMMARY'     // Aggregated clinical summaries
  | 'DEIDENTIFIED'         // De-identified research or metrics data
  | 'NON_SENSITIVE';       // Public medical definitions, greeting chat, system config

export type ProcessingLocationPreference = 'local_only' | 'local_preferred' | 'cloud_allowed';

export interface UserConsent {
  userId: string;
  allowCloudProcessing: boolean;
  consentTimestamp?: string;
  policyVersion?: string;
}

export interface OrganizationPolicy {
  enforceLocalOnly: boolean;
  allowedCloudProviders?: string[];
  maxSensitivityForCloud?: DataSensitivity;
}

export interface ProviderHealthStatus {
  providerId: string;
  location: 'LOCAL' | 'CLOUD';
  isAvailable: boolean;
  latencyMs?: number;
  lastCheckedAt: string;
  error?: string;
}

export interface AIRoutingContext {
  taskType: TaskType;
  sensitivity: DataSensitivity;
  userConsent: UserConsent;
  orgPolicy?: OrganizationPolicy;
  preferredLocation?: ProcessingLocationPreference;
  targetModel?: string;
}

export interface AIRoutingAuditRecord {
  auditId: string;
  timestamp: string;
  taskType: TaskType;
  sensitivity: DataSensitivity;
  userConsented: boolean;
  orgLocalOnlyEnforced: boolean;
  selectedProviderId: string;
  executionLocation: 'LOCAL' | 'CLOUD';
  decisionReason: string;
}

export interface AIRoutingDecision {
  selectedProviderId: string;
  executionLocation: 'LOCAL' | 'CLOUD';
  reason: string;
  auditRecord: AIRoutingAuditRecord;
  privacyGatePassed: boolean;
}

export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InferenceRequest {
  systemPrompt: string;
  messages: InferenceMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface InferenceResponse {
  content: string;
  providerId: string;
  location: 'LOCAL' | 'CLOUD';
  latencyMs: number;
  modelUsed: string;
}

export interface AIInferenceProvider {
  readonly providerId: string;
  readonly location: 'LOCAL' | 'CLOUD';
  checkHealth(): Promise<ProviderHealthStatus>;
  invoke(request: InferenceRequest): Promise<InferenceResponse>;
}
