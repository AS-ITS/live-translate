export function createTranslationExecutionProviderResolver(implementation) {
  assertResolverImplementation(implementation);

  return Object.freeze({
    resolve(providerKey) {
      return implementation.resolve(providerKey);
    }
  });
}

function assertResolverImplementation(implementation) {
  if (!implementation || typeof implementation !== 'object') {
    throw new TypeError('translationExecutionProviderResolver implementation is required.');
  }

  if (typeof implementation.resolve !== 'function') {
    throw new TypeError('translationExecutionProviderResolver.resolve must be a function.');
  }
}
