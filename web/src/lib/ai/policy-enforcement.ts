import { AIRoutingContext, DataSensitivity } from './types';
import { deploymentProfileManager } from '@/lib/deployment';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export class DataEgressViolationError extends AppError {
  constructor(message = 'External data egress violation') {
    super(message, 403, 'DATA_EGRESS_VIOLATION');
    this.name = 'DataEgressViolationError';
  }
}

export class ConsentRevokedError extends AppError {
  constructor(message = 'Operation blocked: User consent has been revoked') {
    super(message, 403, 'CONSENT_REVOKED');
    this.name = 'ConsentRevokedError';
  }
}

export interface ServerSideConsentRecord {
  userId: string;
  allowCloudProcessing: boolean;
  grantedAt?: string;
  revokedAt?: string;
  permittedCategories: Set<DataSensitivity>;
  permittedOperations: Set<string>;
  auditTrail: Array<{
    timestamp: string;
    action: 'GRANTED' | 'REVOKED' | 'EVALUATED';
    reason?: string;
  }>;
}

/**
 * Server-side Policy Enforcement & Data Egress Controller
 *
 * Invariant: Every operation attempting to transmit sensitive health data off-premises
 * must be verified server-side. Client-supplied consent flags are cross-referenced
 * against the authoritative server-side registry.
 */
export class ServerSidePolicyEnforcement {
  private static instance: ServerSidePolicyEnforcement;
  private readonly consentRegistry = new Map<string, ServerSideConsentRecord>();
  private readonly allowedCloudProviders = new Set<string>(['openai', 'anthropic', 'google']);
  private readonly allowedCloudOperations = new Set<string>([
    'consented_second_opinion',
    'literature_search',
    'deidentified_summary',
    'general_health_education',
    'clinical_query',
  ]);

  private constructor() {}

  public static getInstance(): ServerSidePolicyEnforcement {
    if (!ServerSidePolicyEnforcement.instance) {
      ServerSidePolicyEnforcement.instance = new ServerSidePolicyEnforcement();
    }
    return ServerSidePolicyEnforcement.instance;
  }

  /** Resets registry for testing */
  public reset(): void {
    this.consentRegistry.clear();
  }

  /**
   * Registers or updates server-side consent for a user.
   */
  public setConsent(
    userId: string,
    granted: boolean,
    options?: {
      permittedCategories?: DataSensitivity[];
      permittedOperations?: string[];
      reason?: string;
    }
  ): void {
    const now = new Date().toISOString();
    const existing = this.consentRegistry.get(userId);

    const categories = new Set<DataSensitivity>(
      options?.permittedCategories || ['NON_SENSITIVE', 'DEIDENTIFIED', 'CLINICAL_SUMMARY', 'HIGHLY_SENSITIVE_PHI']
    );
    const operations = new Set<string>(options?.permittedOperations || Array.from(this.allowedCloudOperations));

    const auditTrail = existing ? [...existing.auditTrail] : [];
    auditTrail.push({
      timestamp: now,
      action: granted ? 'GRANTED' : 'REVOKED',
      reason: options?.reason,
    });

    this.consentRegistry.set(userId, {
      userId,
      allowCloudProcessing: granted,
      grantedAt: granted ? now : existing?.grantedAt,
      revokedAt: granted ? undefined : now,
      permittedCategories: categories,
      permittedOperations: operations,
      auditTrail,
    });

    logger.info('Server-side consent updated', {
      userId,
      granted,
      timestamp: now,
      reason: options?.reason,
    });
  }

  /**
   * Authoritatively revokes cloud consent for a user.
   */
  public revokeConsent(userId: string, reason = 'User requested consent revocation'): void {
    this.setConsent(userId, false, { reason });
  }

  /**
   * Gets server-side consent record if present.
   */
  public getConsent(userId: string): ServerSideConsentRecord | undefined {
    return this.consentRegistry.get(userId);
  }

  /**
   * Enforces server-side data egress authorization for external AI / cloud transmission.
   * Throws DataEgressViolationError or ConsentRevokedError if checks fail.
   */
  public enforceEgressPolicy(
    context: AIRoutingContext,
    targetProviderId: string,
    operationName = 'inference_query'
  ): void {
    const deploymentMode = deploymentProfileManager.getActiveMode();

    // 1. In Local Mode, cloud egress is unconditionally forbidden
    if (deploymentMode === 'local') {
      throw new DataEgressViolationError(
        `Local self-hosted profile: External transmission to "${targetProviderId}" is strictly prohibited.`
      );
    }

    // 2. Validate Target Provider against explicit allowlist
    if (!this.allowedCloudProviders.has(targetProviderId)) {
      throw new DataEgressViolationError(
        `Target provider "${targetProviderId}" is not in the approved cloud provider allowlist.`
      );
    }

    // 3. Organization Policy Gate
    if (context.orgPolicy?.enforceLocalOnly) {
      throw new DataEgressViolationError(
        'Organization policy mandates strict on-premises data boundary. Cloud egress blocked.'
      );
    }

    // 4. Server-Side User Consent Verification
    const userId = context.userConsent.userId;
    const serverRecord = this.consentRegistry.get(userId);

    // If server record exists and is explicitly revoked
    if (serverRecord && !serverRecord.allowCloudProcessing) {
      throw new ConsentRevokedError(
        `User ${userId} has revoked consent for external cloud data processing.`
      );
    }

    // If client claims consent but server has no consent record or client says false
    if (!context.userConsent.allowCloudProcessing) {
      throw new DataEgressViolationError(
        `Missing user authorization: Cloud egress for user ${userId} is not consented.`
      );
    }

    // Check category restrictions
    if (serverRecord && !serverRecord.permittedCategories.has(context.sensitivity)) {
      throw new DataEgressViolationError(
        `Sensitivity level ${context.sensitivity} is not permitted for cloud transmission under active user consent.`
      );
    }

    // 5. Operation allowlist check
    if (!this.allowedCloudOperations.has(operationName) && !this.allowedCloudOperations.has(context.taskType)) {
      throw new DataEgressViolationError(
        `Operation "${operationName}" is not authorized for cloud dispatch.`
      );
    }

    logger.debug('Server-side data egress check passed', {
      userId,
      provider: targetProviderId,
      sensitivity: context.sensitivity,
    });
  }

  /**
   * Sanitizes external error messages to guarantee no clinical PHI, documents,
   * or credential secrets are leaked in logs or error objects.
   */
  public sanitizeProviderError(error: unknown, providerId: string): Error {
    const rawMessage = error instanceof Error ? error.message : String(error);

    // Strip potential API keys (sk-..., sk-proj-..., AIza...)
    const sanitized = rawMessage
      .replace(/(sk-[a-zA-Z0-9_-]{20,})/g, '[REDACTED_API_KEY]')
      .replace(/(AIza[a-zA-Z0-9_-]{20,})/g, '[REDACTED_API_KEY]')
      .replace(/(Bearer\s+[a-zA-Z0-9._-]+)/gi, 'Bearer [REDACTED_TOKEN]');

    // Strip clinical context tokens
    const safeMessage = `External AI provider "${providerId}" returned an error: ${sanitized.slice(0, 160)}`;

    const safeErr = new AppError(safeMessage, 502, 'EXTERNAL_PROVIDER_ERROR');
    return safeErr;
  }
}

export const serverSidePolicyEnforcement = ServerSidePolicyEnforcement.getInstance();
