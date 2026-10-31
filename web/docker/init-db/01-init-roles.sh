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
END
$do$;

-- 3. Grant schema ownership and DDL permissions to the owner role
EXECUTE format('ALTER SCHEMA public OWNER TO %I', :'owner_user');
EXECUTE format('GRANT ALL ON SCHEMA public TO %I', :'owner_user');

-- 4. Grant database connection and schema access to runtime app role
EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', :'target_db', :'app_user');
EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', :'app_user');
EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_user');

-- 5. Grant data manipulation privileges on existing tables to runtime app role
EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user');

-- 6. Grant sequence access on existing sequences to runtime app role
EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user');

-- 7. Configure default privileges for future tables created by the migration owner
EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'owner_user', :'app_user');

EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'owner_user', :'app_user');

-- 8. Restrict default PUBLIC privileges
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;

EOSQL

echo "MediMate AI: PostgreSQL least-privilege roles initialized successfully."
