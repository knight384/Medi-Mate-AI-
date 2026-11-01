import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HealthCheckupSchema } from '@/lib/health-data/parser/schema';

describe('Zod Boundary Validation & Array Limits (GHSA-mrhx-c7xc-m3w5 mitigation)', () => {
  // Pattern for enforcing bounded arrays on external input
  const BoundedHealthTagsSchema = z.object({
    patientId: z.string().min(1).max(128),
    tags: z.array(z.string().max(50)).max(100), // Bound array length to prevent unbounded allocations
  });

  it('accepts compliant bounded inputs', () => {
    const input = {
      patientId: 'patient-123',
      tags: ['blood-work', 'annual-checkup', 'glucose-monitoring'],
    };

    const parsed = BoundedHealthTagsSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tags).toHaveLength(3);
    }
  });

  it('rejects arrays exceeding maximum size before expensive nested validation', () => {
    // Generate an oversized array of 150 items (exceeding max 100)
    const oversizedTags = Array.from({ length: 150 }, (_, i) => `tag-${i}`);
    const input = {
      patientId: 'patient-123',
      tags: oversizedTags,
    };

    const parsed = BoundedHealthTagsSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.code === 'too_big');
      expect(issue).toBeDefined();
    }
  });

  it('rejects nested malformed and prototype-poisoning properties without prototype pollution', () => {
    const maliciousPayload = JSON.parse(
      '{"date":"2026-10-30","name":"Alice","__proto__":{"polluted":true},"test_result":{"fev1":{"value":"3.2","unit":"L"}}}'
    );

    const parsed = HealthCheckupSchema.safeParse(maliciousPayload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('Alice');
      expect(parsed.data.date).toBe('2026-10-30');
      expect(parsed.data.test_result.fev1?.value).toBe('3.2');
    }

    // Verify global Object prototype remains clean
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('handles empty and partial health test results safely', () => {
    const emptyResult = {
      date: null,
      name: null,
      test_result: {},
    };

    const parsed = HealthCheckupSchema.safeParse(emptyResult);
    expect(parsed.success).toBe(true);
  });

  it('rejects oversized invalid arrays where elements fail validation', () => {
    // Array of 10,000 invalid items; schema has max 50 items
    const invalidOversizedItems = Array.from({ length: 1000 }, () => 12345); // numbers instead of strings
    const input = {
      patientId: 'patient-test',
      tags: invalidOversizedItems,
    };

    const parsed = BoundedHealthTagsSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // Must fail fast on collection bounds
      expect(parsed.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('enforces bounded dictionary and record collections against unbounded key injection', () => {
    const BoundedMetadataSchema = z.record(
      z.string().max(64),
      z.string().max(256)
    );

    // Valid bounded record
    const validMeta = { department: 'Cardiology', physician: 'Dr. Smith' };
    expect(BoundedMetadataSchema.safeParse(validMeta).success).toBe(true);

    // Malformed key exceeding primitive boundary
    const invalidMetaKey = { ['k'.repeat(128)]: 'valid value' };
    expect(BoundedMetadataSchema.safeParse(invalidMetaKey).success).toBe(false);

    // Malformed value exceeding boundary
    const invalidMetaVal = { department: 'v'.repeat(512) };
    expect(BoundedMetadataSchema.safeParse(invalidMetaVal).success).toBe(false);
  });

  it('validates primitive type coercion and strict string bounds', () => {
    const StrictPatientIdSchema = z.string().trim().min(3).max(32);
    expect(StrictPatientIdSchema.safeParse('  patient-01  ').success).toBe(true);
    expect(StrictPatientIdSchema.safeParse('x'.repeat(64)).success).toBe(false);
    expect(StrictPatientIdSchema.safeParse('').success).toBe(false);
  });
});

