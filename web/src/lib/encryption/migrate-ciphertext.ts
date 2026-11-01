import { encrypt, decrypt, getCiphertextVersion, EncryptionError } from './index';

export interface RecordCiphertextMigration {
  id: string;
  originalCiphertext: string;
  newCiphertext?: string;
  status: 'migrated' | 'already_v2' | 'skipped_empty' | 'failed';
  error?: string;
}

export interface MigrationSummary {
  totalRecords: number;
  migrated: number;
  alreadyV2: number;
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
 * Safely migrates an individual encrypted string from legacy CBC (or v1) to authenticated AES-256-GCM (v2).
 * Verifies round-trip integrity before returning the migrated ciphertext.
 *
 * @param ciphertext - The raw or versioned ciphertext.
 * @param aad - Optional Additional Authenticated Data to bind during re-encryption.
 */
export function migrateCiphertextString(
  ciphertext: string,
  aad?: string | Buffer
): { newCiphertext: string; wasMigrated: boolean } {
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

  // 2. Re-encrypt with modern authenticated AES-256-GCM
  const newCiphertext = encrypt(plaintext, aad);

  // 3. Round-trip integrity verification before committing
  let verifiedPlaintext: string;
  try {
    verifiedPlaintext = decrypt(newCiphertext, aad);
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
 * Maintains recoverable in-memory backups and refuses to overwrite records on verification failure.
 */
export async function migrateLlmProviderApiKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaClient: any,
  options: { dryRun?: boolean } = {}
): Promise<MigrationSummary> {
  const dryRun = options.dryRun ?? false;

  const records: Array<{ id: string; apiKey: string }> = await prismaClient.lLMProvider.findMany({
    select: { id: true, apiKey: true },
  });

  const summary: MigrationSummary = {
    totalRecords: records.length,
    migrated: 0,
    alreadyV2: 0,
    skippedEmpty: 0,
    failed: 0,
    backups: [],
  };

  for (const record of records) {
    const backupEntry: RecordCiphertextMigration = {
      id: record.id,
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
      const { newCiphertext, wasMigrated } = migrateCiphertextString(record.apiKey);
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
