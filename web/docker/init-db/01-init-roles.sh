#!/bin/sh
set -e

APP_USER="${APP_DB_USER:-medimate_app}"
APP_PASS="${APP_DB_PASSWORD:?APP_DB_PASSWORD environment variable is required}"
OWNER_USER="${OWNER_DB_USER:-medimate_owner}"
OWNER_PASS="${OWNER_DB_PASSWORD:?OWNER_DB_PASSWORD environment variable is required}"
TARGET_DB="${POSTGRES_DB:-open-health}"

echo "MediMate AI: Initializing least-privilege PostgreSQL roles for database: $TARGET_DB..."

# Pass environment variables safely via psql -v to prevent shell interpolation injection.
# The heredoc is quoted (<<'EOSQL') so no shell expansion occurs inside the SQL text.
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$TARGET_DB" \
     -v owner_user="$OWNER_USER" \
     -v owner_pass="$OWNER_PASS" \
     -v app_user="$APP_USER" \
     -v app_pass="$APP_PASS" \
     -v target_db="$TARGET_DB" <<'EOSQL'

-- 1. Create or update the schema owner role (for Prisma migrations / DDL)
-- Uses EXECUTE format with %I for identifiers and %L for literals to prevent SQL injection.
DO $do$
DECLARE
    v_owner_user text := :'owner_user';
    v_owner_pass text := :'owner_pass';
    v_app_user   text := :'app_user';
    v_app_pass   text := :'app_pass';
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = v_owner_user) THEN
        EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER INHERIT', v_owner_user, v_owner_pass);
    ELSE
        EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER INHERIT', v_owner_user, v_owner_pass);
    END IF;

    -- 2. Create or update the application runtime role (least-privilege, no DDL, no superuser, no bypass RLS)
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = v_app_user) THEN
        EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', v_app_user, v_app_pass);
    ELSE
        EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', v_app_user, v_app_pass);
    END IF;

    -- 2b. Create dedicated internal authentication role (NOLOGIN, BYPASSRLS for SECURITY DEFINER auth lookup)
    -- This role cannot be logged into directly, cannot be assumed by app_user, and solely owns pre-auth functions.
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_auth_definer') THEN
        CREATE ROLE medimate_auth_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
    ELSE
        ALTER ROLE medimate_auth_definer WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
    END IF;

    -- 2c. Create dedicated worker role for Reddit operations (least-privilege, no DDL, no superuser, no bypass RLS)
    -- Isolated service identity to prevent spoofable Boolean GUC privilege escalation from runtime app role.
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medimate_reddit_worker') THEN
        CREATE ROLE medimate_reddit_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    ELSE
        ALTER ROLE medimate_reddit_worker WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$do$;

-- 3. Grant schema ownership and DDL permissions to the owner role
EXECUTE format('ALTER SCHEMA public OWNER TO %I', :'owner_user');
EXECUTE format('GRANT ALL ON SCHEMA public TO %I', :'owner_user');

-- 4. Grant database connection and schema access to runtime app role
EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', :'target_db', :'app_user');
EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', :'app_user');
EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_user');

-- Grant schema access and read privileges to dedicated auth definer role
GRANT USAGE ON SCHEMA public TO medimate_auth_definer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO medimate_auth_definer;

-- Grant schema access to dedicated Reddit worker role
GRANT USAGE ON SCHEMA public TO medimate_reddit_worker;

-- 5. Grant data manipulation privileges on existing tables to runtime app role
EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user');

-- 5b. Enforce column-level least-privilege on User table for registration
-- Prevents privilege escalation by restricting registration INSERT to required user columns only.
IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'User') THEN
    EXECUTE format('REVOKE INSERT ON TABLE public."User" FROM %I', :'app_user');
    EXECUTE format('GRANT INSERT (id, username, password, "hasOnboarded", "createdAt", "updatedAt") ON TABLE public."User" TO %I', :'app_user');
END IF;

-- Explicitly revoke access to migration history from application runtime
IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations') THEN
    EXECUTE format('REVOKE ALL ON TABLE _prisma_migrations FROM %I', :'app_user');
END IF;

-- Explicitly revoke access to RedditAccessToken from application runtime role (Task A)
-- Grants minimum required operations strictly to dedicated medimate_reddit_worker role
IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'RedditAccessToken') THEN
    EXECUTE format('REVOKE ALL ON TABLE public."RedditAccessToken" FROM %I', :'app_user');
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."RedditAccessToken" TO medimate_reddit_worker;
END IF;

-- 6. Grant sequence access on existing sequences to runtime app role
EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user');

-- 7. Restrict function execution: revoke blanket EXECUTE privileges from PUBLIC and runtime app role
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'app_user');

-- Explicitly grant execute ONLY on approved pre-auth functions to runtime app role
DO $grant_fn$
DECLARE
    v_app_user text := :'app_user';
BEGIN
    IF EXISTS (
        SELECT FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'lookup_user_for_auth'
    ) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.lookup_user_for_auth(text) TO %I', v_app_user);
    END IF;
END
$grant_fn$;

-- 8. Configure default privileges for future objects created by the migration owner
EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'owner_user', :'app_user');

EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'owner_user', :'app_user');

EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO medimate_auth_definer', :'owner_user');

-- Restrict default function execution privileges so newly created functions do NOT grant execute to PUBLIC or app_user
EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', :'owner_user');
EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', :'owner_user', :'app_user');

-- 9. Restrict default PUBLIC privileges
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;

EOSQL

echo "MediMate AI: PostgreSQL least-privilege roles initialized successfully."
