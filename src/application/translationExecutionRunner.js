import { TranslationExecution, TranslationOutput } from '../domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { createRetryPolicy } from './translation/retryPolicy.js';
import { createTranscriptPolishingRateLimiter } from './translation/transcriptPolishingRateLimiter.js';
import { OBSERVABILITY_METRIC_NAMES, providerStatusClass } from './observability/observabilityMetricRegistry.js';

export function createTranslationExecutionRunner({
  translationRepository,
  translationExecutionProvider,
  retryPolicy = createRetryPolicy(),
  executionFenceGuard,
  logger = (event) => console.error(JSON.stringify(event)),
  clock = () => new Date().toISOString(),
  transcriptPolishingRateLimiter = createTranscriptPolishingRateLimiter(),
  observabilityMetrics
} = {}) {
  assertTranslationRepository(translationRepository);
  assertTranslationExecutionProvider(translationExecutionProvider);
  assertRetryPolicy(retryPolicy);
  assertOptionalExecutionFenceGuard(executionFenceGuard);
  if (typeof logger !== 'function') throw new TypeError('logger must be a function.');
  assertClock(clock);
  if (!transcriptPolishingRateLimiter || typeof transcriptPolishingRateLimiter.acquire !== 'function') {
    throw new TypeError('transcriptPolishingRateLimiter.acquire must be a function.');
  }

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
          clock,
      transcriptPolishingRateLimiter,
      observabilityMetrics
        }));
      } catch (error) {
        if (error.providerExecutionError !== true) throw error;
        if (payload.operation === 'transcript_polishing') {
          logger({
            level: 'error',
            event: 'transcript_polishing_provider_failed',
            operation: payload.operation,
            ...providerDiagnosticsFor(error)
          });
        }
        if (deferProviderFailure) throw error;
        await assertWritable(executionFenceGuard, execution, executionFence);
        await failExecutionAfterProviderError(
          translationRepository,
          error.providerAttemptExecution ?? providerAttemptExecution ?? execution,
          { ...payload, providerError: error },
          onTranslationExecutionUpdated
        );
        throw error;
      }

      const output = new TranslationOutput({
        id: payload.outputId ?? `${execution.id}-output-0`,
        executionId: execution.id,
        cueId: payload.cueId,
        sequence: payload.outputSequence ?? 0,
        translatedText: providerAttemptExecution.providerResult.translatedText || providerAttemptExecution.providerResult.refinedTranslation || providerAttemptExecution.providerResult.refinedCues?.map((cue) => cue.refinedTranslation).join('\n') || ' ',
        polishedItems: providerAttemptExecution.providerResult.polishedItems,
        refinedItems: providerAttemptExecution.providerResult.refinedItems,
        refinedCues: providerAttemptExecution.providerResult.refinedCues,
        refinedSource: providerAttemptExecution.providerResult.refinedSource,
        refinedTranslation: providerAttemptExecution.providerResult.refinedTranslation,
        refinementTargets: providerAttemptExecution.providerResult.refinementTargets ?? payload.refinementTargets,
        version: providerAttemptExecution.providerResult.version ?? payload.refinementVersion ?? payload.version,
        targetLanguageCode: payload.targetLanguageCode,
        createdAt: payload.outputCreatedAt ?? payload.completedAt ?? execution.startedAt,
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        sourceText: payload.sourceText,
        sourceLanguageCode: payload.sourceLanguageCode,
        sourceLanguageMetadata: payload.sourceLanguageMetadata,
        sourceTranscriptMetadata: payload.sourceTranscriptMetadata,
        detectedSourceLanguageCode: providerAttemptExecution.providerResult.detectedSourceLanguageCode,
        providerMetadata: providerMetadataForPayload(payload),
        operation: payload.operation,
        segmentRange: payload.segmentRange,
        inputHash: payload.inputHash,
        model: payload.model,
        completedAt: payload.completedAt ?? execution.startedAt
      });
      await assertWritable(executionFenceGuard, execution, executionFence);
      const outputRepositoryResult = await translationRepository.createTranslationOutput(output);

      await notifyOptional(onTranslationOutputCreated, {
        output: outputRepositoryResult,
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

    async reconcileSucceeded({ execution, payload, executionFence, onTranslationOutputCreated } = {}) {
      assertExecutionInput(execution);
      assertPayloadInput(payload);
      if (execution.providerAttemptStatus !== 'succeeded' || execution.providerResult === null) {
        throw new Error('translation_execution_provider_result_integrity_error');
      }
      const output = new TranslationOutput({
        id: payload.outputId ?? `${execution.id}-output-0`,
        executionId: execution.id,
        cueId: payload.cueId,
        sequence: payload.outputSequence ?? 0,
        translatedText: execution.providerResult.translatedText || execution.providerResult.refinedTranslation || execution.providerResult.refinedCues?.map((cue) => cue.refinedTranslation).join('\n') || ' ',
        polishedItems: execution.providerResult.polishedItems,
        refinedItems: execution.providerResult.refinedItems,
        refinedCues: execution.providerResult.refinedCues,
        refinedSource: execution.providerResult.refinedSource,
        refinedTranslation: execution.providerResult.refinedTranslation,
        refinementTargets: execution.providerResult.refinementTargets ?? payload.refinementTargets,
        version: execution.providerResult.version ?? payload.refinementVersion ?? payload.version,
        targetLanguageCode: payload.targetLanguageCode,
        createdAt: payload.outputCreatedAt ?? payload.completedAt ?? execution.startedAt,
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        sourceText: payload.sourceText,
        sourceLanguageCode: payload.sourceLanguageCode,
        sourceLanguageMetadata: payload.sourceLanguageMetadata,
        sourceTranscriptMetadata: payload.sourceTranscriptMetadata,
        detectedSourceLanguageCode: execution.providerResult.detectedSourceLanguageCode,
        providerMetadata: providerMetadataForPayload(payload),
        operation: payload.operation,
        segmentRange: payload.segmentRange,
        inputHash: payload.inputHash,
        model: payload.model,
        completedAt: payload.completedAt ?? execution.startedAt
      });
      await assertWritable(executionFenceGuard, execution, executionFence);
      const outputRepositoryResult = await translationRepository.createTranslationOutput(output);
      await notifyOptional(onTranslationOutputCreated, {
        output: outputRepositoryResult,
        repositoryResult: outputRepositoryResult
      });
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

function providerMetadataForPayload(payload = {}) {
  const metadata = {};
  for (const field of ['model', 'operation', 'segmentRange', 'inputHash']) {
    if (payload[field] !== undefined) metadata[field] = payload[field];
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

async function executeProviderWithRetry({
  translationExecutionProvider,
  retryPolicy,
  translationRepository,
  execution,
  payload,
  executionFenceGuard,
  executionFence,
  clock,
  transcriptPolishingRateLimiter,
  observabilityMetrics
}) {
  let providerAttemptExecution = execution;
  let attempt = 1;

  while (true) {
    if (payload.operation === 'transcript_polishing') {
      await transcriptPolishingRateLimiter.acquire();
    }
    const inFlightExecution = providerAttemptExecution.markProviderAttemptInFlight(clock());
    await assertWritable(executionFenceGuard, execution, executionFence);
    await translationRepository.updateTranslationExecution(inFlightExecution);

    let providerResult;
    try {
      providerResult = await translationExecutionProvider.execute({
        sourceText: payload.sourceText,
        ...(payload.operation === undefined ? {} : { operation: payload.operation }),
        ...(payload.mode === undefined ? {} : { mode: payload.mode }),
        ...(payload.items === undefined ? {} : { items: payload.items }),
        ...(payload.polishingItems === undefined ? {} : { polishingItems: payload.polishingItems }),
        ...(payload.refinementItems === undefined ? {} : { refinementItems: payload.refinementItems }),
        ...(payload.refinementTargets === undefined ? {} : { refinementTargets: payload.refinementTargets }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
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
    failureInfoForProviderError(payload.providerError),
    payload.completedAt ?? execution.startedAt
  );
  const failedRepositoryResult = await translationRepository.updateTranslationExecution(failedExecution);

  await notifyOptional(onTranslationExecutionUpdated, {
    execution: failedExecution,
    repositoryResult: failedRepositoryResult
  });
}

function failureInfoForProviderError(error) {
  return {
    reason: 'provider_execution_failed',
    errorName: error?.name || 'Error',
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(typeof error?.providerCode === 'string' || typeof error?.providerCode === 'number' ? { providerCode: error.providerCode } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.model === 'string' ? { model: safeFailureText(error.model) } : {}),
    ...(typeof error?.providerStatus === 'string' ? { providerStatus: safeFailureText(error.providerStatus) } : {}),
    ...(typeof error?.providerMessage === 'string' ? { providerMessage: safeFailureText(error.providerMessage) } : {}),
    ...(Array.isArray(error?.providerDetails) ? { providerDetails: safeFailureDetails(error.providerDetails) } : {}),
    ...(error?.requestConfig ? { requestConfig: safeFailureDetails(error.requestConfig) } : {}),
    message: safeFailureMessage(error)
  };
}

function providerDiagnosticsFor(error) {
  return {
    errorName: error?.name || 'Error',
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(typeof error?.providerCode === 'string' || typeof error?.providerCode === 'number' ? { providerCode: error.providerCode } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.model === 'string' ? { model: safeFailureText(error.model) } : {}),
    ...(typeof error?.providerStatus === 'string' ? { providerStatus: safeFailureText(error.providerStatus) } : {}),
    ...(typeof error?.providerMessage === 'string' ? { providerMessage: safeFailureText(error.providerMessage) } : {}),
    ...(error?.requestConfig ? { requestConfig: safeFailureDetails(error.requestConfig) } : {})
  };
}

function safeFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return safeFailureText(message);
}

function safeFailureText(value) {
  return redactSensitiveText(value).slice(0, 240);
}

function safeFailureDetails(value, depth = 0) {
  if (depth > 3) {
    return '[truncated]';
  }

  if (typeof value === 'string') {
    return safeFailureText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => safeFailureDetails(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, entryValue]) => [safeFailureText(key), safeFailureDetails(entryValue, depth + 1)])
    ));
  }

  return String(value);
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/GEMINI_API_KEY/gi, '[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]')
    .replace(/AQ\.[0-9A-Za-z._-]{20,}/g, '[redacted-token]');
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
