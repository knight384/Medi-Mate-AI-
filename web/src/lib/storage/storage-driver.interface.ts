import { Readable } from 'node:stream';
import { StoredObjectMetadata, StorageReadResult } from './local-driver';

export interface StorageDriver {
  readonly driverType: 'local' | 'cloud' | 'hybrid';
  init(): Promise<void>;
  writeStream(
    storageKey: string,
    sourceStream: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array> | Buffer | Uint8Array,
    maxBytes?: number
  ): Promise<StoredObjectMetadata>;
  readStream(storageKey: string): Promise<StorageReadResult>;
  readBuffer(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<boolean>;
  exists(storageKey: string): Promise<boolean>;
  getValidatedDiskPath?(storageKey: string): Promise<string>;
  withDecryptedTempFile?<T>(
    storageKey: string,
    fn: (tempPlaintextPath: string) => Promise<T>
  ): Promise<T>;
}
