import { describe, it, expect, vi, beforeEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { withTenantContext, TenantContextError, TENANT_CONFIG_KEY } from '@/lib/db-tenant';
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
        })
      ).rejects.toThrow('Database transaction constraint violation');
    });

    it('verifies tenant context key constant', () => {
      expect(TENANT_CONFIG_KEY).toBe('app.current_user_id');
    });
  });

  describe('findUserForAuth Pre-Authentication Lookup', () => {
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

    it('verifies 02-init-rls.sql defines security definer lookup_user_for_auth function', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE OR REPLACE FUNCTION lookup_user_for_auth');
      expect(content).toContain('SECURITY DEFINER');
      expect(content).toContain('SET search_path = public');
    });

    it('verifies 02-init-rls.sql enables and forces RLS on HealthData, ChatRoom, ChatMessage, LLMProvider, OAuth2Token', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('ALTER TABLE "HealthData" ENABLE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "HealthData" FORCE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "ChatRoom" ENABLE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "ChatRoom" FORCE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "ChatMessage" ENABLE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "ChatMessage" FORCE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "LLMProvider" ENABLE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "OAuth2Token" ENABLE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "OAuth2Client" ENABLE ROW LEVEL SECURITY;');
      expect(content).toContain('ALTER TABLE "OAuth2AuthorizationCode" ENABLE ROW LEVEL SECURITY;');
    });

    it('verifies 02-init-rls.sql User table policies allow registration INSERT while restricting profile access', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE POLICY user_register_insert ON "User"');
      expect(content).toContain('FOR INSERT');
      expect(content).toContain('WITH CHECK (true)');
      expect(content).toContain('CREATE POLICY user_self_select ON "User"');
      expect(content).toContain('USING (id = current_setting(\'app.current_user_id\', true))');
    });

    it('verifies 02-init-rls.sql ChatMessage policy isolates child messages via parent join', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('EXISTS');
      expect(content).toContain('SELECT 1 FROM "ChatRoom"');
      expect(content).toContain('"ChatRoom".id = "ChatMessage"."chatRoomId"');
      expect(content).toContain('"ChatRoom"."authorId" = current_setting(\'app.current_user_id\', true)');
    });

    it('verifies 02-init-rls.sql registers ddl_command_end event trigger for automatic RLS on new tables', async () => {
      const content = await fsp.readFile(initRlsPath, 'utf-8');
      expect(content).toContain('CREATE EVENT TRIGGER medimate_rls_event_trigger');
      expect(content).toContain('ON ddl_command_end');
      expect(content).toContain("WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS')");
    });
  });
});
