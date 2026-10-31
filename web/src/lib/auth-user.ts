import prisma from '@/lib/prisma';

export interface AuthUserRecord {
  id: string;
  password: string;
}

/**
 * Pre-authentication user lookup.
 * Attempts to call the security-definer function `lookup_user_for_auth(username)`
 * which bypasses RLS in PostgreSQL for credential validation without exposing
 * the entire User table to enumeration.
 * Falls back to standard Prisma lookup in mocked environments or non-PostgreSQL drivers.
 */
export async function findUserForAuth(username: string): Promise<AuthUserRecord | null> {
  if (!username || typeof username !== 'string') return null;

  try {
    if (typeof prisma.$queryRaw === 'function') {
      const rows = await prisma.$queryRaw<Array<{ id: string; password: string }>>`
        SELECT id, password FROM lookup_user_for_auth(${username})
      `;
      if (rows && rows.length > 0) {
        return { id: rows[0].id, password: rows[0].password };
      }
      return null;
    }
  } catch {
    // If the SQL function is not available (e.g. test environment), fallback to prisma.user
  }

  return prisma.user.findUnique({
    select: { id: true, password: true },
    where: { username },
  });
}

