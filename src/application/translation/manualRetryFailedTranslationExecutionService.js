import { TranslationExecution } from '../../domain/translation/index.js';
import { assertTranslationExecutionQueue } from './translationExecutionQueue.js';

export function createManualRetryFailedTranslationExecutionService({
  translationRepository,
  translationExecutionQueue,
  idGenerator,
  clock
} = {}) {
  assertMethod(translationRepository, 'findExecutionById', 'translationRepository');
  assertMethod(translationRepository, 'findRequestById', 'translationRepository');
  assertMethod(translationRepository, 'createTranslationExecution', 'translationRepository');
  assertTranslationExecutionQueue(translationExecutionQueue);
  if (typeof idGenerator !== 'function') throw new TypeError('idGenerator must be a function.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  return Object.freeze({
    async retryFailedExecution({ executionId } = {}) {
      assertExecutionId(executionId);
      const sourceExecution = await translationRepository.findExecutionById(executionId);
      if (sourceExecution === null || sourceExecution === undefined) throw executionNotFoundError(executionId);
      if (!sourceExecution.isManualRetryEligible()) throw retryIneligibleError(executionId);

      const request = await translationRepository.findRequestById(sourceExecution.translationRequestId);
      if (request === null || request === undefined) throw requestNotFoundError(sourceExecution.translationRequestId);

      // Retry creates a distinct execution identity; the failed source is never rewritten.
      const execution = new TranslationExecution({
        id: idGenerator('translation-execution'),
        translationRequestId: sourceExecution.translationRequestId,
        ...(sourceExecution.providerKey === undefined ? {} : { providerKey: sourceExecution.providerKey }),
        startedAt: clock()
      }).queue();

      await translationRepository.createTranslationExecution(execution);
      await translationExecutionQueue.enqueue({
        executionId: execution.id,
        requestId: execution.translationRequestId
      });

      return execution;
    }
  });
}

function assertExecutionId(executionId) {
  if (typeof executionId !== 'string' || executionId.trim().length === 0) {
    throw new TypeError('executionId must be a non-empty string.');
  }
}

function executionNotFoundError(executionId) {
  return applicationError(`TranslationExecution ${executionId} was not found`, 'translation_execution_not_found');
}

function requestNotFoundError(requestId) {
  return applicationError(`TranslationRequest ${requestId} was not found`, 'translation_request_not_found');
}

function retryIneligibleError(executionId) {
  return applicationError(`TranslationExecution ${executionId} is not eligible for manual retry`, 'execution_invalid_state');
}

function applicationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertMethod(target, methodName, targetName) {
  if (!target || typeof target[methodName] !== 'function') {
    throw new TypeError(`${targetName}.${methodName} must be a function.`);
  }
}
