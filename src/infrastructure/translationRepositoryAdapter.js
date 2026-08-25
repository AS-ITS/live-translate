import { TranslationExecution, TranslationOutput, TranslationRequest } from '../domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { safeFailureInfo } from '../readModels/translationReadModels.js';

const REQUIRED_SESSION_REPOSITORY_METHODS = Object.freeze(['getSessionRecord', 'updateSessionRecord', 'listSessionRecords']);
const EMPTY_TRANSLATION_COMMAND_STATE = Object.freeze({
  requests: Object.freeze([]),
  executions: Object.freeze([]),
  outputs: Object.freeze([])
});

export function createTranslationRepositoryAdapter({ sessionRepository, executionEventBroadcaster } = {}) {
  assertSessionRepository(sessionRepository);

  const repository = {
    createTranslationRequest(request) {
      const translationRequest = new TranslationRequest(request);
      const detail = sessionRepository.getSessionRecord(translationRequest.sessionId);

      return mapMaybePromise(detail, (sessionDetail) => {
        const sessionRecord = requireSessionDetail(sessionDetail, translationRequest.sessionId).sessionRecord;
        const state = translationCommandStateFor(sessionRecord);

        const existingRequest = state.requests.find((storedRequest) => storedRequest.id === translationRequest.id);
        if (existingRequest) {
          if (!sameTranslationRequestIdentity(existingRequest, translationRequest)) {
            throw new Error(`TranslationRequest already exists: ${translationRequest.id}`);
          }
          return toTranslationRequest(existingRequest);
        }

        return saveTranslationState(sessionRepository, sessionRecord.id, {
          ...state,
          requests: [...state.requests, serializeTranslationRequest(translationRequest)]
        }).thenResult(() => toTranslationRequest(translationRequest));
      });
    },

    getTranslationRequest(requestId) {
      return mapMaybePromise(findSessionRecord(sessionRepository, (state) => findById(state.requests, requestId)), (result) =>
        result ? toTranslationRequest(result.entity) : null
      );
    },

    findRequestById(requestId) {
      return repository.getTranslationRequest(requestId);
    },

    updateTranslationRequest(request) {
      const translationRequest = new TranslationRequest(request);

      return mapMaybePromise(
        findSessionRecord(sessionRepository, (state) => findById(state.requests, translationRequest.id)),
        (result) => {
          if (!result) {
            return null;
          }

          if (result.entity.sessionId !== translationRequest.sessionId) {
            throw new Error(`TranslationRequest ${translationRequest.id} cannot change sessionId`);
          }

          const state = translationCommandStateFor(result.sessionRecord);
          const index = state.requests.findIndex((storedRequest) => storedRequest.id === translationRequest.id);
          const requests = replaceAt(state.requests, index, serializeTranslationRequest(translationRequest));

          return saveTranslationState(sessionRepository, result.sessionRecord.id, { ...state, requests }).thenResult(() =>
            toTranslationRequest(translationRequest)
          );
        }
      );
    },

    listTranslationRequestsBySession(sessionId) {
      assertRequiredString(sessionId, 'sessionId');

      return mapMaybePromise(sessionRepository.getSessionRecord(sessionId), (sessionDetail) => {
        if (!sessionDetail?.sessionRecord) {
          return [];
        }

        return translationCommandStateFor(sessionDetail.sessionRecord).requests
          .filter((request) => request.sessionId === sessionId)
          .map(toTranslationRequest);
      });
    },

    createTranslationExecution(execution) {
      const translationExecution = new TranslationExecution(execution);

      return mapMaybePromise(
        findSessionRecord(sessionRepository, (state) =>
          state.requests.some((request) => request.id === translationExecution.translationRequestId)
        ),
        (result) => {
          if (!result) {
            throw new Error(`TranslationRequest ${translationExecution.translationRequestId} was not found`);
          }

          const state = translationCommandStateFor(result.sessionRecord);

          const existingExecution = state.executions.find((storedExecution) => storedExecution.id === translationExecution.id);
          if (existingExecution) {
            if (existingExecution.translationRequestId !== translationExecution.translationRequestId) {
              throw new Error(`TranslationExecution already exists: ${translationExecution.id}`);
            }
            const request = state.requests.find((item) => item.id === translationExecution.translationRequestId);
            const persistedExecution = toTranslationExecution(existingExecution);
            publishExecutionEvent(executionEventBroadcaster, request, persistedExecution);
            return persistedExecution;
          }

          return saveTranslationState(sessionRepository, result.sessionRecord.id, {
            ...state,
            executions: [...state.executions, serializeTranslationExecution(translationExecution)]
          }).thenResult(() => {
            const persistedExecution = toTranslationExecution(translationExecution);
            publishExecutionEvent(executionEventBroadcaster, state.requests.find((item) => item.id === translationExecution.translationRequestId), persistedExecution);
            return persistedExecution;
          });
        }
      );
    },

    getTranslationExecution(executionId) {
      return mapMaybePromise(findSessionRecord(sessionRepository, (state) => findById(state.executions, executionId)), (result) =>
        result ? toTranslationExecution(result.entity) : null
      );
    },

    findExecutionById(executionId) {
      return repository.getTranslationExecution(executionId);
    },

    updateTranslationExecution(execution) {
      const translationExecution = new TranslationExecution(execution);

      return mapMaybePromise(
        findSessionRecord(sessionRepository, (state) => findById(state.executions, translationExecution.id)),
        (result) => {
          if (!result) {
            return null;
          }

          if (result.entity.translationRequestId !== translationExecution.translationRequestId) {
            throw new Error(`TranslationExecution ${translationExecution.id} cannot change translationRequestId`);
          }

          const state = translationCommandStateFor(result.sessionRecord);
          const index = state.executions.findIndex((storedExecution) => storedExecution.id === translationExecution.id);
          const executions = replaceAt(state.executions, index, serializeTranslationExecution(translationExecution));

          return saveTranslationState(sessionRepository, result.sessionRecord.id, { ...state, executions }).thenResult(() => {
            const request = state.requests.find((item) => item.id === translationExecution.translationRequestId);
            const persistedExecution = toTranslationExecution(translationExecution);
            publishExecutionEvent(executionEventBroadcaster, request, persistedExecution);
            return persistedExecution;
          });
        }
      );
    },

    listTranslationExecutionsByRequest(requestId) {
      assertRequiredString(requestId, 'requestId');

      return mapMaybePromise(
        findSessionRecord(sessionRepository, (state) => state.requests.some((request) => request.id === requestId)),
        (result) => {
          if (!result) {
            return [];
          }

          return translationCommandStateFor(result.sessionRecord).executions
            .filter((execution) => execution.translationRequestId === requestId)
            .map(toTranslationExecution);
        }
      );
    },

    createTranslationOutput(output) {
      const translationOutput = new TranslationOutput(output);

      return mapMaybePromise(
        findSessionRecord(sessionRepository, (state) =>
          state.executions.some((execution) => execution.id === translationOutput.executionId)
        ),
        (result) => {
          if (!result) {
            throw new Error(`TranslationExecution ${translationOutput.executionId} was not found`);
          }

          const state = translationCommandStateFor(result.sessionRecord);

          const existingOutput = state.outputs.find((storedOutput) => storedOutput.executionId === translationOutput.executionId);
          if (existingOutput !== undefined) {
            return toTranslationOutput(existingOutput);
          }

          if (state.outputs.some((storedOutput) => storedOutput.id === translationOutput.id)) {
            throw new Error(`TranslationOutput already exists: ${translationOutput.id}`);
          }

          const execution = state.executions.find((item) => item.id === translationOutput.executionId);
          const request = state.requests.find((item) => item.id === execution?.translationRequestId);
          if (!execution || !request) throw new Error(`TranslationExecution ${translationOutput.executionId} was not found`);
          if (
            (translationOutput.sessionId !== undefined || translationOutput.requestId !== undefined) &&
            translationOutput.targetLanguageCode !== request.targetLanguageCode
          ) {
            throw new Error('TranslationOutput targetLanguageCode must match TranslationRequest');
          }
          const persistedOutput = enrichOutputForPersistence(translationOutput, request, state.outputs);

          return saveTranslationState(sessionRepository, result.sessionRecord.id, {
            ...state,
            outputs: [...state.outputs, serializeTranslationOutput(persistedOutput)]
          }).thenResult(() => toTranslationOutput(persistedOutput));
        }
      );
    },

    listTranslationOutputsByExecution(executionId) {
      return mapMaybePromise(
        findSessionRecord(sessionRepository, (state) => state.outputs.some((output) => output.executionId === executionId)),
        (result) => {
          if (!result) {
            return [];
          }

          return translationCommandStateFor(result.sessionRecord).outputs
            .filter((output) => output.executionId === executionId)
            .sort(compareTranslationOutputs)
            .map(toTranslationOutput);
        }
      );
    },

    listTranslationOutputsBySession(sessionId) {
      assertRequiredString(sessionId, 'sessionId');

      return mapMaybePromise(sessionRepository.getSessionRecord(sessionId), (sessionDetail) => {
        if (!sessionDetail?.sessionRecord) {
          return [];
        }

        return sortedTranslationOutputs(translationCommandStateFor(sessionDetail.sessionRecord).outputs);
      });
    },

    listTranslationOutputsByRequest(requestId) {
      assertRequiredString(requestId, 'requestId');

      return mapMaybePromise(
        findSessionRecord(sessionRepository, (state) => state.requests.some((request) => request.id === requestId)),
        (result) => {
          if (!result) {
            return [];
          }

          const state = translationCommandStateFor(result.sessionRecord);
          const executionIds = new Set(
            state.executions
              .filter((execution) => execution.translationRequestId === requestId)
              .map((execution) => execution.id)
          );

          return sortedTranslationOutputs(
            state.outputs.filter((output) => output.requestId === requestId || executionIds.has(output.executionId))
          );
        }
      );
    },

    getTranslationOutput(outputId) {
      return mapMaybePromise(findSessionRecord(sessionRepository, (state) => findById(state.outputs, outputId)), (result) =>
        result ? toTranslationOutput(result.entity) : null
      );
    },

    deleteTranslationOutput(outputId) {
      assertRequiredString(outputId, 'outputId');

      return mapMaybePromise(findSessionRecord(sessionRepository, (state) => findById(state.outputs, outputId)), (result) => {
        if (!result) {
          return false;
        }

        const state = translationCommandStateFor(result.sessionRecord);
        const nextOutputs = state.outputs.filter((output) => output.id !== outputId);

        if (nextOutputs.length === state.outputs.length) {
          return false;
        }

        return saveTranslationState(sessionRepository, result.sessionRecord.id, { ...state, outputs: nextOutputs }).thenResult(() => true);
      });
    }
  };

  return Object.freeze(Object.fromEntries(TRANSLATION_REPOSITORY_METHODS.map((method) => [method, repository[method]])));
}

function assertSessionRepository(sessionRepository) {
  if (!sessionRepository) {
    throw new TypeError('sessionRepository is required.');
  }

  for (const method of REQUIRED_SESSION_REPOSITORY_METHODS) {
    if (typeof sessionRepository[method] !== 'function') {
      throw new TypeError(`sessionRepository.${method} must be a function.`);
    }
  }
}

function requireSessionDetail(sessionDetail, sessionId) {
  if (!sessionDetail?.sessionRecord) {
    throw new Error(`Session record not found: ${sessionId}`);
  }

  return sessionDetail;
}

function saveTranslationState(sessionRepository, sessionId, translationCommandState) {
  const result = sessionRepository.updateSessionRecord(sessionId, {
    translationCommandState: clonePlain(translationCommandState)
  });

  return {
    thenResult(mapper) {
      return mapMaybePromise(result, mapper);
    }
  };
}

function publishExecutionEvent(broadcaster, request, execution) {
  if (!broadcaster || typeof broadcaster.publish !== 'function' || !request?.sessionId) return;
  broadcaster.publish(request.sessionId, {
    id: execution.id,
    requestId: request.id,
    translationRequestId: request.id,
    status: execution.status,
    targetLanguageCode: request.targetLanguageCode,
    startedAt: execution.startedAt ?? null,
    createdAt: request.createdAt ?? null,
    providerAttemptStatus: execution.providerAttemptStatus ?? 'not_started',
    providerAttemptedAt: execution.providerAttemptedAt ?? null,
    providerCompletedAt: execution.providerCompletedAt ?? null,
    completedAt: execution.completedAt ?? null,
    failureInfo: safeFailureInfo(execution.failureInfo)
  });
}

function findSessionRecord(sessionRepository, predicate) {
  const records = sessionRepository.listSessionRecords();

  return mapMaybePromise(records, (sessionRecords) => {
    for (const sessionRecord of sessionRecords || []) {
      const state = translationCommandStateFor(sessionRecord);
      const entity = predicate(state);

      if (entity) {
        return { sessionRecord, entity };
      }
    }

    return null;
  });
}

function translationCommandStateFor(sessionRecord = {}) {
  const state = sessionRecord.translationCommandState || EMPTY_TRANSLATION_COMMAND_STATE;

  return {
    requests: Array.isArray(state.requests) ? state.requests.map(clonePlain) : [],
    executions: Array.isArray(state.executions) ? state.executions.map(clonePlain) : [],
    outputs: Array.isArray(state.outputs) ? state.outputs.map(clonePlain) : []
  };
}

function findById(items, id) {
  return items.find((item) => item.id === id) || null;
}

function replaceAt(items, index, value) {
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function serializeTranslationRequest(request) {
  return {
    id: request.id,
    sessionId: request.sessionId,
    sourceTranscriptRevisionId: request.sourceTranscriptRevisionId,
    sourceTranscriptSnapshot: clonePlain(request.sourceTranscriptSnapshot),
    targetLanguageCode: request.targetLanguageCode,
    ...(request.operation === undefined ? {} : { operation: request.operation }),
    ...(request.segmentRange === undefined ? {} : { segmentRange: clonePlain(request.segmentRange) }),
    ...(request.inputHash === undefined ? {} : { inputHash: request.inputHash }),
    ...(request.model === undefined ? {} : { model: request.model }),
    createdAt: request.createdAt
  };
}

function sameTranslationRequestIdentity(existingRequest, nextRequest) {
  return JSON.stringify({
    sessionId: existingRequest.sessionId,
    sourceTranscriptRevisionId: existingRequest.sourceTranscriptRevisionId,
    sourceTranscriptSnapshot: existingRequest.sourceTranscriptSnapshot ?? null,
    targetLanguageCode: existingRequest.targetLanguageCode,
    operation: existingRequest.operation ?? null,
    segmentRange: existingRequest.segmentRange ?? null,
    inputHash: existingRequest.inputHash ?? null,
    model: existingRequest.model ?? null
  }) === JSON.stringify({
    sessionId: nextRequest.sessionId,
    sourceTranscriptRevisionId: nextRequest.sourceTranscriptRevisionId,
    sourceTranscriptSnapshot: nextRequest.sourceTranscriptSnapshot ?? null,
    targetLanguageCode: nextRequest.targetLanguageCode,
    operation: nextRequest.operation ?? null,
    segmentRange: nextRequest.segmentRange ?? null,
    inputHash: nextRequest.inputHash ?? null,
    model: nextRequest.model ?? null
  });
}

function serializeTranslationExecution(execution) {
  return {
    id: execution.id,
    translationRequestId: execution.translationRequestId,
    status: execution.status,
    ...(execution.providerKey === undefined ? {} : { providerKey: execution.providerKey }),
    providerIdempotencyKey: execution.providerIdempotencyKey,
    providerAttemptStatus: execution.providerAttemptStatus,
    providerAttemptedAt: execution.providerAttemptedAt,
    providerCompletedAt: execution.providerCompletedAt,
    providerResult: clonePlain(execution.providerResult),
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    failureInfo: clonePlain(execution.failureInfo)
  };
}

function serializeTranslationOutput(output) {
  return {
    id: output.id,
    executionId: output.executionId,
    sequence: output.sequence,
    translatedText: output.translatedText,
    ...(output.polishedItems === undefined ? {} : { polishedItems: clonePlain(output.polishedItems) }),
    ...(output.refinedItems === undefined ? {} : { refinedItems: clonePlain(output.refinedItems) }),
    ...(output.refinedCues === undefined ? {} : { refinedCues: clonePlain(output.refinedCues) }),
    ...(output.refinementTargets === undefined ? {} : { refinementTargets: clonePlain(output.refinementTargets) }),
    ...(output.refinedSource === undefined ? {} : { refinedSource: output.refinedSource }),
    ...(output.refinedTranslation === undefined ? {} : { refinedTranslation: output.refinedTranslation }),
    targetLanguageCode: output.targetLanguageCode,
    ...(output.operation === undefined ? {} : { operation: output.operation }),
    ...(output.segmentRange === undefined ? {} : { segmentRange: clonePlain(output.segmentRange) }),
    ...(output.inputHash === undefined ? {} : { inputHash: output.inputHash }),
    ...(output.model === undefined ? {} : { model: output.model }),
    providerMetadata: clonePlain(output.providerMetadata),
    createdAt: output.createdAt,
    ...(output.sessionId === undefined ? {} : { sessionId: output.sessionId }),
    ...(output.requestId === undefined ? {} : { requestId: output.requestId }),
    ...(output.sourceText === undefined ? {} : { sourceText: output.sourceText }),
    ...(output.sourceLanguageCode === undefined ? {} : { sourceLanguageCode: output.sourceLanguageCode }),
    sourceLanguageMetadata: clonePlain(output.sourceLanguageMetadata),
    sourceTranscriptMetadata: clonePlain(output.sourceTranscriptMetadata),
    ...(output.detectedSourceLanguageCode === undefined ? {} : { detectedSourceLanguageCode: output.detectedSourceLanguageCode }),
    ...(output.version === undefined ? {} : { version: output.version }),
    completedAt: output.completedAt
  };
}

function enrichOutputForPersistence(output, request, existingOutputs) {
  // Preserve legacy direct command compatibility. Runner-backed formal outputs
  // always provide canonical request/session context.
  if (output.sessionId === undefined && output.requestId === undefined) return output;
  const snapshot = request.sourceTranscriptSnapshot ?? {};
  const version = output.version ?? nextOutputVersion(existingOutputs, request.sessionId, request.targetLanguageCode);
  return new TranslationOutput({
    id: output.id,
    executionId: output.executionId,
    sequence: output.sequence,
    translatedText: output.translatedText,
    polishedItems: output.polishedItems,
    refinedItems: output.refinedItems,
    refinedCues: output.refinedCues,
    refinementTargets: output.refinementTargets,
    refinedSource: output.refinedSource,
    refinedTranslation: output.refinedTranslation,
    targetLanguageCode: request.targetLanguageCode,
    providerMetadata: output.providerMetadata,
    createdAt: output.createdAt,
    completedAt: output.completedAt,
    sessionId: request.sessionId,
    requestId: request.id,
    sourceText: output.sourceText ?? sourceTextFromSnapshot(snapshot),
    sourceLanguageCode: output.sourceLanguageCode ?? snapshot.sourceLanguageCode,
    sourceLanguageMetadata: output.sourceLanguageMetadata ?? snapshot.sourceLanguageDetection,
    sourceTranscriptMetadata: output.sourceTranscriptMetadata ?? { revisionId: request.sourceTranscriptRevisionId, snapshot },
    detectedSourceLanguageCode: output.detectedSourceLanguageCode ?? output.providerMetadata?.detectedSourceLanguageCode,
    version
    , operation: output.operation ?? request.operation
    , segmentRange: output.segmentRange ?? request.segmentRange
    , inputHash: output.inputHash ?? request.inputHash
    , model: output.model ?? request.model
  });
}

function nextOutputVersion(outputs, sessionId, targetLanguageCode) {
  return outputs.filter((output) => output.sessionId === sessionId && output.targetLanguageCode === targetLanguageCode)
    .reduce((maximum, output) => Math.max(maximum, Number.isInteger(output.version) ? output.version : 0), 0) + 1;
}

function sourceTextFromSnapshot(snapshot) {
  if (typeof snapshot.sourceText === 'string') return snapshot.sourceText;
  if (typeof snapshot.text === 'string') return snapshot.text;
  return Array.isArray(snapshot.items) ? snapshot.items.map((item) => item?.text).filter((text) => typeof text === 'string' && text.length > 0).join('\n') : undefined;
}

function toTranslationRequest(value) {
  return new TranslationRequest(value);
}

function toTranslationExecution(value) {
  return new TranslationExecution(value);
}

function toTranslationOutput(value) {
  return new TranslationOutput(value);
}

function compareTranslationOutputs(first, second) {
  const firstSequence = Number.isInteger(first.sequence) ? first.sequence : Number.MAX_SAFE_INTEGER;
  const secondSequence = Number.isInteger(second.sequence) ? second.sequence : Number.MAX_SAFE_INTEGER;

  if (firstSequence !== secondSequence) {
    return firstSequence - secondSequence;
  }

  const firstCreatedAt = String(first.createdAt ?? '');
  const secondCreatedAt = String(second.createdAt ?? '');

  if (firstCreatedAt !== secondCreatedAt) {
    return firstCreatedAt.localeCompare(secondCreatedAt);
  }

  return String(first.id).localeCompare(String(second.id));
}

function sortedTranslationOutputs(outputs) {
  return [...outputs].sort(compareTranslationOutputs).map(toTranslationOutput);
}

function assertRequiredString(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`);
  }

  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be empty`);
  }

  return value;
}

function mapMaybePromise(value, mapper) {
  if (isPromiseLike(value)) {
    return value.then(mapper);
  }

  return mapper(value);
}

function isPromiseLike(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

function clonePlain(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(clonePlain);
  }

  const copy = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    copy[key] = clonePlain(nestedValue);
  }
  return copy;
}
