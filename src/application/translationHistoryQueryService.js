import {
  compareTranslationOutputDetails,
  mapTranslationExecutionHistoryDTO,
  mapTranslationExecutionToDTO,
  mapTranslationOutputToDetailDTO,
  mapTranslationOutputToSummaryDTO,
  mapTranslationRequestToDTO
} from '../readModels/translationReadModels.js';

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
          translations.push({ request: mapTranslationRequestToDTO(request), execution: null, output: null, sourceLanguageDetections });
          continue;
        }
        for (const execution of executions) {
          const outputs = await translationRepository.listTranslationOutputsByExecution(execution.id);
          translations.push({ request: mapTranslationRequestToDTO(request), execution: mapTranslationExecutionToDTO(execution, request), output: outputs[0] ? mapTranslationOutputToSummaryDTO(outputs[0]) : null, sourceLanguageDetections });
          if (outputs.length > 0) {
            outputItems.push(...outputs.map((output) => mapTranslationOutputToDetailDTO(output)));
          } else {
            executionItems.push(mapTranslationExecutionHistoryDTO(execution, request));
          }
        }
      }
      const result = {
        sessionId,
        translations
      };
      if (includeReadModel) result.translationHistory = {
        outputs: outputItems.sort(compareTranslationOutputDetails),
        executions: executionItems.sort((first, second) => String(first.id).localeCompare(String(second.id)))
      };
      return result;
    }
  });
}

function sourceLanguageDetectionsFor(items = []) { return Object.freeze((items || []).filter((item) => item?.stream === 'source' && item.sourceLanguageDetection).map((item) => Object.freeze({ transcriptItemId: item.id, ...item.sourceLanguageDetection }))); }
function assertString(value, name) { if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string.`); }
