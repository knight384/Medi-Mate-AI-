import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { LocalStorageDriver } from '../local-driver';
import { generateStorageKey } from '../naming';
import {
  migrateStorageDocumentFile,
  recoverInterruptedStorageMigrations,
  inspectStorageDocument,
} from './migrate-storage-encryption';

describe('Part D — Crash-Safe Storage Migration & Multi-State Failure Recovery (Checkpoint 5D.25)', () => {
  let testStorageRoot: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    testStorageRoot = path.join(os.tmpdir(), `medimate-crash-test-${crypto.randomUUID()}`);
    await fsp.mkdir(testStorageRoot, { recursive: true, mode: 0o700 });
    driver = new LocalStorageDriver({ customStorageDir: testStorageRoot });
    await driver.init();
  });

  afterEach(async () => {
    try {
      await fsp.rm(testStorageRoot, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('State 1: original file intact, orphaned .tmp scratch left from crash during encryption', async () => {
    const key = generateStorageKey('patient_state1', '.pdf');
    const originalPlaintext = Buffer.from('%PDF-1.4 Patient Clinical Vitals Chart');
    const targetPath = driver.resolveSecurePath(key);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, originalPlaintext);

    // Simulate crash: orphaned .migration.tmp file created in .tmp
    const orphanTmp = path.join(driver.getStorageRoot(), '.tmp', `crashed_${crypto.randomUUID()}.migration.tmp`);
    await fsp.writeFile(orphanTmp, Buffer.from('HALF_ENCRYPTED_CORRUPTED_BYTES'));

    // Recovery runs
    const { recovered, cleanedBackups } = await recoverInterruptedStorageMigrations(driver);
    expect(recovered).toBe(0);
    expect(cleanedBackups).toBe(0);

    // Original file remains unchanged
    expect(await inspectStorageDocument(driver, key)).toBe('LEGACY_PLAINTEXT');
    const content = await fsp.readFile(targetPath);
    expect(content.equals(originalPlaintext)).toBe(true);

    // Scratch cleaner purges orphaned tmp
    const cleanedTmp = await driver.cleanupOrphanedTempFiles(0);
    expect(cleanedTmp).toBeGreaterThanOrEqual(1);
    expect(await fsp.stat(orphanTmp).catch(() => false)).toBe(false);
  });

  it('State 2: backup .bak present, target file absent (crash before atomic publication)', async () => {
    const key = generateStorageKey('patient_state2', '.pdf');
    const originalPlaintext = Buffer.from('%PDF-1.4 Patient Critical Cardiology History');
    const targetPath = driver.resolveSecurePath(key);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });

    // Simulate crash after backup copy was made, but target file disappeared
    const backupPath = `${targetPath}.bak`;
    await fsp.writeFile(backupPath, originalPlaintext);

    expect(await fsp.stat(targetPath).catch(() => false)).toBe(false);
    expect(await fsp.stat(backupPath).then(() => true)).toBe(true);

    // Run recovery
    const { recovered, cleanedBackups } = await recoverInterruptedStorageMigrations(driver);
    expect(recovered).toBe(1);
    expect(cleanedBackups).toBe(0);

    // Target must be restored from backup
    expect(await fsp.stat(targetPath).then(() => true)).toBe(true);
    const restored = await fsp.readFile(targetPath);
    expect(restored.equals(originalPlaintext)).toBe(true);

    // Backup is cleaned after restoration
    expect(await fsp.stat(backupPath).catch(() => false)).toBe(false);
  });

  it('State 3: backup .bak present, target file corrupted / partially written (crash during publication)', async () => {
    const key = generateStorageKey('patient_state3', '.pdf');
    const originalPlaintext = Buffer.from('%PDF-1.4 Critical Pre-Crash Medical Record');
    const targetPath = driver.resolveSecurePath(key);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });

    // Backup contains authentic document
    const backupPath = `${targetPath}.bak`;
    await fsp.writeFile(backupPath, originalPlaintext);

    // Target file is corrupted or partially published
    await fsp.writeFile(targetPath, Buffer.from('TRUNCATED_CORRUPT_GCM_CIPHERTEXT'));

    expect(await inspectStorageDocument(driver, key)).toBe('LEGACY_PLAINTEXT');

    // Run recovery
    const { recovered, cleanedBackups } = await recoverInterruptedStorageMigrations(driver);
    expect(recovered).toBe(1);
    expect(cleanedBackups).toBe(0);

    // Original must be faithfully restored
    const restored = await fsp.readFile(targetPath);
    expect(restored.equals(originalPlaintext)).toBe(true);
    expect(await fsp.stat(backupPath).catch(() => false)).toBe(false);
  });

  it('State 4: target is authenticated MM_ENC03, backup .bak retained (crash before backup deletion)', async () => {
    const key = generateStorageKey('patient_state4', '.pdf');
    const originalPlaintext = Buffer.from('%PDF-1.4 Migrated Patient Immunization History');

    // Write original plaintext
    const targetPath = driver.resolveSecurePath(key);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, originalPlaintext);

    // Perform migration with preserveBackup = true
    const result = await migrateStorageDocumentFile(driver, key, { preserveBackup: true });
    expect(result.status).toBe('migrated');

    const backupPath = `${targetPath}.bak`;
    expect(await fsp.stat(backupPath).then(() => true)).toBe(true);
    expect(await inspectStorageDocument(driver, key)).toBe('MM_ENC03');

    // Recovery runs
    const { recovered, cleanedBackups } = await recoverInterruptedStorageMigrations(driver);
    expect(recovered).toBe(0);
    expect(cleanedBackups).toBe(1);

    // Target must still be MM_ENC03 and readable
    expect(await inspectStorageDocument(driver, key)).toBe('MM_ENC03');
    const read = await driver.readBuffer(key);
    expect(read.equals(originalPlaintext)).toBe(true);

    // Stale backup must be safely unlinked
    expect(await fsp.stat(backupPath).catch(() => false)).toBe(false);
  });

  it('State 5 & 6: end-to-end atomic publication verifies source hash and performs clean backup disposal', async () => {
    const key = generateStorageKey('patient_state5', '.pdf');
    const originalPlaintext = Buffer.from('%PDF-1.4 End to End Patient Diagnostic Report');

    const targetPath = driver.resolveSecurePath(key);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, originalPlaintext);

    // Normal migration without backup retention
    const result = await migrateStorageDocumentFile(driver, key, { preserveBackup: false });
    expect(result.status).toBe('migrated');
    expect(result.sourceSha256).toBeDefined();
    expect(result.migratedSha256).toBe(result.sourceSha256);

    // No leftover .bak or .tmp files
    const backupPath = `${targetPath}.bak`;
    expect(await fsp.stat(backupPath).catch(() => false)).toBe(false);

    // Document is authenticated MM_ENC03
    expect(await inspectStorageDocument(driver, key)).toBe('MM_ENC03');
    const readBack = await driver.readBuffer(key);
    expect(readBack.equals(originalPlaintext)).toBe(true);
  });
});
