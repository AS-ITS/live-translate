export function createCancelQueuedTranslationExecutionService({ translationRepository, clock } = {}) {
  assertMethod(translationRepository, 'findExecutionById', 'translationRepository');
  assertMethod(translationRepository, 'updateTranslationExecution', 'translationRepository');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  return Object.freeze({
    async cancelQueuedExecution({ executionId } = {}) {
      assertExecutionId(executionId);
      const execution = await translationRepository.findExecutionById(executionId);
      if (execution === null || execution === undefined) throw executionNotFoundError(executionId);

      const cancelledExecution = execution.cancel(clock());
      return translationRepository.updateTranslationExecution(cancelledExecution);
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
