import { SUPPORTED_LANGUAGES } from '../../lib/languages.js';

const COMMAND_METHODS = Object.freeze(['createTranslationRequest', 'createTranslationExecution']);

export function createSessionRetranslationCommandService({
  sessionRepository,
  translationCommandService,
  translationProviderResolver,
  idGenerator,
  clock
} = {}) {
  assertMethod(sessionRepository, 'getSessionRecord', 'sessionRepository');
  for (const method of COMMAND_METHODS) assertMethod(translationCommandService, method, 'translationCommandService');
  assertMethod(translationProviderResolver, 'resolve', 'translationProviderResolver');
  if (typeof idGenerator !== 'function') throw new TypeError('idGenerator must be a function.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  return Object.freeze({
    async submitRetranslation(input = {}) {
      const command = validateInput(input);
      const detail = await sessionRepository.getSessionRecord(command.sessionId);
      const source = resolveCanonicalSource(detail, command.sessionId);

      // Resolution validates selection/defaulting only. It must not invoke a provider.
      await translationProviderResolver.resolve(command.providerKey);

      const request = await translationCommandService.createTranslationRequest({
        id: idGenerator('translation-request'),
        sessionId: command.sessionId,
        sourceTranscriptRevisionId: source.revisionId,
        sourceTranscriptSnapshot: source.snapshot,
        targetLanguageCode: command.targetLanguageCode,
        createdAt: clock()
      });
      const execution = await translationCommandService.createTranslationExecution({
        id: idGenerator('translation-execution'),
        translationRequestId: request.id,
        providerKey: command.providerKey,
        startedAt: clock()
      });

      return Object.freeze({
        request: Object.freeze({
          id: request.id,
          sessionId: request.sessionId,
          sourceLanguageCode: source.snapshot.sourceLanguageCode,
          targetLanguageCode: request.targetLanguageCode
        }),
        execution: Object.freeze({
          id: execution.id,
          requestId: execution.translationRequestId,
          status: execution.status,
          ...(execution.providerKey === undefined ? {} : { providerKey: execution.providerKey })
        })
      });
    }
  });
}

function validateInput(input) {
  if (!isRecord(input)) throw validationError('input must be an object.');
  const sessionId = requiredString(input.sessionId, 'sessionId');
  const targetLanguageCode = requiredString(input.targetLanguageCode, 'targetLanguageCode');
  if (!SUPPORTED_LANGUAGES.some((language) => language.code === targetLanguageCode)) {
    const error = new Error('Unsupported targetLanguageCode');
    error.code = 'unsupported_language';
    throw error;
  }
  if (input.providerKey !== undefined) requiredString(input.providerKey, 'providerKey');
  return { sessionId, targetLanguageCode, providerKey: input.providerKey };
}

function resolveCanonicalSource(detail, sessionId) {
  if (!detail?.sessionRecord) {
    const error = new Error(`Session record not found: ${sessionId}`);
    error.code = 'session_not_found';
    throw error;
  }
  if (!Array.isArray(detail.transcriptItems)) throw validationError('Canonical source transcript is not available.');

  const items = detail.transcriptItems
    .filter((item) => item?.stream === 'source' && item.status === 'final')
    .sort((first, second) => sequenceValue(first) - sequenceValue(second))
    .map((item) => structuredClone(item));
  const text = items.map((item) => item.text).filter((value) => typeof value === 'string').join('\n');
  if (items.length === 0 || text.trim().length === 0) throw validationError('Canonical source transcript is empty.');

  const revisionId = `source-revision:${sessionId}:final`;
  const sourceLanguageDetection = canonicalLanguageDetection(items);
  const sourceLanguageCode = sourceLanguageDetection.sourceLanguageCode ?? optionalSourceLanguageCode(detail.sessionRecord.sourceLanguageCode);
  return {
    revisionId,
    snapshot: {
      revisionId,
      items,
      sourceText: text,
      ...(sourceLanguageCode === undefined ? {} : { sourceLanguageCode }),
      sourceLanguageDetection: sourceLanguageDetection.metadata
    }
  };
}

function canonicalLanguageDetection(items) {
  const codes = [...new Set(items.flatMap((item) => [
    ...(Array.isArray(item.sourceLanguageDetection?.detectedLanguageCodes) ? item.sourceLanguageDetection.detectedLanguageCodes : []),
    ...(typeof item.languageCode === 'string' && item.languageCode.trim() ? [item.languageCode] : [])
  ]))];
  const sourceLanguageCode = codes.length === 1 ? codes[0] : undefined;
  return {
    ...(sourceLanguageCode === undefined ? {} : { sourceLanguageCode }),
    metadata: { detectedLanguageCodes: codes, coverage: codes.length > 0 ? 'complete' : 'partial' }
  };
}

function sequenceValue(item) { return Number.isFinite(item?.sequence) ? item.sequence : 0; }
function optionalSourceLanguageCode(value) { return typeof value === 'string' && value.trim().length > 0 ? value : undefined; }
function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw validationError(`${name} must be a non-empty string.`);
  return value;
}
function validationError(message) { const error = new TypeError(message); error.code = 'invalid_request'; return error; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function assertMethod(target, method, name) {
  if (!target || typeof target[method] !== 'function') throw new TypeError(`${name}.${method} must be a function.`);
}
