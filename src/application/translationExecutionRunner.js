import { TranslationExecution, TranslationOutput } from '../domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { createRetryPolicy } from './translation/retryPolicy.js';

export function createTranslationExecutionRunner({
  translationRepository,
  translationExecutionProvider,
  retryPolicy = createRetryPolicy(),
  executionFenceGuard,
  clock = () => new Date().toISOString()
} = {}) {
  assertTranslationRepository(translationRepository);
  assertTranslationExecutionProvider(translationExecutionProvider);
  assertRetryPolicy(retryPolicy);
  assertOptionalExecutionFenceGuard(executionFenceGuard);
  assertClock(clock);

  return Object.freeze({
    async execute(input = {}) {
      const { execution, payload, repositoryResult, onTranslationOutputCreated, onTranslationExecutionUpdated, executionFence, deferProviderFailure = false } = input;

      assertExecutionInput(execution);
      assertPayloadInput(payload);

      let providerAttemptExecution;
      let providerResult;
      try {
        ({ providerAttemptExecution, providerResult } = await executeProviderWithRetry({
          translationExecutionProvider,
          retryPolicy,
          translationRepository,
          execution,
          payload,
          executionFenceGuard,
          executionFence,
          clock
        }));
      } catch (error) {
        if (error.providerExecutionError !== true) throw error;
        if (deferProviderFailure) throw error;
        await assertWritable(executionFenceGuard, execution, executionFence);
        await failExecutionAfterProviderError(
          translationRepository,
          error.providerAttemptExecution ?? providerAttemptExecution ?? execution,
          payload,
          onTranslationExecutionUpdated
        );
        throw error;
      }

      const output = new TranslationOutput({
        id: payload.outputId ?? `${execution.id}-output-0`,
        executionId: execution.id,
        sequence: payload.outputSequence ?? 0,
        translatedText: providerAttemptExecution.providerResult.translatedText,
        targetLanguageCode: payload.targetLanguageCode,
        createdAt: payload.outputCreatedAt ?? payload.completedAt ?? execution.startedAt
      });
      await assertWritable(executionFenceGuard, execution, executionFence);
      const outputRepositoryResult = await translationRepository.createTranslationOutput(output);

      await notifyOptional(onTranslationOutputCreated, {
        output,
        repositoryResult: outputRepositoryResult
      });

      const completedExecution = new TranslationExecution({
        id: execution.id,
        translationRequestId: execution.translationRequestId,
        status: 'completed',
        providerKey: execution.providerKey,
        providerIdempotencyKey: execution.providerIdempotencyKey,
        providerAttemptStatus: providerAttemptExecution.providerAttemptStatus,
        providerAttemptedAt: providerAttemptExecution.providerAttemptedAt,
        providerCompletedAt: providerAttemptExecution.providerCompletedAt,
        providerResult: providerAttemptExecution.providerResult,
        startedAt: execution.startedAt,
        completedAt: payload.completedAt ?? execution.startedAt
      });
      await assertWritable(executionFenceGuard, execution, executionFence);
      const completedRepositoryResult = await translationRepository.updateTranslationExecution(completedExecution);

      await notifyOptional(onTranslationExecutionUpdated, {
        execution: completedExecution,
        repositoryResult: completedRepositoryResult
      });

      return repositoryResult;
    },

    async reconcileSucceeded({ execution, payload, executionFence } = {}) {
      assertExecutionInput(execution);
      assertPayloadInput(payload);
      if (execution.providerAttemptStatus !== 'succeeded' || execution.providerResult === null) {
        throw new Error('translation_execution_provider_result_integrity_error');
      }
      const output = new TranslationOutput({
        id: payload.outputId ?? `${execution.id}-output-0`,
        executionId: execution.id,
        sequence: payload.outputSequence ?? 0,
        translatedText: execution.providerResult.translatedText,
        targetLanguageCode: payload.targetLanguageCode,
        createdAt: payload.outputCreatedAt ?? payload.completedAt ?? execution.startedAt
      });
      await assertWritable(executionFenceGuard, execution, executionFence);
      await translationRepository.createTranslationOutput(output);
      const completed = new TranslationExecution({
        id: execution.id,
        translationRequestId: execution.translationRequestId,
        status: 'completed',
        providerKey: execution.providerKey,
        providerIdempotencyKey: execution.providerIdempotencyKey,
        providerAttemptStatus: execution.providerAttemptStatus,
        providerAttemptedAt: execution.providerAttemptedAt,
        providerCompletedAt: execution.providerCompletedAt,
        providerResult: execution.providerResult,
        startedAt: execution.startedAt,
        completedAt: payload.completedAt ?? execution.startedAt
      });
      await assertWritable(executionFenceGuard, execution, executionFence);
      return translationRepository.updateTranslationExecution(completed);
    }
  });
}

async function assertWritable(executionFenceGuard, execution, executionFence) {
  if (executionFenceGuard === undefined || executionFence === undefined) return;
  await executionFenceGuard.assertWritable({
    executionId: execution.id,
    claim: {
      leaseId: executionFence.leaseId,
      fenceToken: executionFence.fenceToken
    }
  });
}

async function executeProviderWithRetry({
  translationExecutionProvider,
  retryPolicy,
  translationRepository,
  execution,
  payload,
  executionFenceGuard,
  executionFence,
  clock
}) {
  let providerAttemptExecution = execution;
  let attempt = 1;

  while (true) {
    const inFlightExecution = providerAttemptExecution.markProviderAttemptInFlight(clock());
    await assertWritable(executionFenceGuard, execution, executionFence);
    await translationRepository.updateTranslationExecution(inFlightExecution);

    let providerResult;
    try {
      providerResult = await translationExecutionProvider.execute({
        sourceText: payload.sourceText,
        sourceLanguageCode: payload.sourceLanguageCode,
        targetLanguageCode: payload.targetLanguageCode,
        providerKey: payload.providerKey,
        ...(execution.providerIdempotencyKey === undefined ? {} : { providerIdempotencyKey: execution.providerIdempotencyKey })
      });

    } catch (error) {
      providerAttemptExecution = inFlightExecution.markProviderAttemptFailed(clock());
      await assertWritable(executionFenceGuard, execution, executionFence);
      await translationRepository.updateTranslationExecution(providerAttemptExecution);

      if (!retryPolicy.canRetry(attempt)) {
        error.providerAttemptExecution = providerAttemptExecution;
        error.providerExecutionError = true;
        throw error;
      }

      retryPolicy.nextDelay(attempt);
      attempt += 1;
      continue;
    }

    providerAttemptExecution = inFlightExecution.markProviderAttemptSucceeded(clock(), providerResult);
    await assertWritable(executionFenceGuard, execution, executionFence);
    await translationRepository.updateTranslationExecution(providerAttemptExecution);
    return { providerAttemptExecution, providerResult };
  }
}

async function failExecutionAfterProviderError(
  translationRepository,
  execution,
  payload,
  onTranslationExecutionUpdated
) {
  const failedExecution = execution.fail(
    { reason: 'provider_execution_failed' },
    payload.completedAt ?? execution.startedAt
  );
  const failedRepositoryResult = await translationRepository.updateTranslationExecution(failedExecution);

  await notifyOptional(onTranslationExecutionUpdated, {
    execution: failedExecution,
    repositoryResult: failedRepositoryResult
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

function assertTranslationExecutionProvider(translationExecutionProvider) {
  if (!translationExecutionProvider || typeof translationExecutionProvider !== 'object') {
    throw new TypeError('translationExecutionProvider is required.');
  }

  if (typeof translationExecutionProvider.execute !== 'function') {
    throw new TypeError('translationExecutionProvider.execute must be a function.');
  }
}

function assertRetryPolicy(retryPolicy) {
  if (!retryPolicy || typeof retryPolicy !== 'object') {
    throw new TypeError('retryPolicy is required.');
  }

  if (typeof retryPolicy.canRetry !== 'function') {
    throw new TypeError('retryPolicy.canRetry must be a function.');
  }

  if (typeof retryPolicy.nextDelay !== 'function') {
    throw new TypeError('retryPolicy.nextDelay must be a function.');
  }
}

function assertOptionalExecutionFenceGuard(executionFenceGuard) {
  if (executionFenceGuard === undefined) return;
  if (!executionFenceGuard || typeof executionFenceGuard.assertWritable !== 'function') {
    throw new TypeError('executionFenceGuard.assertWritable must be a function.');
  }
}

function assertClock(clock) {
  if (typeof clock !== 'function') {
    throw new TypeError('translationExecutionRunner clock must be a function.');
  }
}

function assertExecutionInput(execution) {
  if (!(execution instanceof TranslationExecution)) {
    throw new TypeError('translationExecutionRunner execution must be a TranslationExecution.');
  }
}

function assertPayloadInput(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('translationExecutionRunner payload is required.');
  }
}

async function notifyOptional(callback, input) {
  if (callback === undefined) {
    return;
  }

  if (typeof callback !== 'function') {
    throw new TypeError('translationExecutionRunner notification callback must be a function.');
  }

  await callback(input);
}
