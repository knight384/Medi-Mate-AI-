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
- **Connection Variable**: `MIGRATION_DATABASE_URL`
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

