import {
  mapTranslationOutputToDetailDTO,
  mapTranslationRequestToDTO
} from '../readModels/translationReadModels.js';

const COMMAND_METHODS = Object.freeze([
  'createTranslationRequest',
  'createTranslationExecution',
  'updateTranslationExecution',
  'createTranslationOutput'
]);

const QUERY_METHODS = Object.freeze([
  'listSessionTranslations'
]);

const REPOSITORY_METHODS = Object.freeze([
  'getTranslationRequest',
  'listTranslationOutputsByExecution',
  'listTranslationOutputsByRequest',
  'listTranslationOutputsBySession'
]);

export function createTranslationApplicationService({
  translationCommandService,
  translationHistoryQueryService,
  translationRepository
} = {}) {
  assertMethods(translationCommandService, COMMAND_METHODS, 'translationCommandService');
  assertMethods(translationHistoryQueryService, QUERY_METHODS, 'translationHistoryQueryService');
  assertMethods(translationRepository, REPOSITORY_METHODS, 'translationRepository');

  return Object.freeze({
    requestTranslation(input) {
      return translationCommandService.createTranslationRequest(input);
    },

    executeTranslation(input) {
      return translationCommandService.createTranslationExecution(input);
    },

    updateExecution(input) {
      return translationCommandService.updateTranslationExecution(input);
    },

    recordTranslationOutput(input) {
      return translationCommandService.createTranslationOutput(input);
    },

    getTranslationRequest(input) {
      return mapResult(
        translationRepository.getTranslationRequest(translationId(input, 'requestId')),
        mapTranslationRequestToDTO
      );
    },

    listTranslationOutputs(input = {}) {
      const { sessionId, requestId, executionId } = input;
      if (executionId !== undefined) return mapOutputList(translationRepository.listTranslationOutputsByExecution(executionId));
      if (requestId !== undefined) return mapOutputList(translationRepository.listTranslationOutputsByRequest(requestId));
      if (sessionId !== undefined) return mapOutputList(translationRepository.listTranslationOutputsBySession(sessionId));
      throw new TypeError('listTranslationOutputs requires sessionId, requestId, or executionId.');
    },

    listSessionTranslations(input) {
      return translationHistoryQueryService.listSessionTranslations(input);
    }
  });
}

function mapResult(value, mapper) {
  if (isPromiseLike(value)) return value.then((resolved) => mapResult(resolved, mapper));
  return value == null ? value : mapper(value);
}

function mapOutputList(value) {
  if (isPromiseLike(value)) return value.then(mapOutputList);
  return value == null || value.length === 0 ? value : value.map(mapTranslationOutputToDetailDTO);
}

function isPromiseLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

function translationId(input, name) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && input[name] !== undefined) return input[name];
  throw new TypeError(`${name} is required.`);
}

function assertMethods(target, methods, label) {
  if (!target || typeof target !== 'object') throw new TypeError(`${label} is required.`);
  for (const method of methods) {
    if (typeof target[method] !== 'function') throw new TypeError(`${label}.${method} must be a function.`);
  }
}
