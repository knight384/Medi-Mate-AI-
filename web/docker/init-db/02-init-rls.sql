-- MediMate AI: Multi-Tenant Row Level Security (RLS) Policies & Event Trigger
-- Protects sensitive clinical records, chat transcripts, OAuth credentials, and user profiles.
-- Enforces fail-closed isolation: missing or unauthenticated context denies all access.

-- 1. Pre-authentication lookup function (SECURITY DEFINER)
-- Atomically created, ownership assigned to medimate_auth_definer, execution revoked from PUBLIC
-- search_path is explicitly configured with trusted schemas and pg_temp last (Task A).
-- Parameterized SQL ensures no dynamic SQL injection vulnerabilities.
DO $init_auth_fn$
BEGIN
    CREATE OR REPLACE FUNCTION public.lookup_user_for_auth(p_username text)
    RETURNS TABLE (id text, password text)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS $$
    BEGIN
        RETURN QUERY
            SELECT u.id, u.password
            FROM public."User" u
            WHERE u.username = p_username
            LIMIT 1;
    END;
    $$;

    -- Revoke execute from PUBLIC and all unauthorized roles atomically
    REVOKE ALL ON FUNCTION public.lookup_user_for_auth(text) FROM PUBLIC;

    -- Assign function ownership to dedicated auth definer role if available
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_auth_definer') THEN
        ALTER FUNCTION public.lookup_user_for_auth(text) OWNER TO medimate_auth_definer;
    END IF;

    -- Grant execution privilege exclusively to application runtime role
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
        GRANT EXECUTE ON FUNCTION public.lookup_user_for_auth(text) TO medimate_app;
    END IF;
END;
$init_auth_fn$;

-- 2. Core RLS Policy & Column Permission Management Function
-- Hardened with SECURITY DEFINER and search_path = public, pg_catalog, pg_temp
-- Supports lenient mode (p_strict = false) for DDL trigger on initial cluster setup,
-- and strict mode (p_strict = true) for post-migration verification (Task B).
CREATE OR REPLACE FUNCTION public.apply_medimate_rls_policies(p_strict boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $rls$
DECLARE
    r record;
    v_tab text;
    v_pol text;
    v_expected_tables text[] := ARRAY[
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
        'RedditPostComment'
    ];
BEGIN
    -- Strict mode validation: fail visibly if any required clinical/security table is missing (Task B)
    IF p_strict THEN
        FOREACH v_tab IN ARRAY v_expected_tables LOOP
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = v_tab) THEN
                RAISE EXCEPTION 'MediMate AI RLS verification failed: Required table public."%" does not exist', v_tab;
            END IF;
        END LOOP;
    END IF;

    -- Fail-closed default: Enable and FORCE RLS on every public table (except Prisma migration ledger)
    -- Any newly created table without an explicit policy is immediately locked down (deny-all).
    FOR r IN (
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('_prisma_migrations')
    ) LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.tablename);
    END LOOP;

    -- Migration owner operational policy: Ensure schema owner (medimate_owner) retains full management access for migrations and maintenance
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_owner') THEN
        FOR r IN (
            SELECT tablename
            FROM pg_catalog.pg_tables
            WHERE schemaname = 'public'
              AND tablename NOT IN ('_prisma_migrations')
        ) LOOP
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tablename || '_owner_all', r.tablename);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO medimate_owner USING (true) WITH CHECK (true)', r.tablename || '_owner_all', r.tablename);
        END LOOP;
    END IF;

    -- Task I: Ensure _prisma_migrations is completely excluded from RLS and inaccessible to medimate_app
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations') THEN
        EXECUTE 'REVOKE ALL ON TABLE public._prisma_migrations FROM PUBLIC';
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
            EXECUTE 'REVOKE ALL ON TABLE public._prisma_migrations FROM medimate_app';
        END IF;
    END IF;

    -- 1. HealthData (Medical documents, clinical notes, patient observations)
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'HealthData') THEN
        DROP POLICY IF EXISTS health_data_tenant_isolation ON public."HealthData";
        CREATE POLICY health_data_tenant_isolation ON public."HealthData"
            FOR ALL
            USING ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true))
            WITH CHECK ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true));
    END IF;

    -- 2. ChatRoom (Clinical conversations and triage rooms)
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'ChatRoom') THEN
        DROP POLICY IF EXISTS chat_room_tenant_isolation ON public."ChatRoom";
        CREATE POLICY chat_room_tenant_isolation ON public."ChatRoom"
            FOR ALL
            USING ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true))
            WITH CHECK ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true));
    END IF;

    -- 3. ChatMessage (Child table of ChatRoom; isolated through parent join)
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'ChatMessage') THEN
        DROP POLICY IF EXISTS chat_message_tenant_isolation ON public."ChatMessage";
        CREATE POLICY chat_message_tenant_isolation ON public."ChatMessage"
            FOR ALL
            USING (
                EXISTS (
                    SELECT 1 FROM public."ChatRoom"
                    WHERE "ChatRoom".id = "ChatMessage"."chatRoomId"
                      AND "ChatRoom"."authorId" IS NOT NULL
                      AND "ChatRoom"."authorId" = pg_catalog.current_setting('app.current_user_id', true)
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM public."ChatRoom"
                    WHERE "ChatRoom".id = "ChatMessage"."chatRoomId"
                      AND "ChatRoom"."authorId" IS NOT NULL
                      AND "ChatRoom"."authorId" = pg_catalog.current_setting('app.current_user_id', true)
                )
            );
    END IF;

    -- 4. AssistantMode (Medical assistant configurations with PUBLIC/PRIVATE visibility)
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'AssistantMode') THEN
        DROP POLICY IF EXISTS assistant_mode_select_policy ON public."AssistantMode";
        CREATE POLICY assistant_mode_select_policy ON public."AssistantMode"
            FOR SELECT
            USING ("visibility"::text = 'PUBLIC' OR ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true)));

        DROP POLICY IF EXISTS assistant_mode_modify_policy ON public."AssistantMode";
        CREATE POLICY assistant_mode_modify_policy ON public."AssistantMode"
            FOR ALL
            USING ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true))
            WITH CHECK ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true));
    END IF;

    -- 5. AssistantModeContext (Child table of AssistantMode)
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'AssistantModeContext') THEN
        DROP POLICY IF EXISTS assistant_mode_context_tenant_isolation ON public."AssistantModeContext";
        CREATE POLICY assistant_mode_context_tenant_isolation ON public."AssistantModeContext"
            FOR ALL
            USING (
                EXISTS (
                    SELECT 1 FROM public."AssistantMode"
                    WHERE "AssistantMode".id = "AssistantModeContext"."assistantModeId"
                      AND ("AssistantMode"."visibility"::text = 'PUBLIC' OR ("AssistantMode"."authorId" IS NOT NULL AND "AssistantMode"."authorId" = pg_catalog.current_setting('app.current_user_id', true)))
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM public."AssistantMode"
                    WHERE "AssistantMode".id = "AssistantModeContext"."assistantModeId"
                      AND "AssistantMode"."authorId" IS NOT NULL
                      AND "AssistantMode"."authorId" = pg_catalog.current_setting('app.current_user_id', true)
                )
            );
    END IF;

    -- 6. LLMProvider (API credentials; system default has authorId IS NULL and apiKey = '')
    -- Task E: Enforces that system default providers (authorId IS NULL) NEVER expose API credentials.
    -- Non-empty API keys can strictly only be read if the provider belongs to the authenticated tenant.
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'LLMProvider') THEN
        DROP POLICY IF EXISTS llm_provider_select_policy ON public."LLMProvider";
        CREATE POLICY llm_provider_select_policy ON public."LLMProvider"
            FOR SELECT
            USING (
                ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true))
                OR ("authorId" IS NULL AND "apiKey" = '')
            );

        DROP POLICY IF EXISTS llm_provider_modify_policy ON public."LLMProvider";
        CREATE POLICY llm_provider_modify_policy ON public."LLMProvider"
            FOR ALL
            USING ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true))
            WITH CHECK ("authorId" IS NOT NULL AND "authorId" = pg_catalog.current_setting('app.current_user_id', true));
    END IF;

    -- 7. OAuth2Token (Patient authorization tokens; physical column is "user_id")
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'OAuth2Token') THEN
        DROP POLICY IF EXISTS oauth2_token_tenant_isolation ON public."OAuth2Token";
        CREATE POLICY oauth2_token_tenant_isolation ON public."OAuth2Token"
            FOR ALL
            USING ("user_id" = pg_catalog.current_setting('app.current_user_id', true))
            WITH CHECK ("user_id" = pg_catalog.current_setting('app.current_user_id', true));
    END IF;

    -- 8. OAuth2Client (Client credentials; physical column is "user_id")
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'OAuth2Client') THEN
        DROP POLICY IF EXISTS oauth2_client_tenant_isolation ON public."OAuth2Client";
        CREATE POLICY oauth2_client_tenant_isolation ON public."OAuth2Client"
            FOR ALL
            USING ("user_id" = pg_catalog.current_setting('app.current_user_id', true))
            WITH CHECK ("user_id" = pg_catalog.current_setting('app.current_user_id', true));
    END IF;

    -- 9. OAuth2AuthorizationCode (Temporary auth codes; physical column is "user_id")
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'OAuth2AuthorizationCode') THEN
        DROP POLICY IF EXISTS oauth2_code_tenant_isolation ON public."OAuth2AuthorizationCode";
        CREATE POLICY oauth2_code_tenant_isolation ON public."OAuth2AuthorizationCode"
            FOR ALL
            USING ("user_id" = pg_catalog.current_setting('app.current_user_id', true))
            WITH CHECK ("user_id" = pg_catalog.current_setting('app.current_user_id', true));
    END IF;

    -- 10. User (Account credentials and profiles)
    -- Task C: Registration enforces safe defaults (hasOnboarded=false, bounded username/password lengths)
    -- Profile access strictly restricted to self.
    -- Task D: Dedicated SELECT policy for medimate_auth_definer enables pre-auth lookup without global BYPASSRLS.
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'User') THEN
        DROP POLICY IF EXISTS user_auth_definer_select ON public."User";
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_auth_definer') THEN
            CREATE POLICY user_auth_definer_select ON public."User"
                FOR SELECT
                TO medimate_auth_definer
                USING (true);
        END IF;

        DROP POLICY IF EXISTS user_register_insert ON public."User";
        CREATE POLICY user_register_insert ON public."User"
            FOR INSERT
            WITH CHECK (
                "hasOnboarded" = false
                AND id IS NOT NULL
                AND length(username) >= 1
                AND length(username) <= 100
                AND length(password) >= 20
            );

        DROP POLICY IF EXISTS user_self_select ON public."User";
        CREATE POLICY user_self_select ON public."User"
            FOR SELECT
            USING (id = pg_catalog.current_setting('app.current_user_id', true));

        DROP POLICY IF EXISTS user_self_update ON public."User";
        CREATE POLICY user_self_update ON public."User"
            FOR UPDATE
            USING (id = pg_catalog.current_setting('app.current_user_id', true))
            WITH CHECK (id = pg_catalog.current_setting('app.current_user_id', true));

        DROP POLICY IF EXISTS user_self_delete ON public."User";
        CREATE POLICY user_self_delete ON public."User"
            FOR DELETE
            USING (id = pg_catalog.current_setting('app.current_user_id', true));

        -- Enforce column-level least privilege on User table dynamically whenever created/verified
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
            EXECUTE 'REVOKE INSERT ON TABLE public."User" FROM medimate_app';
            EXECUTE 'GRANT INSERT (id, username, password, "hasOnboarded", "createdAt", "updatedAt") ON TABLE public."User" TO medimate_app';
            EXECUTE 'REVOKE UPDATE ON TABLE public."User" FROM medimate_app';
            EXECUTE 'GRANT UPDATE (name, password, "hasOnboarded", "updatedAt") ON TABLE public."User" TO medimate_app';
            EXECUTE 'REVOKE SELECT ON TABLE public."User" FROM medimate_app';
            EXECUTE 'GRANT SELECT (id, name, username, "hasOnboarded", "createdAt", "updatedAt") ON TABLE public."User" TO medimate_app';
        END IF;

        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_auth_definer') THEN
            EXECUTE 'REVOKE ALL ON TABLE public."User" FROM medimate_auth_definer';
            EXECUTE 'GRANT SELECT (id, username, password) ON TABLE public."User" TO medimate_auth_definer';
        END IF;
    END IF;

    -- 11. RedditAccessToken (Restricted system tokens)
    -- Task A: Spoofable Boolean GUC (app.is_admin_context) completely eliminated.
    -- Table access explicitly targeted to dedicated service role TO medimate_reddit_worker.
    -- Application runtime role (medimate_app) has zero access.
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'RedditAccessToken') THEN
        DROP POLICY IF EXISTS reddit_token_tenant_isolation ON public."RedditAccessToken";
        DROP POLICY IF EXISTS reddit_token_worker_policy ON public."RedditAccessToken";

        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
            CREATE POLICY reddit_token_worker_policy ON public."RedditAccessToken"
                FOR ALL
                TO medimate_reddit_worker
                USING (true)
                WITH CHECK (true);
        END IF;

        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
            EXECUTE 'REVOKE ALL ON TABLE public."RedditAccessToken" FROM medimate_app';
        END IF;
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."RedditAccessToken" TO medimate_reddit_worker';
        END IF;
    END IF;

    -- 12. RedditPost and RedditPostComment (Worker synchronization tables)
    -- Explicitly targeted to dedicated service role TO medimate_reddit_worker.
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'RedditPost') THEN
        DROP POLICY IF EXISTS reddit_post_worker_policy ON public."RedditPost";
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
            CREATE POLICY reddit_post_worker_policy ON public."RedditPost"
                FOR ALL
                TO medimate_reddit_worker
                USING (true)
                WITH CHECK (true);
        END IF;

        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
            EXECUTE 'REVOKE ALL ON TABLE public."RedditPost" FROM medimate_app';
        END IF;
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."RedditPost" TO medimate_reddit_worker';
        END IF;
    END IF;

    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'RedditPostComment') THEN
        DROP POLICY IF EXISTS reddit_comment_worker_policy ON public."RedditPostComment";
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
            CREATE POLICY reddit_comment_worker_policy ON public."RedditPostComment"
                FOR ALL
                TO medimate_reddit_worker
                USING (true)
                WITH CHECK (true);
        END IF;

        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
            EXECUTE 'REVOKE ALL ON TABLE public."RedditPostComment" FROM medimate_app';
        END IF;
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."RedditPostComment" TO medimate_reddit_worker';
        END IF;
    END IF;

    -- Strict mode policy verification: fail visibly if any expected policy is missing
    IF p_strict THEN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'User' AND policyname = 'user_auth_definer_select') THEN
            RAISE EXCEPTION 'MediMate AI RLS verification failed: Policy user_auth_definer_select on User is missing';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'HealthData' AND policyname = 'health_data_tenant_isolation') THEN
            RAISE EXCEPTION 'MediMate AI RLS verification failed: Policy health_data_tenant_isolation on HealthData is missing';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'ChatRoom' AND policyname = 'chat_room_tenant_isolation') THEN
            RAISE EXCEPTION 'MediMate AI RLS verification failed: Policy chat_room_tenant_isolation on ChatRoom is missing';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'ChatMessage' AND policyname = 'chat_message_tenant_isolation') THEN
            RAISE EXCEPTION 'MediMate AI RLS verification failed: Policy chat_message_tenant_isolation on ChatMessage is missing';
        END IF;
    END IF;
END;
$rls$;

-- Revoke execute on policy management function from PUBLIC and application runtime role
REVOKE ALL ON FUNCTION public.apply_medimate_rls_policies(boolean) FROM PUBLIC;
DO $app_revoke$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
        REVOKE ALL ON FUNCTION public.apply_medimate_rls_policies(boolean) FROM medimate_app;
    END IF;
END
$app_revoke$;

-- Grant execute and assign ownership of policy management function to schema owner
DO $owner_grant$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_owner') THEN
        ALTER FUNCTION public.apply_medimate_rls_policies(boolean) OWNER TO medimate_owner;
        GRANT EXECUTE ON FUNCTION public.apply_medimate_rls_policies(boolean) TO medimate_owner;
    END IF;
END
$owner_grant$;

-- Execute bootstrap policy application in non-strict mode (safe for empty data directory)
SELECT public.apply_medimate_rls_policies(false);

-- Ensure public schema trust boundaries: untrusted roles cannot create objects in searched schemas
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $schema_revoke$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
        REVOKE CREATE ON SCHEMA public FROM medimate_app;
    END IF;
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_auth_definer') THEN
        REVOKE CREATE ON SCHEMA public FROM medimate_auth_definer;
    END IF;
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
        REVOKE CREATE ON SCHEMA public FROM medimate_reddit_worker;
    END IF;
END
$schema_revoke$;

-- Create event trigger function to automatically apply RLS whenever new tables are created via Prisma DDL
CREATE OR REPLACE FUNCTION public.trg_apply_rls_on_ddl()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    PERFORM public.apply_medimate_rls_policies(false);
END;
$$;

-- Revoke execute on trigger function from PUBLIC and application runtime role
REVOKE ALL ON FUNCTION public.trg_apply_rls_on_ddl() FROM PUBLIC;
DO $trg_revoke$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
        REVOKE ALL ON FUNCTION public.trg_apply_rls_on_ddl() FROM medimate_app;
    END IF;
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_owner') THEN
        ALTER FUNCTION public.trg_apply_rls_on_ddl() OWNER TO medimate_owner;
        GRANT EXECUTE ON FUNCTION public.trg_apply_rls_on_ddl() TO medimate_owner;
    END IF;
END
$trg_revoke$;

DROP EVENT TRIGGER IF EXISTS medimate_rls_event_trigger;
CREATE EVENT TRIGGER medimate_rls_event_trigger
    ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS')
    EXECUTE FUNCTION public.trg_apply_rls_on_ddl();
