import { LocalInferenceProvider } from './local-inference-provider';
import { CloudInferenceProvider } from './cloud-inference-provider';
import { AIProviderRouter } from './provider-router';

export * from './types';
export * from './consent-policy';
export * from './local-inference-provider';
export * from './cloud-inference-provider';
export * from './health-check';
export * from './provider-router';

// Default system providers
export const defaultLocalProvider = new LocalInferenceProvider();
export const defaultOpenAIProvider = new CloudInferenceProvider({ providerId: 'openai' });
export const defaultAnthropicProvider = new CloudInferenceProvider({ providerId: 'anthropic' });
export const defaultGoogleProvider = new CloudInferenceProvider({ providerId: 'google' });

// Default AI Provider Router singleton
export const aiProviderRouter = new AIProviderRouter([
  defaultLocalProvider,
  defaultOpenAIProvider,
  defaultAnthropicProvider,
  defaultGoogleProvider,
]);
