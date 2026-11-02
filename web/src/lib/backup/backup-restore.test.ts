import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EncryptedBackupService, BackupIntegrityError } from './backup-service';
import { LocalStorageDriver } from '@/lib/storage/local-driver';
import { generateStorageKey } from '@/lib/storage/naming';

describe('Encrypted Backup & Disaster Recovery Service', () => {
  let tempDir: string;
  let restoreDir: string;
  let backupService: EncryptedBackupService;
  let driver: LocalStorageDriver;
  let restoreDriver: LocalStorageDriver;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup_source_'));
    restoreDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup_restore_'));

    backupService = new EncryptedBackupService();
    driver = new LocalStorageDriver(tempDir);
    restoreDriver = new LocalStorageDriver(restoreDir);

    await driver.init();
    await restoreDriver.init();
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
    await fsp.rm(restoreDir, { recursive: true, force: true });
  });

  it('creates and verifies an encrypted backup archive without exposing plaintext', async () => {
    const backupKey = EncryptedBackupService.generateBackupKey();
    const storageKey1 = generateStorageKey('patient_01', '.pdf');
    const storageKey2 = generateStorageKey('patient_02', '.pdf');

    const plaintext1 = Buffer.from('%PDF-1.4 Clinical Chemistry Panel for Patient 01');
    const plaintext2 = Buffer.from('%PDF-1.4 Cardiac Angiogram Imaging Notes for Patient 02');

    await driver.writeStream(storageKey1, plaintext1);
    await driver.writeStream(storageKey2, plaintext2);

    // Read the encrypted disk bytes
    const encryptedDoc1 = await fsp.readFile(driver.resolveSecurePath(storageKey1));
    const encryptedDoc2 = await fsp.readFile(driver.resolveSecurePath(storageKey2));

    const docsMap = new Map<string, Buffer>();
    docsMap.set(storageKey1, encryptedDoc1);
    docsMap.set(storageKey2, encryptedDoc2);

    const dbRecords = {
      users: [
        { id: 'user_01', email: 'alice@example.com' },
        { id: 'user_02', email: 'bob@example.com' },
      ],
      blood_test_results: [
        { id: 'btr_01', userId: 'user_01', testName: 'Lipid Panel' },
      ],
    };

    const { backupBuffer, manifest, sha256 } = await backupService.createEncryptedBackup(
      {
        deploymentMode: 'hybrid',
        keyVersion: 'k001',
        databaseRecords: dbRecords,
        encryptedDocuments: docsMap,
      },
      backupKey
    );

    expect(manifest.formatVersion).toBe('MM_BAK01');
    expect(manifest.documentsCount).toBe(2);
    expect(manifest.databaseRecordsCount).toBe(3);
    expect(sha256).toBeDefined();

    // Verify raw archive does NOT leak plaintext medical data or patient emails
    const rawArchiveStr = backupBuffer.toString('utf8');
    expect(rawArchiveStr).not.toContain('Clinical Chemistry Panel');
    expect(rawArchiveStr).not.toContain('alice@example.com');

    // Verify integrity succeeds with valid key
    const verification = await backupService.verifyBackup(backupBuffer, backupKey);
    expect(verification.isValid).toBe(true);
    expect(verification.manifest.payloadSha256).toBe(manifest.payloadSha256);
  });

  it('rejects backup verification when using an incorrect key', async () => {
    const validKey = EncryptedBackupService.generateBackupKey();
    const wrongKey = EncryptedBackupService.generateBackupKey();

    const { backupBuffer } = await backupService.createEncryptedBackup(
      {
        deploymentMode: 'local',
        keyVersion: 'k001',
        databaseRecords: { users: [{ id: 'u1' }] },
        encryptedDocuments: new Map(),
      },
      validKey
    );

    await expect(backupService.verifyBackup(backupBuffer, wrongKey)).rejects.toThrow(
      BackupIntegrityError
    );
  });

  it('rejects backup verification when ciphertext has been tampered with', async () => {
    const backupKey = EncryptedBackupService.generateBackupKey();
    const { backupBuffer } = await backupService.createEncryptedBackup(
      {
        deploymentMode: 'local',
        keyVersion: 'k001',
        databaseRecords: { users: [] },
        encryptedDocuments: new Map(),
      },
      backupKey
    );

    // Flip a byte in the encrypted payload
    const corruptedBuffer = Buffer.from(backupBuffer);
    corruptedBuffer[corruptedBuffer.length - 10] ^= 0xff;

    await expect(backupService.verifyBackup(corruptedBuffer, backupKey)).rejects.toThrow(
      BackupIntegrityError
    );
  });

  it('executes a complete Disaster Recovery Drill: restores database records and encrypted documents', async () => {
    const backupKey = EncryptedBackupService.generateBackupKey();
    const storageKey = generateStorageKey('disaster_patient', '.pdf');
    const originalPlaintext = Buffer.from('%PDF-1.7 Emergency Trauma Surgical Summary');

    await driver.writeStream(storageKey, originalPlaintext);
    const encryptedDoc = await fsp.readFile(driver.resolveSecurePath(storageKey));

    const docsMap = new Map([[storageKey, encryptedDoc]]);
    const dbRecords = {
      users: [{ id: 'p_disaster', role: 'PATIENT' }],
      chat_rooms: [{ id: 'room_99', userId: 'p_disaster' }],
    };

    // 1. Create encrypted backup
    const { backupBuffer, manifest } = await backupService.createEncryptedBackup(
      {
        deploymentMode: 'local',
        keyVersion: 'k001',
        databaseRecords: dbRecords,
        encryptedDocuments: docsMap,
      },
      backupKey
    );

    // 2. Simulate disaster recovery into an empty restore environment
    expect(await restoreDriver.exists(storageKey)).toBe(false);

    const restoreResult = await backupService.restoreBackup(backupBuffer, backupKey, restoreDriver);
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.restoredDocumentsCount).toBe(1);
    expect(restoreResult.restoredRecordsCount).toBe(2);
    expect(restoreResult.manifest.payloadSha256).toBe(manifest.payloadSha256);

    // 3. Confirm document exists in restored driver
    expect(await restoreDriver.exists(storageKey)).toBe(true);

    // 4. Decrypt restored document and verify exact 100% byte fidelity
    const readResult = await restoreDriver.readStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of readResult.stream) {
      chunks.push(Buffer.from(chunk));
    }
    const restoredPlaintext = Buffer.concat(chunks);
    expect(restoredPlaintext.equals(originalPlaintext)).toBe(true);
  });
});
