export function createProductionTranslationExecutionProvider({ resolver } = {}) {
  assertResolver(resolver);

  return Object.freeze({
    async execute(input) {
      const provider = await resolver.resolve({ providerKey: input?.providerKey });
      assertTranslationProvider(provider);

      return await provider.translate({
        sourceText: input?.sourceText,
        sourceLanguageCode: input?.sourceLanguageCode,
        targetLanguageCode: input?.targetLanguageCode,
        requestId: input?.requestId,
        sessionId: input?.sessionId,
        executionId: input?.executionId,
        ...(input?.providerIdempotencyKey === undefined ? {} : { providerIdempotencyKey: input.providerIdempotencyKey })
      });
    }
  });
}

function assertResolver(resolver) {
  if (!resolver || typeof resolver !== 'object' || Array.isArray(resolver)) {
    throw new TypeError('translation provider resolver is required.');
  }

  if (typeof resolver.resolve !== 'function') {
    throw new TypeError('translation provider resolver.resolve must be a function.');
  }
}

function assertTranslationProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError('resolved translation provider must be an object.');
  }

  if (typeof provider.translate !== 'function') {
    throw new TypeError('resolved translation provider.translate must be a function.');
  }
}
