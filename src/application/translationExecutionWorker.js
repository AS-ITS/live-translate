import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { assertTranslationExecutionQueue } from './translation/translationExecutionQueue.js';

const IDLE_RESULT = Object.freeze({ status: 'idle' });

export function createTranslationExecutionWorker({
  translationExecutionQueue,
  translationRepository,
  translationExecutionRunner
} = {}) {
  assertTranslationExecutionQueue(translationExecutionQueue);
  assertTranslationRepository(translationRepository);
  assertTranslationExecutionRunner(translationExecutionRunner);

  return Object.freeze({
    async processNext() {
      const job = await translationExecutionQueue.dequeue();

      if (job === null || job === undefined) {
        return IDLE_RESULT;
      }

      const execution = await translationRepository.findExecutionById(job.executionId);
      assertFoundExecution(execution, job.executionId);

      const request = await translationRepository.findRequestById(job.requestId);
      assertFoundRequest(request, job.requestId);

      await runTranslationExecution(translationExecutionRunner, {
        execution,
        request
      });

      return {
        status: 'processed',
        executionId: job.executionId
      };
    }
  });
}

function assertTranslationRepository(translationRepository) {
  if (!translationRepository) {
    throw new TypeError('translationRepository is required.');
  }

  for (const methodName of TRANSLATION_REPOSITORY_METHODS) {
    if (typeof translationRepository[methodName] !== 'function') {
      throw new TypeError(`translationRepository.${methodName} must be a function.`);
    }
  }
}

function assertTranslationExecutionRunner(translationExecutionRunner) {
  if (!translationExecutionRunner || typeof translationExecutionRunner !== 'object') {
    throw new TypeError('translationExecutionRunner is required.');
  }

  if (
    typeof translationExecutionRunner.run !== 'function' &&
    typeof translationExecutionRunner.execute !== 'function'
  ) {
    throw new TypeError('translationExecutionRunner.run must be a function.');
  }
}

function runTranslationExecution(translationExecutionRunner, input) {
  if (typeof translationExecutionRunner.run === 'function') {
    return translationExecutionRunner.run(input);
  }

  return translationExecutionRunner.execute(input);
}

function assertFoundExecution(execution, executionId) {
  if (execution === null || execution === undefined) {
    throw new Error(`TranslationExecution ${executionId} was not found`);
  }
}

function assertFoundRequest(request, requestId) {
  if (request === null || request === undefined) {
    throw new Error(`TranslationRequest ${requestId} was not found`);
  }
}
