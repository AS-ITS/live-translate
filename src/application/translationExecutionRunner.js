import { TranslationExecution, TranslationOutput } from '../domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { createRetryPolicy } from './translation/retryPolicy.js';

export function createTranslationExecutionRunner({
  translationRepository,
  translationExecutionProvider,
  retryPolicy = createRetryPolicy()
} = {}) {
  assertTranslationRepository(translationRepository);
  assertTranslationExecutionProvider(translationExecutionProvider);
  assertRetryPolicy(retryPolicy);

  return Object.freeze({
    async execute(input = {}) {
      const { execution, payload, repositoryResult, onTranslationOutputCreated, onTranslationExecutionUpdated } = input;

      assertExecutionInput(execution);
      assertPayloadInput(payload);

      let providerResult;
      try {
        providerResult = await executeProviderWithRetry(translationExecutionProvider, retryPolicy, payload);
      } catch (error) {
        await failExecutionAfterProviderError(translationRepository, execution, payload, onTranslationExecutionUpdated);
        throw error;
      }

      const output = new TranslationOutput({
        id: payload.outputId ?? `${execution.id}-output-0`,
        executionId: execution.id,
        sequence: payload.outputSequence ?? 0,
        translatedText: providerResult.translatedText,
        targetLanguageCode: payload.targetLanguageCode,
        createdAt: payload.outputCreatedAt ?? payload.completedAt ?? execution.startedAt
      });
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
        startedAt: execution.startedAt,
        completedAt: payload.completedAt ?? execution.startedAt
      });
      const completedRepositoryResult = await translationRepository.updateTranslationExecution(completedExecution);

      await notifyOptional(onTranslationExecutionUpdated, {
        execution: completedExecution,
        repositoryResult: completedRepositoryResult
      });

      return repositoryResult;
    }
  });
}

async function executeProviderWithRetry(translationExecutionProvider, retryPolicy, payload) {
  let attempt = 1;

  while (true) {
    try {
      return await translationExecutionProvider.execute({
        sourceText: payload.sourceText,
        sourceLanguageCode: payload.sourceLanguageCode,
        targetLanguageCode: payload.targetLanguageCode,
        providerKey: payload.providerKey
      });
    } catch (error) {
      if (!retryPolicy.canRetry(attempt)) {
        throw error;
      }

      retryPolicy.nextDelay(attempt);
      attempt += 1;
    }
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
