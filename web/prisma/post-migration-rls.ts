import { PrismaClient } from '@prisma/client';

/**
 * MediMate AI: Post-Migration Multi-Tenant RLS & Security Initializer
 *
 * Runs after `prisma db push` or `prisma migrate deploy` to install and strictly verify:
 * 1. Fail-closed Row Level Security on all clinical and auth tables.
 * 2. Dedicated security definer authentication lookup policies.
 * 3. User table column-level least privilege (INSERT, UPDATE, and SELECT).
 * 4. Reddit worker service role boundaries and token table isolation.
 * 5. Exclusion and protection of the `_prisma_migrations` migration ledger.
 *
 * Executes `public.apply_medimate_rls_policies(true)` in strict mode:
 * Fails visibly if any expected application table or policy is missing.
 */
const migrationUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({
  datasources: migrationUrl ? { db: { url: migrationUrl } } : undefined,
});

async function main() {
  console.log('MediMate AI: Applying and verifying multi-tenant RLS policies (strict mode)...');

  try {
    await prisma.$executeRawUnsafe('SELECT public.apply_medimate_rls_policies(true);');
    console.log('MediMate AI: Multi-tenant RLS policies and least-privilege role boundaries verified successfully.');
  } catch (error) {
    console.error('MediMate AI: RLS policy verification failed:', error);
    throw error;
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
