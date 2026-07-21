export function createFakeTranslationExecutionProvider({ calls = [], idempotencyMode = 'guaranteed' } = {}) {
  const resultsByKey = new Map();
  return Object.freeze({
    idempotency: Object.freeze({ mode: idempotencyMode }),
    async execute(input) {
      calls.push(input);
      const key = input?.providerIdempotencyKey;
      if (idempotencyMode === 'guaranteed' && key !== undefined && resultsByKey.has(key)) {
        return resultsByKey.get(key);
      }
      const result = Object.freeze({
        translatedText: `[fake] ${input.sourceText}`,
        detectedSourceLanguageCode: input.sourceLanguageCode ?? undefined
      });
      if (idempotencyMode === 'guaranteed' && key !== undefined) resultsByKey.set(key, result);
      return result;
    }
  });
}
