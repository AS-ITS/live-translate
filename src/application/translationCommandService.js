import { TranslationExecution, TranslationOutput, TranslationRequest } from '../domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';

const EXECUTION_TRANSITIONS = Object.freeze(['start', 'complete', 'fail', 'cancel']);

export function createTranslationCommandService({ translationRepository } = {}) {
  assertTranslationRepository(translationRepository);

  return Object.freeze({
    createTranslationRequest(payload) {
      return translationRepository.createTranslationRequest(new TranslationRequest(payload));
    },

    createTranslationExecution(payload) {
      return translationRepository.createTranslationExecution(new TranslationExecution(payload));
    },

    updateTranslationExecution(payload = {}) {
      const { executionId, transition, ...transitionPayload } = payload;
      const result = translationRepository.getTranslationExecution(executionId);

      if (isPromiseLike(result)) {
        return result.then((execution) => updateExecution(translationRepository, executionId, execution, transition, transitionPayload));
      }

      return updateExecution(translationRepository, executionId, result, transition, transitionPayload);
    },

    createTranslationOutput(payload) {
      return translationRepository.createTranslationOutput(new TranslationOutput(payload));
    }
  });
}

function assertTranslationRepository(translationRepository) {
  if (!translationRepository) {
    throw new TypeError('translationRepository is required.');
  }

  for (const methodName of TRANSLATION_REPOSITORY_METHODS) {
    assertMethod(translationRepository, methodName);
  }
}

function assertMethod(target, methodName) {
  if (typeof target[methodName] !== 'function') {
    throw new TypeError(`translationRepository.${methodName} must be a function.`);
  }
}

function updateExecution(translationRepository, executionId, execution, transition, transitionPayload) {
  if (execution === null || execution === undefined) {
    throw new Error(`TranslationExecution ${executionId} was not found`);
  }

  const updatedExecution = applyExecutionTransition(execution, transition, transitionPayload);
  return translationRepository.updateTranslationExecution(updatedExecution);
}

function applyExecutionTransition(execution, transition, payload) {
  if (!EXECUTION_TRANSITIONS.includes(transition) || typeof execution[transition] !== 'function') {
    throw new TypeError(`Unsupported TranslationExecution transition: ${transition}`);
  }

  switch (transition) {
    case 'start':
      return execution.start(payload.startedAt);
    case 'complete':
      return execution.complete(payload.completedAt);
    case 'fail':
      return execution.fail(payload.failureInfo, payload.completedAt);
    case 'cancel':
      return execution.cancel(payload.completedAt);
    default:
      throw new TypeError(`Unsupported TranslationExecution transition: ${transition}`);
  }
}

function isPromiseLike(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}
