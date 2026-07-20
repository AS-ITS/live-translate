import { TranslationExecution, TranslationOutput, TranslationRequest } from '../domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';

const REQUIRED_SESSION_REPOSITORY_METHODS = Object.freeze(['getSessionRecord', 'updateSessionRecord', 'listSessionRecords']);
const EMPTY_TRANSLATION_COMMAND_STATE = Object.freeze({
  requests: Object.freeze([]),
  executions: Object.freeze([]),
  outputs: Object.freeze([])
});

export function createTranslationRepositoryAdapter({ sessionRepository } = {}) {
  assertSessionRepository(sessionRepository);

  const repository = {
    createTranslationRequest(request) {
      const translationRequest = new TranslationRequest(request);
      const detail = sessionRepository.getSessionRecord(translationRequest.sessionId);

      return mapMaybePromise(detail, (sessionDetail) => {
        const sessionRecord = requireSessionDetail(sessionDetail, translationRequest.sessionId).sessionRecord;
        const state = translationCommandStateFor(sessionRecord);

        if (state.requests.some((storedRequest) => storedRequest.id === translationRequest.id)) {
          throw new Error(`TranslationRequest already exists: ${translationRequest.id}`);
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

          if (state.executions.some((storedExecution) => storedExecution.id === translationExecution.id)) {
            throw new Error(`TranslationExecution already exists: ${translationExecution.id}`);
          }

          return saveTranslationState(sessionRepository, result.sessionRecord.id, {
            ...state,
            executions: [...state.executions, serializeTranslationExecution(translationExecution)]
          }).thenResult(() => toTranslationExecution(translationExecution));
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

          return saveTranslationState(sessionRepository, result.sessionRecord.id, { ...state, executions }).thenResult(() =>
            toTranslationExecution(translationExecution)
          );
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

          return saveTranslationState(sessionRepository, result.sessionRecord.id, {
            ...state,
            outputs: [...state.outputs, serializeTranslationOutput(translationOutput)]
          }).thenResult(() => toTranslationOutput(translationOutput));
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
    createdAt: request.createdAt
  };
}

function serializeTranslationExecution(execution) {
  return {
    id: execution.id,
    translationRequestId: execution.translationRequestId,
    status: execution.status,
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
    targetLanguageCode: output.targetLanguageCode,
    providerMetadata: clonePlain(output.providerMetadata),
    createdAt: output.createdAt
  };
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
