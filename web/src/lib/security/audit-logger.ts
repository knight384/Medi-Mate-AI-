import { logger } from '@/lib/logger';

export type SecurityAuditEventType =
  | 'AUTH_SUCCESS'
  | 'AUTH_FAILURE'
  | 'DOCUMENT_READ'
  | 'DOCUMENT_WRITE'
  | 'DOCUMENT_DELETE'
  | 'CONSENT_GRANTED'
  | 'CONSENT_REVOKED'
  | 'EGRESS_BLOCKED'
  | 'KMS_OPERATION'
  | 'KEY_ROTATION'
  | 'RATE_LIMIT_EXCEEDED'
  | 'BACKUP_CREATED'
  | 'BACKUP_RESTORED'
  | 'SECURITY_VIOLATION'
  | 'WEARABLE_SYNC_SUCCESS'
  | 'WEARABLE_SYNC_FAILED'
  | 'PROVIDER_DISCONNECTED'
  | 'ACCESS_DENIED';

export interface SecurityAuditEvent {
  eventType: SecurityAuditEventType;
  timestamp?: string;
  actorId?: string;
  tenantId?: string;
  resourceId?: string;
  action: string;
  status: 'SUCCESS' | 'DENIED' | 'FAILURE';
  ipAddress?: string;
  details?: Record<string, unknown>;
}

// Regex patterns for automatic token / credential / key redaction
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/gi,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, // JWT
  /(password|secret|key|dek|kek|token)\s*[:=]\s*["']?[^"',\s]+["']?/gi,
];

/**
 * Sanitizes and redacts any accidentally passed sensitive strings, tokens, or credentials.
 */
export function redactSensitiveData(input: unknown): unknown {
  if (typeof input === 'string') {
    let sanitized = input;
    for (const pattern of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED_SECRET]');
    }
    return sanitized;
  }

  if (Array.isArray(input)) {
    return input.map(redactSensitiveData);
  }

  if (input !== null && typeof input === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('password') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('apikey') ||
        lowerKey.includes('dek') ||
        lowerKey.includes('kek') ||
        lowerKey.includes('privatekey')
      ) {
        copy[key] = '[REDACTED]';
      } else {
        copy[key] = redactSensitiveData(value);
      }
    }
    return copy;
  }

  return input;
}

/**
 * Enterprise Structured Security Audit Logger
 *
 * Emits sanitized JSON audit events for compliance (HIPAA §164.312(b), SOC 2, ISO 27001).
 * Never emits medical payload contents, keys, or bearer tokens.
 */
export class SecurityAuditLogger {
  private static instance: SecurityAuditLogger;

  public static getInstance(): SecurityAuditLogger {
    if (!SecurityAuditLogger.instance) {
      SecurityAuditLogger.instance = new SecurityAuditLogger();
    }
    return SecurityAuditLogger.instance;
  }

  public static log(event: SecurityAuditEvent): void {
    SecurityAuditLogger.getInstance().logEvent(event);
  }

  public logEvent(event: SecurityAuditEvent): void {
    const sanitizedDetails = event.details
      ? (redactSensitiveData(event.details) as Record<string, unknown>)
      : undefined;

    const auditEntry = {
      audit: true,
      eventType: event.eventType,
      timestamp: event.timestamp || new Date().toISOString(),
      actorId: event.actorId ? String(event.actorId) : 'anonymous',
      tenantId: event.tenantId ? String(event.tenantId) : undefined,
      resourceId: event.resourceId,
      action: event.action,
      status: event.status,
      ipAddress: event.ipAddress || 'unknown',
      details: sanitizedDetails,
    };

    if (event.status === 'DENIED' || event.status === 'FAILURE') {
      logger.warn(`Security audit event: ${event.eventType} - ${event.action}`, auditEntry);
    } else {
      logger.info(`Security audit event: ${event.eventType} - ${event.action}`, auditEntry);
    }
  }
}

export const securityAuditLogger = SecurityAuditLogger.getInstance();
