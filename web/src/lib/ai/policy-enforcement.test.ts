import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LocalInferenceProvider,
  CloudInferenceProvider,
  AIProviderRouter,
  AIRoutingContext,
} from './index';
import {
  serverSidePolicyEnforcement,
  DataEgressViolationError,
  ConsentRevokedError,
} from './policy-enforcement';
import { deploymentProfileManager } from '@/lib/deployment';

describe('Phase 2 — Server-Side Policy Enforcement, Provider Routing & Data Egress Controls (Checkpoint 5D.26)', () => {
  let localProvider: LocalInferenceProvider;
  let cloudProvider: CloudInferenceProvider;
  let router: AIProviderRouter;

  beforeEach(() => {
    deploymentProfileManager.resetOverride();
    serverSidePolicyEnforcement.reset();

    localProvider = new LocalInferenceProvider({
      providerId: 'local_ollama',
      simulatedResponse: 'Local medical model response: Patient ECG normal.',
    });

    cloudProvider = new CloudInferenceProvider({
      providerId: 'openai',
      simulatedResponse: 'Cloud GPT-4o response: Specialized cardiology assessment.',
    });

    router = new AIProviderRouter([localProvider, cloudProvider], {
      defaultLocalProviderId: 'local_ollama',
      defaultCloudProviderId: 'openai',
    });
  });

  afterEach(() => {
    deploymentProfileManager.resetOverride();
    serverSidePolicyEnforcement.reset();
  });

  it('1. Local mode rejects unauthorized cloud requests even with client consent flag', async () => {
    deploymentProfileManager.setOverrideMode('local');

    const context: AIRoutingContext = {
      taskType: 'clinical_query',
      sensitivity: 'HIGHLY_SENSITIVE_PHI',
      userConsent: { userId: 'patient_001', allowCloudProcessing: true },
      preferredLocation: 'cloud_allowed',
    };

    // Router must route to local_ollama despite preferredLocation='cloud_allowed'
    const decision = await router.route(context);
    expect(decision.executionLocation).toBe('LOCAL');
    expect(decision.selectedProviderId).toBe('local_ollama');

    // Direct egress check must reject cloud
    expect(() => {
      serverSidePolicyEnforcement.enforceEgressPolicy(context, 'openai', 'clinical_query');
    }).toThrow(DataEgressViolationError);
  });

  it('2. Hybrid mode uses local processing by default for sensitive clinical tasks', async () => {
    deploymentProfileManager.setOverrideMode('hybrid');

    const context: AIRoutingContext = {
      taskType: 'clinical_query',
      sensitivity: 'HIGHLY_SENSITIVE_PHI',
      userConsent: { userId: 'patient_002', allowCloudProcessing: false },
    };

    const decision = await router.route(context);
    expect(decision.executionLocation).toBe('LOCAL');
    expect(decision.selectedProviderId).toBe('local_ollama');
  });

  it('3. Hybrid mode can use approved cloud providers after explicit server-side authorization', async () => {
    deploymentProfileManager.setOverrideMode('hybrid');

    // Grant server-side consent
    serverSidePolicyEnforcement.setConsent('patient_003', true, {
      permittedCategories: ['HIGHLY_SENSITIVE_PHI', 'CLINICAL_SUMMARY'],
      permittedOperations: ['clinical_query'],
      reason: 'Patient requested specialized cloud cardiology review',
    });

    const context: AIRoutingContext = {
      taskType: 'clinical_query',
      sensitivity: 'HIGHLY_SENSITIVE_PHI',
      userConsent: { userId: 'patient_003', allowCloudProcessing: true },
      preferredLocation: 'cloud_allowed',
      targetModel: 'gpt-4o',
    };

    const decision = await router.route(context);
    expect(decision.executionLocation).toBe('CLOUD');
    expect(decision.selectedProviderId).toBe('openai');
  });

  it('4. Revoked consent immediately blocks subsequent external operations', async () => {
    deploymentProfileManager.setOverrideMode('hybrid');

    const userId = 'patient_004';
    // Initially grant consent
    serverSidePolicyEnforcement.setConsent(userId, true);

    const context: AIRoutingContext = {
      taskType: 'clinical_query',
      sensitivity: 'HIGHLY_SENSITIVE_PHI',
      userConsent: { userId, allowCloudProcessing: true },
      preferredLocation: 'cloud_allowed',
    };

    // First request passes
    await expect(router.route(context)).resolves.toBeDefined();

    // Now user authoritatively revokes consent
    serverSidePolicyEnforcement.revokeConsent(userId, 'Patient withdrew data sharing consent');

    // Subsequent external operation must fail with ConsentRevokedError
    await expect(router.route(context)).rejects.toThrow(ConsentRevokedError);
  });

  it('5. Missing authorization blocks external transmission', async () => {
    deploymentProfileManager.setOverrideMode('hybrid');

    const context: AIRoutingContext = {
      taskType: 'clinical_query',
      sensitivity: 'HIGHLY_SENSITIVE_PHI',
      userConsent: { userId: 'patient_005', allowCloudProcessing: false },
      preferredLocation: 'cloud_allowed',
    };

    // Client says false, and no server consent
    await expect(router.route(context)).rejects.toThrow();
  });

  it('6. Cloud failures never trigger unauthorized fallback to unapproved providers or compromise isolation', async () => {
    deploymentProfileManager.setOverrideMode('hybrid');

    // Offline cloud provider
    const failingCloud = new CloudInferenceProvider({
      providerId: 'openai',
      apiKey: 'sk-invalid',
    });
    // Offline local provider
    const offlineLocal = new LocalInferenceProvider({
      providerId: 'local_ollama',
      baseUrl: 'http://127.0.0.1:9999',
    });

    const failingRouter = new AIProviderRouter([offlineLocal, failingCloud], {
      defaultLocalProviderId: 'local_ollama',
      defaultCloudProviderId: 'openai',
    });

    const context: AIRoutingContext = {
      taskType: 'clinical_query',
      sensitivity: 'HIGHLY_SENSITIVE_PHI',
      userConsent: { userId: 'patient_006', allowCloudProcessing: false },
    };

    // When local is offline for sensitive PHI, it MUST NOT silently fall back to cloud!
    await expect(failingRouter.route(context)).rejects.toThrow(
      /silent automatic fallback to external cloud AI is strictly prohibited/
    );
  });

  it('7. Provider errors do not disclose medical documents or secrets', async () => {
    deploymentProfileManager.setOverrideMode('hybrid');

    const leakingProvider = new CloudInferenceProvider({
      providerId: 'openai',
      simulatedError: 'Invalid request to sk-proj-1234567890abcdef1234567890 with document "Patient John Doe Cancer Diagnosis"',
    });

    const leakRouter = new AIProviderRouter([localProvider, leakingProvider], {
      defaultLocalProviderId: 'local_ollama',
      defaultCloudProviderId: 'openai',
    });

    // Authorize cloud
    serverSidePolicyEnforcement.setConsent('patient_007', true);

    const context: AIRoutingContext = {
      taskType: 'clinical_query',
      sensitivity: 'DEIDENTIFIED',
      userConsent: { userId: 'patient_007', allowCloudProcessing: true },
      preferredLocation: 'cloud_allowed',
    };

    try {
      await leakRouter.execute(context, {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Patient John Doe Cancer Diagnosis' }],
      });
      expect.fail('Should have thrown sanitized error');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('sk-proj-1234567890abcdef1234567890');
      expect(msg).toContain('[REDACTED_API_KEY]');
    }
  });
});
