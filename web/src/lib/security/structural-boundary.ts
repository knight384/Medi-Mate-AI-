import { z } from 'zod';
import { StructuralBoundaryError } from '@/lib/errors';

export interface StructuralBoundsOptions {
  /** Maximum nesting depth allowed (default: 8) */
  maxDepth?: number;
  /** Maximum number of keys on any single object (default: 500) */
  maxKeys?: number;
  /** Maximum number of items in any single array (default: 500) */
  maxArrayLength?: number;
  /** Maximum length of any string value (default: 65,536 characters) */
  maxStringLength?: number;
  /** Reject prototype pollution keys (__proto__, constructor, prototype) (default: true) */
  prohibitPrototypePollution?: boolean;
}

const DEFAULT_OPTIONS: Required<StructuralBoundsOptions> = {
  maxDepth: 8,
  maxKeys: 500,
  maxArrayLength: 500,
  maxStringLength: 65536,
  prohibitPrototypePollution: true,
};

/**
 * Fast O(N) structural preflight check that validates collection depth,
 * array bounds, object key counts, and string lengths before invoking Zod schema parsing.
 *
 * This provides defense-in-depth against GHSA-mrhx-c7xc-m3w5 (Zod 3 memory exhaustion
 * during validation of oversized or deeply nested structures) by rejecting hostile
 * payloads before Zod creates massive error collections or traverses unbounded graphs.
 */
export function validateStructuralBounds(
  value: unknown,
  options: StructuralBoundsOptions = {},
  currentDepth = 0
): void {
  const maxDepth = options.maxDepth ?? DEFAULT_OPTIONS.maxDepth;
  const maxKeys = options.maxKeys ?? DEFAULT_OPTIONS.maxKeys;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_OPTIONS.maxArrayLength;
  const maxStringLength = options.maxStringLength ?? DEFAULT_OPTIONS.maxStringLength;
  const prohibitProto = options.prohibitPrototypePollution ?? DEFAULT_OPTIONS.prohibitPrototypePollution;

  if (currentDepth > maxDepth) {
    throw new StructuralBoundaryError(
      `Structure nesting depth ${currentDepth} exceeds maximum limit of ${maxDepth}`
    );
  }

  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    if (value.length > maxStringLength) {
      throw new StructuralBoundaryError(
        `String length ${value.length} exceeds maximum limit of ${maxStringLength}`
      );
    }
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > maxArrayLength) {
      throw new StructuralBoundaryError(
        `Array length ${value.length} exceeds maximum limit of ${maxArrayLength}`
      );
    }
    for (let i = 0; i < value.length; i++) {
      validateStructuralBounds(value[i], options, currentDepth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > maxKeys) {
      throw new StructuralBoundaryError(
        `Object key count ${keys.length} exceeds maximum limit of ${maxKeys}`
      );
    }

    for (const key of keys) {
      if (prohibitProto && (key === '__proto__' || key === 'constructor' || key === 'prototype')) {
        throw new StructuralBoundaryError(
          `Prohibited object key '${key}' detected`
        );
      }
      if (key.length > maxStringLength) {
        throw new StructuralBoundaryError(
          `Object key length ${key.length} exceeds maximum limit of ${maxStringLength}`
        );
      }
      validateStructuralBounds((value as Record<string, unknown>)[key], options, currentDepth + 1);
    }
    return;
  }
}

/**
 * Pre-validates structural boundaries before calling Zod schema.parse().
 * Guarantees that oversized collections or deep recursion never reach Zod's internal loop.
 */
export function parseWithBounds<T>(
  schema: z.ZodType<T>,
  data: unknown,
  options?: StructuralBoundsOptions
): T {
  validateStructuralBounds(data, options);
  return schema.parse(data);
}

/**
 * Pre-validates structural boundaries before calling Zod schema.safeParse().
 */
export function safeParseWithBounds<T>(
  schema: z.ZodType<T>,
  data: unknown,
  options?: StructuralBoundsOptions
): z.SafeParseReturnType<unknown, T> {
  try {
    validateStructuralBounds(data, options);
  } catch (error) {
    if (error instanceof StructuralBoundaryError) {
      return {
        success: false,
        error: new z.ZodError([
          {
            code: z.ZodIssueCode.custom,
            message: error.message,
            path: [],
          },
        ]),
      };
    }
    throw error;
  }
  return schema.safeParse(data);
}

