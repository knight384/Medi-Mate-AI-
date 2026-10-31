-- MediMate AI: Multi-Tenant Row Level Security (RLS) Policies & Event Trigger
-- Protects sensitive clinical records, chat transcripts, OAuth credentials, and user profiles.
-- Enforces fail-closed isolation: missing or unauthenticated context denies all access.

-- Pre-authentication lookup function (SECURITY DEFINER)
-- Allows checking credentials by exact username during login without exposing User table enumeration to runtime role.
CREATE OR REPLACE FUNCTION lookup_user_for_auth(p_username text)
RETURNS TABLE (id text, password text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT "User".id, "User".password
    FROM "User"
    WHERE "User".username = p_username
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION apply_medimate_rls_policies()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $rls$
BEGIN
    -- 1. HealthData (Medical documents, clinical notes, patient observations)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'HealthData') THEN
        ALTER TABLE "HealthData" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "HealthData" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS health_data_tenant_isolation ON "HealthData";
        CREATE POLICY health_data_tenant_isolation ON "HealthData"
            FOR ALL
            USING ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true))
            WITH CHECK ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true));
    END IF;

    -- 2. ChatRoom (Clinical conversations and triage rooms)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ChatRoom') THEN
        ALTER TABLE "ChatRoom" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "ChatRoom" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS chat_room_tenant_isolation ON "ChatRoom";
        CREATE POLICY chat_room_tenant_isolation ON "ChatRoom"
            FOR ALL
            USING ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true))
            WITH CHECK ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true));
    END IF;

    -- 3. ChatMessage (Child table of ChatRoom; isolated through parent join)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ChatMessage') THEN
        ALTER TABLE "ChatMessage" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "ChatMessage" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS chat_message_tenant_isolation ON "ChatMessage";
        CREATE POLICY chat_message_tenant_isolation ON "ChatMessage"
            FOR ALL
            USING (
                EXISTS (
                    SELECT 1 FROM "ChatRoom"
                    WHERE "ChatRoom".id = "ChatMessage"."chatRoomId"
                      AND "ChatRoom"."authorId" IS NOT NULL
                      AND "ChatRoom"."authorId" = current_setting('app.current_user_id', true)
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM "ChatRoom"
                    WHERE "ChatRoom".id = "ChatMessage"."chatRoomId"
                      AND "ChatRoom"."authorId" IS NOT NULL
                      AND "ChatRoom"."authorId" = current_setting('app.current_user_id', true)
                )
            );
    END IF;

    -- 4. AssistantMode (Medical assistant configurations with PUBLIC/PRIVATE visibility)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'AssistantMode') THEN
        ALTER TABLE "AssistantMode" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "AssistantMode" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS assistant_mode_select_policy ON "AssistantMode";
        CREATE POLICY assistant_mode_select_policy ON "AssistantMode"
            FOR SELECT
            USING ("visibility"::text = 'PUBLIC' OR ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true)));

        DROP POLICY IF EXISTS assistant_mode_modify_policy ON "AssistantMode";
        CREATE POLICY assistant_mode_modify_policy ON "AssistantMode"
            FOR ALL
            USING ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true))
            WITH CHECK ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true));
    END IF;

    -- 5. AssistantModeContext (Child table of AssistantMode)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'AssistantModeContext') THEN
        ALTER TABLE "AssistantModeContext" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "AssistantModeContext" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS assistant_mode_context_tenant_isolation ON "AssistantModeContext";
        CREATE POLICY assistant_mode_context_tenant_isolation ON "AssistantModeContext"
            FOR ALL
            USING (
                EXISTS (
                    SELECT 1 FROM "AssistantMode"
                    WHERE "AssistantMode".id = "AssistantModeContext"."assistantModeId"
                      AND ("AssistantMode"."visibility"::text = 'PUBLIC' OR ("AssistantMode"."authorId" IS NOT NULL AND "AssistantMode"."authorId" = current_setting('app.current_user_id', true)))
                )
            )
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM "AssistantMode"
                    WHERE "AssistantMode".id = "AssistantModeContext"."assistantModeId"
                      AND "AssistantMode"."authorId" IS NOT NULL
                      AND "AssistantMode"."authorId" = current_setting('app.current_user_id', true)
                )
            );
    END IF;

    -- 6. LLMProvider (API credentials; system default has authorId IS NULL)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'LLMProvider') THEN
        ALTER TABLE "LLMProvider" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "LLMProvider" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS llm_provider_select_policy ON "LLMProvider";
        CREATE POLICY llm_provider_select_policy ON "LLMProvider"
            FOR SELECT
            USING ("authorId" IS NULL OR "authorId" = current_setting('app.current_user_id', true));

        DROP POLICY IF EXISTS llm_provider_modify_policy ON "LLMProvider";
        CREATE POLICY llm_provider_modify_policy ON "LLMProvider"
            FOR ALL
            USING ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true))
            WITH CHECK ("authorId" IS NOT NULL AND "authorId" = current_setting('app.current_user_id', true));
    END IF;

    -- 7. OAuth2Token (Patient authorization tokens)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'OAuth2Token') THEN
        ALTER TABLE "OAuth2Token" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "OAuth2Token" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS oauth2_token_tenant_isolation ON "OAuth2Token";
        CREATE POLICY oauth2_token_tenant_isolation ON "OAuth2Token"
            FOR ALL
            USING ("user_id" = current_setting('app.current_user_id', true))
            WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
    END IF;

    -- 8. OAuth2Client (Client credentials)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'OAuth2Client') THEN
        ALTER TABLE "OAuth2Client" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "OAuth2Client" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS oauth2_client_tenant_isolation ON "OAuth2Client";
        CREATE POLICY oauth2_client_tenant_isolation ON "OAuth2Client"
            FOR ALL
            USING ("user_id" = current_setting('app.current_user_id', true))
            WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
    END IF;

    -- 9. OAuth2AuthorizationCode (Temporary auth codes)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'OAuth2AuthorizationCode') THEN
        ALTER TABLE "OAuth2AuthorizationCode" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "OAuth2AuthorizationCode" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS oauth2_code_tenant_isolation ON "OAuth2AuthorizationCode";
        CREATE POLICY oauth2_code_tenant_isolation ON "OAuth2AuthorizationCode"
            FOR ALL
            USING ("user_id" = current_setting('app.current_user_id', true))
            WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
    END IF;

    -- 10. User (Account credentials and profiles)
    -- Registration allows INSERT; profile access strictly restricted to self
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'User') THEN
        ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "User" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS user_register_insert ON "User";
        CREATE POLICY user_register_insert ON "User"
            FOR INSERT
            WITH CHECK (true);

        DROP POLICY IF EXISTS user_self_select ON "User";
        CREATE POLICY user_self_select ON "User"
            FOR SELECT
            USING (id = current_setting('app.current_user_id', true));

        DROP POLICY IF EXISTS user_self_update ON "User";
        CREATE POLICY user_self_update ON "User"
            FOR UPDATE
            USING (id = current_setting('app.current_user_id', true))
            WITH CHECK (id = current_setting('app.current_user_id', true));

        DROP POLICY IF EXISTS user_self_delete ON "User";
        CREATE POLICY user_self_delete ON "User"
            FOR DELETE
            USING (id = current_setting('app.current_user_id', true));
    END IF;

    -- 11. RedditAccessToken (Restricted system tokens)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'RedditAccessToken') THEN
        ALTER TABLE "RedditAccessToken" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "RedditAccessToken" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS reddit_token_tenant_isolation ON "RedditAccessToken";
        CREATE POLICY reddit_token_tenant_isolation ON "RedditAccessToken"
            FOR ALL
            USING (current_setting('app.is_admin_context', true) = 'true')
            WITH CHECK (current_setting('app.is_admin_context', true) = 'true');
    END IF;
END;
$rls$;

-- Execute immediately to apply policies to any existing tables
SELECT apply_medimate_rls_policies();

-- Create event trigger to automatically apply RLS whenever new tables are created via Prisma DDL
CREATE OR REPLACE FUNCTION trg_apply_rls_on_ddl()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM apply_medimate_rls_policies();
END;
$$;

DROP EVENT TRIGGER IF EXISTS medimate_rls_event_trigger;
CREATE EVENT TRIGGER medimate_rls_event_trigger
    ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS')
    EXECUTE FUNCTION trg_apply_rls_on_ddl();
