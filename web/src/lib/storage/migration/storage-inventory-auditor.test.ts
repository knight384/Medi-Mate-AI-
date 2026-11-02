import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { LocalStorageDriver } from '../local-driver';
import { generateStorageKey } from '../naming';
import {
  auditAllStorageLocations,
  inspectFileEncryptionFormat,
} from './storage-inventory-auditor';
import { Readable } from 'node:stream';

describe('Part C — Physical Legacy-Storage Inventory Auditor (Checkpoint 5D.25)', () => {
  let testRoot: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `medimate-audit-test-${crypto.randomUUID()}`);
    await fsp.mkdir(testRoot, { recursive: true, mode: 0o700 });
    driver = new LocalStorageDriver({ customStorageDir: testRoot });
    await driver.init();
  });

  afterEach(async () => {
    try {
      await fsp.rm(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('accurately identifies MM_ENC03, MM_ENC02, LEGACY_PLAINTEXT and corrupt file formats', async () => {
    const keyV3 = generateStorageKey('patient_v3', '.pdf');
    const keyV2 = generateStorageKey('patient_v2', '.pdf');

    // Create v3
    await driver.writeStream(keyV3, Readable.from(Buffer.from('V3_CONTENT')));
    // Create v2
    await driver.writeStream(keyV2, Readable.from(Buffer.from('V2_CONTENT')), undefined, {
      version: 'MM_ENC02',
    });

    const fV3 = driver.resolveSecurePath(keyV3);
    const fV2 = driver.resolveSecurePath(keyV2);

    const fPlain = path.join(testRoot, 'users', 'patient_legacy', `${crypto.randomUUID()}.pdf`);
    await fsp.mkdir(path.dirname(fPlain), { recursive: true });
    await fsp.writeFile(fPlain, Buffer.from('%PDF-1.4 Legacy Plaintext Medical Record'));

    const fCorrupt = path.join(testRoot, 'users', 'patient_corrupt', `${crypto.randomUUID()}.pdf`);
    await fsp.mkdir(path.dirname(fCorrupt), { recursive: true });
    await fsp.writeFile(fCorrupt, Buffer.from('SHORT'));

    expect(await inspectFileEncryptionFormat(fV3)).toBe('MM_ENC03');
    expect(await inspectFileEncryptionFormat(fV2)).toBe('MM_ENC02');
    expect(await inspectFileEncryptionFormat(fPlain)).toBe('LEGACY_PLAINTEXT');
    expect(await inspectFileEncryptionFormat(fCorrupt)).toBe('LEGACY_PLAINTEXT');
  });

  it('runs complete storage inventory audit, classifying unmounted docker volumes as BLOCKED', async () => {
    // Populate test directory
    await driver.writeStream('users/pat_1/a.pdf', Readable.from(Buffer.from('A')));
    await driver.writeStream('users/pat_2/b.pdf', Readable.from(Buffer.from('B')));

    const legacyPath = path.join(testRoot, 'users', 'pat_3', 'c.pdf');
    await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
    await fsp.writeFile(legacyPath, Buffer.from('%PDF-1.4 Legacy Patient Record'));

    const report = await auditAllStorageLocations(driver);

    expect(report.timestamp).toBeDefined();
    expect(report.locations.length).toBeGreaterThanOrEqual(3);

    const activeLoc = report.locations.find((l) => l.name === 'Active LocalStorageDriver Root');
    expect(activeLoc).toBeDefined();
    expect(activeLoc?.accessible).toBe(true);
    expect(activeLoc?.accessStatus).toBe('ACCESSIBLE');
    expect(activeLoc?.totalFiles).toBe(3);
    expect(activeLoc?.formatDistribution.MM_ENC03).toBe(2);
    expect(activeLoc?.formatDistribution.LEGACY_PLAINTEXT).toBe(1);

    // Docker volumes MUST be classified as BLOCKED when daemon is offline
    const dockerStorageLoc = report.locations.find((l) => l.name === 'Docker app_storage Volume');
    expect(dockerStorageLoc?.accessStatus).toBe('BLOCKED');
    expect(dockerStorageLoc?.details).toContain('Docker daemon offline');

    const dockerLegacyLoc = report.locations.find((l) => l.name === 'Docker app_data Legacy Uploads Volume');
    expect(dockerLegacyLoc?.accessStatus).toBe('BLOCKED');

    expect(report.unresolvedLocations).toContain('Docker app_storage Volume');
    expect(report.unresolvedLocations).toContain('Docker app_data Legacy Uploads Volume');
    expect(report.overallMigrationStatus).toBe('PARTIALLY_BLOCKED');
  });

  it('audits repository real environment paths with read-only fidelity', async () => {
    const realDriver = new LocalStorageDriver();
    const report = await auditAllStorageLocations(realDriver);

    console.log('REAL_INVENTORY_REPORT:', JSON.stringify(report, null, 2));

    expect(report.locations.length).toBeGreaterThanOrEqual(4);
    expect(report.overallMigrationStatus).toBe('PARTIALLY_BLOCKED');
  });
});
