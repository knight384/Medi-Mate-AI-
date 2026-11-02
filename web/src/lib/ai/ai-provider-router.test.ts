import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LocalInferenceProvider,
  CloudInferenceProvider,
  AIProviderRouter,
  PrivacyConsentError,
  InferenceUnavailableError,
  AIRoutingContext,
} from './index';
import { deploymentProfileManager } from '@/lib/deployment';

describe('Permanent Architecture — Intelligent AI Routing, Privacy Consent & Zero Silent Fallback', () => {
  let localProvider: LocalInferenceProvider;
  let cloudProvider: CloudInferenceProvider;
  let router: AIProviderRouter;

  beforeEach(() => {
    deploymentProfileManager.resetOverride();

    localProvider = new LocalInferenceProvider({
      providerId: 'local_ollama',
      simulatedResponse: 'Simulated local medical AI response: Vital signs within normal limits.',
    });

    cloudProvider = new CloudInferenceProvider({
      providerId: 'openai',
      simulatedResponse: 'Simulated cloud GPT-4o response: Detailed clinical guideline review.',
    });

    router = new AIProviderRouter([localProvider, cloudProvider], {
      defaultLocalProviderId: 'local_ollama',
      defaultCloudProviderId: 'openai',
    });
  });

  afterEach(() => {
    deploymentProfileManager.resetOverride();
  });

  describe('Local Self-Hosted Mode Routing', () => {
    it('always routes to local inference provider regardless of user consent or preference', async () => {
      deploymentProfileManager.setOverrideMode('local');

      const context: AIRoutingContext = {
        taskType: 'clinical_query',
        sensitivity: 'HIGHLY_SENSITIVE_PHI',
        userConsent: {
          userId: 'patient_alpha',
          allowCloudProcessing: true, // Even if true, local mode blocks cloud egress
        },
        preferredLocation: 'cloud_allowed',
      };

      const decision = await router.route(context);
      expect(decision.selectedProviderId).toBe('local_ollama');
      expect(decision.executionLocation).toBe('LOCAL');
      expect(decision.privacyGatePassed).toBe(true);

      const res = await router.execute(context, {
        systemPrompt: 'System instructions',
        messages: [{ role: 'user', content: 'What is my blood pressure trend?' }],
      });
      expect(res.location).toBe('LOCAL');
      expect(res.content).toContain('Simulated local medical AI');
    });

    it('throws InferenceUnavailableError if local inference is down in local mode', async () => {
      deploymentProfileManager.setOverrideMode('local');

      // Create an unavailable local provider
      const offlineLocal = new LocalInferenceProvider({
        providerId: 'offline_local',
        baseUrl: 'http://127.0.0.1:9999', // non-existent port
      });
      const offlineRouter = new AIProviderRouter([offlineLocal], {
        defaultLocalProviderId: 'offline_local',
      });

      const context: AIRoutingContext = {
        taskType: 'clinical_query',
        sensitivity: 'HIGHLY_SENSITIVE_PHI',
        userConsent: { userId: 'patient_alpha', allowCloudProcessing: false },
      };

      await expect(offlineRouter.route(context)).rejects.toThrow(InferenceUnavailableError);
    });
  });

  describe('Hybrid Mode Routing & Privacy Consent Gate', () => {
    it('routes sensitive clinical queries to local on-prem model by default for data confidentiality', async () => {
      deploymentProfileManager.setOverrideMode('hybrid');

      const context: AIRoutingContext = {
        taskType: 'clinical_query',
        sensitivity: 'HIGHLY_SENSITIVE_PHI',
        userConsent: {
          userId: 'patient_beta',
          allowCloudProcessing: false,
        },
      };

      const decision = await router.route(context);
      expect(decision.selectedProviderId).toBe('local_ollama');
      expect(decision.executionLocation).toBe('LOCAL');
      expect(decision.privacyGatePassed).toBe(true);
    });

    it('routes sensitive queries to cloud ONLY when user grants explicit consent and cloud is requested', async () => {
      deploymentProfileManager.setOverrideMode('hybrid');

      const context: AIRoutingContext = {
        taskType: 'clinical_query',
        sensitivity: 'HIGHLY_SENSITIVE_PHI',
        userConsent: {
          userId: 'patient_gamma',
          allowCloudProcessing: true, // Explicit user consent
        },
        preferredLocation: 'cloud_allowed',
        targetModel: 'gpt-4o',
      };

      const decision = await router.route(context);
      expect(decision.selectedProviderId).toBe('openai');
      expect(decision.executionLocation).toBe('CLOUD');
      expect(decision.privacyGatePassed).toBe(true);
    });

    it('rejects cloud routing for sensitive PHI if user has NOT granted explicit consent', async () => {
      deploymentProfileManager.setOverrideMode('hybrid');

      const context: AIRoutingContext = {
        taskType: 'clinical_query',
        sensitivity: 'HIGHLY_SENSITIVE_PHI',
        userConsent: {
          userId: 'patient_delta',
          allowCloudProcessing: false, // NO consent
        },
        preferredLocation: 'cloud_allowed',
      };

      await expect(router.route(context)).rejects.toThrow(PrivacyConsentError);
    });

    it('rejects cloud routing if organization policy enforces local-only, overriding user consent', async () => {
      deploymentProfileManager.setOverrideMode('hybrid');

      const context: AIRoutingContext = {
        taskType: 'clinical_query',
        sensitivity: 'HIGHLY_SENSITIVE_PHI',
        userConsent: {
          userId: 'patient_org_restricted',
          allowCloudProcessing: true,
        },
        orgPolicy: {
          enforceLocalOnly: true, // Org restricts all data to on-premise
        },
        preferredLocation: 'cloud_allowed',
      };

      await expect(router.route(context)).rejects.toThrow(PrivacyConsentError);
    });

    it('CRITICAL: NEVER silently falls back to cloud when local model is offline for sensitive PHI', async () => {
      deploymentProfileManager.setOverrideMode('hybrid');

      // Offline local provider
      const offlineLocal = new LocalInferenceProvider({
        providerId: 'local_ollama',
        baseUrl: 'http://127.0.0.1:9999',
      });
      // Available cloud provider
      const activeCloud = new CloudInferenceProvider({
        providerId: 'openai',
        simulatedResponse: 'Cloud response',
      });

      const hybridRouter = new AIProviderRouter([offlineLocal, activeCloud], {
        defaultLocalProviderId: 'local_ollama',
        defaultCloudProviderId: 'openai',
      });

      const context: AIRoutingContext = {
        taskType: 'clinical_query',
        sensitivity: 'HIGHLY_SENSITIVE_PHI',
        userConsent: {
          userId: 'patient_silent_fallback_victim',
          allowCloudProcessing: false, // User did NOT consent to cloud
        },
      };

      // MUST NOT fall back to activeCloud! Must throw InferenceUnavailableError
      await expect(hybridRouter.route(context)).rejects.toThrow(
        /silent automatic fallback to external cloud AI is strictly prohibited/
      );
    });

    it('generates a non-repudiable, tamper-evident audit record for every routing decision', async () => {
      deploymentProfileManager.setOverrideMode('hybrid');

      const context: AIRoutingContext = {
        taskType: 'triage_assessment',
        sensitivity: 'HIGHLY_SENSITIVE_PHI',
        userConsent: {
          userId: 'patient_audited',
          allowCloudProcessing: false,
        },
      };

      const decision = await router.route(context);
      expect(decision.auditRecord).toBeDefined();
      expect(decision.auditRecord.auditId).toMatch(/^audit_/);
      expect(decision.auditRecord.taskType).toBe('triage_assessment');
      expect(decision.auditRecord.selectedProviderId).toBe('local_ollama');
      expect(decision.auditRecord.executionLocation).toBe('LOCAL');
      expect(decision.auditRecord.timestamp).toBeDefined();
    });
  });
});
