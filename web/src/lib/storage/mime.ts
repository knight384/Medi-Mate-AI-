/**
 * MIME Type Lookup and Document Validation
 *
 * Adapted from mirobody (mirobody/utils/file_types.py)
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Modifications: Ported from Python to TypeScript for MediMate AI.
 * Added strict medical document allowlist and executable extension blocking.
 */

import path from 'node:path';

/**
 * Pinned Extension -> MIME mapping to avoid host machine-dependent /etc/mime.types inconsistencies.
 */
export const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
});

/**
 * Permitted MIME types for uploaded medical documents.
 */
export const PERMITTED_DOCUMENT_MIMES = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/**
 * Blocked hostile / executable extensions.
 */
const BLOCKED_EXTENSIONS = new Set<string>([
  '.exe', '.bat', '.cmd', '.sh', '.bash', '.bin', '.js', '.mjs',
  '.cjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.php', '.phtml',
  '.asp', '.aspx', '.jsp', '.py', '.rb', '.pl', '.svg', '.xml',
  '.dll', '.so', '.dylib', '.com', '.vbs', '.ps1',
]);

/**
 * Determines the MIME type from a filename or extension.
 */
export function guessMime(filename: string | null | undefined): string {
  if (!filename) return 'application/octet-stream';
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Validates whether a file extension and declared MIME type are permitted for medical documents.
 */
export function isPermittedDocument(filename: string, detectedMime: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return false;
  }
  return PERMITTED_DOCUMENT_MIMES.has(detectedMime);
}
