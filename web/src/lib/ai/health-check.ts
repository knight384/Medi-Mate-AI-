import { AIInferenceProvider, ProviderHealthStatus } from './types';

export class ProviderHealthCheck {
  private readonly providers: Map<string, AIInferenceProvider>;
  private readonly cache: Map<string, { status: ProviderHealthStatus; expiresAt: number }>;
  private readonly cacheTtlMs: number;

  constructor(providers: AIInferenceProvider[] = [], cacheTtlMs = 15_000) {
    this.providers = new Map();
    this.cache = new Map();
    this.cacheTtlMs = cacheTtlMs;
    for (const p of providers) {
      this.providers.set(p.providerId, p);
    }
  }

  public registerProvider(provider: AIInferenceProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  public async getHealth(providerId: string): Promise<ProviderHealthStatus> {
    const cached = this.cache.get(providerId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.status;
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      const missingStatus: ProviderHealthStatus = {
        providerId,
        location: 'LOCAL',
        isAvailable: false,
        lastCheckedAt: new Date().toISOString(),
        error: `Provider "${providerId}" not found in health check registry`,
      };
      return missingStatus;
    }

    try {
      const status = await provider.checkHealth();
      this.cache.set(providerId, {
        status,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
      return status;
    } catch (err) {
      const errorStatus: ProviderHealthStatus = {
        providerId,
        location: provider.location,
        isAvailable: false,
        lastCheckedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
      this.cache.set(providerId, {
        status: errorStatus,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
      return errorStatus;
    }
  }

  public async checkAll(): Promise<Record<string, ProviderHealthStatus>> {
    const results: Record<string, ProviderHealthStatus> = {};
    for (const providerId of this.providers.keys()) {
      results[providerId] = await this.getHealth(providerId);
    }
    return results;
  }
}
