import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProductionApplicationDependencies,
  createProductionSavedTranscriptTranslationProvider
} from '../../server/compositionRoot.js';

test('production composition assembles Gemini provider and injects it into saved transcript retranslation service', () => {
  const calls = [];
  const env = { GEMINI_API_KEY: 'unused-by-mock', GEMINI_MODEL: 'unused-by-mock' };
  const googleClient = { models: { generateContent() {} } };
  const geminiClient = { generateContent() {} };
  const provider = { translate() {} };
  const service = { translateSavedTranscript() {} };

  const dependencies = createProductionApplicationDependencies({
    env,
    sessionRepository: repository(),
    geminiEnvironmentFactory(options) {
      calls.push(['environment', options]);
      return { apiKey: 'exact-api-key', model: 'exact-model' };
    },
    googleGenAIClientFactory(options) {
      calls.push(['googleClient', options]);
      return googleClient;
    },
    geminiClientAdapterFactory(options) {
      calls.push(['adapter', options]);
      return geminiClient;
    },
    geminiSavedTranscriptTranslationCompositionFactory(options) {
      calls.push(['providerComposition', options]);
      return { savedTranscriptTranslationProvider: provider };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      calls.push(['service', options]);
      return service;
    }
  });

  assert.strictEqual(dependencies.savedTranscriptRetranslationService, service);
  assert.deepEqual(calls.map(([name]) => name), [
    'environment',
    'googleClient',
    'adapter',
    'providerComposition',
    'service'
  ]);
  assert.deepEqual(calls[0][1], { env });
  assert.deepEqual(calls[1][1], { apiKey: 'exact-api-key' });
  assert.deepEqual(calls[2][1], { client: googleClient });
  assert.deepEqual(calls[3][1], {
    client: geminiClient,
    model: 'exact-model'
  });
  assert.strictEqual(calls[4][1].savedTranscriptTranslationProvider, provider);
  assert.strictEqual(calls[4][1].translationCommandService, dependencies.translationCommandService);
  assert.strictEqual(calls[4][1].sessionRepository, dependencies.sessionRepository);
  assert.equal(typeof calls[4][1].idGenerator, 'function');
  assert.equal(typeof calls[4][1].clock, 'function');
});

test('production Gemini provider factory returns provider composition output exactly once', () => {
  const calls = [];
  const provider = { translate() {} };
  const result = createProductionSavedTranscriptTranslationProvider({
    env: { GEMINI_API_KEY: 'unused-by-mock' },
    geminiEnvironmentFactory(options) {
      calls.push(['environment', options]);
      return { apiKey: 'api-key', model: 'model-name' };
    },
    googleGenAIClientFactory(options) {
      calls.push(['googleClient', options]);
      return { models: { generateContent() {} } };
    },
    geminiClientAdapterFactory(options) {
      calls.push(['adapter', options]);
      return { generateContent() {} };
    },
    geminiSavedTranscriptTranslationCompositionFactory(options) {
      calls.push(['providerComposition', options]);
      return { savedTranscriptTranslationProvider: provider };
    }
  });

  assert.strictEqual(result, provider);
  assert.deepEqual(calls.map(([name]) => name), ['environment', 'googleClient', 'adapter', 'providerComposition']);
});

test('production Gemini environment validation errors propagate without wrapping', () => {
  const validationError = new Error('Missing GEMINI_API_KEY');

  assert.throws(
    () =>
      createProductionSavedTranscriptTranslationProvider({
        env: {},
        geminiEnvironmentFactory() {
          throw validationError;
        },
        googleGenAIClientFactory() {
          throw new Error('must not be called');
        },
        geminiClientAdapterFactory() {
          throw new Error('must not be called');
        },
        geminiSavedTranscriptTranslationCompositionFactory() {
          throw new Error('must not be called');
        }
      }),
    (error) => error === validationError
  );
});

function repository() {
  return {
    createSessionRecord() {},
    updateSessionRecord() {},
    appendTranscriptItem() {},
    finalizeSessionRecord() {},
    listSessionRecords() {
      return [];
    },
    getSessionRecord() {
      return null;
    },
    deleteSessionRecord() {}
  };
}
