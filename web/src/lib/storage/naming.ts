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
 * Generates an opaque, cryptographically random storage key.
 * Format: users/<userId>/<uuid>.<extension>
 *
 * Never uses the original filename as the physical storage path.
 */
export function generateStorageKey(userId: string, extension: string): string {
  const safeExt = extension.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fileId = crypto.randomUUID();
  const safeUser = safeBasename(userId);
  if (!safeUser) {
    throw new Error('Invalid userId for storage key generation');
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
  // Must match users/<userId>/<fileId>.<ext>
  return /^users\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(storageKey);
}
