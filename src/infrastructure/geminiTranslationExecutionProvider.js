export function createGeminiTranslationExecutionProvider({ client } = {}) {
  assertClient(client);
  const translate = resolveTranslate(client);

  return Object.freeze({
    idempotency: Object.freeze({ mode: 'unknown' }),
    async execute(input) {
      const result = await translate.call(client, mapProviderInputToGeminiRequest(input));

      return Object.freeze({
        translatedText: result?.translatedText,
        ...(result?.polishedItems === undefined ? {} : { polishedItems: result.polishedItems }),
        ...(result?.refinedItems === undefined ? {} : { refinedItems: result.refinedItems }),
        ...(result?.refinedSource === undefined ? {} : { refinedSource: result.refinedSource }),
        ...(result?.refinedTranslation === undefined ? {} : { refinedTranslation: result.refinedTranslation }),
        ...(result?.refinedCues === undefined ? {} : { refinedCues: result.refinedCues }),
        ...(result?.refinementTargets === undefined ? {} : { refinementTargets: result.refinementTargets }),
        detectedSourceLanguageCode: result?.detectedSourceLanguageCode
      });
    }
  });
}

function assertClient(client) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    throw new TypeError('client is required.');
  }

  if (typeof client.translate !== 'function' && typeof client.execute !== 'function') {
    throw new TypeError('client.translate must be a function.');
  }
}

function resolveTranslate(client) {
  return typeof client.translate === 'function' ? client.translate : client.execute;
}

function mapProviderInputToGeminiRequest(input) {
  return Object.freeze({
    sourceText: input?.sourceText,
    ...(input?.operation === undefined ? {} : { operation: input.operation }),
    ...(input?.mode === undefined ? {} : { mode: input.mode }),
    ...(input?.items === undefined ? {} : { items: input.items }),
    ...(input?.polishingItems === undefined ? {} : { polishingItems: input.polishingItems }),
    ...(input?.refinementItems === undefined ? {} : { refinementItems: input.refinementItems }),
    ...(input?.refinementTargets === undefined ? {} : { refinementTargets: input.refinementTargets }),
    ...(input?.model === undefined ? {} : { model: input.model }),
    ...(input?.sourceLanguageCode === undefined ? {} : { sourceLanguageCode: input.sourceLanguageCode }),
    targetLanguageCode: input?.targetLanguageCode,
    ...(input?.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input?.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input?.executionId === undefined ? {} : { executionId: input.executionId }),
    ...(input?.providerIdempotencyKey === undefined ? {} : { providerIdempotencyKey: input.providerIdempotencyKey })
  });
}
