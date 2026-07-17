const DEFAULT_PROVIDER_KEY = 'fake';

export function createFakeTranslationExecutionProviderResolver({
  translationExecutionProvider,
  providerKey = DEFAULT_PROVIDER_KEY,
  defaultProviderKey = providerKey
} = {}) {
  assertTranslationExecutionProvider(translationExecutionProvider);
  assertProviderKey(providerKey, 'providerKey');
  assertProviderKey(defaultProviderKey, 'defaultProviderKey');

  return Object.freeze({
    resolve(requestedProviderKey) {
      const resolvedProviderKey = requestedProviderKey ?? defaultProviderKey;

      if (resolvedProviderKey !== providerKey) {
        throw new Error(`translation execution provider not found: ${resolvedProviderKey}`);
      }

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

function assertProviderKey(providerKey, fieldName) {
  if (typeof providerKey !== 'string') {
    throw new TypeError(`${fieldName} must be a string.`);
  }

  if (providerKey.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}
