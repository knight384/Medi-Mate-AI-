import { z } from 'zod';

const deploymentEnvSchema = z.enum(['local', 'cloud', 'hybrid']);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1).optional(),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  AUTH_SECRET: z.string().min(1).optional(),
  AUTH_TRUST_HOST: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  MEDIMATE_DEPLOYMENT_MODE: deploymentEnvSchema.optional(),
  DEPLOYMENT_ENV: deploymentEnvSchema.default('local'),
  NEXT_PUBLIC_DEPLOYMENT_ENV: deploymentEnvSchema.default('local'),
  NEXT_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_AMPLITUDE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  UPSTAGE_API_KEY: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false' && value !== '0'),
  REDIS_KEY_PREFIX: z.string().default('open-health:'),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  REDIS_MAX_RETRIES: z.coerce.number().int().min(0).default(10),
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  TRUSTED_PROXIES: z.string().default('127.0.0.1,::1'),
  MEDIMATE_STORAGE_DIR: z.string().optional(),
  MEDIMATE_SCRATCH_DIR: z.string().optional(),
  MEDIMATE_CLOUD_STORAGE_BUCKET: z.string().optional(),
  MEDIMATE_CLOUD_STORAGE_REGION: z.string().optional(),
  MEDIMATE_CLOUD_KMS_KEY_ARN: z.string().optional(),
});

export type DeploymentEnv = z.infer<typeof deploymentEnvSchema>;
export type AppEnv = z.infer<typeof envSchema>;

function parseEnv(): AppEnv {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${formatted}`);
  }
  return result.data;
}

let cachedEnv: AppEnv | undefined;

/** Resets cached environment (for tests only). */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    cachedEnv = parseEnv();
  }
  return cachedEnv;
}

export function getDeploymentEnv(): DeploymentEnv {
  const env = getEnv();
  return env.MEDIMATE_DEPLOYMENT_MODE ?? env.DEPLOYMENT_ENV ?? env.NEXT_PUBLIC_DEPLOYMENT_ENV;
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

export function isRedisEnabled(): boolean {
  return getEnv().REDIS_ENABLED;
}

export function isTrustProxy(): boolean {
  return getEnv().TRUST_PROXY;
}

export function getTrustedProxies(): string[] {
  return getEnv().TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Validates configuration consistency against the active deployment profile.
 * Throws an Error if configuration violates profile invariants.
 */
export function validateDeploymentProfileConfig(env: AppEnv = getEnv()): {
  valid: boolean;
  mode: DeploymentEnv;
  warnings: string[];
} {
  const mode = env.MEDIMATE_DEPLOYMENT_MODE ?? env.DEPLOYMENT_ENV ?? env.NEXT_PUBLIC_DEPLOYMENT_ENV;
  const warnings: string[] = [];

  if (mode === 'local') {
    // In local mode, verify external dependencies are not forcibly bound
    if (env.MEDIMATE_CLOUD_STORAGE_BUCKET) {
      warnings.push('MEDIMATE_CLOUD_STORAGE_BUCKET is set but ignored in local mode.');
    }
    if (env.MEDIMATE_CLOUD_KMS_KEY_ARN) {
      warnings.push('MEDIMATE_CLOUD_KMS_KEY_ARN is set but ignored in local mode.');
    }
  } else if (mode === 'cloud') {
    if (env.NODE_ENV === 'production') {
      if (env.NEXT_PUBLIC_URL && env.NEXT_PUBLIC_URL.startsWith('http://')) {
        throw new Error(
          'Insecure configuration: Production Cloud mode requires HTTPS for NEXT_PUBLIC_URL.'
        );
      }
      if (!env.DATABASE_URL) {
        throw new Error('Cloud deployment requires DATABASE_URL to be explicitly configured.');
      }
    }
  } else if (mode === 'hybrid') {
    if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
      throw new Error('Hybrid deployment requires DATABASE_URL to be explicitly configured.');
    }
  }

  return { valid: true, mode, warnings };
}
