# PostgreSQL Role Architecture & Least Privilege Configuration

## Overview
MediMate AI enforces database least-privilege separation between administrative bootstrap, schema migrations, and application runtime.

### 1. `postgres` (Bootstrap / Cluster Administrator)
- **Role**: Superuser.
- **Scope**: Used only by Docker entrypoint initialization scripts to provision roles, create extensions, and set database ownership.
- **Access Rule**: The application runtime (`app` service) must **never** connect as `postgres`.

### 2. `medimate_owner` (Schema Owner & DDL Migrations)
- **Role**: Schema Owner (`NOSUPERUSER`, `INHERIT`).
- **Scope**: Runs Prisma migrations (`npx prisma migrate deploy`, `npx prisma db push`).
- **Connection Variable**: `MIGRATION_DATABASE_URL` (configured as `directUrl` in `schema.prisma`).
- **Permissions**:
  - Full DDL permissions (`CREATE`, `ALTER`, `DROP`) on schema `public`.
  - Configures `ALTER DEFAULT PRIVILEGES` granting DML to `medimate_app`.

### 3. `medimate_app` (Application Runtime)
- **Role**: Least-Privilege Application User (`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`).
- **Scope**: Normal Next.js web application runtime transactions.
- **Connection Variable**: `DATABASE_URL`
- **Permissions**:
  - `CONNECT` on target database.
  - `USAGE` on schema `public`.
  - `SELECT`, `INSERT`, `UPDATE`, `DELETE` on tables in schema `public`.
  - `USAGE`, `SELECT` on all sequences in schema `public`.
  - **No DDL privileges**: Cannot `CREATE TABLE`, `DROP TABLE`, or `ALTER TABLE`.
  - **Enforces Row-Level Security**: Cannot bypass RLS policies (`NOBYPASSRLS`).

---

## Row Level Security (RLS) & Multi-Tenant Isolation

### Policy Structure (`02-init-rls.sql`)
1. **`HealthData`**: Restricts all operations (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) to records where `"authorId" = current_setting('app.current_user_id', true)`.
2. **`ChatRoom`**: Restricts operations to rooms where `"authorId" = current_setting('app.current_user_id', true)`.
3. **`ChatMessage`**: Restricts child messages via join to parent `"ChatRoom"`:
   `EXISTS (SELECT 1 FROM "ChatRoom" WHERE "ChatRoom".id = "ChatMessage"."chatRoomId" AND "ChatRoom"."authorId" = current_setting('app.current_user_id', true))`
4. **`AssistantMode`**: Allows `SELECT` on `visibility = 'PUBLIC'` or owner; restricts modifications strictly to owner.
5. **`FORCE ROW LEVEL SECURITY`**: Enabled on all sensitive tables to ensure policies apply even if table ownership is transferred.

### Tenant Identity Context (`withTenantContext`)
- Set via `withTenantContext(userId, callback)` in `src/lib/db-tenant.ts`.
- Executes: `SELECT set_config('app.current_user_id', userId, true);`
- `is_local = true`: Scoped strictly to the active transaction and automatically cleared on commit or rollback.
- Prevents connection-pool context leakage.

---

## Existing Database Volume Upgrade Procedure (Task J)

> [!WARNING]
> Official PostgreSQL container images run `/docker-entrypoint-initdb.d/` scripts **only** when initializing an empty data directory. If `postgres_data` already exists, entrypoint scripts will **not** rerun automatically.

To safely upgrade an existing pre-Checkpoint 5D.7 database volume:

1. **Pre-Upgrade Backup**:
   ```bash
   docker compose exec database pg_dump -U postgres -Fc open-health > open-health-backup-$(date +%s).dump
   ```
2. **Review Existing Role Inventory**:
   ```sql
   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles;
   ```
3. **Execute Role Initialization Script**:
   Run `01-init-roles.sh` commands as superuser `postgres`.
4. **Reassign Object Ownership from `postgres` to `medimate_owner`**:
   ```sql
   REASSIGN OWNED BY postgres TO medimate_owner;
   ```
5. **Execute RLS Initialization Script**:
   Execute `02-init-rls.sql` against the database to create RLS policies and the DDL event trigger.
6. **Verify Effective Role Flags**:
   ```sql
   SELECT rolname, rolsuper, rolbypassrls, rolcreatedb FROM pg_roles WHERE rolname IN ('medimate_app', 'medimate_owner');
   ```
   Confirm `medimate_app` has `rolsuper = false`, `rolbypassrls = false`.
7. **Rollback Strategy**:
   If application issues occur, restore from backup:
   ```bash
   pg_restore -U postgres -d open-health --clean --if-exists open-health-backup-*.dump
   ```
