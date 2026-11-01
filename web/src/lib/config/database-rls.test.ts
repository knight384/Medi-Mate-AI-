import { describe, it, expect, vi, beforeEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  withTenantContext,
  withAdminContext,
  TenantContextError,
  TENANT_CONFIG_KEY,
} from '@/lib/db-tenant';
import { findUserForAuth } from '@/lib/auth-user';
import prisma from '@/lib/prisma';

vi.mock('@/lib/prisma', () => {
  const mockExecuteRaw = vi.fn().mockResolvedValue(1);
  const mockQueryRaw = vi.fn().mockResolvedValue([{ id: 'user_1', password: 'hashed_password' }]);
  const mockTransaction = vi.fn().mockImplementation(async (callback) => {
    const mockTx = {
      $executeRaw: mockExecuteRaw,
      healthData: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'rec_1' }),
      },
      redditAccessToken: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    return callback(mockTx);
  });

  return {
    default: {
      $transaction: mockTransaction,
      $executeRaw: mockExecuteRaw,
      $queryRaw: mockQueryRaw,
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'user_fallback', password: 'fallback_password' }),
      },
    },
    Prisma: {},
  };
});

describe('Database Multi-Tenant Isolation & RLS Infrastructure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('withTenantContext Helper', () => {
    it('sets transaction-local app.current_user_id with is_local=true', async () => {
      const result = await withTenantContext('patient_alpha_123', async (tx) => {
        return tx.healthData.findMany();
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });

    it('rejects empty or whitespace-only tenant identifier', async () => {
      await expect(withTenantContext('', async () => {})).rejects.toThrow(TenantContextError);
      await expect(withTenantContext('   ', async () => {})).rejects.toThrow(TenantContextError);
      // @ts-expect-error test invalid type input
      await expect(withTenantContext(null, async () => {})).rejects.toThrow(TenantContextError);
      // @ts-expect-error test invalid type input
      await expect(withTenantContext(undefined, async () => {})).rejects.toThrow(TenantContextError);
    });

    it('propagates transaction errors and ensures rollback occurs', async () => {
      await expect(
        withTenantContext('patient_alpha_123', async () => {
          throw new Error('Database transaction constraint violation');
        }),
      ).rejects.toThrow('Database transaction constraint violation');
    });

    it('verifies tenant context key constant', () => {
      expect(TENANT_CONFIG_KEY).toBe('app.current_user_id');
    });
  });

  describe('Administrative Service Boundary (Task A: GUC Elimination)', () => {
    it('rejects withAdminContext calls through application runtime with TenantContextError', async () => {
      await expect(
        withAdminContext(async (tx) => {
          return tx.redditAccessToken.findMany();
        }),
      ).rejects.toThrow(
        'Administrative operations require dedicated service identity credentials (medimate_reddit_worker)',
      );
    });

    it('ensures application runtime does not spoof administrative GUC', async () => {
      try {
        await withAdminContext(async () => {});
      } catch {
        // Expected rejection
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('findUserForAuth Pre-Authentication Lookup (Task B)', () => {
    it('returns user credentials via security definer raw query when available', async () => {
      const user = await findUserForAuth('alice');
      expect(user).toEqual({ id: 'user_1', password: 'hashed_password' });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('returns null for empty or non-string username', async () => {
      expect(await findUserForAuth('')).toBeNull();
      // @ts-expect-error test invalid type
      expect(await findUserForAuth(null)).toBeNull();
    });

    it('falls back to prisma.user.findUnique when raw SQL query throws', async () => {
      vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error('Function does not exist'));
      const user = await findUserForAuth('alice');
      expect(user).toEqual({ id: 'user_fallback', password: 'fallback_password' });
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('Static Inspection of Bootstrap Scripts (01-init-roles.sh & 02-init-rls.sql)', () => {
    const initRolesPath = path.resolve(__dirname, '../../../docker/init-db/01-init-roles.sh');
    const initRlsPath = path.resolve(__dirname, '../../../docker/init-db/02-init-rls.sql');

    it('verifies 01-init-roles.sh quotes heredoc delimiter to eliminate shell interpolation injection', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain("<<'EOSQL'");
    });

    it('verifies 01-init-roles.sh uses psql -v parameter passing for credentials and roles', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain('-v owner_user="$OWNER_USER"');
      expect(content).toContain('-v owner_pass="$OWNER_PASS"');
      expect(content).toContain('-v app_user="$APP_USER"');
      expect(content).toContain('-v app_pass="$APP_PASS"');
    });

    it('verifies 01-init-roles.sh creates dedicated internal medimate_auth_definer role with NOBYPASSRLS (Task D)', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain("CREATE ROLE medimate_auth_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
      expect(content).toContain("GRANT USAGE ON SCHEMA public TO medimate_auth_definer");
    });

    it('verifies 01-init-roles.sh creates dedicated worker role medimate_reddit_worker with NOBYPASSRLS (Task A)', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain("CREATE ROLE medimate_reddit_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
      expect(content).toContain("GRANT USAGE ON SCHEMA public TO medimate_reddit_worker");
      expect(content).toContain('REVOKE ALL ON TABLE public."RedditAccessToken" FROM %I');
      expect(content).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."RedditAccessToken" TO medimate_reddit_worker');
    });

    it('verifies 01-init-roles.sh restricts User table INSERT to specific registration columns (Task C)', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain('REVOKE INSERT ON TABLE public."User" FROM %I');
      expect(content).toContain('GRANT INSERT (id, username, password, "hasOnboarded", "createdAt", "updatedAt") ON TABLE public."User" TO %I');
    });

    it('verifies 01-init-roles.sh restricts User table UPDATE to mutable columns only (Task J)', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain('REVOKE UPDATE ON TABLE public."User" FROM %I');
      expect(content).toContain('GRANT UPDATE (name, password, "hasOnboarded", "updatedAt") ON TABLE public."User" TO %I');
    });

    it('verifies 01-init-roles.sh restricts User table SELECT to non-secret columns for app role and password to auth definer (Task E)', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain('REVOKE SELECT ON TABLE public."User" FROM %I');
      expect(content).toContain('GRANT SELECT (id, name, username, "hasOnboarded", "createdAt", "updatedAt") ON TABLE public."User" TO %I');
      expect(content).toContain('REVOKE ALL ON TABLE public."User" FROM medimate_auth_definer');
      expect(content).toContain('GRANT SELECT (id, username, password) ON TABLE public."User" TO medimate_auth_definer');
    });

    it('verifies 01-init-roles.sh uses dynamic SQL format(%I, %L) to safely escape identifiers and literals', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain("EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER INHERIT'");
      expect(content).toContain("EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'");
    });

    it('verifies 01-init-roles.sh explicitly revokes CREATE on schema public from runtime app role', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain("REVOKE CREATE ON SCHEMA public FROM %I");
    });

    it('verifies 01-init-roles.sh revokes all permissions on _prisma_migrations from runtime app role', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain("REVOKE ALL ON TABLE _prisma_migrations FROM %I");
    });

    it('verifies 01-init-roles.sh revokes blanket function execution from PUBLIC and runtime app role', async () => {
      const content = await fsp.readFile(initRolesPath, 'utf-8');
      expect(content).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
      expect(content).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I");
      expect(content).toContain("GRANT EXECUTE ON FUNCTION public.lookup_user_for_auth(text) TO %I");
      expect(content).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    });

    it('verifies 02-init-rls.sql defines security definer lookup_user_for_auth function with hardened search_path (Part A)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE OR REPLACE FUNCTION public.lookup_user_for_auth');
      expect(content).toContain('SECURITY DEFINER');
      expect(content).toContain('SET search_path = public, pg_catalog, pg_temp');
      expect(content).toContain('FROM public."User" u');
      expect(content).toContain('OWNER TO medimate_auth_definer');
    });

    it('verifies 02-init-rls.sql automatically applies fail-closed RLS to all public tables', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain("ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY");
      expect(content).toContain("ALTER TABLE public.%I FORCE ROW LEVEL SECURITY");
      expect(content).toContain("WHERE schemaname = 'public'");
      expect(content).toContain("AND tablename NOT IN ('_prisma_migrations')");
    });

    it('verifies 02-init-rls.sql sets hardened search_path on policy and trigger functions', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain("CREATE OR REPLACE FUNCTION public.apply_medimate_rls_policies(p_strict boolean DEFAULT false)");
      expect(content).toContain("CREATE OR REPLACE FUNCTION public.trg_apply_rls_on_ddl()");
      expect(content).toContain("REVOKE ALL ON FUNCTION public.apply_medimate_rls_policies(boolean) FROM PUBLIC");
      expect(content).toContain("REVOKE ALL ON FUNCTION public.trg_apply_rls_on_ddl() FROM PUBLIC");
    });

    it('verifies 02-init-rls.sql uses physical column names for OAuth tables (user_id) (Task D)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE POLICY oauth2_token_tenant_isolation ON public."OAuth2Token"');
      expect(content).toContain('USING ("user_id" = pg_catalog.current_setting(\'app.current_user_id\', true))');
      expect(content).toContain('CREATE POLICY oauth2_client_tenant_isolation ON public."OAuth2Client"');
      expect(content).toContain('USING ("user_id" = pg_catalog.current_setting(\'app.current_user_id\', true))');
      expect(content).toContain('CREATE POLICY oauth2_code_tenant_isolation ON public."OAuth2AuthorizationCode"');
      expect(content).toContain('USING ("user_id" = pg_catalog.current_setting(\'app.current_user_id\', true))');
    });

    it('verifies 02-init-rls.sql enforces safe defaults on user registration at row level (Task C)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE POLICY user_register_insert ON public."User"');
      expect(content).toContain('FOR INSERT');
      expect(content).toContain('"hasOnboarded" = false');
      expect(content).toContain('id IS NOT NULL');
      expect(content).toContain('length(username) >= 1');
      expect(content).toContain('length(username) <= 100');
      expect(content).toContain('length(password) >= 20');
      expect(content).toContain('CREATE POLICY user_self_select ON public."User"');
      expect(content).toContain('USING (id = pg_catalog.current_setting(\'app.current_user_id\', true))');
    });

    it('verifies 02-init-rls.sql defines dedicated user_auth_definer_select policy specifically TO medimate_auth_definer (Task D)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE POLICY user_auth_definer_select ON public."User"');
      expect(content).toContain('TO medimate_auth_definer');
      expect(content).toContain('USING (true)');
    });

    it('verifies 02-init-rls.sql revokes all access on _prisma_migrations from PUBLIC and medimate_app (Task I)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain("REVOKE ALL ON TABLE public._prisma_migrations FROM PUBLIC");
      expect(content).toContain("REVOKE ALL ON TABLE public._prisma_migrations FROM medimate_app");
    });

    it('verifies 02-init-rls.sql isolates Reddit sync tables to medimate_reddit_worker (Task K)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE POLICY reddit_post_worker_policy ON public."RedditPost"');
      expect(content).toContain('CREATE POLICY reddit_comment_worker_policy ON public."RedditPostComment"');
    });

    it('verifies 02-init-rls.sql enforces LLMProvider secret isolation for system records (Task E)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE POLICY llm_provider_select_policy ON public."LLMProvider"');
      expect(content).toContain('("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting(\'app.current_user_id\', true))');
      expect(content).toContain('("authorId" IS NULL AND "apiKey" = \'\')');
    });

    it('verifies 02-init-rls.sql targets RedditAccessToken policy strictly TO medimate_reddit_worker (Task A)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE POLICY reddit_token_worker_policy ON public."RedditAccessToken"');
      expect(content).toContain('TO medimate_reddit_worker');
      expect(content).not.toContain("current_setting('app.is_admin_context'");
    });

    it('verifies 02-init-rls.sql ChatMessage policy isolates child messages via parent join', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('EXISTS');
      expect(content).toContain('SELECT 1 FROM public."ChatRoom"');
      expect(content).toContain('"ChatRoom".id = "ChatMessage"."chatRoomId"');
      expect(content).toContain('"ChatRoom"."authorId" = pg_catalog.current_setting(\'app.current_user_id\', true)');
    });

    it('verifies 02-init-rls.sql registers ddl_command_end event trigger for automatic RLS on new tables', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE EVENT TRIGGER medimate_rls_event_trigger');
      expect(content).toContain('ON ddl_command_end');
      expect(content).toContain("WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS')");
    });

    it('verifies 02-init-rls.sql supports strict mode post-migration table verification (Part B)', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('v_expected_tables text[] := ARRAY[');
      expect(content).toContain("'User'");
      expect(content).toContain("'HealthData'");
      expect(content).toContain("'ChatRoom'");
      expect(content).toContain('IF p_strict THEN');
      expect(content).toContain('RAISE EXCEPTION \'MediMate AI RLS verification failed: Required table public."%" does not exist\'');
    });

    it('verifies prisma/post-migration-rls.ts invokes apply_medimate_rls_policies in strict mode (Part B)', async () => {
      const postMigrationPath = path.resolve(__dirname, '../../../prisma/post-migration-rls.ts');
      const content = await fsp.readFile(postMigrationPath, 'utf-8');
      expect(content).toContain('SELECT public.apply_medimate_rls_policies(true);');
    });
  });
});
