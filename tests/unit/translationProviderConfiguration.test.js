import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TRANSLATION_PROVIDER,
  createTranslationProviderConfiguration
} from '../../src/infrastructure/translationProviderConfiguration.js';

test('creates configuration from a valid environment', () => {
  const configuration = createTranslationProviderConfiguration({
    environment: {
      TRANSLATION_PROVIDER: 'gemini'
    }
  });

  assert.deepEqual(configuration, {
    defaultProviderKey: 'gemini'
  });
});

test('returned configuration object is frozen and only exposes defaultProviderKey', () => {
  const configuration = createTranslationProviderConfiguration({
    environment: {
      TRANSLATION_PROVIDER: 'gemini'
    }
  });

  assert.equal(Object.isFrozen(configuration), true);
  assert.deepEqual(Object.keys(configuration), ['defaultProviderKey']);
  assert.throws(() => {
    configuration.defaultProviderKey = 'openai';
  }, TypeError);
  assert.deepEqual(configuration, {
    defaultProviderKey: 'gemini'
  });
});

test('defaults to gemini when TRANSLATION_PROVIDER is not set', () => {
  const configuration = createTranslationProviderConfiguration({
    environment: {}
  });

  assert.equal(configuration.defaultProviderKey, DEFAULT_TRANSLATION_PROVIDER);
  assert.equal(configuration.defaultProviderKey, 'gemini');
});

test('preserves explicit provider values without validating provider existence', () => {
  for (const providerKey of ['gemini', 'openai', 'azure', 'deepl', 'custom-provider']) {
    const configuration = createTranslationProviderConfiguration({
      environment: {
        TRANSLATION_PROVIDER: providerKey
      }
    });

    assert.equal(configuration.defaultProviderKey, providerKey);
  }
});

test('does not trim or normalize configured provider values', () => {
  const configuration = createTranslationProviderConfiguration({
    environment: {
      TRANSLATION_PROVIDER: 'Custom-Provider'
    }
  });

  assert.equal(configuration.defaultProviderKey, 'Custom-Provider');
});

test('rejects missing factory input and missing environment', () => {
  assert.throws(() => createTranslationProviderConfiguration(), TypeError);
  assert.throws(() => createTranslationProviderConfiguration({}), /environment is required/);
});

test('rejects null, undefined, and non-object environments', () => {
  assert.throws(() => createTranslationProviderConfiguration({ environment: null }), /environment must be an object/);
  assert.throws(() => createTranslationProviderConfiguration({ environment: undefined }), /environment must be an object/);
  assert.throws(() => createTranslationProviderConfiguration({ environment: 'env' }), /environment must be an object/);
  assert.throws(() => createTranslationProviderConfiguration({ environment: 1 }), /environment must be an object/);
  assert.throws(() => createTranslationProviderConfiguration({ environment: true }), /environment must be an object/);
  assert.throws(() => createTranslationProviderConfiguration({ environment: [] }), /environment must be an object/);
});

test('rejects non-string TRANSLATION_PROVIDER values', () => {
  assert.throws(
    () => createTranslationProviderConfiguration({ environment: { TRANSLATION_PROVIDER: 1 } }),
    /TRANSLATION_PROVIDER must be a string/
  );
  assert.throws(
    () => createTranslationProviderConfiguration({ environment: { TRANSLATION_PROVIDER: true } }),
    /TRANSLATION_PROVIDER must be a string/
  );
  assert.throws(
    () => createTranslationProviderConfiguration({ environment: { TRANSLATION_PROVIDER: null } }),
    /TRANSLATION_PROVIDER must be a string/
  );
});

test('rejects empty and whitespace-only TRANSLATION_PROVIDER values', () => {
  assert.throws(
    () => createTranslationProviderConfiguration({ environment: { TRANSLATION_PROVIDER: '' } }),
    /TRANSLATION_PROVIDER must be a non-empty string/
  );
  assert.throws(
    () => createTranslationProviderConfiguration({ environment: { TRANSLATION_PROVIDER: '   ' } }),
    /TRANSLATION_PROVIDER must be a non-empty string/
  );
});

test('does not mutate the supplied environment', () => {
  const environment = {
    TRANSLATION_PROVIDER: 'gemini'
  };
  const before = structuredClone(environment);

  createTranslationProviderConfiguration({ environment });

  assert.deepEqual(environment, before);
});

test('performs no provider construction, registry lookup, resolver lookup, SDK, HTTP, retry, or fallback behavior', () => {
  const environment = Object.freeze({
    TRANSLATION_PROVIDER: 'missing-provider'
  });

  const configuration = createTranslationProviderConfiguration({ environment });

  assert.deepEqual(configuration, {
    defaultProviderKey: 'missing-provider'
  });
});
