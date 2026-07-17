export function createFakeTranslationExecutionProviderResolver({ translationExecutionProvider } = {}) {
  assertTranslationExecutionProvider(translationExecutionProvider);

  return Object.freeze({
    resolve(providerKey) {
      void providerKey;
      return translationExecutionProvider;
    }
  });
}

function assertTranslationExecutionProvider(translationExecutionProvider) {
  if (!translationExecutionProvider || typeof translationExecutionProvider !== 'object') {
    throw new TypeError('translationExecutionProvider is required.');
  }

  if (typeof translationExecutionProvider.execute !== 'function') {
    throw new TypeError('translationExecutionProvider.execute must be a function.');
  }
}
