-- MediMate AI: Multi-Tenant Row Level Security (RLS) Policies & Event Trigger
-- Protects sensitive clinical records, chat transcripts, OAuth credentials, and user profiles.
-- Enforces fail-closed isolation: missing or unauthenticated context denies all access.

-- 1. Pre-authentication lookup function (SECURITY DEFINER)
-- Hardened with search_path = '' to prevent schema poisoning attacks.
-- Owned by dedicated 'medimate_auth_definer' role which possesses BYPASSRLS.
-- This safely resolves the interaction between FORCE ROW LEVEL SECURITY on "User" and
-- pre-authentication credential verification without granting BYPASSRLS to runtime roles.
CREATE OR REPLACE FUNCTION public.lookup_user_for_auth(p_username text)
RETURNS TABLE (id text, password text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
        SELECT u.id, u.password
        FROM public."User" u
        WHERE u.username = p_username
        LIMIT 1;
END;
$$;

-- Restrict execution: revoke from PUBLIC, grant exclusively to app runtime role
REVOKE EXECUTE ON FUNCTION public.lookup_user_for_auth(text) FROM PUBLIC;

DO $auth_setup$
BEGIN
    -- Assign function ownership to dedicated auth definer role if available
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_auth_definer') THEN
        ALTER FUNCTION public.lookup_user_for_auth(text) OWNER TO medimate_auth_definer;
    END IF;

    -- Grant execution privilege to application runtime role
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_app') THEN
        GRANT EXECUTE ON FUNCTION public.lookup_user_for_auth(text) TO medimate_app;
    END IF;
END
$auth_setup$;

-- 2. Core RLS Policy Application Function
-- Hardened with SECURITY DEFINER and search_path = ''
CREATE OR REPLACE FUNCTION public.apply_medimate_rls_policies()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $rls$
DECLARE
    r record;
BEGIN
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

    -- Task I: Ensure _prisma_migrations is completely inaccessible to application runtime and PUBLIC
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
    END IF;

    -- 11. RedditAccessToken (Restricted system tokens)
    -- Task A: Spoofable Boolean GUC (app.is_admin_context) completely eliminated.
    -- Table access explicitly targeted to dedicated service role TO medimate_reddit_worker.
    -- Application runtime role (medimate_app) has zero access.
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'RedditAccessToken') THEN
        DROP POLICY IF EXISTS reddit_token_tenant_isolation ON public."RedditAccessToken";
        DROP POLICY IF EXISTS reddit_token_worker_policy ON public."RedditAccessToken";

        DO $worker_policy$
        BEGIN
            IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
                CREATE POLICY reddit_token_worker_policy ON public."RedditAccessToken"
                    TO medimate_reddit_worker
                    FOR ALL
                    USING (true)
                    WITH CHECK (true);
            END IF;
        END
        $worker_policy$;
    END IF;

    -- 12. RedditPost and RedditPostComment (Worker synchronization tables)
    -- Explicitly targeted to dedicated service role TO medimate_reddit_worker.
    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'RedditPost') THEN
        DROP POLICY IF EXISTS reddit_post_worker_policy ON public."RedditPost";
        DO $post_worker_policy$
        BEGIN
            IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
                CREATE POLICY reddit_post_worker_policy ON public."RedditPost"
                    TO medimate_reddit_worker
                    FOR ALL
                    USING (true)
                    WITH CHECK (true);
            END IF;
        END
        $post_worker_policy$;
    END IF;

    IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'RedditPostComment') THEN
        DROP POLICY IF EXISTS reddit_comment_worker_policy ON public."RedditPostComment";
        DO $comment_worker_policy$
        BEGIN
            IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
                CREATE POLICY reddit_comment_worker_policy ON public."RedditPostComment"
                    TO medimate_reddit_worker
                    FOR ALL
                    USING (true)
                    WITH CHECK (true);
            END IF;
        END
        $comment_worker_policy$;
    END IF;
END;
$rls$;

-- Revoke execute on management function from PUBLIC
REVOKE EXECUTE ON FUNCTION public.apply_medimate_rls_policies() FROM PUBLIC;

-- Execute immediately to apply policies to any existing tables
SELECT public.apply_medimate_rls_policies();

-- Create event trigger to automatically apply RLS whenever new tables are created via Prisma DDL
CREATE OR REPLACE FUNCTION public.trg_apply_rls_on_ddl()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.apply_medimate_rls_policies();
END;
$$;

-- Revoke execute on trigger function from PUBLIC
REVOKE EXECUTE ON FUNCTION public.trg_apply_rls_on_ddl() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS medimate_rls_event_trigger;
CREATE EVENT TRIGGER medimate_rls_event_trigger
    ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS')
    EXECUTE FUNCTION public.trg_apply_rls_on_ddl();
