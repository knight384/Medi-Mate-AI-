import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  parseWithBounds,
  safeParseWithBounds,
  validateStructuralBounds,
} from './structural-boundary';
import { StructuralBoundaryError } from '@/lib/errors';
import { HealthCheckupSchema } from '@/lib/health-data/parser/schema';

describe('Structural Boundary & Zod Pre-Validation Protection', () => {
  it('rejects oversized arrays before expensive element validation', () => {
    let elementEvaluations = 0;
    const ExpensiveElementSchema = z.string().refine((val) => {
      elementEvaluations++;
      return val.length > 0;
    });
    const ArraySchema = z.array(ExpensiveElementSchema);

    // Synthetic payload with 1,500 elements
    const oversizedArray = Array.from({ length: 1500 }, (_, i) => `item_${i}`);

    expect(() => {
      parseWithBounds(ArraySchema, oversizedArray, { maxArrayLength: 100 });
    }).toThrow(StructuralBoundaryError);

    // Crucial check: zero elements were evaluated by Zod, proving early rejection
    expect(elementEvaluations).toBe(0);
  });

  it('rejects excessive nesting depth before call stack exhaustion', () => {
    // Generate deeply nested object graph (depth = 20)
    let nested: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < 20; i++) {
      nested = { child: nested };
    }

    expect(() => {
      validateStructuralBounds(nested, { maxDepth: 5 });
    }).toThrow(StructuralBoundaryError);
  });

  it('rejects excessive dynamic object keys', () => {
    const wideObject: Record<string, number> = {};
    for (let i = 0; i < 600; i++) {
      wideObject[`key_${i}`] = i;
    }

    expect(() => {
      validateStructuralBounds(wideObject, { maxKeys: 100 });
    }).toThrow(StructuralBoundaryError);
  });

  it('rejects prototype pollution attempts', () => {
    const maliciousPayload = JSON.parse(
      '{"__proto__": {"admin": true}, "name": "attacker"}'
    );

    expect(() => {
      validateStructuralBounds(maliciousPayload);
    }).toThrow(/Prohibited object key '__proto__' detected/);

    const constructorPayload = { constructor: { prototype: { poll: 1 } } };
    expect(() => {
      validateStructuralBounds(constructorPayload);
    }).toThrow(/Prohibited object key 'constructor' detected/);
  });

  it('rejects oversized strings before memory allocation', () => {
    const oversizedString = 'x'.repeat(100_000);
    expect(() => {
      validateStructuralBounds({ message: oversizedString }, { maxStringLength: 10_000 });
    }).toThrow(/String length 100000 exceeds maximum limit/);
  });

  it('allows valid medical checkup results through parseWithBounds', () => {
    const validMedicalData = {
      date: '2026-10-30',
      name: 'Synthetic Patient',
      test_result: {
        cholesterol_total: { unit: 'mg/dL', value: '185' },
        hdl_cholesterol: { unit: 'mg/dL', value: '55' },
        ldl_cholesterol: { unit: 'mg/dL', value: '110' },
        triglycerides: { unit: 'mg/dL', value: '120' },
        glucose: { unit: 'mg/dL', value: '92' },
        hemoglobin_a1c: { unit: '%', value: '5.4' },
      },
    };

    const parsed = parseWithBounds(HealthCheckupSchema, validMedicalData, {
      maxDepth: 5,
      maxKeys: 500,
    });

    expect(parsed.name).toBe('Synthetic Patient');
    expect(parsed.test_result.cholesterol_total?.value).toBe('185');
    expect(parsed.test_result.glucose?.value).toBe('92');
  });

  it('returns formatted Zod error response via safeParseWithBounds on structural violation', () => {
    const oversizedArray = Array.from({ length: 50 }, () => 'item');
    const result = safeParseWithBounds(
      z.array(z.string()),
      oversizedArray,
      { maxArrayLength: 10 }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Array length 50 exceeds maximum limit of 10');
    }
  });
});

