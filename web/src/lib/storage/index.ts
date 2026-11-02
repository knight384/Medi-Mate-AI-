import { LocalStorageDriver } from './local-driver';
import { CloudObjectStorageDriver } from './cloud-driver';
import { HybridStorageDriver } from './hybrid-policy';

// Primary Local Driver singleton
export const localStorageDriver = new LocalStorageDriver();

// Cloud Driver singleton (standby/unconfigured by default in local mode)
export const cloudStorageDriver = new CloudObjectStorageDriver();

// Unified Hybrid Driver singleton
export const hybridStorageDriver = new HybridStorageDriver(localStorageDriver, cloudStorageDriver);

export * from './naming';
export * from './mime';
export * from './local-driver';
export * from './storage-driver.interface';
export * from './cloud-driver';
export * from './hybrid-policy';
export * from './temp-storage';
