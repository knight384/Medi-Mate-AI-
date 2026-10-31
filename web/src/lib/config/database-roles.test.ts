import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseDatabaseUrlRole,
  validateRuntimeDatabaseRole,
  validateMigrationDatabaseRole,
  DatabaseSecurityError,
} from './database';

describe('PostgreSQL Least-Privilege Role Validation & DATABASE_URL Security', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('parseDatabaseUrlRole', () => {
    it('correctly parses connection parameters for standard application role', () => {
      const url = 'postgresql://medimate_app:secret123@database.internal:5432/open-health';
      const parsed = parseDatabaseUrlRole(url);

      expect(parsed.role).toBe('medimate_app');
      expect(parsed.isSuperuser).toBe(false);
      expect(parsed.database).toBe('open-health');
      expect(parsed.host).toBe('database.internal');
      expect(parsed.port).toBe(5432);
    });

    it('identifies superuser accounts (postgres, admin, root, superuser)', () => {
      const superusers = ['postgres', 'root', 'admin', 'superuser', 'POSTGRES'];
      for (const user of superusers) {
        const url = `postgresql://${user}:pass@localhost:5432/db`;
        const parsed = parseDatabaseUrlRole(url);
        expect(parsed.isSuperuser).toBe(true);
      }
    });

    it('identifies non-superuser roles as safe', () => {
      const safeRoles = ['medimate_app', 'medimate_owner', 'app_user', 'reporting_readonly'];
      for (const role of safeRoles) {
        const url = `postgresql://${role}:pass@localhost:5432/db`;
        const parsed = parseDatabaseUrlRole(url);
        expect(parsed.isSuperuser).toBe(false);
      }
    });

    it('handles encoded usernames in connection URL', () => {
      const url = 'postgresql://user%40domain:pass@localhost:5432/db';
      const parsed = parseDatabaseUrlRole(url);
      expect(parsed.role).toBe('user@domain');
    });

    it('throws DatabaseSecurityError on missing role/username', () => {
      const url = 'postgresql://localhost:5432/db';
      expect(() => parseDatabaseUrlRole(url)).toThrow(DatabaseSecurityError);
      expect(() => parseDatabaseUrlRole(url)).toThrow('missing user/role');
    });

    it('throws DatabaseSecurityError on invalid protocol', () => {
      const url = 'http://localhost:5432/db';
      expect(() => parseDatabaseUrlRole(url)).toThrow(DatabaseSecurityError);
      expect(() => parseDatabaseUrlRole(url)).toThrow('Unsupported database protocol');
    });

    it('throws DatabaseSecurityError on malformed URL string', () => {
      const url = 'not a valid url';
      expect(() => parseDatabaseUrlRole(url)).toThrow(DatabaseSecurityError);
      expect(() => parseDatabaseUrlRole(url)).toThrow('Malformed database URL');
    });
  });

  describe('validateRuntimeDatabaseRole', () => {
    it('blocks superuser connection in production or strict mode', () => {
      const superuserUrl = 'postgresql://postgres:pass@localhost:5432/open-health';

      // Strict mode
      expect(() =>
        validateRuntimeDatabaseRole(superuserUrl, { enforceStrict: true })
      ).toThrow(DatabaseSecurityError);
      expect(() =>
        validateRuntimeDatabaseRole(superuserUrl, { enforceStrict: true })
      ).toThrow('Least-privilege violation');

      // Production environment
      Object.assign(process.env, { NODE_ENV: 'production' });
      expect(() => validateRuntimeDatabaseRole(superuserUrl)).toThrow(DatabaseSecurityError);
    });

    it('allows least-privilege medimate_app role in production', () => {
      Object.assign(process.env, { NODE_ENV: 'production' });
      const appUrl = 'postgresql://medimate_app:pass@database:5432/open-health';
      const parsed = validateRuntimeDatabaseRole(appUrl);
      expect(parsed.role).toBe('medimate_app');
      expect(parsed.isSuperuser).toBe(false);
    });

    it('reads from process.env.DATABASE_URL if no URL argument is passed', () => {
      process.env.DATABASE_URL = 'postgresql://medimate_app:secure@localhost:5432/open-health';
      const parsed = validateRuntimeDatabaseRole();
      expect(parsed.role).toBe('medimate_app');
    });

    it('throws if DATABASE_URL is not configured', () => {
      delete process.env.DATABASE_URL;
      expect(() => validateRuntimeDatabaseRole()).toThrow('DATABASE_URL is not set');
    });
  });

  describe('validateMigrationDatabaseRole', () => {
    it('accepts medimate_owner role for migrations', () => {
      const ownerUrl = 'postgresql://medimate_owner:secure@localhost:5432/open-health';
      const parsed = validateMigrationDatabaseRole(ownerUrl);
      expect(parsed.role).toBe('medimate_owner');
      expect(parsed.isSuperuser).toBe(false);
    });

    it('reads from process.env.MIGRATION_DATABASE_URL', () => {
      process.env.MIGRATION_DATABASE_URL = 'postgresql://medimate_owner:pass@localhost:5432/open-health';
      const parsed = validateMigrationDatabaseRole();
      expect(parsed.role).toBe('medimate_owner');
    });
  });
});

