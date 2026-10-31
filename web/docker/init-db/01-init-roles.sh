#!/bin/sh
set -e

APP_USER="${APP_DB_USER:-medimate_app}"
APP_PASS="${APP_DB_PASSWORD:?APP_DB_PASSWORD environment variable is required}"
OWNER_USER="${OWNER_DB_USER:-medimate_owner}"
OWNER_PASS="${OWNER_DB_PASSWORD:?OWNER_DB_PASSWORD environment variable is required}"
TARGET_DB="${POSTGRES_DB:-open-health}"

echo "MediMate AI: Initializing least-privilege PostgreSQL roles for database: $TARGET_DB..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$TARGET_DB" <<EOSQL
-- 1. Create or update the schema owner role (for Prisma migrations / DDL)
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$OWNER_USER') THEN
        CREATE ROLE "$OWNER_USER" WITH LOGIN PASSWORD '$OWNER_PASS' NOSUPERUSER INHERIT;
    ELSE
        ALTER ROLE "$OWNER_USER" WITH LOGIN PASSWORD '$OWNER_PASS' NOSUPERUSER INHERIT;
    END IF;
END
\$\$;

-- 2. Create or update the application runtime role (least-privilege, no DDL, no superuser, no bypass RLS)
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$APP_USER') THEN
        CREATE ROLE "$APP_USER" WITH LOGIN PASSWORD '$APP_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    ELSE
        ALTER ROLE "$APP_USER" WITH LOGIN PASSWORD '$APP_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
\$\$;

-- 3. Grant schema ownership and DDL permissions to the owner role
ALTER SCHEMA public OWNER TO "$OWNER_USER";
GRANT ALL ON SCHEMA public TO "$OWNER_USER";

-- 4. Grant database connection and schema access to runtime app role
GRANT CONNECT ON DATABASE "$TARGET_DB" TO "$APP_USER";
GRANT USAGE ON SCHEMA public TO "$APP_USER";

-- 5. Grant data manipulation privileges on existing tables to runtime app role
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "$APP_USER";

-- 6. Grant sequence access on existing sequences to runtime app role
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "$APP_USER";

-- 7. Configure default privileges for future tables created by the migration owner
ALTER DEFAULT PRIVILEGES FOR ROLE "$OWNER_USER" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "$APP_USER";

ALTER DEFAULT PRIVILEGES FOR ROLE "$OWNER_USER" IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO "$APP_USER";

-- 8. Restrict default PUBLIC privileges
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
EOSQL

echo "MediMate AI: PostgreSQL least-privilege roles initialized successfully."

