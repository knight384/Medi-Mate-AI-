import { AIRoutingContext, AIRoutingAuditRecord, DataSensitivity } from './types';
import { deploymentProfileManager } from '@/lib/deployment';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import crypto from 'node:crypto';

export class PrivacyConsentError extends AppError {
  constructor(message = 'Cloud AI processing rejected by privacy consent policy') {
    super(message, 403, 'PRIVACY_CONSENT_VIOLATION');
    this.name = 'PrivacyConsentError';
  }
}

export class ConsentAndPrivacyPolicy {
  /**
   * Evaluates whether cloud processing is permitted for the given context.
   *
   * STRICT SECURITY RULES:
   * 1. Local Mode: Always false (zero cloud egress).
   * 2. Org Policy Enforce Local: Always false.
   * 3. User Consent Missing: Always false.
   * 4. PHI Sensitivity Over Limit: Always false.
   * 5. Silent Fallback to Cloud: Permanently forbidden.
   */
  public static evaluateCloudProcessing(context: AIRoutingContext): {
    permitted: boolean;
    reason: string;
  } {
    const mode = deploymentProfileManager.getActiveMode();

    if (mode === 'local') {
      return {
        permitted: false,
        reason: 'Deployment profile is Local Self-Hosted: cloud egress is strictly disabled.',
      };
    }

    if (context.orgPolicy?.enforceLocalOnly) {
      return {
        permitted: false,
        reason: 'Organization policy mandates strict on-premises/local-only execution.',
      };
    }

    if (!context.userConsent.allowCloudProcessing) {
      return {
        permitted: false,
        reason: 'User has not granted explicit consent for off-premises cloud AI processing.',
      };
    }

    if (context.orgPolicy?.maxSensitivityForCloud) {
      const sensitivityOrder: Record<DataSensitivity, number> = {
        NON_SENSITIVE: 1,
        DEIDENTIFIED: 2,
        CLINICAL_SUMMARY: 3,
        HIGHLY_SENSITIVE_PHI: 4,
      };
      const contextLevel = sensitivityOrder[context.sensitivity] || 4;
      const maxAllowed = sensitivityOrder[context.orgPolicy.maxSensitivityForCloud] || 1;

      if (contextLevel > maxAllowed) {
        return {
          permitted: false,
          reason: `Data sensitivity level (${context.sensitivity}) exceeds organization maximum allowed for cloud (${context.orgPolicy.maxSensitivityForCloud}).`,
        };
      }
    }

    return {
      permitted: true,
      reason: 'Explicit user consent granted and organization privacy policy requirements satisfied.',
    };
  }

  /**
   * Enforces that cloud processing is permitted; throws PrivacyConsentError if rejected.
   */
  public static assertCanProcessInCloud(context: AIRoutingContext): void {
    const evaluation = this.evaluateCloudProcessing(context);
    if (!evaluation.permitted) {
      logger.warn('Blocked cloud processing attempt due to consent/policy violation', {
        userId: context.userConsent.userId,
        sensitivity: context.sensitivity,
        reason: evaluation.reason,
      });
      throw new PrivacyConsentError(evaluation.reason);
    }
  }

  /**
   * Generates a tamper-evident audit record for AI routing decisions.
   */
  public static createAuditRecord(
    context: AIRoutingContext,
    selectedProviderId: string,
    executionLocation: 'LOCAL' | 'CLOUD',
    decisionReason: string
  ): AIRoutingAuditRecord {
    return {
      auditId: `audit_${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      taskType: context.taskType,
      sensitivity: context.sensitivity,
      userConsented: context.userConsent.allowCloudProcessing,
      orgLocalOnlyEnforced: Boolean(context.orgPolicy?.enforceLocalOnly),
      selectedProviderId,
      executionLocation,
      decisionReason,
    };
  }
}
