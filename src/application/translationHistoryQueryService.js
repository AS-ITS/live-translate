const REQUIRED_TRANSLATION_HISTORY_REPOSITORY_METHODS = Object.freeze([
  'listTranslationRequestsBySession',
  'listTranslationExecutionsByRequest',
  'listTranslationOutputsByExecution'
]);

export function createTranslationHistoryQueryService({ sessionRepository, translationRepository } = {}) {
  if (!sessionRepository || typeof sessionRepository.getSessionRecord !== 'function') throw new TypeError('sessionRepository.getSessionRecord is required.');
  for (const method of REQUIRED_TRANSLATION_HISTORY_REPOSITORY_METHODS) {
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
          translations.push({ request: mapRequest(request), execution: mapExecution(execution, request), output: outputs[0] ? mapOutput(outputs[0]) : null, sourceLanguageDetections });
          if (outputs.length > 0) {
            outputItems.push(...outputs.map((output) => mapHistoryOutput(output)));
          } else {
            executionItems.push({
              id: execution.id,
              requestId: request.id,
              targetLanguageCode: request.targetLanguageCode,
              ...(request.operation === 'transcript_polishing' ? { operation: request.operation } : {}),
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

function mapRequest(request) { return { id: request.id, sourceText: sourceTextFor(request.sourceTranscriptSnapshot), targetLanguageCode: request.targetLanguageCode, ...(request.operation === 'transcript_polishing' ? { operation: request.operation, segmentRange: request.segmentRange ?? null, inputHash: request.inputHash ?? null, model: request.model ?? null } : {}), createdAt: request.createdAt }; }
function mapExecution(execution, request) { return { id: execution.id, translationRequestId: execution.translationRequestId, ...(request?.operation === 'transcript_polishing' ? { operation: request.operation } : {}), status: execution.status, startedAt: execution.startedAt, completedAt: execution.completedAt, failureInfo: safeFailureInfo(execution.failureInfo) }; }
function mapOutput(output) { return { id: output.id, executionId: output.executionId, translatedText: output.translatedText, targetLanguageCode: output.targetLanguageCode, ...(output.operation === 'transcript_polishing' ? { operation: output.operation, polishedItems: output.polishedItems ?? [], segmentRange: output.segmentRange ?? null, inputHash: output.inputHash ?? null, model: output.model ?? output.providerMetadata?.model ?? null } : {}), createdAt: output.createdAt }; }
function mapHistoryOutput(output) { return { ...mapOutput(output), requestId: output.requestId, ...(output.operation === 'transcript_polishing' ? { operation: output.operation, polishedItems: output.polishedItems ?? [], segmentRange: output.segmentRange ?? null, inputHash: output.inputHash ?? null, model: output.model ?? output.providerMetadata?.model ?? null } : {}), version: output.version ?? null, source: output.version === undefined ? 'legacy' : 'formal', sourceLanguageCode: output.sourceLanguageCode ?? null, completedAt: output.completedAt ?? output.createdAt }; }
function compareOutputItems(first, second) { const completed = String(second.completedAt).localeCompare(String(first.completedAt)); return completed || String(first.id).localeCompare(String(second.id)); }
function sourceTextFor(snapshot = {}) { if (typeof snapshot?.sourceText === 'string') return snapshot.sourceText; if (typeof snapshot?.text === 'string') return snapshot.text; return Array.isArray(snapshot?.items) ? snapshot.items.map((item) => item?.text).filter((text) => typeof text === 'string' && text.length > 0).join('\n') : null; }
function sourceLanguageDetectionsFor(items = []) { return Object.freeze((items || []).filter((item) => item?.stream === 'source' && item.sourceLanguageDetection).map((item) => Object.freeze({ transcriptItemId: item.id, ...item.sourceLanguageDetection }))); }
function safeFailureInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['reason', 'category', 'code', 'providerCode', 'errorName', 'message', 'providerStatus', 'providerMessage', 'model']) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  if (typeof value.providerCode === 'number') result.providerCode = value.providerCode;
  if (Number.isInteger(value.status)) result.status = value.status;
  if (value.requestConfig && typeof value.requestConfig === 'object') {
    result.requestConfig = { fields: Array.isArray(value.requestConfig.fields) ? value.requestConfig.fields.slice(0, 20) : [] };
  }
  return Object.keys(result).length ? result : null;
}
function assertString(value, name) { if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string.`); }
