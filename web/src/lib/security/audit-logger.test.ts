import { describe, it, expect } from 'vitest';
import { redactSensitiveData, securityAuditLogger } from './audit-logger';
import { validateOutboundUrl, SSRFProtectionError } from './ssrf-protection';

describe('Security Audit Logging & SSRF Network Protection', () => {
  describe('Audit Log Sanitization & Redaction', () => {
    it('redacts sensitive API keys, Bearer tokens, and password fields', () => {
      const rawDetails = {
        userId: 'patient_101',
        action: 'EXTERNAL_INFERENCE_REQUEST',
        apiKey: 'sk-ant-api03-abcdef123456789012345678',
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozGz',
        dbPassword: 'super_secret_db_password_123',
        documentTitle: 'Annual Physical Results',
        nested: {
          dek: 'super-secret-dek-bytes',
          allowedProp: 'safe-metadata-value',
        },
      };

      const sanitized = redactSensitiveData(rawDetails) as Record<string, unknown>;

      expect(sanitized.userId).toBe('patient_101');
      expect(sanitized.documentTitle).toBe('Annual Physical Results');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.dbPassword).toBe('[REDACTED]');
      expect((sanitized.nested as Record<string, unknown>).dek).toBe('[REDACTED]');
      expect((sanitized.nested as Record<string, unknown>).allowedProp).toBe('safe-metadata-value');

      // Check text-level redaction
      const textWithBearer = 'Failed call with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 token';
      expect(redactSensitiveData(textWithBearer)).toContain('[REDACTED_SECRET]');
    });

    it('emits sanitized audit log events without throwing', () => {
      expect(() => {
        securityAuditLogger.logEvent({
          eventType: 'DOCUMENT_READ',
          actorId: 'user_42',
          action: 'READ_CLINICAL_DOCUMENT',
          status: 'SUCCESS',
          details: {
            storageKey: 'users/user_42/chart.pdf',
            ip: '192.168.1.1',
          },
        });
      }).not.toThrow();

      expect(() => {
        securityAuditLogger.logEvent({
          eventType: 'EGRESS_BLOCKED',
          actorId: 'user_42',
          action: 'CLOUD_FALLBACK_REJECTED',
          status: 'DENIED',
          details: {
            reason: 'User revoked consent for cloud AI',
          },
        });
      }).not.toThrow();
    });
  });

  describe('SSRF Outbound Destination Protection', () => {
    it('blocks AWS and GCP cloud metadata endpoints unconditionally', () => {
      expect(() => validateOutboundUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
        SSRFProtectionError
      );
      expect(() => validateOutboundUrl('http://metadata.google.internal/computeMetadata/v1/')).toThrow(
        SSRFProtectionError
      );
      expect(() => validateOutboundUrl('http://169.254.170.2/v2/credentials')).toThrow(
        SSRFProtectionError
      );
    });

    it('blocks private and loopback IPs when allowLocalNetwork is false', () => {
      expect(() => validateOutboundUrl('http://127.0.0.1:8080/admin')).toThrow(SSRFProtectionError);
      expect(() => validateOutboundUrl('http://localhost:3000/api')).toThrow(SSRFProtectionError);
      expect(() => validateOutboundUrl('http://10.0.1.5:5432')).toThrow(SSRFProtectionError);
      expect(() => validateOutboundUrl('http://192.168.1.100/status')).toThrow(SSRFProtectionError);
    });

    it('allows approved public HTTPS targets and allowlisted endpoints', () => {
      const parsed = validateOutboundUrl('https://api.openai.com/v1/chat/completions');
      expect(parsed.hostname).toBe('api.openai.com');

      const allowedLocal = validateOutboundUrl('http://localhost:11434/api/generate', {
        allowLocalNetwork: true,
      });
      expect(allowedLocal.hostname).toBe('localhost');
    });

    it('enforces HTTPS when requireHttps is true', () => {
      expect(() =>
        validateOutboundUrl('http://api.anthropic.com/v1/messages', { requireHttps: true })
      ).toThrow('HTTPS required');
    });
  });
});
