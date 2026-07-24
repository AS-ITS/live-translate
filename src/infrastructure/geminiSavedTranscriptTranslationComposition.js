import { createGeminiClientAdapter } from './geminiClientAdapter.js';
import { createGeminiEnvironment } from './geminiEnvironment.js';
import { createGeminiSavedTranscriptTranslationProvider } from './geminiSavedTranscriptTranslationProvider.js';
import {
  createDefaultGoogleGenAIClient,
  createGoogleGenAIClient
} from './googleGenAIClient.js';

export const DEFAULT_SAVED_RETRANSLATION_GEMINI_MODEL = 'gemini-3.5-flash';
export const SAVED_RETRANSLATION_GEMINI_MODEL_ENV = 'SAVED_RETRANSLATION_GEMINI_MODEL';

export function createGeminiSavedTranscriptTranslationComposition({
  client,
  model,
  env = process.env,
  GoogleGenAI,
  promptBuilder,
  glossary,
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
        model: model ?? resolveSavedRetranslationModel(env),
        ...(promptBuilder ? { promptBuilder } : {}),
        ...(glossary ? { glossary } : {})
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
  const savedRetranslationModel = resolveSavedRetranslationModel(env);
  const sdkClient = resolvedGoogleGenAIClientFactory({
    apiKey: geminiEnvironment.apiKey,
    ...(GoogleGenAI ? { GoogleGenAI } : {})
  });
  const adaptedClient = geminiClientAdapterFactory({ client: sdkClient });
  const savedTranscriptTranslationProvider = geminiSavedTranscriptTranslationProviderFactory({
    client: adaptedClient,
    model: savedRetranslationModel,
    ...(promptBuilder ? { promptBuilder } : {}),
    ...(glossary ? { glossary } : {})
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

export function resolveSavedRetranslationModel(env = process.env) {
  const value = env[SAVED_RETRANSLATION_GEMINI_MODEL_ENV];

  if (value === undefined) {
    return DEFAULT_SAVED_RETRANSLATION_GEMINI_MODEL;
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid ${SAVED_RETRANSLATION_GEMINI_MODEL_ENV}`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${SAVED_RETRANSLATION_GEMINI_MODEL_ENV}`);
  }

  return trimmed;
}
