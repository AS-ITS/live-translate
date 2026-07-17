import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionProviderResolver } from '../../src/application/translation/translationExecutionProviderResolver.js';

test('accepts a valid implementation', () => {
  const resolver = createTranslationExecutionProviderResolver({
    resolve() {
      return provider();
    }
  });

  assert.equal(typeof resolver, 'object');
  assert.notEqual(resolver, null);
  assert.deepEqual(Object.keys(resolver), ['resolve']);
  assert.equal(typeof resolver.resolve, 'function');
  assert.equal(resolver.resolve.length, 1);
  assert.equal(Object.isFrozen(resolver), true);
});

test('rejects missing implementation', () => {
  assert.throws(
    () => createTranslationExecutionProviderResolver(),
    /translationExecutionProviderResolver implementation is required/
  );
  assert.throws(
    () => createTranslationExecutionProviderResolver(null),
    /translationExecutionProviderResolver implementation is required/
  );
});

test('rejects missing resolve', () => {
  assert.throws(
    () => createTranslationExecutionProviderResolver({}),
    /translationExecutionProviderResolver\.resolve must be a function/
  );
});

test('rejects non-function resolve', () => {
  assert.throws(
    () => createTranslationExecutionProviderResolver({ resolve: 'not-a-function' }),
    /translationExecutionProviderResolver\.resolve must be a function/
  );
});

test('resolve forwards providerKey unchanged', () => {
  const providerKey = Object.freeze({ providerKey: 'fake' });
  let receivedProviderKey;
  const resolver = createTranslationExecutionProviderResolver({
    resolve(inputProviderKey) {
      receivedProviderKey = inputProviderKey;
      return provider();
    }
  });

  resolver.resolve(providerKey);

  assert.strictEqual(receivedProviderKey, providerKey);
});

test('resolve returns provider unchanged', () => {
  const selectedProvider = provider();
  const resolver = createTranslationExecutionProviderResolver({
    resolve() {
      return selectedProvider;
    }
  });

  const actualProvider = resolver.resolve('fake');

  assert.strictEqual(actualProvider, selectedProvider);
});

test('resolve validates only implementation contract', () => {
  const selectedProvider = Object.freeze({ execute: 'not-validated-by-resolver-port' });
  const resolver = createTranslationExecutionProviderResolver({
    resolve() {
      return selectedProvider;
    }
  });

  assert.strictEqual(resolver.resolve('fake'), selectedProvider);
});

test('resolve propagates implementation errors unchanged', () => {
  const error = new Error('sentinel resolver failure');
  const resolver = createTranslationExecutionProviderResolver({
    resolve() {
      throw error;
    }
  });

  assert.throws(() => resolver.resolve('fake'), (actualError) => actualError === error);
});

function provider() {
  return Object.freeze({
    execute() {
      return Promise.resolve({ translatedText: 'Bonjour' });
    }
  });
}
