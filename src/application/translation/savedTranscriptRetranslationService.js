const COMMAND_SERVICE_METHODS = Object.freeze([
  'createTranslationRequest',
  'createTranslationExecution',
  'updateTranslationExecution',
  'createTranslationOutput'
]);

export function createSavedTranscriptRetranslationService({
  translationCommandService,
  savedTranscriptTranslationProvider,
  resolveSavedTranscriptTranslationProvider,
  sessionRepository,
  idGenerator,
  clock
} = {}) {
  assertCommandService(translationCommandService);
  const resolveProvider = resolveProviderDependency({
    savedTranscriptTranslationProvider,
    resolveSavedTranscriptTranslationProvider
  });
  assertSessionRepository(sessionRepository);
  assertFunction(idGenerator, 'idGenerator');
  assertFunction(clock, 'clock');

  return Object.freeze({
    async translateSavedTranscript(input = {}) {
      const operationInput = validateInput(input);
      const sessionDetail = await maybeAwait(sessionRepository.getSessionRecord(operationInput.sessionId));
      const sourceTranscript = resolveSavedSourceTranscript(sessionDetail, operationInput.sessionId);
      const provider = await maybeAwait(
        resolveProvider({
          providerKey: operationInput.providerKey
        })
      );
      assertProvider(provider);
      const requestId = idGenerator('translation-request');
      const executionId = idGenerator('translation-execution');
      const createdAt = clock();

      const request = await maybeAwait(
        translationCommandService.createTranslationRequest({
          id: requestId,
          sessionId: operationInput.sessionId,
          sourceTranscriptRevisionId: sourceTranscript.revisionId,
          sourceTranscriptSnapshot: sourceTranscript.snapshot,
          targetLanguageCode: operationInput.targetLanguageCode,
          createdAt
        })
      );

      await maybeAwait(
        translationCommandService.createTranslationExecution({
          id: executionId,
          translationRequestId: request.id,
          status: 'pending',
          startedAt: clock()
        })
      );

      const runningExecution = await maybeAwait(
        translationCommandService.updateTranslationExecution({
          executionId,
          transition: 'start',
          startedAt: clock()
        })
      );

      let providerResult;
      try {
        providerResult = await provider.translate({
          sourceText: sourceTranscript.text,
          sourceLanguageCode: operationInput.sourceLanguageCode,
          targetLanguageCode: operationInput.targetLanguageCode,
          requestId: request.id,
          sessionId: operationInput.sessionId,
          executionId: runningExecution.id
        });
      } catch (error) {
        await maybeAwait(
          translationCommandService.updateTranslationExecution({
            executionId: runningExecution.id,
            transition: 'fail',
            failureInfo: failureInfoFor(error),
            completedAt: clock()
          })
        );
        throw error;
      }

      const translatedText = validateProviderResult(providerResult);
      const output = await maybeAwait(
        translationCommandService.createTranslationOutput({
          id: idGenerator('translation-output'),
          executionId: runningExecution.id,
          sequence: 0,
          translatedText,
          targetLanguageCode: operationInput.targetLanguageCode,
          providerMetadata: providerMetadataFor(providerResult),
          createdAt: clock()
        })
      );
      const execution = await maybeAwait(
        translationCommandService.updateTranslationExecution({
          executionId: runningExecution.id,
          transition: 'complete',
          completedAt: clock()
        })
      );

      return Object.freeze({ request, execution, output });
    }
  });
}

function validateInput(input) {
  if (!isRecord(input)) {
    throw new TypeError('input must be an object.');
  }

  return {
    sessionId: assertNonEmptyString(input.sessionId, 'sessionId'),
    sourceLanguageCode: assertNonEmptyString(input.sourceLanguageCode, 'sourceLanguageCode'),
    targetLanguageCode: assertNonEmptyString(input.targetLanguageCode, 'targetLanguageCode'),
    providerKey: input.providerKey
  };
}

function resolveSavedSourceTranscript(sessionDetail, sessionId) {
  if (!sessionDetail?.sessionRecord) {
    throw new Error(`Session record not found: ${sessionId}`);
  }

  if (!Array.isArray(sessionDetail.transcriptItems)) {
    throw new Error(`Saved source transcript is not available for session: ${sessionId}`);
  }

  const items = sessionDetail.transcriptItems
    .filter((item) => item?.stream === 'source' && item.status === 'final')
    .sort(compareBySequence)
    .map(copyTranscriptItem);
  const textItems = items.filter((item) => typeof item.text === 'string' && item.text.length > 0);

  if (textItems.length === 0) {
    throw new Error(`Saved source transcript is not available for session: ${sessionId}`);
  }

  const revisionId = `source-revision:${sessionId}:final`;

  return {
    revisionId,
    text: textItems.map((item) => item.text).join('\n'),
    snapshot: {
      revisionId,
      items
    }
  };
}

function validateProviderResult(providerResult) {
  if (!isRecord(providerResult)) {
    throw new TypeError('saved transcript translation provider result must be an object.');
  }

  return assertNonEmptyString(providerResult.translatedText, 'translatedText');
}

function providerMetadataFor(providerResult) {
  if (!isRecord(providerResult) || typeof providerResult.detectedSourceLanguageCode !== 'string') {
    return null;
  }

  const detectedSourceLanguageCode = providerResult.detectedSourceLanguageCode.trim();
  return detectedSourceLanguageCode ? { detectedSourceLanguageCode } : null;
}

function failureInfoFor(error) {
  return {
    reason: 'provider_error',
    message: error instanceof Error ? error.message : String(error)
  };
}

function compareBySequence(first, second) {
  return sequenceValue(first) - sequenceValue(second);
}

function sequenceValue(item) {
  return Number.isFinite(item?.sequence) ? item.sequence : 0;
}

function copyTranscriptItem(item) {
  return { ...item };
}

function assertCommandService(translationCommandService) {
  if (!translationCommandService || typeof translationCommandService !== 'object') {
    throw new TypeError('translationCommandService is required.');
  }

  for (const method of COMMAND_SERVICE_METHODS) {
    if (typeof translationCommandService[method] !== 'function') {
      throw new TypeError(`translationCommandService.${method} must be a function.`);
    }
  }
}

function assertProvider(savedTranscriptTranslationProvider) {
  if (!savedTranscriptTranslationProvider || typeof savedTranscriptTranslationProvider !== 'object') {
    throw new TypeError('savedTranscriptTranslationProvider is required.');
  }

  if (typeof savedTranscriptTranslationProvider.translate !== 'function') {
    throw new TypeError('savedTranscriptTranslationProvider.translate must be a function.');
  }
}

function resolveProviderDependency({ savedTranscriptTranslationProvider, resolveSavedTranscriptTranslationProvider }) {
  if (resolveSavedTranscriptTranslationProvider !== undefined) {
    assertFunction(resolveSavedTranscriptTranslationProvider, 'resolveSavedTranscriptTranslationProvider');
    return resolveSavedTranscriptTranslationProvider;
  }

  assertProvider(savedTranscriptTranslationProvider);
  return () => savedTranscriptTranslationProvider;
}

function assertSessionRepository(sessionRepository) {
  if (!sessionRepository || typeof sessionRepository !== 'object') {
    throw new TypeError('sessionRepository is required.');
  }

  if (typeof sessionRepository.getSessionRecord !== 'function') {
    throw new TypeError('sessionRepository.getSessionRecord must be a function.');
  }
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string.`);
  }

  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be empty.`);
  }

  return value;
}

function maybeAwait(value) {
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
