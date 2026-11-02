import {
  KMSClient,
  EncryptedEnvelope,
  encryptEnvelope,
  decryptEnvelope,
  LocalSyntheticKMSAdapter,
} from './kms-adapter';
import { logger } from '@/lib/logger';

/**
 * Envelope Encryption Service
 *
 * Provides cryptographic isolation by generating per-document Data Encryption Keys (DEKs)
 * wrapped by master Key Encryption Keys (KEKs). Supported across local, cloud, and hybrid modes.
 */
export class EnvelopeEncryptionService {
  private readonly kmsClient: KMSClient;

  constructor(kmsClient?: KMSClient) {
    this.kmsClient = kmsClient || new LocalSyntheticKMSAdapter();
  }

  public async encrypt(
    plaintext: Buffer | string,
    keyId = 'default-master-kek',
    context?: Record<string, string>
  ): Promise<EncryptedEnvelope> {
    const envelope = await encryptEnvelope(plaintext, this.kmsClient, keyId, context);
    logger.debug('Generated encrypted envelope', { keyId, keyVersion: envelope.keyVersion });
    return envelope;
  }

  public async decrypt(envelope: EncryptedEnvelope): Promise<Buffer> {
    return decryptEnvelope(envelope, this.kmsClient);
  }
}
