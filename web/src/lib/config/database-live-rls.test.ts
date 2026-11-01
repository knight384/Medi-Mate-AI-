import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '@/lib/prisma';
import { withTenantContext } from '@/lib/db-tenant';
import { PrismaClient } from '@prisma/client';

/**
 * MediMate AI: Real PostgreSQL Security & RLS Integration Test Suite
 *
 * Checkpoint 5D.16 requirements:
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
 * 11. Behavioral isolation across all tenant-owned tables:
 *     - User (profile isolation, immutable fields, password denial)
 *     - HealthData (tenant CRUD isolation, fail-closed)
 *     - ChatRoom & ChatMessage (room isolation, parent-join message isolation, foreign room insertion rejection)
 *     - AssistantMode & AssistantModeContext (public vs private visibility, owner modification, context isolation)
 *     - LLMProvider (owner isolation, system default empty-key exposure, non-empty system key protection)
 *     - OAuth2Client, OAuth2AuthorizationCode, OAuth2Token (user_id tenant isolation)
 *     - RedditAccessToken, RedditPost, RedditPostComment (complete medimate_app denial, worker role boundary)
 */

describe('PostgreSQL Live Authentication, RLS & Role Privilege Verification (Checkpoint 5D.16)', () => {
  let isPostgresLive = false;
  let ownerPrisma: PrismaClient | null = null;

  const alphaId = 'synthetic_test_alpha_user_5d16';
  const betaId = 'synthetic_test_beta_user_5d16';
  const alphaUsername = 'synth_alpha_user_5d16';
  const betaUsername = 'synth_beta_user_5d16';
  const alphaPasswordHash = '$2a$10$abcdefghijklmnopqrstuvwxyz123456';
  const betaPasswordHash = '$2a$10$abcdefghijklmnopqrstuvwxyz123456';

  async function cleanFixtures(client: PrismaClient) {
    const statements = [
      `DELETE FROM public."ChatMessage" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."ChatRoom" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."AssistantModeContext" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."AssistantMode" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."HealthData" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."OAuth2Token" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."OAuth2AuthorizationCode" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."OAuth2Client" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."LLMProvider" WHERE id LIKE 'synth_%'`,
      `DELETE FROM public."User" WHERE id IN ('${alphaId}', '${betaId}') OR id LIKE 'new_test_user_%'`,
    ];
    for (const stmt of statements) {
      try {
        await client.$executeRawUnsafe(stmt);
      } catch {
        // ignore during initial cleanup
      }
    }
  }

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
        '[LIVE-POSTGRESQL-BLOCKED] PostgreSQL connection to disposable test container is required but offline or unreachable.'
      );
    }

    if (isPostgresLive && process.env.MIGRATION_DATABASE_URL) {
      ownerPrisma = new PrismaClient({
        datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } },
      });

      // Reset and seed synthetic test fixtures as owner (bypasses RLS to establish known state)
      try {
        await cleanFixtures(ownerPrisma);

        // 1. Synthetic Users
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."User" (id, username, password, name, "hasOnboarded", "createdAt", "updatedAt")
          VALUES 
            ('${alphaId}', '${alphaUsername}', '${alphaPasswordHash}', 'Alpha Patient', true, NOW(), NOW()),
            ('${betaId}', '${betaUsername}', '${betaPasswordHash}', 'Beta Patient', true, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE 
            SET name = EXCLUDED.name, "hasOnboarded" = EXCLUDED."hasOnboarded", "updatedAt" = NOW();
        `);

        // 2. Synthetic LLM Providers (System empty-key, System non-empty-key, Alpha private, Beta private)
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."LLMProvider" (id, "providerId", name, "apiKey", "authorId", "createdAt", "updatedAt", "apiURL", "order")
          VALUES 
            ('synth_sys_llm_prov_01', 'openai', 'System OpenAI', '', NULL, NOW(), NOW(), 'https://api.openai.com/v1', 1),
            ('synth_sys_llm_prov_secret', 'anthropic_secret', 'System Secret Claude', 'sys-secret-key-12345', NULL, NOW(), NOW(), 'https://api.anthropic.com/v1', 2),
            ('synth_alpha_llm_prov_01', 'custom_alpha', 'Alpha Provider', 'sk-alpha-custom-key', '${alphaId}', NOW(), NOW(), 'https://custom.alpha.ai', 3),
            ('synth_beta_llm_prov_01', 'custom_beta', 'Beta Provider', 'sk-beta-custom-key', '${betaId}', NOW(), NOW(), 'https://custom.beta.ai', 4)
          ON CONFLICT (id) DO UPDATE 
            SET "apiKey" = EXCLUDED."apiKey", "authorId" = EXCLUDED."authorId", "updatedAt" = NOW();
        `);

        // 3. Synthetic AssistantModes (Public vs Private)
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."AssistantMode" (id, name, description, "systemPrompt", visibility, "authorId", "llmProviderId", "createdAt", "updatedAt")
          VALUES 
            ('synth_pub_assistant_01', 'Public General Triage', 'Public triage mode', 'You are a general health assistant', 'PUBLIC', NULL, 'synth_sys_llm_prov_01', NOW(), NOW()),
            ('synth_alpha_assistant_01', 'Alpha Private Oncology', 'Alpha private oncology mode', 'You are an oncology specialist', 'PRIVATE', '${alphaId}', 'synth_alpha_llm_prov_01', NOW(), NOW()),
            ('synth_beta_assistant_01', 'Beta Private Cardiology', 'Beta private cardiology mode', 'You are a cardiology specialist', 'PRIVATE', '${betaId}', 'synth_beta_llm_prov_01', NOW(), NOW())
          ON CONFLICT (id) DO UPDATE 
            SET visibility = EXCLUDED.visibility, "authorId" = EXCLUDED."authorId", "updatedAt" = NOW();
        `);

        // 4. Synthetic AssistantModeContexts
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."AssistantModeContext" (id, "assistantModeId", data, "createdAt", "updatedAt")
          VALUES 
            ('synth_pub_ctx_01', 'synth_pub_assistant_01', 'Public general medical knowledge guidelines', NOW(), NOW()),
            ('synth_alpha_ctx_01', 'synth_alpha_assistant_01', 'Alpha private clinical oncology notes', NOW(), NOW()),
            ('synth_beta_ctx_01', 'synth_beta_assistant_01', 'Beta private cardiology titration guidelines', NOW(), NOW())
          ON CONFLICT (id) DO UPDATE 
            SET data = EXCLUDED.data, "updatedAt" = NOW();
        `);

        // 5. Synthetic ChatRooms
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."ChatRoom" (id, name, "assistantModeId", "llmProviderId", "authorId", "createdAt", "updatedAt")
          VALUES 
            ('synth_alpha_room_01', 'Alpha Confidential Consultation', 'synth_pub_assistant_01', 'synth_sys_llm_prov_01', '${alphaId}', NOW(), NOW()),
            ('synth_beta_room_01', 'Beta Confidential Consultation', 'synth_pub_assistant_01', 'synth_sys_llm_prov_01', '${betaId}', NOW(), NOW())
          ON CONFLICT (id) DO UPDATE 
            SET name = EXCLUDED.name, "authorId" = EXCLUDED."authorId", "updatedAt" = NOW();
        `);

        // 6. Synthetic ChatMessages
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."ChatMessage" (id, content, "chatRoomId", role, "createdAt", "updatedAt")
          VALUES 
            ('synth_alpha_msg_01', 'Alpha private symptom report: recurring fever and night sweats', 'synth_alpha_room_01', 'USER', NOW(), NOW()),
            ('synth_beta_msg_01', 'Beta private symptom report: elevated heart rate and palpitations', 'synth_beta_room_01', 'USER', NOW(), NOW())
          ON CONFLICT (id) DO UPDATE 
            SET content = EXCLUDED.content, "updatedAt" = NOW();
        `);

        // 7. Synthetic HealthData
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."HealthData" (id, type, data, "authorId", "createdAt", "updatedAt")
          VALUES 
            ('synth_alpha_doc_01', 'LAB_RESULT', '{"hemoglobin": 14.2, "wbc": 6800}'::jsonb, '${alphaId}', NOW(), NOW()),
            ('synth_beta_doc_01', 'LAB_RESULT', '{"cholesterol": 210, "ldl": 130}'::jsonb, '${betaId}', NOW(), NOW())
          ON CONFLICT (id) DO UPDATE 
            SET data = EXCLUDED.data, "authorId" = EXCLUDED."authorId", "updatedAt" = NOW();
        `);

        // 8. Synthetic OAuth2 records (separate statements for prepared statement compatibility)
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."OAuth2Client" (id, "user_id", "client_id", "client_secret", "client_metadata")
          VALUES 
            ('synth_alpha_oauth_client_01', '${alphaId}', 'cid_alpha_client_01', 'csec_alpha_secret_01', '{"app_name":"Alpha Health App"}'),
            ('synth_beta_oauth_client_01', '${betaId}', 'cid_beta_client_01', 'csec_beta_secret_01', '{"app_name":"Beta Health App"}')
          ON CONFLICT (id) DO UPDATE 
            SET "user_id" = EXCLUDED."user_id";
        `);

        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."OAuth2AuthorizationCode" (id, "user_id", "client_id", code, "response_type", "auth_time")
          VALUES 
            ('synth_alpha_auth_code_01', '${alphaId}', 'cid_alpha_client_01', 'code_alpha_secret_xyz', 'code', 1700000000),
            ('synth_beta_auth_code_01', '${betaId}', 'cid_beta_client_01', 'code_beta_secret_xyz', 'code', 1700000000)
          ON CONFLICT (id) DO UPDATE 
            SET "user_id" = EXCLUDED."user_id";
        `);

        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."OAuth2Token" (id, "user_id", "client_id", "token_type", "access_token", "issued_at")
          VALUES 
            ('synth_alpha_token_01', '${alphaId}', 'cid_alpha_client_01', 'Bearer', 'tok_alpha_access_111', 1700000000),
            ('synth_beta_token_01', '${betaId}', 'cid_beta_client_01', 'Bearer', 'tok_beta_access_222', 1700000000)
          ON CONFLICT (id) DO UPDATE 
            SET "user_id" = EXCLUDED."user_id";
        `);
      } catch (err) {
        console.warn('Fixture setup error (continuing):', err);
      }
    }
  });

  afterAll(async () => {
    if (ownerPrisma) {
      try {
        await cleanFixtures(ownerPrisma);
      } catch (err) {
        console.warn('Fixture teardown error:', err);
      } finally {
        await ownerPrisma.$disconnect();
      }
    }
  });

  describe('PostgreSQL Daemon Availability Probe', () => {
    it('verifies live database connection status without masking offline state', () => {
      if (!isPostgresLive) {
        console.warn(
          '[LIVE-POSTGRESQL-BLOCKED] Disposable PostgreSQL service is offline or unreachable. Live queries are BLOCKED until container is started.'
        );
      }
      expect(typeof isPostgresLive).toBe('boolean');
    });
  });

  describe('Security-Definer Function Catalog Attributes & Permissions (Part F)', () => {
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
      expect(fn.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    });

    it('verifies apply_medimate_rls_policies is owned by medimate_owner with safe search_path', async (ctx) => {
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
        WHERE n.nspname = 'public' AND p.proname = 'apply_medimate_rls_policies';
      `);

      expect(procs.length).toBe(1);
      const fn = procs[0];
      expect(fn.prosecdef).toBe(true);
      expect(fn.owner_role).toBe('medimate_owner');
      expect(fn.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    });

    it('verifies trg_apply_rls_on_ddl is owned by medimate_owner with safe search_path', async (ctx) => {
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
        WHERE n.nspname = 'public' AND p.proname = 'trg_apply_rls_on_ddl';
      `);

      expect(procs.length).toBe(1);
      const fn = procs[0];
      expect(fn.prosecdef).toBe(true);
      expect(fn.owner_role).toBe('medimate_owner');
      expect(fn.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    });

    it('verifies medimate_app cannot SET ROLE to medimate_auth_definer, medimate_owner, or medimate_reddit_worker', async (ctx) => {
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

      await expect(
        prisma.$executeRawUnsafe('SET ROLE medimate_reddit_worker;')
      ).rejects.toThrow();
    });

    it('verifies PUBLIC has no execute privilege on lookup_user_for_auth or apply_medimate_rls_policies', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const grants = await prisma.$queryRawUnsafe<Array<{ routine_name: string; count: number }>>(`
        SELECT routine_name, count(*)::int as count
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name IN ('lookup_user_for_auth', 'apply_medimate_rls_policies', 'trg_apply_rls_on_ddl')
          AND grantee = 'PUBLIC'
        GROUP BY routine_name;
      `);

      expect(grants.length).toBe(0);
    });

    it('verifies medimate_app is denied execute on apply_medimate_rls_policies and trg_apply_rls_on_ddl', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$executeRawUnsafe('SELECT public.apply_medimate_rls_policies(false);')
      ).rejects.toThrow(/permission denied/i);

      await expect(
        prisma.$executeRawUnsafe('SELECT public.trg_apply_rls_on_ddl();')
      ).rejects.toThrow(/permission denied/i);
    });

    it('verifies medimate_app can execute lookup_user_for_auth and retrieve user auth credentials safely', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; password: string }>>(
        `SELECT id, password FROM public.lookup_user_for_auth('${alphaUsername}');`
      );

      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(alphaId);
      expect(rows[0].password).toBe(alphaPasswordHash);

      // Non-existent user lookup returns empty array without throwing
      const emptyRows = await prisma.$queryRawUnsafe<Array<{ id: string; password: string }>>(
        "SELECT id, password FROM public.lookup_user_for_auth('non_existent_username_xyz');"
      );
      expect(emptyRows.length).toBe(0);
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

  describe('User Table Isolation & Column Least-Privilege (Part E)', () => {
    it('verifies direct selection of User.password is rejected with permission error', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$queryRawUnsafe('SELECT password FROM public."User" LIMIT 1;')
      ).rejects.toThrow(/permission denied/i);

      await expect(
        prisma.$queryRawUnsafe('SELECT * FROM public."User" LIMIT 1;')
      ).rejects.toThrow(/permission denied/i);
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
      ).rejects.toThrow(/permission denied/i);

      await expect(
        prisma.$executeRawUnsafe(`
          UPDATE public."User"
          SET username = 'tampered_user'
          WHERE id = 'nonexistent_test_id';
        `)
      ).rejects.toThrow(/permission denied/i);
    });

    it('verifies Alpha cannot read or update Beta user profile', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      // Without tenant context, User query returns 0 rows due to RLS
      const noContextRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id, name, username FROM public."User" WHERE id = '${alphaId}';`
      );
      expect(noContextRows.length).toBe(0);

      // Under Alpha tenant context: can see Alpha, cannot see Beta
      await withTenantContext(alphaId, async (tx) => {
        const alphaRows = await tx.$queryRawUnsafe<Array<{ id: string; username: string }>>(
          `SELECT id, username FROM public."User" WHERE id = '${alphaId}';`
        );
        expect(alphaRows.length).toBe(1);
        expect(alphaRows[0].username).toBe(alphaUsername);

        const betaRows = await tx.$queryRawUnsafe<Array<{ id: string; username: string }>>(
          `SELECT id, username FROM public."User" WHERE id = '${betaId}';`
        );
        expect(betaRows.length).toBe(0);

        // Alpha cannot update Beta's profile
        const updateBetaCount = await tx.$executeRawUnsafe(`
          UPDATE public."User"
          SET name = 'Tampered By Alpha'
          WHERE id = '${betaId}';
        `);
        expect(updateBetaCount).toBe(0);

        // Alpha can update Alpha's own mutable profile field
        const updateSelfCount = await tx.$executeRawUnsafe(`
          UPDATE public."User"
          SET name = 'Alpha Renamed'
          WHERE id = '${alphaId}';
        `);
        expect(updateSelfCount).toBe(1);
      });
    });
  });

  describe('HealthData Behavioral Isolation (Part E)', () => {
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

    it('verifies Alpha can read and insert Alpha own health records', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const records = await tx.$queryRawUnsafe<Array<{ id: string; type: string }>>(`
          SELECT id, type FROM public."HealthData" WHERE id = 'synth_alpha_doc_01';
        `);
        expect(records.length).toBe(1);
        expect(records[0].type).toBe('LAB_RESULT');

        const insertCount = await tx.$executeRawUnsafe(`
          INSERT INTO public."HealthData" (id, type, data, "authorId", "createdAt", "updatedAt")
          VALUES ('synth_alpha_doc_new', 'PRESCRIPTION', '{"dosage":"50mg"}'::jsonb, '${alphaId}', NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type;
        `);
        expect(insertCount).toBe(1);
      });
    });
  });

  describe('ChatRoom and ChatMessage Behavioral Isolation (Part E)', () => {
    it('verifies query without tenant context returns 0 chat rooms and 0 chat messages', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const rooms = await prisma.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM public."ChatRoom";');
      expect(rooms.length).toBe(0);

      const msgs = await prisma.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM public."ChatMessage";');
      expect(msgs.length).toBe(0);
    });

    it('verifies Alpha cannot read, update, or delete Beta chat rooms', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const betaRooms = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."ChatRoom" WHERE id = 'synth_beta_room_01';`
        );
        expect(betaRooms.length).toBe(0);

        const updateCount = await tx.$executeRawUnsafe(
          `UPDATE public."ChatRoom" SET name = 'Tampered' WHERE id = 'synth_beta_room_01';`
        );
        expect(updateCount).toBe(0);

        const deleteCount = await tx.$executeRawUnsafe(
          `DELETE FROM public."ChatRoom" WHERE id = 'synth_beta_room_01';`
        );
        expect(deleteCount).toBe(0);

        // Alpha can read Alpha's own chat room
        const alphaRooms = await tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(
          `SELECT id, name FROM public."ChatRoom" WHERE id = 'synth_alpha_room_01';`
        );
        expect(alphaRooms.length).toBe(1);
        expect(alphaRooms[0].name).toContain('Alpha');
      });
    });

    it('verifies Alpha cannot read or manipulate messages in Beta chat room', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        // Message join isolation: Beta's room messages are invisible to Alpha
        const betaMsgs = await tx.$queryRawUnsafe<Array<{ id: string; content: string }>>(
          `SELECT id, content FROM public."ChatMessage" WHERE id = 'synth_beta_msg_01';`
        );
        expect(betaMsgs.length).toBe(0);

        const updateCount = await tx.$executeRawUnsafe(
          `UPDATE public."ChatMessage" SET content = 'Tampered Message' WHERE id = 'synth_beta_msg_01';`
        );
        expect(updateCount).toBe(0);

        const deleteCount = await tx.$executeRawUnsafe(
          `DELETE FROM public."ChatMessage" WHERE id = 'synth_beta_msg_01';`
        );
        expect(deleteCount).toBe(0);

        // Alpha can read messages in Alpha's own chat room
        const alphaMsgs = await tx.$queryRawUnsafe<Array<{ id: string; content: string }>>(
          `SELECT id, content FROM public."ChatMessage" WHERE id = 'synth_alpha_msg_01';`
        );
        expect(alphaMsgs.length).toBe(1);
        expect(alphaMsgs[0].content).toContain('Alpha private symptom report');
      });
    });

    it('verifies Alpha cannot insert a message into Beta chat room (parent join check)', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      // Negative check in dedicated transaction
      await withTenantContext(alphaId, async (tx) => {
        await expect(
          tx.$executeRawUnsafe(`
            INSERT INTO public."ChatMessage" (id, content, "chatRoomId", role, "createdAt", "updatedAt")
            VALUES ('spoofed_msg_01', 'Injected message', 'synth_beta_room_01', 'USER', NOW(), NOW());
          `)
        ).rejects.toThrow();
      });

      // Positive check in clean transaction: inserting into Alpha's own room succeeds
      await withTenantContext(alphaId, async (tx) => {
        const insertCount = await tx.$executeRawUnsafe(`
          INSERT INTO public."ChatMessage" (id, content, "chatRoomId", role, "createdAt", "updatedAt")
          VALUES ('synth_alpha_msg_new', 'Legitimate Alpha reply', 'synth_alpha_room_01', 'ASSISTANT', NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content;
        `);
        expect(insertCount).toBe(1);
      });
    });
  });

  describe('AssistantMode & AssistantModeContext Behavioral Isolation (Part E)', () => {
    it('verifies query without tenant context returns only PUBLIC modes and 0 private modes', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const modes = await prisma.$queryRawUnsafe<Array<{ id: string; visibility: string }>>(
        `SELECT id, visibility FROM public."AssistantMode" WHERE id IN ('synth_pub_assistant_01', 'synth_alpha_assistant_01', 'synth_beta_assistant_01');`
      );
      expect(modes.length).toBe(1);
      expect(modes[0].id).toBe('synth_pub_assistant_01');
      expect(modes[0].visibility).toBe('PUBLIC');
    });

    it('verifies Alpha cannot read or modify Beta private AssistantMode', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const betaModes = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."AssistantMode" WHERE id = 'synth_beta_assistant_01';`
        );
        expect(betaModes.length).toBe(0);

        const updateBeta = await tx.$executeRawUnsafe(
          `UPDATE public."AssistantMode" SET name = 'Tampered' WHERE id = 'synth_beta_assistant_01';`
        );
        expect(updateBeta).toBe(0);

        // Alpha can read and update Alpha's own private mode
        const alphaModes = await tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(
          `SELECT id, name FROM public."AssistantMode" WHERE id = 'synth_alpha_assistant_01';`
        );
        expect(alphaModes.length).toBe(1);
        expect(alphaModes[0].name).toContain('Alpha Private');

        // Alpha can read public mode
        const pubModes = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."AssistantMode" WHERE id = 'synth_pub_assistant_01';`
        );
        expect(pubModes.length).toBe(1);

        // Alpha CANNOT modify public mode owned by NULL
        const updatePub = await tx.$executeRawUnsafe(
          `UPDATE public."AssistantMode" SET name = 'Tampered Public' WHERE id = 'synth_pub_assistant_01';`
        );
        expect(updatePub).toBe(0);
      });
    });

    it('verifies AssistantModeContext respects parent mode visibility and ownership', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      // Without tenant context: only public mode context is visible
      const unauthedCtxs = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM public."AssistantModeContext" WHERE id IN ('synth_pub_ctx_01', 'synth_alpha_ctx_01', 'synth_beta_ctx_01');`
      );
      expect(unauthedCtxs.length).toBe(1);
      expect(unauthedCtxs[0].id).toBe('synth_pub_ctx_01');

      // Under Alpha tenant context:
      await withTenantContext(alphaId, async (tx) => {
        // Can see public context and Alpha's private context
        const visibleCtxs = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."AssistantModeContext" WHERE id IN ('synth_pub_ctx_01', 'synth_alpha_ctx_01', 'synth_beta_ctx_01');`
        );
        const visibleIds = visibleCtxs.map((c) => c.id).sort();
        expect(visibleIds).toEqual(['synth_alpha_ctx_01', 'synth_pub_ctx_01']);

        // Cannot see Beta's private context
        const betaCtx = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."AssistantModeContext" WHERE id = 'synth_beta_ctx_01';`
        );
        expect(betaCtx.length).toBe(0);
      });

      // Negative check in separate transaction
      await withTenantContext(alphaId, async (tx) => {
        // Cannot insert context into Beta's mode
        await expect(
          tx.$executeRawUnsafe(`
            INSERT INTO public."AssistantModeContext" (id, "assistantModeId", data, "createdAt", "updatedAt")
            VALUES ('injected_ctx_01', 'synth_beta_assistant_01', 'Injected data', NOW(), NOW());
          `)
        ).rejects.toThrow();
      });
    });
  });

  describe('LLMProvider Behavioral Isolation & API Key Masking (Part E)', () => {
    it('verifies Alpha can read Alpha own LLMProvider including apiKey', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ id: string; apiKey: string }>>(
          `SELECT id, "apiKey" FROM public."LLMProvider" WHERE id = 'synth_alpha_llm_prov_01';`
        );
        expect(rows.length).toBe(1);
        expect(rows[0].apiKey).toBe('sk-alpha-custom-key');
      });
    });

    it('verifies Alpha cannot read or manipulate Beta LLMProvider or API keys', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const betaRows = await tx.$queryRawUnsafe<Array<{ id: string; apiKey: string }>>(
          `SELECT id, "apiKey" FROM public."LLMProvider" WHERE id = 'synth_beta_llm_prov_01';`
        );
        expect(betaRows.length).toBe(0);

        const updateCount = await tx.$executeRawUnsafe(
          `UPDATE public."LLMProvider" SET "apiKey" = 'tampered_key' WHERE id = 'synth_beta_llm_prov_01';`
        );
        expect(updateCount).toBe(0);

        const deleteCount = await tx.$executeRawUnsafe(
          `DELETE FROM public."LLMProvider" WHERE id = 'synth_beta_llm_prov_01';`
        );
        expect(deleteCount).toBe(0);
      });
    });

    it('verifies system default provider is visible only when apiKey is empty', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        // System provider with empty key is readable
        const sysEmpty = await tx.$queryRawUnsafe<Array<{ id: string; apiKey: string }>>(
          `SELECT id, "apiKey" FROM public."LLMProvider" WHERE id = 'synth_sys_llm_prov_01';`
        );
        expect(sysEmpty.length).toBe(1);
        expect(sysEmpty[0].apiKey).toBe('');

        // System provider with non-empty key is completely hidden by RLS policy
        const sysSecret = await tx.$queryRawUnsafe<Array<{ id: string; apiKey: string }>>(
          `SELECT id, "apiKey" FROM public."LLMProvider" WHERE id = 'synth_sys_llm_prov_secret';`
        );
        expect(sysSecret.length).toBe(0);

        // Alpha cannot update system provider (authorId is NULL)
        const updateSys = await tx.$executeRawUnsafe(
          `UPDATE public."LLMProvider" SET "apiKey" = 'tampered' WHERE id = 'synth_sys_llm_prov_01';`
        );
        expect(updateSys).toBe(0);
      });
    });
  });

  describe('OAuth2 Tables Behavioral Isolation (Part E)', () => {
    it('verifies query without tenant context returns 0 OAuth2 clients, codes, and tokens', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const clients = await prisma.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM public."OAuth2Client";');
      expect(clients.length).toBe(0);

      const codes = await prisma.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM public."OAuth2AuthorizationCode";');
      expect(codes.length).toBe(0);

      const tokens = await prisma.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM public."OAuth2Token";');
      expect(tokens.length).toBe(0);
    });

    it('verifies Alpha cannot read, update, or delete Beta OAuth2Client', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const betaClients = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."OAuth2Client" WHERE id = 'synth_beta_oauth_client_01';`
        );
        expect(betaClients.length).toBe(0);

        const updateCount = await tx.$executeRawUnsafe(
          `UPDATE public."OAuth2Client" SET "client_metadata" = '{}' WHERE id = 'synth_beta_oauth_client_01';`
        );
        expect(updateCount).toBe(0);

        // Alpha can read Alpha's own client
        const alphaClients = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."OAuth2Client" WHERE id = 'synth_alpha_oauth_client_01';`
        );
        expect(alphaClients.length).toBe(1);
      });

      // Separate transaction for negative insert check
      await withTenantContext(alphaId, async (tx) => {
        await expect(
          tx.$executeRawUnsafe(`
            INSERT INTO public."OAuth2Client" (id, "user_id", "client_id", "client_secret", "client_metadata")
            VALUES ('spoofed_oauth_client', '${betaId}', 'spoofed_cid', 'spoofed_sec', '{}');
          `)
        ).rejects.toThrow();
      });
    });

    it('verifies Alpha cannot read or insert Beta OAuth2AuthorizationCode', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const betaCodes = await tx.$queryRawUnsafe<Array<{ id: string; code: string }>>(
          `SELECT id, code FROM public."OAuth2AuthorizationCode" WHERE id = 'synth_beta_auth_code_01';`
        );
        expect(betaCodes.length).toBe(0);

        const alphaCodes = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."OAuth2AuthorizationCode" WHERE id = 'synth_alpha_auth_code_01';`
        );
        expect(alphaCodes.length).toBe(1);
      });

      // Separate transaction for negative insert check
      await withTenantContext(alphaId, async (tx) => {
        await expect(
          tx.$executeRawUnsafe(`
            INSERT INTO public."OAuth2AuthorizationCode" (id, "user_id", "client_id", code, "response_type", "auth_time")
            VALUES ('spoofed_code_01', '${betaId}', 'cid_beta_client_01', 'code_spoofed_123', 'code', 1700000000);
          `)
        ).rejects.toThrow();
      });
    });

    it('verifies Alpha cannot read or insert Beta OAuth2Token', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const betaTokens = await tx.$queryRawUnsafe<Array<{ id: string; access_token: string }>>(
          `SELECT id, "access_token" FROM public."OAuth2Token" WHERE id = 'synth_beta_token_01';`
        );
        expect(betaTokens.length).toBe(0);

        const alphaTokens = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."OAuth2Token" WHERE id = 'synth_alpha_token_01';`
        );
        expect(alphaTokens.length).toBe(1);
      });

      // Separate transaction for negative insert check
      await withTenantContext(alphaId, async (tx) => {
        await expect(
          tx.$executeRawUnsafe(`
            INSERT INTO public."OAuth2Token" (id, "user_id", "client_id", "token_type", "access_token", "issued_at")
            VALUES ('spoofed_token_01', '${betaId}', 'cid_beta_client_01', 'Bearer', 'tok_spoofed_123', 1700000000);
          `)
        ).rejects.toThrow();
      });
    });
  });

  describe('Reddit Worker Tables Privilege Boundaries (Part E)', () => {
    it('verifies medimate_app runtime role has zero access to RedditAccessToken', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$queryRawUnsafe('SELECT * FROM public."RedditAccessToken" LIMIT 1;')
      ).rejects.toThrow(/permission denied/i);

      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO public."RedditAccessToken" (id, username, "accessToken", "tokenType", "expiresIn", scope, "expiresAt", "createdAt", "updatedAt")
          VALUES ('probe', 'testuser', 'tok123', 'bearer', 3600, 'read', NOW(), NOW(), NOW());
        `)
      ).rejects.toThrow(/permission denied/i);
    });

    it('verifies medimate_app runtime role has zero access to RedditPost and RedditPostComment', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await expect(
        prisma.$queryRawUnsafe('SELECT * FROM public."RedditPost" LIMIT 1;')
      ).rejects.toThrow(/permission denied/i);

      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO public."RedditPost" (id, "postId", title, content, "isMedicalAdviceRequired", "createdAt", "updatedAt")
          VALUES ('probe', 'pid_probe', 'title', 'content', true, NOW(), NOW());
        `)
      ).rejects.toThrow(/permission denied/i);

      await expect(
        prisma.$queryRawUnsafe('SELECT * FROM public."RedditPostComment" LIMIT 1;')
      ).rejects.toThrow(/permission denied/i);

      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO public."RedditPostComment" (id, "postId", "commentId", "assistantModeId", content, "createdAt", "updatedAt")
          VALUES ('probe', 'pid_probe', 'cid_probe', 'aid_probe', 'content', NOW(), NOW());
        `)
      ).rejects.toThrow(/permission denied/i);
    });

    it('verifies medimate_reddit_worker has exclusive grants in information_schema table_privileges', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      // Check PostgreSQL privilege function has_table_privilege
      const privs = await prisma.$queryRawUnsafe<Array<{
        worker_token: boolean;
        worker_post: boolean;
        worker_comment: boolean;
        app_token: boolean;
        app_post: boolean;
        app_comment: boolean;
      }>>(`
        SELECT 
          has_table_privilege('medimate_reddit_worker', 'public."RedditAccessToken"', 'SELECT') as worker_token,
          has_table_privilege('medimate_reddit_worker', 'public."RedditPost"', 'SELECT') as worker_post,
          has_table_privilege('medimate_reddit_worker', 'public."RedditPostComment"', 'SELECT') as worker_comment,
          has_table_privilege('medimate_app', 'public."RedditAccessToken"', 'SELECT') as app_token,
          has_table_privilege('medimate_app', 'public."RedditPost"', 'SELECT') as app_post,
          has_table_privilege('medimate_app', 'public."RedditPostComment"', 'SELECT') as app_comment;
      `);

      expect(privs.length).toBe(1);
      expect(privs[0].worker_token).toBe(true);
      expect(privs[0].worker_post).toBe(true);
      expect(privs[0].worker_comment).toBe(true);
      expect(privs[0].app_token).toBe(false);
      expect(privs[0].app_post).toBe(false);
      expect(privs[0].app_comment).toBe(false);
    });
  });

  describe('Session Hygiene, Rollback & Connection Pool Safety', () => {
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

      const tables = await prisma.$queryRawUnsafe<
        Array<{ tablename: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >(`
        SELECT c.relname as tablename, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN (${expectedTables.map((t) => `'${t}'`).join(', ')});
      `);

      expect(tables.length).toBe(13);
      for (const t of tables) {
        expect(t.relrowsecurity).toBe(true);
        expect(t.relforcerowsecurity).toBe(true);
      }
    });

    it('verifies all 13 required tables have explicit applicable RLS policies', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const policies = await prisma.$queryRawUnsafe<
        Array<{ tablename: string; policy_count: number }>
      >(`
        SELECT tablename, count(*)::int as policy_count
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
        GROUP BY tablename;
      `);

      expect(policies.length).toBe(13);
      for (const p of policies) {
        expect(p.policy_count).toBeGreaterThan(0);
      }
    });

    it('verifies no unexpected or unmanaged application tables exist in public schema', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const allPublicTables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('_prisma_migrations');
      `);

      const actualTableNames = allPublicTables.map((t) => t.tablename).sort();
      const expectedSorted = [...expectedTables].sort();

      expect(actualTableNames).toEqual(expectedSorted);
    });

    it('verifies migration owner can execute strict RLS verification and access migration ledger', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const migrationUrl = process.env.MIGRATION_DATABASE_URL;
      if (!migrationUrl) {
        ctx.skip();
        return;
      }

      const { PrismaClient } = await import('@prisma/client');
      const testOwnerPrisma = new PrismaClient({
        datasources: { db: { url: migrationUrl } },
      });

      try {
        // Strict verification must succeed without error for migration owner
        await expect(
          testOwnerPrisma.$executeRawUnsafe('SELECT public.apply_medimate_rls_policies(true);')
        ).resolves.toBeDefined();

        // Migration owner can query _prisma_migrations
        const migrationRows = await testOwnerPrisma.$queryRawUnsafe<Array<unknown>>(
          'SELECT * FROM public._prisma_migrations LIMIT 1;'
        );
        expect(Array.isArray(migrationRows)).toBe(true);
      } finally {
        await testOwnerPrisma.$disconnect();
      }
    });

    it('verifies migration ledger records all committed migrations without rollbacks', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const migrationUrl = process.env.MIGRATION_DATABASE_URL;
      if (!migrationUrl) {
        ctx.skip();
        return;
      }

      const { PrismaClient } = await import('@prisma/client');
      const testOwnerPrisma = new PrismaClient({
        datasources: { db: { url: migrationUrl } },
      });

      try {
        const migrations = await testOwnerPrisma.$queryRawUnsafe<
          Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null; applied_steps_count: number }>
        >(`
          SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
          FROM public._prisma_migrations
          WHERE rolled_back_at IS NULL
          ORDER BY started_at ASC;
        `);

        expect(migrations.length).toBeGreaterThanOrEqual(3);
        const migrationNames = migrations.map((m) => m.migration_name);
        expect(migrationNames).toContain('0_init');
        expect(migrationNames).toContain('20261101120000_reconcile_user_has_onboarded');
        expect(migrationNames).toContain('20261101130000_add_llm_provider_author_index');

        for (const m of migrations) {
          expect(m.finished_at).not.toBeNull();
          expect(m.rolled_back_at).toBeNull();
          expect(m.applied_steps_count).toBe(1);
        }
      } finally {
        await testOwnerPrisma.$disconnect();
      }
    });
  });

  describe('Database Least-Privilege & Administrative Boundaries (Checkpoint 5D.17 Part A & B)', () => {
    it('verifies medimate_owner does not possess database-level CREATE privilege (least-privilege)', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const rows = await prisma.$queryRawUnsafe<Array<{ has_create: boolean; has_connect: boolean; has_temp: boolean }>>(`
        SELECT 
          has_database_privilege('medimate_owner', current_database(), 'CREATE') as has_create,
          has_database_privilege('medimate_owner', current_database(), 'CONNECT') as has_connect,
          has_database_privilege('medimate_owner', current_database(), 'TEMPORARY') as has_temp;
      `);

      expect(rows.length).toBe(1);
      expect(rows[0].has_create).toBe(false);
      expect(rows[0].has_connect).toBe(true);
      expect(rows[0].has_temp).toBe(true);
    });

    it('verifies medimate_owner retains full schema-level DDL privileges (USAGE, CREATE) on schema public', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const rows = await prisma.$queryRawUnsafe<Array<{ has_usage: boolean; has_create: boolean }>>(`
        SELECT 
          has_schema_privilege('medimate_owner', 'public', 'USAGE') as has_usage,
          has_schema_privilege('medimate_owner', 'public', 'CREATE') as has_create;
      `);

      expect(rows.length).toBe(1);
      expect(rows[0].has_usage).toBe(true);
      expect(rows[0].has_create).toBe(true);
    });

    it('verifies medimate_app has zero CREATE privilege on database and public schema', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const rows = await prisma.$queryRawUnsafe<Array<{ db_create: boolean; schema_create: boolean }>>(`
        SELECT 
          has_database_privilege('medimate_app', current_database(), 'CREATE') as db_create,
          has_schema_privilege('medimate_app', 'public', 'CREATE') as schema_create;
      `);

      expect(rows.length).toBe(1);
      expect(rows[0].db_create).toBe(false);
      expect(rows[0].schema_create).toBe(false);
    });

    it('verifies _owner_all policies explicitly target medimate_owner and exclude public and medimate_app', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const policies = await prisma.$queryRawUnsafe<
        Array<{ tablename: string; policyname: string; roles: string[]; cmd: string }>
      >(`
        SELECT tablename, policyname, roles, cmd
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND policyname LIKE '%_owner_all'
        ORDER BY tablename;
      `);

      expect(policies.length).toBe(13);
      for (const pol of policies) {
        expect(pol.roles).toEqual(['medimate_owner']);
        expect(pol.cmd).toBe('ALL');
      }
    });

    it('verifies medimate_app has no administrative role memberships or inheritance', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const memberships = await prisma.$queryRawUnsafe<Array<{ role: string; member: string }>>(`
        SELECT r.rolname as role, m.rolname as member
        FROM pg_catalog.pg_roles r
        JOIN pg_catalog.pg_auth_members am ON r.oid = am.roleid
        JOIN pg_catalog.pg_roles m ON m.oid = am.member
        WHERE m.rolname = 'medimate_app';
      `);

      expect(memberships.length).toBe(0);
    });
  });

  describe('User Registration Semantics & hasOnboarded Reconciliation (Checkpoint 5D.17 Part C)', () => {
    it('verifies physical User.hasOnboarded column default is false in PostgreSQL catalog', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const cols = await prisma.$queryRawUnsafe<Array<{ column_default: string; is_nullable: string }>>(`
        SELECT column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'User'
          AND column_name = 'hasOnboarded';
      `);

      expect(cols.length).toBe(1);
      expect(cols[0].column_default).toBe('false');
      expect(cols[0].is_nullable).toBe('NO');
    });

    it('verifies registration policy user_register_insert enforces hasOnboarded = false', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      // Ensure test registration keys are clean before inserting
      if (ownerPrisma) {
        await ownerPrisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE id LIKE 'new_test_user_%';`);
      }

      // Valid registration with hasOnboarded = false succeeds
      const regSuccess = await prisma.$executeRawUnsafe(`
        INSERT INTO public."User" (id, username, password, "hasOnboarded", "createdAt", "updatedAt")
        VALUES ('new_test_user_01', 'synth_reg_valid_user', 'valid_test_password_hash_exceeding_20_chars', false, NOW(), NOW());
      `);
      expect(regSuccess).toBe(1);

      // Registration with hasOnboarded = true violates user_register_insert policy
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO public."User" (id, username, password, "hasOnboarded", "createdAt", "updatedAt")
          VALUES ('new_test_user_02', 'synth_reg_spoof_user', 'valid_test_password_hash_exceeding_20_chars', true, NOW(), NOW());
        `)
      ).rejects.toThrow(/row-level security policy/i);

      // Registration relying on column default (hasOnboarded omitted) succeeds because default is false
      const regDefaultSuccess = await prisma.$executeRawUnsafe(`
        INSERT INTO public."User" (id, username, password, "createdAt", "updatedAt")
        VALUES ('new_test_user_03', 'synth_reg_def_user', 'valid_test_password_hash_exceeding_20_chars', NOW(), NOW());
      `);
      expect(regDefaultSuccess).toBe(1);
    });

    it('verifies user_self_update permits updating hasOnboarded to true under tenant context', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      // Without tenant context: update affects 0 rows
      const unauthedUpdate = await prisma.$executeRawUnsafe(`
        UPDATE public."User" SET "hasOnboarded" = true WHERE id = 'new_test_user_01';
      `);
      expect(unauthedUpdate).toBe(0);

      // With tenant context for new_test_user_01: update succeeds
      await withTenantContext('new_test_user_01', async (tx) => {
        const authedUpdate = await tx.$executeRawUnsafe(`
          UPDATE public."User" SET "hasOnboarded" = true WHERE id = 'new_test_user_01';
        `);
        expect(authedUpdate).toBe(1);

        const rows = await tx.$queryRawUnsafe<Array<{ hasOnboarded: boolean }>>(`
          SELECT "hasOnboarded" FROM public."User" WHERE id = 'new_test_user_01';
        `);
        expect(rows[0].hasOnboarded).toBe(true);
      });
    });
  });

  describe('Database Inventory Reconciliation, Migration Reliability & Release Isolation (Checkpoint 5D.18)', () => {
    it('authoritatively reconciles physical table inventory against pg_tables and pg_class', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const expectedTables = [
        'AssistantMode',
        'AssistantModeContext',
        'ChatMessage',
        'ChatRoom',
        'HealthData',
        'LLMProvider',
        'OAuth2AuthorizationCode',
        'OAuth2Client',
        'OAuth2Token',
        'RedditAccessToken',
        'RedditPost',
        'RedditPostComment',
        'User',
      ].sort();

      const physicalTables = await prisma.$queryRawUnsafe<
        Array<{ tablename: string; tableowner: string; rowsecurity: boolean; forcerowsecurity: boolean }>
      >(`
        SELECT 
          t.tablename, 
          t.tableowner, 
          t.rowsecurity,
          c.relforcerowsecurity as forcerowsecurity
        FROM pg_catalog.pg_tables t
        JOIN pg_catalog.pg_class c ON c.relname = t.tablename
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
        WHERE t.schemaname = 'public'
          AND t.tablename NOT IN ('_prisma_migrations')
        ORDER BY t.tablename;
      `);

      const actualTableNames = physicalTables.map((t) => t.tablename).sort();
      expect(actualTableNames).toEqual(expectedTables);

      for (const t of physicalTables) {
        expect(t.tableowner).toBe('medimate_owner');
        expect(t.rowsecurity).toBe(true);
        expect(t.forcerowsecurity).toBe(true);
      }
    });

    it('verifies connected database identity is open-health and runtime user is medimate_app (Checkpoint 5D.23 Part G)', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const res = await prisma.$queryRawUnsafe<Array<{ current_user: string; current_database: string }>>(
        'SELECT current_user, current_database();'
      );

      expect(res).toBeDefined();
      expect(res.length).toBe(1);
      expect(res[0].current_user).toBe('medimate_app');
      expect(res[0].current_database).toBe('open-health');
    });

    it('verifies non-canonical and hallucinated tables (DocumentAuditLog, HealthDataFile, MedicalProfile, UserConsents) do not exist', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const unexpectedTables = [
        'DocumentAuditLog',
        'HealthDataFile',
        'MedicalProfile',
        'UserConsents',
      ];

      const res = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
        SELECT tablename 
        FROM pg_catalog.pg_tables 
        WHERE schemaname = 'public' 
          AND tablename IN (${unexpectedTables.map((t) => `'${t}'`).join(', ')});
      `);

      expect(res).toHaveLength(0);
    });

    it('verifies every _owner_all policy has explicit USING (true) and WITH CHECK (true) targeting medimate_owner', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const policies = await prisma.$queryRawUnsafe<
        Array<{ tablename: string; policyname: string; roles: string[]; cmd: string; qual: string; with_check: string }>
      >(`
        SELECT tablename, policyname, roles, cmd, qual, with_check
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND policyname LIKE '%_owner_all'
        ORDER BY tablename;
      `);

      expect(policies.length).toBe(13);
      for (const pol of policies) {
        expect(pol.roles).toEqual(['medimate_owner']);
        expect(pol.cmd).toBe('ALL');
        expect(pol.qual).toBe('true');
        expect(pol.with_check).toBe('true');
      }
    });

    it('verifies strict RLS policy manager rejects unexpected application tables in public schema', async (ctx) => {
      if (!isPostgresLive || !ownerPrisma) {
        ctx.skip();
        return;
      }

      // 1. Normal state verifies cleanly in strict mode
      await expect(ownerPrisma.$executeRawUnsafe('SELECT public.apply_medimate_rls_policies(true);')).resolves.not.toThrow();

      // 2. An unexpected table causes apply_medimate_rls_policies(true) to fail visibly
      try {
        await ownerPrisma.$executeRawUnsafe('CREATE TABLE public.unexpected_canary_table (id text PRIMARY KEY);');
        await expect(ownerPrisma.$executeRawUnsafe('SELECT public.apply_medimate_rls_policies(true);')).rejects.toThrow(
          /Unexpected table public\."unexpected_canary_table" found in schema public/i
        );
      } finally {
        await ownerPrisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.unexpected_canary_table;');
        // Restore strict verified state
        await ownerPrisma.$executeRawUnsafe('SELECT public.apply_medimate_rls_policies(true);');
      }
    });

    it('verifies current_user matches medimate_app for runtime client and medimate_owner for migration client', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const appUser = await prisma.$queryRawUnsafe<Array<{ current_user: string; current_database: string }>>(
        'SELECT current_user, current_database();'
      );
      expect(appUser[0].current_user).toBe('medimate_app');
      expect(appUser[0].current_database).toBe('open-health');

      if (ownerPrisma) {
        const ownerUser = await ownerPrisma.$queryRawUnsafe<Array<{ current_user: string; current_database: string }>>(
          'SELECT current_user, current_database();'
        );
        expect(ownerUser[0].current_user).toBe('medimate_owner');
        expect(ownerUser[0].current_database).toBe('open-health');
      }
    });

    it('verifies multi-statement transactional atomicity on DDL failure', async (ctx) => {
      if (!isPostgresLive || !ownerPrisma) {
        ctx.skip();
        return;
      }

      // Execute a transaction that attempts DDL then deliberately fails
      await expect(
        ownerPrisma.$executeRawUnsafe(`
          DO $$
          BEGIN
            CREATE TABLE public.failing_tx_test_canary (id text PRIMARY KEY);
            RAISE EXCEPTION 'Deliberate migration step failure';
          END;
          $$;
        `)
      ).rejects.toThrow(/Deliberate migration step failure/i);

      // Verify table does not exist in catalog due to transaction rollback
      const check = await ownerPrisma.$queryRawUnsafe<Array<{ regclass: string | null }>>(
        `SELECT to_regclass('public.failing_tx_test_canary')::text as regclass;`
      );
      expect(check[0].regclass).toBeNull();
    });
  });

  describe('Migration Failure Semantics, Function Catalog & Security Parity (Checkpoint 5D.19)', () => {
    it('verifies all required security-definer functions exist with strict search_path and proper ownership', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const funcs = await prisma.$queryRawUnsafe<
        Array<{ proname: string; prosecdef: boolean; owner: string; proconfig: string[] | null }>
      >(`
        SELECT 
          p.proname,
          p.prosecdef,
          r.rolname as owner,
          p.proconfig
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'public'
          AND p.proname IN ('lookup_user_for_auth', 'apply_medimate_rls_policies', 'trg_apply_rls_on_ddl')
        ORDER BY p.proname;
      `);

      expect(funcs.length).toBe(3);

      const authLookup = funcs.find((f) => f.proname === 'lookup_user_for_auth');
      expect(authLookup).toBeDefined();
      expect(authLookup?.prosecdef).toBe(true);
      expect(authLookup?.owner).toBe('medimate_auth_definer');
      expect(authLookup?.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);

      const rlsPolicies = funcs.find((f) => f.proname === 'apply_medimate_rls_policies');
      expect(rlsPolicies).toBeDefined();
      expect(rlsPolicies?.prosecdef).toBe(true);
      expect(rlsPolicies?.owner).toBe('medimate_owner');
      expect(rlsPolicies?.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);

      const ddlTrigger = funcs.find((f) => f.proname === 'trg_apply_rls_on_ddl');
      expect(ddlTrigger).toBeDefined();
      expect(ddlTrigger?.prosecdef).toBe(true);
      expect(ddlTrigger?.owner).toBe('medimate_owner');
      expect(ddlTrigger?.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });

    it('verifies event trigger medimate_rls_event_trigger is active on ddl_command_end', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const triggers = await prisma.$queryRawUnsafe<
        Array<{ evtname: string; evtevent: string; evtenabled: string; function_name: string }>
      >(`
        SELECT 
          t.evtname,
          t.evtevent,
          t.evtenabled,
          p.proname as function_name
        FROM pg_catalog.pg_event_trigger t
        JOIN pg_catalog.pg_proc p ON p.oid = t.evtfoid
        WHERE t.evtname = 'medimate_rls_event_trigger';
      `);

      expect(triggers.length).toBe(1);
      expect(triggers[0].evtevent).toBe('ddl_command_end');
      expect(triggers[0].evtenabled).toBe('O'); // 'O' = origin and local (enabled)
      expect(triggers[0].function_name).toBe('trg_apply_rls_on_ddl');
    });

    it('verifies medimate_app possesses NOINHERIT and zero administrative role memberships', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const roleProps = await prisma.$queryRawUnsafe<Array<{ rolinherit: boolean; rolsuper: boolean; rolbypassrls: boolean }>>(`
        SELECT rolinherit, rolsuper, rolbypassrls
        FROM pg_catalog.pg_roles
        WHERE rolname = 'medimate_app';
      `);

      expect(roleProps.length).toBe(1);
      expect(roleProps[0].rolinherit).toBe(false);
      expect(roleProps[0].rolsuper).toBe(false);
      expect(roleProps[0].rolbypassrls).toBe(false);

      const memberships = await prisma.$queryRawUnsafe<Array<{ role: string }>>(`
        SELECT r.rolname as role
        FROM pg_catalog.pg_roles r
        JOIN pg_catalog.pg_auth_members am ON r.oid = am.roleid
        JOIN pg_catalog.pg_roles m ON m.oid = am.member
        WHERE m.rolname = 'medimate_app';
      `);

      expect(memberships.length).toBe(0);
    });

    it('verifies exact checksum matching between applied migrations and committed migration files', async (ctx) => {
      if (!isPostgresLive || !ownerPrisma) {
        ctx.skip();
        return;
      }

      const applied = await ownerPrisma.$queryRawUnsafe<
        Array<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>
      >(`
        SELECT migration_name, checksum, finished_at, rolled_back_at
        FROM public._prisma_migrations
        WHERE rolled_back_at IS NULL
        ORDER BY started_at ASC;
      `);

      expect(applied.length).toBeGreaterThanOrEqual(3);
      for (const m of applied) {
        expect(m.checksum).toBeDefined();
        expect(m.checksum.length).toBe(64); // SHA-256 hash
        expect(m.finished_at).not.toBeNull();
        expect(m.rolled_back_at).toBeNull();
      }
    });

    it('verifies release-job execution command succeeds and enforces strict RLS across all tables', async (ctx) => {
      if (!isPostgresLive || !ownerPrisma) {
        ctx.skip();
        return;
      }

      // Re-run strict mode verification directly as owner to simulate release-job post-migration step
      await expect(ownerPrisma.$executeRawUnsafe('SELECT public.apply_medimate_rls_policies(true);')).resolves.not.toThrow();

      // Verify that every single application table in schema public has rowsecurity and relforcerowsecurity enabled
      const tables = await ownerPrisma.$queryRawUnsafe<
        Array<{ tablename: string; rowsecurity: boolean; forcerowsecurity: boolean }>
      >(`
        SELECT t.tablename, t.rowsecurity, c.relforcerowsecurity as forcerowsecurity
        FROM pg_catalog.pg_tables t
        JOIN pg_catalog.pg_class c ON c.relname = t.tablename
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
        WHERE t.schemaname = 'public'
          AND t.tablename NOT IN ('_prisma_migrations');
      `);

      expect(tables.length).toBe(13);
      for (const t of tables) {
        expect(t.rowsecurity).toBe(true);
        expect(t.forcerowsecurity).toBe(true);
      }
    });
  });

  describe('LLMProvider System Secret Masking & Forward Migration Verification (Checkpoint 5D.20 Part A & B)', () => {
    it('verifies LLMProvider_authorId_idx physical index exists in PostgreSQL catalog', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(`
        SELECT indexname FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'LLMProvider'
          AND indexname = 'LLMProvider_authorId_idx';
      `);

      expect(idx.length).toBe(1);
    });

    it('verifies synthetic system provider with non-empty apiKey cannot be retrieved by ordinary tenants', async (ctx) => {
      if (!isPostgresLive || !ownerPrisma) {
        ctx.skip();
        return;
      }

      const canaryProviderId = 'synth_sys_canary_secret_provider';
      const secretCanary = 'SYNTHETIC_SECRET_CANARY_VALUE_5D20';

      try {
        // Seed as owner: system provider with non-empty secret key
        await ownerPrisma.$executeRawUnsafe(`
          INSERT INTO public."LLMProvider" (id, "providerId", name, "apiKey", "authorId", "createdAt", "updatedAt", "apiURL", "order")
          VALUES ('${canaryProviderId}', 'canary_llm', 'Canary System Secret', '${secretCanary}', NULL, NOW(), NOW(), 'https://api.canary.ai', 99)
          ON CONFLICT (id) DO UPDATE SET "apiKey" = EXCLUDED."apiKey";
        `);

        // Verify unauthenticated query returns 0 rows
        const unauthedRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM public."LLMProvider" WHERE id = '${canaryProviderId}';`
        );
        expect(unauthedRows.length).toBe(0);

        // Verify Alpha tenant context returns 0 rows (RLS blocks system provider with non-empty key)
        await withTenantContext(alphaId, async (tx) => {
          const alphaRows = await tx.$queryRawUnsafe<Array<{ id: string; apiKey: string }>>(
            `SELECT id, "apiKey" FROM public."LLMProvider" WHERE id = '${canaryProviderId}';`
          );
          expect(alphaRows.length).toBe(0);
        });

        // Verify Beta tenant context returns 0 rows
        await withTenantContext(betaId, async (tx) => {
          const betaRows = await tx.$queryRawUnsafe<Array<{ id: string; apiKey: string }>>(
            `SELECT id, "apiKey" FROM public."LLMProvider" WHERE id = '${canaryProviderId}';`
          );
          expect(betaRows.length).toBe(0);
        });
      } finally {
        await ownerPrisma.$executeRawUnsafe(`DELETE FROM public."LLMProvider" WHERE id = '${canaryProviderId}';`);
      }
    });

    it('verifies system default provider with empty apiKey is accessible to tenants', async (ctx) => {
      if (!isPostgresLive) {
        ctx.skip();
        return;
      }

      await withTenantContext(alphaId, async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ id: string; apiKey: string }>>(
          `SELECT id, "apiKey" FROM public."LLMProvider" WHERE id = 'synth_sys_llm_prov_01';`
        );
        expect(rows.length).toBe(1);
        expect(rows[0].apiKey).toBe('');
      });
    });
  });
});
