import crypto from "node:crypto";

/**
 * Get the MD5 hash of a file
 *
 * @param buffer
 */
export async function getFileMd5(buffer: Buffer): Promise<string> {
    const hash = crypto.createHash('md5')
    hash.update(buffer)
    return hash.digest('hex')
}

/**
 * Process items in batches with a concurrency limit
 *
 * @param items
 * @param processItem
 * @param concurrencyLimit
 */
export async function processBatchWithConcurrency<T, R>(
    items: T[],
    processItem: (item: T) => Promise<R>,
    concurrencyLimit: number
): Promise<R[]> {
    const results: R[] = [];

    // Process items in batches
    for (let i = 0; i < items.length; i += concurrencyLimit) {
        const batch = items.slice(i, i + concurrencyLimit);
        const batchResults = await Promise.all(
            batch.map(item => processItem(item))
        );
        results.push(...batchResults);
    }

    return results;
}

import { localStorageDriver, isValidStorageKey } from '@/lib/storage';

/**
 * Resolve the upload path using private storage driver.
 *
 * @param storageKey
 */
export async function resolveUploadPath(storageKey: string): Promise<string> {
    if (isValidStorageKey(storageKey)) {
        return localStorageDriver.resolveSecurePath(storageKey);
    }
    throw new Error('Direct public upload paths are decommissioned. Use private storage keys.');
}
