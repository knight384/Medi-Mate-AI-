export class DatabaseSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseSecurityError';
  }
}

export interface ParsedDatabaseRole {
  role: string;
  isSuperuser: boolean;
  database: string;
  host: string;
  port: number;
}

const SUPERUSER_ROLE_NAMES = new Set(['postgres', 'root', 'admin', 'superuser']);

/**
 * Parses a PostgreSQL connection URL and inspects the configured role.
 */
export function parseDatabaseUrlRole(urlStr: string): ParsedDatabaseRole {
  try {
    const parsed = new URL(urlStr);
    if (!parsed.protocol.startsWith('postgres')) {
      throw new DatabaseSecurityError(`Unsupported database protocol: ${parsed.protocol}`);
    }
    const role = decodeURIComponent(parsed.username || '');
    if (!role) {
      throw new DatabaseSecurityError('Database URL is missing user/role specification');
    }
    const database = parsed.pathname.replace(/^\//, '');
    const isSuperuser = SUPERUSER_ROLE_NAMES.has(role.toLowerCase());

    return {
      role,
      isSuperuser,
      database,
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    };
  } catch (error) {
    if (error instanceof DatabaseSecurityError) {
      throw error;
    }
    throw new DatabaseSecurityError(`Malformed database URL: ${(error as Error).message}`);
  }
}

/**
 * Validates that the runtime DATABASE_URL does not use a superuser role.
 * In production or when enforceStrict is true, connecting as superuser fails closed.
 */
export function validateRuntimeDatabaseRole(
  urlStr?: string,
  options: { enforceStrict?: boolean } = {}
): ParsedDatabaseRole {
  const targetUrl = urlStr || process.env.DATABASE_URL;
  if (!targetUrl) {
    throw new DatabaseSecurityError('DATABASE_URL is not set');
  }

  const parsed = parseDatabaseUrlRole(targetUrl);
  const isProd = process.env.NODE_ENV === 'production';
  const shouldEnforce = options.enforceStrict || isProd || process.env.ENFORCE_LEAST_PRIVILEGE_DB === 'true';

  if (parsed.isSuperuser && shouldEnforce) {
    throw new DatabaseSecurityError(
      `Least-privilege violation: Runtime database connection cannot use superuser role '${parsed.role}'. ` +
      `Configure a restricted role (e.g., 'medimate_app') with NOSUPERUSER and NOBYPASSRLS.`
    );
  }

  return parsed;
}

/**
 * Validates that migration connection URL is properly configured.
 */
export function validateMigrationDatabaseRole(urlStr?: string): ParsedDatabaseRole {
  const targetUrl = urlStr || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!targetUrl) {
    throw new DatabaseSecurityError('Neither MIGRATION_DATABASE_URL nor DATABASE_URL is set');
  }

  return parseDatabaseUrlRole(targetUrl);
}

