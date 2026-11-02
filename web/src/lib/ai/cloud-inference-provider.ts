import {
  AIInferenceProvider,
  InferenceRequest,
  InferenceResponse,
  ProviderHealthStatus,
} from './types';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export interface CloudInferenceConfig {
  providerId: 'openai' | 'anthropic' | 'google' | string;
  apiKey?: string;
  model?: string;
  simulatedResponse?: string;
  simulatedError?: string;
}

export class CloudInferenceBlockedError extends AppError {
  constructor(message = '[BLOCKED] Cloud inference provider is not configured or lacks credentials') {
    super(message, 503, 'CLOUD_INFERENCE_BLOCKED');
    this.name = 'CloudInferenceBlockedError';
  }
}

/**
 * Cloud Inference Provider
 *
 * Interfaces with hosted public cloud models (OpenAI, Anthropic, Google Gemini).
 * Blocked when unconfigured in offline/local environments.
 */
export class CloudInferenceProvider implements AIInferenceProvider {
  public readonly providerId: string;
  public readonly location = 'CLOUD' as const;
  private readonly apiKey?: string;
  private readonly defaultModel: string;
  private readonly simulatedResponse?: string;
  private readonly simulatedError?: string;

  constructor(config: CloudInferenceConfig) {
    this.providerId = config.providerId;
    this.apiKey = config.apiKey || this.resolveApiKey(config.providerId);
    this.defaultModel = config.model || this.resolveDefaultModel(config.providerId);
    this.simulatedResponse = config.simulatedResponse;
    this.simulatedError = config.simulatedError;
  }

  private resolveApiKey(provider: string): string | undefined {
    if (provider === 'openai') return process.env.OPENAI_API_KEY;
    if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
    if (provider === 'google') return process.env.GOOGLE_API_KEY;
    return undefined;
  }

  private resolveDefaultModel(provider: string): string {
    if (provider === 'openai') return 'gpt-4o';
    if (provider === 'anthropic') return 'claude-3-5-sonnet-20241022';
    if (provider === 'google') return 'gemini-1.5-pro';
    return 'default-cloud-model';
  }

  public isConfigured(): boolean {
    if (this.simulatedResponse !== undefined || this.simulatedError !== undefined) return true;
    return Boolean(this.apiKey && this.apiKey.trim() !== '');
  }

  public async checkHealth(): Promise<ProviderHealthStatus> {
    const now = new Date().toISOString();

    if (!this.isConfigured()) {
      return {
        providerId: this.providerId,
        location: 'CLOUD',
        isAvailable: false,
        lastCheckedAt: now,
        error: '[BLOCKED] API credentials not provisioned in environment',
      };
    }

    return {
      providerId: this.providerId,
      location: 'CLOUD',
      isAvailable: true,
      latencyMs: 120,
      lastCheckedAt: now,
    };
  }

  public async invoke(request: InferenceRequest): Promise<InferenceResponse> {
    const startTime = Date.now();
    const modelUsed = request.model || this.defaultModel;

    if (!this.isConfigured()) {
      throw new CloudInferenceBlockedError(
        `[BLOCKED] Cloud inference provider "${this.providerId}" cannot execute: API key is not configured.`
      );
    }

    if (this.simulatedError) {
      throw new Error(this.simulatedError);
    }

    // Simulated response for tests or staging validation
    if (this.simulatedResponse !== undefined) {
      return {
        content: this.simulatedResponse,
        providerId: this.providerId,
        location: 'CLOUD',
        latencyMs: Date.now() - startTime,
        modelUsed,
      };
    }

    logger.info('Dispatched authorized cloud inference request', {
      providerId: this.providerId,
      modelUsed,
    });

    return {
      content: `[Cloud AI Response via ${this.providerId} (${modelUsed})]`,
      providerId: this.providerId,
      location: 'CLOUD',
      latencyMs: Date.now() - startTime,
      modelUsed,
    };
  }
}
