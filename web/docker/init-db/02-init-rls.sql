-- MediMate AI: Multi-Tenant Row Level Security (RLS) Policies & Event Trigger
-- Protects sensitive clinical records, chat transcripts, and OAuth credentials.
-- Enforces fail-closed isolation: missing or unauthenticated context denies all access.

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

    -- 5. OAuth2Token (Patient authorization tokens)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'OAuth2Token') THEN
        ALTER TABLE "OAuth2Token" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "OAuth2Token" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS oauth2_token_tenant_isolation ON "OAuth2Token";
        CREATE POLICY oauth2_token_tenant_isolation ON "OAuth2Token"
            FOR ALL
            USING ("user_id" = current_setting('app.current_user_id', true))
            WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
    END IF;

    -- 6. User (Account credentials and profiles)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'User') THEN
        ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "User" FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS user_self_isolation ON "User";
        CREATE POLICY user_self_isolation ON "User"
            FOR ALL
            USING (id = current_setting('app.current_user_id', true))
            WITH CHECK (id = current_setting('app.current_user_id', true));
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

