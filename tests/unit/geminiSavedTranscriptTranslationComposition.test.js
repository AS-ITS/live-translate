import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SAVED_RETRANSLATION_TIMEOUT_MS,
  DEFAULT_SAVED_RETRANSLATION_GEMINI_MODEL,
  createGeminiSavedTranscriptTranslationComposition
} from '../../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';

test('valid environment returns the expected frozen provider composition contract', () => {
  const composition = createGeminiSavedTranscriptTranslationComposition({
    env: env(),
    GoogleGenAI: fakeGoogleGenAI()
  });

  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(Object.keys(composition), ['savedTranscriptTranslationProvider']);
  assert.equal(typeof composition.savedTranscriptTranslationProvider.translate, 'function');
});

test('constructs SDK, adapter, and provider once with exact forwarded dependencies', () => {
  const calls = [];
  const promptBuilder = () => ({ systemInstruction: 'Translate only.', parts: ['Hello'] });
  const sdkClient = { models: { generateContent() {} } };
  const adaptedClient = { generateContent() {} };
  const provider = { translate() {} };

  const composition = createGeminiSavedTranscriptTranslationComposition({
    env: env({
      GEMINI_API_KEY: 'exact-api-key',
      SAVED_RETRANSLATION_GEMINI_MODEL: 'exact-model',
      SAVED_RETRANSLATION_TIMEOUT_MS: '12345'
    }),
    promptBuilder,
    geminiEnvironmentFactory(options) {
      calls.push(['environment', options]);
      return { apiKey: 'exact-api-key' };
    },
    googleGenAIClientFactory(options) {
      calls.push(['sdk', options]);
      return sdkClient;
    },
    geminiClientAdapterFactory(options) {
      calls.push(['adapter', options]);
      return adaptedClient;
    },
    geminiSavedTranscriptTranslationProviderFactory(options) {
      calls.push(['provider', options]);
      return provider;
    }
  });

  assert.strictEqual(composition.savedTranscriptTranslationProvider, provider);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], [
    'environment',
    {
      env: env({
        GEMINI_API_KEY: 'exact-api-key',
        SAVED_RETRANSLATION_GEMINI_MODEL: 'exact-model',
        SAVED_RETRANSLATION_TIMEOUT_MS: '12345'
      })
    }
  ]);
  assert.deepEqual(calls[1], ['sdk', { apiKey: 'exact-api-key' }]);
  assert.deepEqual(calls[2], ['adapter', { client: sdkClient }]);
  assert.deepEqual(calls[3], [
    'provider',
    {
      client: adaptedClient,
      model: 'exact-model',
      timeoutMs: 12345,
      promptBuilder
    }
  ]);
});

test('saved retranslation defaults to flash when its model env is omitted', () => {
  const calls = [];
  const provider = { translate() {} };

  createGeminiSavedTranscriptTranslationComposition({
    env: env(),
    GoogleGenAI: fakeGoogleGenAI(),
    geminiSavedTranscriptTranslationProviderFactory(options) {
      calls.push(options);
      return provider;
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, DEFAULT_SAVED_RETRANSLATION_GEMINI_MODEL);
  assert.equal(calls[0].timeoutMs, DEFAULT_SAVED_RETRANSLATION_TIMEOUT_MS);
});

test('saved retranslation timeout env is forwarded to provider', () => {
  const calls = [];

  createGeminiSavedTranscriptTranslationComposition({
    env: env({ SAVED_RETRANSLATION_TIMEOUT_MS: '2500' }),
    GoogleGenAI: fakeGoogleGenAI(),
    geminiSavedTranscriptTranslationProviderFactory(options) {
      calls.push(options);
      return { translate() {} };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 2500);
});

test('saved retranslation model env is trimmed', () => {
  const calls = [];
  const provider = { translate() {} };

  createGeminiSavedTranscriptTranslationComposition({
    env: env({
      SAVED_RETRANSLATION_GEMINI_MODEL: '  gemini-3.5-flash-custom  '
    }),
    GoogleGenAI: fakeGoogleGenAI(),
    geminiSavedTranscriptTranslationProviderFactory(options) {
      calls.push(options);
      return provider;
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gemini-3.5-flash-custom');
});

test('client injection without explicit model uses saved retranslation model env', () => {
  const calls = [];
  const provider = { translate() {} };

  createGeminiSavedTranscriptTranslationComposition({
    client: { generateContent() {} },
    env: env({
      SAVED_RETRANSLATION_GEMINI_MODEL: 'client-env-model'
    }),
    geminiSavedTranscriptTranslationProviderFactory(options) {
      calls.push(options);
      return provider;
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'client-env-model');
});

test('explicit model input takes precedence over saved retranslation model env', () => {
  const calls = [];
  const provider = { translate() {} };

  const composition = createGeminiSavedTranscriptTranslationComposition({
    client: { generateContent() {} },
    model: 'explicit-model',
    env: env({ SAVED_RETRANSLATION_GEMINI_MODEL: 'env-model' }),
    geminiSavedTranscriptTranslationProviderFactory(options) {
      calls.push(options);
      return provider;
    }
  });

  assert.strictEqual(composition.savedTranscriptTranslationProvider, provider);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'explicit-model');
});

test('injected GoogleGenAI constructor receives the API key exactly once', () => {
  const constructorCalls = [];
  class FakeGoogleGenAI {
    constructor(options) {
      constructorCalls.push(options);
      this.models = {
        generateContent() {
          return { translatedText: 'Bonjour' };
        }
      };
    }
  }

  createGeminiSavedTranscriptTranslationComposition({
    env: env({ GEMINI_API_KEY: '  trimmed-api-key  ' }),
    GoogleGenAI: FakeGoogleGenAI
  });

  assert.deepEqual(constructorCalls, [{ apiKey: 'trimmed-api-key' }]);
});

test('missing required configuration and invalid dependencies fail', () => {
  const GoogleGenAI = fakeGoogleGenAI();

  assert.throws(
    () => createGeminiSavedTranscriptTranslationComposition({ env: {}, GoogleGenAI }),
    /^Error: Missing GEMINI_API_KEY$/
  );
  assert.throws(
    () => createGeminiSavedTranscriptTranslationComposition({ env: env(), GoogleGenAI: {} }),
    /GoogleGenAI must be a constructable function/
  );
  assert.throws(
    () =>
      createGeminiSavedTranscriptTranslationComposition({
        env: env(),
        GoogleGenAI,
        geminiEnvironmentFactory: {}
      }),
    /geminiEnvironmentFactory must be a function/
  );
  assert.throws(
    () =>
      createGeminiSavedTranscriptTranslationComposition({
        env: env({ SAVED_RETRANSLATION_GEMINI_MODEL: '   ' }),
        GoogleGenAI
      }),
    /^Error: Invalid SAVED_RETRANSLATION_GEMINI_MODEL$/
  );
  assert.throws(
    () =>
      createGeminiSavedTranscriptTranslationComposition({
        env: env({ SAVED_RETRANSLATION_TIMEOUT_MS: '0' }),
        GoogleGenAI
      }),
    /^Error: Invalid SAVED_RETRANSLATION_TIMEOUT_MS$/
  );
});

test('composition performs no generateContent call', () => {
  let generateContentCallCount = 0;
  class FakeGoogleGenAI {
    constructor() {
      this.models = {
        generateContent() {
          generateContentCallCount += 1;
          return { translatedText: 'Bonjour' };
        }
      };
    }
  }

  createGeminiSavedTranscriptTranslationComposition({
    env: env(),
    GoogleGenAI: FakeGoogleGenAI
  });

  assert.equal(generateContentCallCount, 0);
});

test('separate composition invocations are isolated', () => {
  const constructorCalls = [];
  class FakeGoogleGenAI {
    constructor(options) {
      constructorCalls.push(options);
      this.models = {
        generateContent() {
          return { translatedText: 'Bonjour' };
        }
      };
    }
  }

  const first = createGeminiSavedTranscriptTranslationComposition({
    env: env({ GEMINI_API_KEY: 'first-key' }),
    GoogleGenAI: FakeGoogleGenAI
  });
  const second = createGeminiSavedTranscriptTranslationComposition({
    env: env({ GEMINI_API_KEY: 'second-key' }),
    GoogleGenAI: FakeGoogleGenAI
  });

  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.savedTranscriptTranslationProvider, second.savedTranscriptTranslationProvider);
  assert.deepEqual(constructorCalls, [{ apiKey: 'first-key' }, { apiKey: 'second-key' }]);
});

test('returned provider performs deterministic translation through fake SDK response', async () => {
  const requests = [];
  class FakeGoogleGenAI {
    constructor() {
      this.models = {
        async generateContent(request) {
          requests.push(request);
          return {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Bonjour' }]
                }
              }
            ]
          };
        }
      };
    }
  }

  const { savedTranscriptTranslationProvider } = createGeminiSavedTranscriptTranslationComposition({
    env: env({ SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-test-model' }),
    GoogleGenAI: FakeGoogleGenAI
  });

  const result = await savedTranscriptTranslationProvider.translate({
    sourceText: 'Hello',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr'
  });

  assert.deepEqual(result, {
    translatedText: 'Bonjour',
    detectedSourceLanguageCode: 'en'
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'gemini-test-model');
  assert.equal(requests[0].contents[0].parts.at(-1).text, 'Hello');
});

function env(overrides = {}) {
  return {
    GEMINI_API_KEY: 'test-api-key',
    ...overrides
  };
}

function fakeGoogleGenAI() {
  return class FakeGoogleGenAI {
    constructor() {
      this.models = {
        generateContent() {
          return { translatedText: 'Bonjour' };
        }
      };
    }
  };
}
