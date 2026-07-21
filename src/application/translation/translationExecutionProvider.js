export function createTranslationExecutionProvider(implementation) {
  assertProviderImplementation(implementation);

  return Object.freeze({
    async execute(input) {
      return implementation.execute(input);
    },
    idempotency: normalizeIdempotency(implementation.idempotency)
  });
}

function normalizeIdempotency(value) {
  const mode = value?.mode;
  if (!['guaranteed', 'unsupported', 'unknown'].includes(mode)) {
    return Object.freeze({ mode: 'unknown' });
  }
  return Object.freeze({ mode });
}

function assertProviderImplementation(implementation) {
  if (!implementation || typeof implementation !== 'object') {
    throw new TypeError('translationExecutionProvider implementation is required.');
  }

  if (typeof implementation.execute !== 'function') {
    throw new TypeError('translationExecutionProvider.execute must be a function.');
  }
}
