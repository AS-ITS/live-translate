import { createGeminiClientAdapter } from './geminiClientAdapter.js';
import { createGeminiEnvironment } from './geminiEnvironment.js';
import { createGeminiSavedTranscriptTranslationProvider } from './geminiSavedTranscriptTranslationProvider.js';
import {
  createDefaultGoogleGenAIClient,
  createGoogleGenAIClient
} from './googleGenAIClient.js';

export function createGeminiSavedTranscriptTranslationComposition({
  client,
  model,
  env = process.env,
  GoogleGenAI,
  promptBuilder,
  geminiEnvironmentFactory = createGeminiEnvironment,
  googleGenAIClientFactory,
  geminiClientAdapterFactory = createGeminiClientAdapter,
  geminiSavedTranscriptTranslationProviderFactory = createGeminiSavedTranscriptTranslationProvider
} = {}) {
  if (client || model) {
    assertFactory(geminiSavedTranscriptTranslationProviderFactory, 'geminiSavedTranscriptTranslationProviderFactory');

    return Object.freeze({
      savedTranscriptTranslationProvider: geminiSavedTranscriptTranslationProviderFactory({
        client,
        model,
        ...(promptBuilder ? { promptBuilder } : {})
      })
    });
  }

  const resolvedGoogleGenAIClientFactory =
    googleGenAIClientFactory ?? (GoogleGenAI ? createGoogleGenAIClient : createDefaultGoogleGenAIClient);

  assertFactory(geminiEnvironmentFactory, 'geminiEnvironmentFactory');
  assertFactory(resolvedGoogleGenAIClientFactory, 'googleGenAIClientFactory');
  assertFactory(geminiClientAdapterFactory, 'geminiClientAdapterFactory');
  assertFactory(geminiSavedTranscriptTranslationProviderFactory, 'geminiSavedTranscriptTranslationProviderFactory');

  const geminiEnvironment = geminiEnvironmentFactory({ env });
  const sdkClient = resolvedGoogleGenAIClientFactory({
    apiKey: geminiEnvironment.apiKey,
    ...(GoogleGenAI ? { GoogleGenAI } : {})
  });
  const adaptedClient = geminiClientAdapterFactory({ client: sdkClient });
  const savedTranscriptTranslationProvider = geminiSavedTranscriptTranslationProviderFactory({
    client: adaptedClient,
    model: geminiEnvironment.model,
    ...(promptBuilder ? { promptBuilder } : {})
  });

  return Object.freeze({
    savedTranscriptTranslationProvider
  });
}

function assertFactory(factory, name) {
  if (typeof factory !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
}
