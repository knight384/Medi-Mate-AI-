import { encrypt, decrypt, getCiphertextVersion, EncryptionError } from './index';
import { logger } from '@/lib/logger';

export type MigrationRecordStatus =
  | 'migrated'
  | 'already_v2'
  | 'ambiguous_manual_reentry_required'
  | 'skipped_empty'
  | 'failed'
  | 'rolled_back';

export interface RecordCiphertextMigration {
  id: string;
  providerId?: string;
  originalCiphertext: string;
  newCiphertext?: string;
  status: MigrationRecordStatus;
  formatCheck?: 'valid' | 'ambiguous' | 'corrupt';
  error?: string;
}

export interface MigrationSummary {
  totalRecords: number;
  migrated: number;
  alreadyV2: number;
  ambiguousRequiresReentry: number;
  skippedEmpty: number;
  failed: number;
  backups: RecordCiphertextMigration[];
}

export class CiphertextMigrationError extends Error {
  public readonly details: RecordCiphertextMigration;

  constructor(message: string, details: RecordCiphertextMigration) {
    super(message);
    this.name = 'CiphertextMigrationError';
    this.details = details;
  }
}

/**
 * Validates decrypted plaintext against expected provider formats.
 * Printable UTF-8 checks are plausibility checks, not cryptographic proof of authenticity.
 * If a secret does not match expected provider patterns, operator re-entry is required.
 */
export function validateProviderKeyPlausibility(
  providerId: string | undefined,
  plaintext: string
): { plausible: boolean; reason?: string } {
  if (!plaintext || plaintext.trim() === '') {
    return { plausible: false, reason: 'Decrypted key is empty' };
  }

  // General binary/control character check
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(plaintext)) {
    return { plausible: false, reason: 'Contains unprintable control characters' };
  }

  const normalizedProvider = providerId?.toLowerCase();

  switch (normalizedProvider) {
    case 'openai':
      // OpenAI keys start with sk- or sk-proj- and are typically at least 20 chars
      if (!plaintext.startsWith('sk-') || plaintext.length < 20) {
        return {
          plausible: false,
          reason: 'OpenAI API key does not conform to sk-... format',
        };
      }
      return { plausible: true };

    case 'anthropic':
      // Anthropic keys start with sk-ant- and are typically at least 20 chars
      if (!plaintext.startsWith('sk-ant-') || plaintext.length < 20) {
        return {
          plausible: false,
          reason: 'Anthropic API key does not conform to sk-ant-... format',
        };
      }
      return { plausible: true };

    case 'google':
      // Google API keys generally start with AIza and are at least 20 chars
      if (!plaintext.startsWith('AIza') && plaintext.length < 20) {
        return {
          plausible: false,
          reason: 'Google Generative AI key does not conform to expected format',
        };
      }
      return { plausible: true };

    case 'ollama':
      // Ollama keys can be empty or custom tokens, but if provided must be printable
      return { plausible: true };

    default:
      // Generic provider: require at least 8 printable characters
      if (plaintext.length < 8) {
        return {
          plausible: false,
          reason: 'Generic secret is too short (< 8 characters)',
        };
      }
      return { plausible: true };
  }
}

/**
 * Safely masks secret for audit logging without leaking the secret plaintext.
 */
export function maskSecretForAudit(plaintext: string): string {
  if (!plaintext || plaintext.length < 8) {
    return '***';
  }
  return `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}`;
}

/**
 * Ciphertext Migration Utility
 *
 * Facilitates safe, audited migration of legacy unauthenticated AES-256-CBC ciphertexts
 * to authenticated AES-256-GCM ciphertexts (v2).
 *
 * Cryptographic Note on Legacy CBC:
 * Historical AES-256-CBC encryption without an HMAC or MAC lacks cryptographic integrity
 * and authenticity guarantees. An attacker with write access to the database could flip bits
 * in ciphertext blocks or forge padding without detection by the cipher itself.
 * Therefore, during migration from legacy CBC, decrypted secrets MUST undergo format
 * validation before re-encrypting under AES-256-GCM.
 *
 * If decrypted plaintext is ambiguous or fails plausibility, migration stops for that secret,
 * the original ciphertext is preserved, and manual re-entry is required.
 */
export function migrateCiphertextString(
  ciphertext: string,
  options: {
    aad?: string | Buffer;
    providerId?: string;
    strictProviderValidation?: boolean;
  } = {}
): {
  newCiphertext: string;
  wasMigrated: boolean;
  isAmbiguous?: boolean;
  reason?: string;
} {
  if (!ciphertext || ciphertext.trim() === '') {
    return { newCiphertext: ciphertext, wasMigrated: false };
  }

  const version = getCiphertextVersion(ciphertext);
  if (version === 'v2') {
    return { newCiphertext: ciphertext, wasMigrated: false };
  }

  if (version === 'unrecognized') {
    throw new EncryptionError(
      'Cannot migrate unrecognized ciphertext format',
      'UNRECOGNIZED_CIPHERTEXT'
    );
  }

  // 1. Controlled legacy CBC decryption
  let plaintext: string;
  try {
    plaintext = decrypt(ciphertext);
  } catch (decErr) {
    throw new EncryptionError(
      `Legacy decryption failed during migration: ${(decErr as Error).message}`,
      'MIGRATION_DECRYPT_FAILED'
    );
  }

  // 2. Format validation: Legacy CBC lacks cryptographic authenticity (no MAC).
  if (!plaintext || plaintext.length === 0) {
    throw new EncryptionError(
      'Decrypted legacy secret is empty; cannot migrate invalid secret',
      'INVALID_SECRET_FORMAT'
    );
  }

  const plausibility = validateProviderKeyPlausibility(options.providerId, plaintext);
  if (!plausibility.plausible) {
    if (options.strictProviderValidation) {
      return {
        newCiphertext: ciphertext,
        wasMigrated: false,
        isAmbiguous: true,
        reason: plausibility.reason,
      };
    }
    // If control characters were found, fail hard
    if (plausibility.reason?.includes('control characters')) {
      throw new EncryptionError(
        `Decrypted legacy secret failed format validation: ${plausibility.reason}`,
        'INVALID_SECRET_FORMAT'
      );
    }
  }

  // 3. Re-encrypt with modern authenticated AES-256-GCM
  const newCiphertext = encrypt(plaintext, options.aad);

  // 4. Round-trip integrity verification before committing
  let verifiedPlaintext: string;
  try {
    verifiedPlaintext = decrypt(newCiphertext, options.aad);
  } catch (verifyErr) {
    throw new EncryptionError(
      `Round-trip integrity verification failed during migration: ${(verifyErr as Error).message}`,
      'MIGRATION_VERIFICATION_FAILED'
    );
  }

  if (verifiedPlaintext !== plaintext) {
    throw new EncryptionError(
      'Cryptographic mismatch: decrypted plaintext does not match original value during migration',
      'MIGRATION_INTEGRITY_MISMATCH'
    );
  }

  return { newCiphertext, wasMigrated: true };
}

/**
 * Migrates LLMProvider API keys in the database from legacy CBC to authenticated AES-256-GCM.
 * Maintains recoverable backups of original ciphertext and refuses to overwrite records on ambiguity.
 */
export async function migrateLlmProviderApiKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaClient: any,
  options: { dryRun?: boolean; strictProviderValidation?: boolean } = {}
): Promise<MigrationSummary> {
  const dryRun = options.dryRun ?? false;
  const strictValidation = options.strictProviderValidation ?? true;

  const records: Array<{ id: string; providerId?: string; apiKey: string }> =
    await prismaClient.lLMProvider.findMany({
      select: { id: true, providerId: true, apiKey: true },
    });

  const summary: MigrationSummary = {
    totalRecords: records.length,
    migrated: 0,
    alreadyV2: 0,
    ambiguousRequiresReentry: 0,
    skippedEmpty: 0,
    failed: 0,
    backups: [],
  };

  for (const record of records) {
    const backupEntry: RecordCiphertextMigration = {
      id: record.id,
      providerId: record.providerId,
      originalCiphertext: record.apiKey,
      status: 'migrated',
    };

    if (!record.apiKey || record.apiKey.trim() === '') {
      backupEntry.status = 'skipped_empty';
      summary.skippedEmpty++;
      summary.backups.push(backupEntry);
      continue;
    }

    if (record.apiKey.startsWith('v2:')) {
      backupEntry.status = 'already_v2';
      summary.alreadyV2++;
      summary.backups.push(backupEntry);
      continue;
    }

    try {
      const { newCiphertext, wasMigrated, isAmbiguous, reason } = migrateCiphertextString(
        record.apiKey,
        {
          providerId: record.providerId,
          strictProviderValidation: strictValidation,
        }
      );

      if (isAmbiguous) {
        backupEntry.status = 'ambiguous_manual_reentry_required';
        backupEntry.error = reason;
        summary.ambiguousRequiresReentry++;
        summary.backups.push(backupEntry);
        logger.warn('Preserved ambiguous legacy CBC secret; operator re-entry required', {
          providerRecordId: record.id,
          providerId: record.providerId,
          reason,
        });
        continue;
      }

      backupEntry.newCiphertext = newCiphertext;

      if (wasMigrated) {
        if (!dryRun) {
          await prismaClient.lLMProvider.update({
            where: { id: record.id },
            data: { apiKey: newCiphertext },
          });
        }
        summary.migrated++;
      }
    } catch (err) {
      backupEntry.status = 'failed';
      backupEntry.error = err instanceof Error ? err.message : String(err);
      summary.failed++;
    }

    summary.backups.push(backupEntry);
  }

  return summary;
}

/**
 * Rolls back migrated records to their preserved original ciphertexts.
 */
export async function rollbackLlmProviderMigrations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaClient: any,
  backups: RecordCiphertextMigration[]
): Promise<{ restored: number; failed: number }> {
  let restored = 0;
  let failed = 0;

  for (const backup of backups) {
    if (backup.status === 'migrated' && backup.originalCiphertext) {
      try {
        await prismaClient.lLMProvider.update({
          where: { id: backup.id },
          data: { apiKey: backup.originalCiphertext },
        });
        restored++;
      } catch (err) {
        failed++;
        logger.error('Failed to rollback LLMProvider API key migration', {
          recordId: backup.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { restored, failed };
}
