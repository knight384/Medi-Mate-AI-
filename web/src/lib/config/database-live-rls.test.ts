import { describe, it, expect, beforeAll } from 'vitest';
import prisma from '@/lib/prisma';
import { withTenantContext } from '@/lib/db-tenant';

/**
 * MediMate AI: Real PostgreSQL Security & RLS Integration Test Suite
 *
 * Checkpoint 5D.14 requirements:
 * 1. Fail-fast mode when explicitly requested (REQUIRE_LIVE_POSTGRES=true).
 * 2. Proper SKIPPED status (ctx.skip()) when database is unreachable during normal test runs.
 * 3. Function permissions: lookup_user_for_auth execution, definer ownership, search_path, SET ROLE rejection.
 * 4. Policy management security: apply_medimate_rls_policies denied to runtime role medimate_app.
 * 5. Public schema trust boundaries: CREATE ON SCHEMA public denied to medimate_app.
 * 6. User table column privileges: non-secret column SELECT, password-column denial, immutable column enforcement.
 * 7. Multi-tenant RLS behavior: Alpha/Beta isolation, fail-closed missing context, transaction-local GUC cleanup.
 * 8. Connection pooling safety: no context leak across pooled client connections.
 * 9. Migration ledger security: _prisma_migrations ledger denial to app role.
 * 10. Complete table coverage: All 13 tables verified for RLS and FORCE RLS.
 */

describe('PostgreSQL Live Authentication, RLS & Role Privilege Verification (Checkpoint 5D.14)', () => {
  let isPostgresLive = false;

  beforeAll(async () => {
    try {
      if (typeof prisma.$queryRawUnsafe === 'function') {
        const result = await prisma.$queryRawUnsafe<Array<{ ready: number }>>('SELECT 1 as ready;');
        if (result && result.length > 0 && result[0].ready === 1) {
          isPostgresLive = true;
        }
      }
    } catch {
      isPostgresLive = false;
    }

    if (process.env.REQUIRE_LIVE_POSTGRES === 'true' && !isPostgresLive) {
      throw new Error(
        '[LIVE-POSTGRESQL-BLOCKED] PostgreSQL connection to disposable test container medimate-rls-5d12-test is required but offline or unreachable.'
      );
    }
  });

  describe('PostgreSQL Daemon Availability Probe', () => {
    it('verifies live database connection status without masking offline state', () => {
      if (!isPostgresLive) {
        console.warn(
          '[LIVE-POSTGRESQL-BLOCKED] Disposable PostgreSQL service (medimate-rls-5d12-test) is offline or unreachable. Live queries are BLOCKED until container is started.'
        );
      }
      expect(typeof isPostgresLive).toBe('boolean');
    });
  });

  describe('Function Permissions (lookup_user_for_auth)', () => {
    it('verifies lookup_user_for_auth function attributes in PostgreSQL catalog', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const procs = await prisma.$queryRawUnsafe<
        Array<{
          proname: string;
          prosecdef: boolean;
          proconfig: string[] | null;
          owner_role: string;
        }>
      >(`
        SELECT p.proname, p.prosecdef, p.proconfig, r.rolname as owner_role
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
        JOIN pg_catalog.pg_roles r ON p.proowner = r.oid
        WHERE n.nspname = 'public' AND p.proname = 'lookup_user_for_auth';
      `);

      expect(procs.length).toBe(1);
      const fn = procs[0];
      expect(fn.prosecdef).toBe(true);
      expect(fn.owner_role).toBe('medimate_auth_definer');
      expect(fn.proconfig).toContain('search_path=public, pg_catalog, pg_temp');
    });

    it('verifies medimate_app cannot SET ROLE to medimate_auth_definer or medimate_owner', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$executeRawUnsafe('SET ROLE medimate_auth_definer;')
      ).rejects.toThrow();

      await expect(
        prisma.$executeRawUnsafe('SET ROLE medimate_owner;')
      ).rejects.toThrow();
    });

    it('verifies PUBLIC has no execute privilege on lookup_user_for_auth', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const grants = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`
        SELECT count(*)::int as count
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = 'lookup_user_for_auth'
          AND grantee = 'PUBLIC';
      `);

      expect(grants[0].count).toBe(0);
    });

    it('verifies medimate_app is denied execute on apply_medimate_rls_policies', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$executeRawUnsafe('SELECT public.apply_medimate_rls_policies(false);')
      ).rejects.toThrow(/permission denied/i);
    });

    it('verifies medimate_app is denied execute on trg_apply_rls_on_ddl', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$executeRawUnsafe('SELECT public.trg_apply_rls_on_ddl();')
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('Public Schema Trust Boundaries', () => {
    it('verifies medimate_app cannot create objects in public schema', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$executeRawUnsafe('CREATE TABLE public.malicious_probe (id int);')
      ).rejects.toThrow(/permission denied for schema public/i);
    });
  });

  describe('User Table Column Privileges', () => {
    it('verifies direct selection of User.password is rejected with permission error', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$queryRawUnsafe('SELECT password FROM public."User" LIMIT 1;')
      ).rejects.toThrow(/permission denied for column "password"/i);

      await expect(
        prisma.$queryRawUnsafe('SELECT * FROM public."User" LIMIT 1;')
      ).rejects.toThrow(/permission denied for column "password"/i);
    });

    it('verifies permitted non-secret columns can be selected without error', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT id, name, username, "hasOnboarded", "createdAt", "updatedAt"
        FROM public."User"
        LIMIT 1;
      `);
      expect(Array.isArray(rows)).toBe(true);
    });

    it('verifies updating immutable columns (id, username, createdAt) is rejected', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$executeRawUnsafe(`
          UPDATE public."User"
          SET id = 'tampered_id'
          WHERE id = 'nonexistent_test_id';
        `)
      ).rejects.toThrow(/permission denied for column "id"/i);

      await expect(
        prisma.$executeRawUnsafe(`
          UPDATE public."User"
          SET username = 'tampered_user'
          WHERE id = 'nonexistent_test_id';
        `)
      ).rejects.toThrow(/permission denied for column "username"/i);
    });
  });

  describe('Multi-Tenant RLS Alpha/Beta Isolation & Session Hygiene', () => {
    const alphaId = 'synthetic_test_alpha_user_5d14';
    const betaId = 'synthetic_test_beta_user_5d14';

    it('verifies query without tenant context returns 0 clinical rows', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT id FROM public."HealthData";
      `);
      expect(rows.length).toBe(0);
    });

    it('verifies Alpha cannot read or manipulate Beta health records', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const records = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
          SELECT id FROM public."HealthData" WHERE "authorId" = '${betaId}';
        `);
        expect(records.length).toBe(0);

        const updateCount = await tx.$executeRawUnsafe(`
          UPDATE public."HealthData"
          SET type = 'TAMPERED'
          WHERE "authorId" = '${betaId}';
        `);
        expect(updateCount).toBe(0);

        const deleteCount = await tx.$executeRawUnsafe(`
          DELETE FROM public."HealthData"
          WHERE "authorId" = '${betaId}';
        `);
        expect(deleteCount).toBe(0);
      });
    });

    it('verifies Alpha cannot insert a record claiming Beta ownership', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        await expect(
          tx.$executeRawUnsafe(`
            INSERT INTO public."HealthData" (id, type, data, "authorId", "createdAt", "updatedAt")
            VALUES ('spoofed_doc_01', 'LAB_RESULT', '{}'::jsonb, '${betaId}', NOW(), NOW());
          `)
        ).rejects.toThrow();
      });
    });

    it('verifies transaction-local tenant context is cleared after commit and rollback', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      // Commit transaction
      await withTenantContext(alphaId, async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ setting: string }>>(`
          SELECT current_setting('app.current_user_id', true) as setting;
        `);
        expect(rows[0].setting).toBe(alphaId);
      });

      // Confirm setting reset outside transaction
      const outsideRows = await prisma.$queryRawUnsafe<Array<{ setting: string }>>(`
        SELECT current_setting('app.current_user_id', true) as setting;
      `);
      expect(outsideRows[0].setting).toBeFalsy();

      // Rollback transaction
      try {
        await withTenantContext(betaId, async () => {
          throw new Error('Simulated abort');
        });
      } catch {
        // Expected
      }

      const postRollbackRows = await prisma.$queryRawUnsafe<Array<{ setting: string }>>(`
        SELECT current_setting('app.current_user_id', true) as setting;
      `);
      expect(postRollbackRows[0].setting).toBeFalsy();
    });

    it('verifies pooled connections do not retain previous transaction tenant context', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ setting: string }>>(
          "SELECT current_setting('app.current_user_id', true) as setting;"
        );
        expect(rows[0].setting).toBe(alphaId);
      });

      // Subsequent independent query on client pool must have setting cleared
      const checkRows = await prisma.$queryRawUnsafe<Array<{ setting: string }>>(
        "SELECT current_setting('app.current_user_id', true) as setting;"
      );
      expect(checkRows[0].setting).toBeFalsy();
    });
  });

  describe('Migration Ledger & 13-Table RLS Enforcement', () => {
    it('verifies medimate_app is denied access to _prisma_migrations', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$queryRawUnsafe('SELECT * FROM public._prisma_migrations LIMIT 1;')
      ).rejects.toThrow(/permission denied/i);
    });

    it('verifies all 13 required clinical and auth tables have RLS and FORCE RLS enabled', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const expectedTables = [
        'User',
        'HealthData',
        'ChatRoom',
        'ChatMessage',
        'AssistantMode',
        'AssistantModeContext',
        'LLMProvider',
        'OAuth2Client',
        'OAuth2AuthorizationCode',
        'OAuth2Token',
        'RedditAccessToken',
        'RedditPost',
        'RedditPostComment',
      ];

      const tables = await prisma.$queryRawUnsafe<
        Array<{ tablename: string; rowsecurity: boolean; forcerowsecurity: boolean }>
      >(`
        SELECT tablename, rowsecurity, forcerowsecurity
        FROM pg_catalog.pg_tables t
        JOIN pg_catalog.pg_class c ON c.relname = t.tablename
        WHERE schemaname = 'public'
          AND tablename IN (${expectedTables.map((t) => `'${t}'`).join(', ')});
      `);

      expect(tables.length).toBe(13);
      for (const t of tables) {
        expect(t.rowsecurity).toBe(true);
        expect(t.forcerowsecurity).toBe(true);
      }
    });
  });
});
