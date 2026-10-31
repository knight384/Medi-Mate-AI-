import { LocalStorageDriver } from './local-driver';

// Singleton instance for application-wide private storage access
export const localStorageDriver = new LocalStorageDriver();

export * from './naming';
export * from './mime';
export * from './local-driver';
