/**
 * Naming and Path Sanitization Utilities
 *
 * Adapted from mirobody (mirobody/agent/filesystem/naming.py)
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Modifications: Ported from Python to TypeScript for MediMate AI.
 * Added cryptographic UUID storage key generation and path validation.
 * Added optional deterministic seed support for crash-safe migration idempotency.
 */

import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Sanitizes a client-provided filename down to a single safe basename segment.
 * Collapses both '/' and '\', strips whitespace, and rejects '.' and '..' navigation.
 */
export function safeBasename(filename: string | null | undefined): string {
  if (!filename) return '';
  // Normalize Windows and POSIX separators
  const normalized = String(filename).replace(/\\/g, '/');
  const base = path.posix.basename(normalized).trim();
  if (!base || base === '.' || base === '..') {
    return '';
  }
  // Strip null bytes and non-printable control characters
  return base.replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Generates an opaque, cryptographically random (or deterministic) storage key.
 * Format: users/<userId>/<uuid>.<extension>
 *
 * When an optional seed (e.g. recordId) is provided, produces a deterministic UUIDv4-formatted
 * key, ensuring that retries or concurrent workers converge on the same target file.
 *
 * Never uses the original filename as the physical storage path.
 * Strictly validates userId against alphanumeric/hyphen/underscore patterns to prevent
 * identifier normalization collisions.
 */
export function generateStorageKey(userId: string, extension: string, seed?: string): string {
  const safeExt = extension.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!userId || typeof userId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error('Invalid userId: must contain only alphanumeric characters, underscores, and hyphens');
  }

  const safeUser = safeBasename(userId);
  if (!safeUser) {
    throw new Error('Invalid userId for storage key generation');
  }

  let fileId: string;
  if (seed) {
    // Length-delimited framing prevents delimiter injection/collision across userId and seed
    const hex = crypto.createHash('sha256').update(`${userId.length}:${userId}:${seed}`).digest('hex');
    fileId = `${hex.substring(0, 8)}-${hex.substring(8, 12)}-4${hex.substring(13, 16)}-a${hex.substring(17, 20)}-${hex.substring(20, 32)}`;
  } else {
    fileId = crypto.randomUUID();
  }

  return `users/${safeUser}/${fileId}.${safeExt || 'bin'}`;
}

/**
 * Validates that an internal storage key follows the required structure
 * and does not contain path traversal attempts ('..').
 */
export function isValidStorageKey(storageKey: string): boolean {
  if (!storageKey || typeof storageKey !== 'string') return false;
  if (storageKey.includes('..') || storageKey.includes('\\') || storageKey.startsWith('/')) {
    return false;
  }
  // Must match users/<userId>/<fileId>.<ext> or tenants/<tenantId>/<fileId>.<ext>
  return /^(?:users|tenants)\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(storageKey);
}

/**
 * Extracts the user or tenant namespace (userId/tenantId) from a valid internal storage key.
 * Returns null if the storage key format is invalid.
 */
export function extractStorageKeyOwner(storageKey: string): string | null {
  if (!isValidStorageKey(storageKey)) return null;
  const match = /^(?:users|tenants)\/([a-zA-Z0-9_-]+)\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.exec(storageKey);
  return match ? match[1] : null;
}

/**
 * Validates that an already-private storage key is structurally valid,
 * belongs exclusively to the expected owner, and has a permitted extension.
 */
export function isValidPrivateDocumentKey(
  storageKey: string,
  expectedOwner: string,
  allowedExtensions?: Set<string>
): boolean {
  if (!isValidStorageKey(storageKey)) return false;
  const owner = extractStorageKeyOwner(storageKey);
  if (!owner || owner !== expectedOwner) return false;

  if (allowedExtensions) {
    const ext = path.posix.extname(storageKey).toLowerCase();
    if (!allowedExtensions.has(ext)) return false;
  }

  return true;
}
