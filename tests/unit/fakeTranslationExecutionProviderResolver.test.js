import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionProviderResolver } from '../../src/application/translation/translationExecutionProviderResolver.js';
import { createFakeTranslationExecutionProvider } from '../../src/infrastructure/fakeTranslationExecutionProvider.js';
import { createFakeTranslationExecutionProviderResolver } from '../../src/infrastructure/fakeTranslationExecutionProviderResolver.js';

test('exposes a frozen resolve API', () => {
  const resolver = createFakeTranslationExecutionProviderResolver({
    translationExecutionProvider: createFakeTranslationExecutionProvider()
  });

  assert.equal(Object.isFrozen(resolver), true);
  assert.deepEqual(Object.keys(resolver), ['resolve']);
  assert.equal(typeof resolver.resolve, 'function');
  assert.equal(resolver.resolve.length, 1);
});

test('requires an injected translation execution provider', () => {
  assert.throws(
    () => createFakeTranslationExecutionProviderResolver(),
    /translationExecutionProvider is required/
  );
  assert.throws(
    () => createFakeTranslationExecutionProviderResolver({ translationExecutionProvider: null }),
    /translationExecutionProvider is required/
  );
  assert.throws(
    () => createFakeTranslationExecutionProviderResolver({ translationExecutionProvider: {} }),
    /translationExecutionProvider\.execute must be a function/
  );
});

test('always returns the injected provider', () => {
  const provider = createFakeTranslationExecutionProvider();
  const resolver = createFakeTranslationExecutionProviderResolver({
    translationExecutionProvider: provider
  });

  assert.strictEqual(resolver.resolve('fake'), provider);
  assert.strictEqual(resolver.resolve('gemini'), provider);
  assert.strictEqual(resolver.resolve('unknown-provider'), provider);
});

test('unknown and undefined providerKey do not throw', () => {
  const provider = createFakeTranslationExecutionProvider();
  const resolver = createFakeTranslationExecutionProviderResolver({
    translationExecutionProvider: provider
  });

  assert.doesNotThrow(() => resolver.resolve('unknown-provider'));
  assert.doesNotThrow(() => resolver.resolve(undefined));
  assert.strictEqual(resolver.resolve('unknown-provider'), provider);
  assert.strictEqual(resolver.resolve(undefined), provider);
});

test('works through TranslationExecutionProviderResolver without changing the provider', () => {
  const provider = createFakeTranslationExecutionProvider();
  const fakeResolver = createFakeTranslationExecutionProviderResolver({
    translationExecutionProvider: provider
  });
  const resolver = createTranslationExecutionProviderResolver(fakeResolver);

  assert.strictEqual(resolver.resolve('fake'), provider);
});

test('does not perform I/O, persistence, or orchestration side effects', () => {
  const provider = createFakeTranslationExecutionProvider();
  const resolver = createFakeTranslationExecutionProviderResolver({
    translationExecutionProvider: provider
  });

  resolver.resolve('fake');

  assert.equal(Object.hasOwn(resolver, 'translationRepository'), false);
  assert.equal(Object.hasOwn(resolver, 'providerRegistry'), false);
  assert.equal(Object.hasOwn(resolver, 'queue'), false);
  assert.equal(Object.hasOwn(resolver, 'scheduler'), false);
  assert.equal(Object.hasOwn(resolver, 'execute'), false);
});
