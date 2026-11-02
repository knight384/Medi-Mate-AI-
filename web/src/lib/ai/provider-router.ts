import {
  AIInferenceProvider,
  AIRoutingContext,
  AIRoutingDecision,
  InferenceRequest,
  InferenceResponse,
} from './types';
import { ConsentAndPrivacyPolicy, PrivacyConsentError } from './consent-policy';
import { ProviderHealthCheck } from './health-check';
import { serverSidePolicyEnforcement } from './policy-enforcement';
import { deploymentProfileManager } from '@/lib/deployment';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export class InferenceUnavailableError extends AppError {
  constructor(message = 'Inference service is currently unavailable') {
    super(message, 503, 'INFERENCE_UNAVAILABLE');
    this.name = 'InferenceUnavailableError';
  }
}

/**
 * Intelligent AI Provider Router
 *
 * Deterministically routes AI requests based on task type, data sensitivity,
 * user consent, organization policy, model capability, availability, and cost.
 *
 * Enforces strict privacy guarantees:
 * - Local-first for sensitive clinical information.
 * - Zero silent cloud fallback for sensitive PHI.
 * - Non-repudiable, auditable execution traces.
 */
export class AIProviderRouter {
  private readonly providers: Map<string, AIInferenceProvider>;
  private readonly healthCheck: ProviderHealthCheck;
  private readonly defaultLocalProviderId: string;
  private readonly defaultCloudProviderId: string;

  constructor(
    providers: AIInferenceProvider[],
    options?: {
      defaultLocalProviderId?: string;
      defaultCloudProviderId?: string;
    }
  ) {
    this.providers = new Map();
    for (const p of providers) {
      this.providers.set(p.providerId, p);
    }
    this.healthCheck = new ProviderHealthCheck(providers);
    this.defaultLocalProviderId = options?.defaultLocalProviderId || 'local_ollama';
    this.defaultCloudProviderId = options?.defaultCloudProviderId || 'openai';
  }

  public getProvider(providerId: string): AIInferenceProvider | undefined {
    return this.providers.get(providerId);
  }

  public getHealthCheck(): ProviderHealthCheck {
    return this.healthCheck;
  }

  /**
   * Deterministically decides which provider executes the request.
   */
  public async route(context: AIRoutingContext): Promise<AIRoutingDecision> {
    const deploymentMode = deploymentProfileManager.getActiveMode();
    const localHealth = await this.healthCheck.getHealth(this.defaultLocalProviderId);

    // 1. Local Deployment Profile: Always local, zero cloud egress
    if (deploymentMode === 'local') {
      if (!localHealth.isAvailable) {
        throw new InferenceUnavailableError(
          `Local inference provider "${this.defaultLocalProviderId}" is offline or unreachable.`
        );
      }
      const audit = ConsentAndPrivacyPolicy.createAuditRecord(
        context,
        this.defaultLocalProviderId,
        'LOCAL',
        'Local Self-Hosted deployment mode: strictly isolated to on-premises local AI model.'
      );
      return {
        selectedProviderId: this.defaultLocalProviderId,
        executionLocation: 'LOCAL',
        reason: audit.decisionReason,
        auditRecord: audit,
        privacyGatePassed: true,
      };
    }

    // 2. Sensitive PHI Handling (Local Preferred, Strict Consent Gate)
    const isSensitive =
      context.sensitivity === 'HIGHLY_SENSITIVE_PHI' ||
      context.sensitivity === 'CLINICAL_SUMMARY' ||
      context.taskType === 'clinical_query' ||
      context.taskType === 'triage_assessment' ||
      context.taskType === 'medication_review';

    if (isSensitive) {
      // Preference: run locally if preference is local_only or local_preferred
      const prefersLocal = context.preferredLocation !== 'cloud_allowed';

      if (prefersLocal && localHealth.isAvailable) {
        const audit = ConsentAndPrivacyPolicy.createAuditRecord(
          context,
          this.defaultLocalProviderId,
          'LOCAL',
          'Sensitive clinical task routed to local on-premises model for data confidentiality.'
        );
        return {
          selectedProviderId: this.defaultLocalProviderId,
          executionLocation: 'LOCAL',
          reason: audit.decisionReason,
          auditRecord: audit,
          privacyGatePassed: true,
        };
      }

      // If user/caller explicitly requested cloud for sensitive task:
      if (context.preferredLocation === 'cloud_allowed') {
        const consentEval = ConsentAndPrivacyPolicy.evaluateCloudProcessing(context);
        if (!consentEval.permitted) {
          throw new PrivacyConsentError(consentEval.reason);
        }

        const cloudProviderId = context.targetModel?.includes('claude')
          ? 'anthropic'
          : context.targetModel?.includes('gemini')
            ? 'google'
            : this.defaultCloudProviderId;

        // Authoritative server-side policy and data egress verification
        serverSidePolicyEnforcement.enforceEgressPolicy(context, cloudProviderId, context.taskType);

        const cloudHealth = await this.healthCheck.getHealth(cloudProviderId);
        if (!cloudHealth.isAvailable) {
          throw new InferenceUnavailableError(
            `Requested cloud AI provider "${cloudProviderId}" is not configured or unavailable.`
          );
        }

        const audit = ConsentAndPrivacyPolicy.createAuditRecord(
          context,
          cloudProviderId,
          'CLOUD',
          'Sensitive task routed to cloud AI under explicit user consent and policy authorization.'
        );
        return {
          selectedProviderId: cloudProviderId,
          executionLocation: 'CLOUD',
          reason: audit.decisionReason,
          auditRecord: audit,
          privacyGatePassed: true,
        };
      }

      // Local was preferred but local provider is unavailable:
      // STRICT INVARIANT: NO SILENT FALLBACK TO CLOUD!
      if (!localHealth.isAvailable) {
        logger.error('Local inference outage encountered for sensitive clinical task', {
          taskType: context.taskType,
          sensitivity: context.sensitivity,
        });
        throw new InferenceUnavailableError(
          'Local clinical inference is currently unavailable. To protect patient privacy, silent automatic fallback to external cloud AI is strictly prohibited.'
        );
      }
    }

    // 3. Non-sensitive or Administrative Tasks
    const consentEval = ConsentAndPrivacyPolicy.evaluateCloudProcessing(context);
    const cloudProviderId = context.targetModel?.includes('claude')
      ? 'anthropic'
      : context.targetModel?.includes('gemini')
        ? 'google'
        : this.defaultCloudProviderId;

    const cloudHealth = await this.healthCheck.getHealth(cloudProviderId);

    // If cloud is consented and available, use cloud
    if (consentEval.permitted && cloudHealth.isAvailable) {
      try {
        serverSidePolicyEnforcement.enforceEgressPolicy(context, cloudProviderId, context.taskType);
        const audit = ConsentAndPrivacyPolicy.createAuditRecord(
          context,
          cloudProviderId,
          'CLOUD',
          'Non-sensitive task routed to cloud AI per policy and available capacity.'
        );
        return {
          selectedProviderId: cloudProviderId,
          executionLocation: 'CLOUD',
          reason: audit.decisionReason,
          auditRecord: audit,
          privacyGatePassed: true,
        };
      } catch {
        // If server policy blocks cloud egress for this task, fall through to local
      }
    }

    // Fall back to local inference if available
    if (localHealth.isAvailable) {
      const audit = ConsentAndPrivacyPolicy.createAuditRecord(
        context,
        this.defaultLocalProviderId,
        'LOCAL',
        'Task routed to local model due to cloud unavailability or absent consent.'
      );
      return {
        selectedProviderId: this.defaultLocalProviderId,
        executionLocation: 'LOCAL',
        reason: audit.decisionReason,
        auditRecord: audit,
        privacyGatePassed: true,
      };
    }

    throw new InferenceUnavailableError(
      'Both local and cloud inference providers are currently unavailable.'
    );
  }

  /**
   * Routes and executes the inference request.
   */
  public async execute(
    context: AIRoutingContext,
    request: InferenceRequest
  ): Promise<InferenceResponse & { decision: AIRoutingDecision }> {
    const decision = await this.route(context);
    const provider = this.providers.get(decision.selectedProviderId);

    if (!provider) {
      throw new InferenceUnavailableError(
        `Selected provider "${decision.selectedProviderId}" is not registered.`
      );
    }

    let response: InferenceResponse;
    try {
      response = await provider.invoke(request);
    } catch (err) {
      logger.error('AI provider invocation failed', {
        providerId: decision.selectedProviderId,
      });
      throw serverSidePolicyEnforcement.sanitizeProviderError(err, decision.selectedProviderId);
    }

    return {
      ...response,
      decision,
    };
  }
}
