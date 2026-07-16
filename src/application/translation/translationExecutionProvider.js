export function createTranslationExecutionProvider(implementation) {
  assertProviderImplementation(implementation);

  return Object.freeze({
    async execute(input) {
      return implementation.execute(input);
    }
  });
}

function assertProviderImplementation(implementation) {
  if (!implementation || typeof implementation !== 'object') {
    throw new TypeError('translationExecutionProvider implementation is required.');
  }

  if (typeof implementation.execute !== 'function') {
    throw new TypeError('translationExecutionProvider.execute must be a function.');
  }
}
