import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';

export function createTranslationHistoryQueryService({ sessionRepository, translationRepository } = {}) {
  if (!sessionRepository || typeof sessionRepository.getSessionRecord !== 'function') throw new TypeError('sessionRepository.getSessionRecord is required.');
  for (const method of TRANSLATION_REPOSITORY_METHODS) {
    if (!translationRepository || typeof translationRepository[method] !== 'function') throw new TypeError(`translationRepository.${method} is required.`);
  }

  return Object.freeze({
    async listSessionTranslations({ sessionId, targetLanguageCode, includeReadModel = false } = {}) {
      assertString(sessionId, 'sessionId');
      const detail = await sessionRepository.getSessionRecord(sessionId);
      if (!detail?.sessionRecord) return null;
      const requests = await translationRepository.listTranslationRequestsBySession(sessionId);
      const filteredRequests = targetLanguageCode === undefined ? requests : requests.filter((request) => request.targetLanguageCode === targetLanguageCode);
      const sourceLanguageDetections = sourceLanguageDetectionsFor(detail.transcriptItems);
      const translations = [];
      const outputItems = [];
      const executionItems = [];
      for (const request of filteredRequests) {
        const executions = await translationRepository.listTranslationExecutionsByRequest(request.id);
        if (executions.length === 0) {
          translations.push({ request: mapRequest(request), execution: null, output: null, sourceLanguageDetections });
          continue;
        }
        for (const execution of executions) {
          const outputs = await translationRepository.listTranslationOutputsByExecution(execution.id);
          translations.push({ request: mapRequest(request), execution: mapExecution(execution), output: outputs[0] ? mapOutput(outputs[0]) : null, sourceLanguageDetections });
          if (outputs.length > 0) {
            outputItems.push(...outputs.map((output) => mapHistoryOutput(output)));
          } else {
            executionItems.push({
              id: execution.id,
              requestId: request.id,
              targetLanguageCode: request.targetLanguageCode,
              status: execution.status,
              startedAt: execution.startedAt ?? null,
              createdAt: request.createdAt ?? null,
              providerAttemptStatus: execution.providerAttemptStatus ?? null,
              providerAttemptedAt: execution.providerAttemptedAt ?? null,
              providerCompletedAt: execution.providerCompletedAt ?? null,
              failureInfo: safeFailureInfo(execution.failureInfo),
              ...(execution.completedAt === null ? {} : { completedAt: execution.completedAt })
            });
          }
        }
      }
      const result = {
        sessionId,
        translations
      };
      if (includeReadModel) result.translationHistory = {
        outputs: outputItems.sort(compareOutputItems),
        executions: executionItems.sort((first, second) => String(first.id).localeCompare(String(second.id)))
      };
      return result;
    }
  });
}

function mapRequest(request) { return { id: request.id, sourceText: sourceTextFor(request.sourceTranscriptSnapshot), targetLanguageCode: request.targetLanguageCode, createdAt: request.createdAt }; }
function mapExecution(execution) { return { id: execution.id, translationRequestId: execution.translationRequestId, status: execution.status, startedAt: execution.startedAt, completedAt: execution.completedAt, failureInfo: safeFailureInfo(execution.failureInfo) }; }
function mapOutput(output) { return { id: output.id, executionId: output.executionId, translatedText: output.translatedText, targetLanguageCode: output.targetLanguageCode, createdAt: output.createdAt }; }
function mapHistoryOutput(output) { return { ...mapOutput(output), requestId: output.requestId, version: output.version ?? null, source: output.version === undefined ? 'legacy' : 'formal', sourceLanguageCode: output.sourceLanguageCode ?? null, completedAt: output.completedAt ?? output.createdAt }; }
function compareOutputItems(first, second) { const completed = String(second.completedAt).localeCompare(String(first.completedAt)); return completed || String(first.id).localeCompare(String(second.id)); }
function sourceTextFor(snapshot = {}) { if (typeof snapshot?.sourceText === 'string') return snapshot.sourceText; if (typeof snapshot?.text === 'string') return snapshot.text; return Array.isArray(snapshot?.items) ? snapshot.items.map((item) => item?.text).filter((text) => typeof text === 'string' && text.length > 0).join('\n') : null; }
function sourceLanguageDetectionsFor(items = []) { return Object.freeze((items || []).filter((item) => item?.stream === 'source' && item.sourceLanguageDetection).map((item) => Object.freeze({ transcriptItemId: item.id, ...item.sourceLanguageDetection }))); }
function safeFailureInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['reason', 'category', 'code', 'errorName', 'message']) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  if (Number.isInteger(value.status)) result.status = value.status;
  return Object.keys(result).length ? result : null;
}
function assertString(value, name) { if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string.`); }
