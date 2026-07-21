const SERVICE_METHODS = Object.freeze([
  ['cancelQueuedTranslationExecutionService', 'cancelQueuedExecution'],
  ['manualRetryFailedTranslationExecutionService', 'retryFailedExecution']
]);

export function createExecutionControlController({
  cancelQueuedTranslationExecutionService,
  manualRetryFailedTranslationExecutionService
} = {}) {
  assertService(cancelQueuedTranslationExecutionService, ...SERVICE_METHODS[0]);
  assertService(manualRetryFailedTranslationExecutionService, ...SERVICE_METHODS[1]);

  return Object.freeze({
    async cancelExecution({ executionId } = {}) {
      try {
        return await cancelQueuedTranslationExecutionService.cancelQueuedExecution({ executionId });
      } catch (error) {
        if (error instanceof RangeError && error.message.startsWith('status transition from ')) {
          error.code = 'execution_invalid_state';
        }
        throw error;
      }
    },

    retryExecution({ executionId } = {}) {
      return manualRetryFailedTranslationExecutionService.retryFailedExecution({ executionId });
    }
  });
}

function assertService(service, serviceName, methodName) {
  if (!service || typeof service[methodName] !== 'function') {
    throw new TypeError(`${serviceName}.${methodName} must be a function.`);
  }
}
