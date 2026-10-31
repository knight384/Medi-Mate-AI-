import prisma from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

export const TENANT_CONFIG_KEY = 'app.current_user_id';

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Executes a callback within a database transaction scoped strictly to the authenticated user ID.
 *
 * Security guarantees:
 * 1. Sets PostgreSQL setting 'app.current_user_id' with is_local=true.
 * 2. Scoped strictly to the active transaction; automatically cleared upon COMMIT or ROLLBACK.
 * 3. Connection-pool reuse cannot leak identity context across requests.
 * 4. Empty, unauthenticated, or invalid tenant IDs fail closed before querying.
 */
export async function withTenantContext<T>(
  userId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new TenantContextError('Tenant context requires a valid, non-empty user identifier');
  }

  const sanitizedUserId = userId.trim();

  return prisma.$transaction(async (tx) => {
    // is_local = true ensures setting is automatically cleared when transaction finishes
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${sanitizedUserId}, true);`;
    return callback(tx);
  });
}

