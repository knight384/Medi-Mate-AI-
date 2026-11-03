import { describe, it, expect } from 'vitest';
import {
  EncryptedBackupService,
  BackupSourceData,
} from '@/lib/backup/backup-service';

describe('Phase 9 — Encrypted Backup & Disaster Recovery Drill Suite', () => {
  const backupService = new EncryptedBackupService();

  it('creates an authenticated encrypted backup archive and verifies manifest metadata', async () => {
    const backupKey = EncryptedBackupService.generateBackupKey();
    expect(backupKey.length).toBe(32);

    const syntheticDocBuffer = Buffer.from('MM_ENC03_SYNTHETIC_CIPHERTEXT_PAYLOAD_FOR_BACKUP');
    const sourceData: BackupSourceData = {
      deploymentMode: 'local',
      keyVersion: 'k001',
      databaseRecords: {
        HealthData: [
          { id: 'rec_01', type: 'PERSONAL_INFO', data: { conditions: ['Mild Asthma'] }, authorId: 'user_dr_01' },
          { id: 'rec_02', type: 'WEARABLE_SUMMARY', data: { period: 'WEEKLY', avgRhr: 65 }, authorId: 'user_dr_01' },
        ],
        UserHealthMemory: [
          { id: 'mem_01', category: 'GOAL', key: 'cardio', content: 'Target 30m aerobic activity' },
        ],
      },
      encryptedDocuments: new Map([
        ['synthetic_doc_key_01.pdf', syntheticDocBuffer],
      ]),
    };

    const backup = await backupService.createEncryptedBackup(sourceData, backupKey);
    expect(backup.backupBuffer).toBeDefined();
    expect(backup.manifest.formatVersion).toBe('MM_BAK01');
    expect(backup.manifest.databaseRecordsCount).toBe(3);
    expect(backup.manifest.documentsCount).toBe(1);
    expect(backup.manifest.payloadSha256).toBeDefined();

    // Verify recovery drill: restore into a target environment
    const targetStorage = new Map<string, Buffer>();
    const mockDriver = {
      restoreRawEncryptedObject: async (key: string, data: Buffer) => {
        targetStorage.set(key, data);
      },
    };

    const restored = await backupService.restoreBackup(
      backup.backupBuffer,
      backupKey,
      mockDriver as any
    );

    expect(restored.success).toBe(true);
    expect(restored.restoredRecordsCount).toBe(3);
    expect(restored.restoredDocumentsCount).toBe(1);
    expect(targetStorage.get('synthetic_doc_key_01.pdf')?.toString()).toBe(syntheticDocBuffer.toString());
  });

  it('detects tampering in backup archives and rejects corrupted restore attempts', async () => {
    const backupKey = EncryptedBackupService.generateBackupKey();
    const sourceData: BackupSourceData = {
      deploymentMode: 'local',
      keyVersion: 'k001',
      databaseRecords: { HealthData: [] },
      encryptedDocuments: new Map(),
    };

    const backup = await backupService.createEncryptedBackup(sourceData, backupKey);
    const corruptedBuffer = Buffer.from(backup.backupBuffer);
    corruptedBuffer[corruptedBuffer.length - 1] ^= 0xaa; // Corrupt ciphertext bit

    const mockDriver = {
      restoreRawEncryptedObject: async () => {},
    };

    await expect(
      backupService.restoreBackup(corruptedBuffer, backupKey, mockDriver as any)
    ).rejects.toThrow();
  });
});
