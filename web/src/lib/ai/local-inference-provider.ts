import {
  AIInferenceProvider,
  InferenceRequest,
  InferenceResponse,
  ProviderHealthStatus,
} from './types';
import { logger } from '@/lib/logger';

export interface LocalInferenceConfig {
  providerId?: string;
  baseUrl?: string;
  defaultModel?: string;
  simulatedResponse?: string;
}

/**
 * Local Inference Provider (Ollama / Local LLM)
 *
 * Runs on device or private infrastructure without external network dependencies.
 * Capable of completely offline clinical query execution.
 */
export class LocalInferenceProvider implements AIInferenceProvider {
  public readonly providerId: string;
  public readonly location = 'LOCAL' as const;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly simulatedResponse?: string;

  constructor(config?: LocalInferenceConfig) {
    this.providerId = config?.providerId || 'local_ollama';
    this.baseUrl = config?.baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434';
    this.defaultModel = config?.defaultModel || 'medimate-llama3';
    this.simulatedResponse = config?.simulatedResponse;
  }

  public async checkHealth(): Promise<ProviderHealthStatus> {
    const now = new Date().toISOString();

    if (this.simulatedResponse !== undefined) {
      return {
        providerId: this.providerId,
        location: 'LOCAL',
        isAvailable: true,
        latencyMs: 15,
        lastCheckedAt: now,
      };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      return {
        providerId: this.providerId,
        location: 'LOCAL',
        isAvailable: res.ok,
        latencyMs: 25,
        lastCheckedAt: now,
      };
    } catch (err) {
      return {
        providerId: this.providerId,
        location: 'LOCAL',
        isAvailable: false,
        lastCheckedAt: now,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async invoke(request: InferenceRequest): Promise<InferenceResponse> {
    const startTime = Date.now();
    const modelUsed = request.model || this.defaultModel;

    // Simulated local response for test runners or offline simulation
    if (this.simulatedResponse !== undefined) {
      return {
        content: this.simulatedResponse,
        providerId: this.providerId,
        location: 'LOCAL',
        latencyMs: Date.now() - startTime,
        modelUsed,
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelUsed,
          system: request.systemPrompt,
          prompt: request.messages.map((m) => `${m.role}: ${m.content}`).join('\n'),
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Local inference server error: HTTP ${response.status}`);
      }

      const data = (await response.json()) as { response?: string };
      return {
        content: data.response || 'Local inference completed.',
        providerId: this.providerId,
        location: 'LOCAL',
        latencyMs: Date.now() - startTime,
        modelUsed,
      };
    } catch (err) {
      logger.error('Local inference execution failed', {
        providerId: this.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
