import { formatTranscriptArticleText } from './transcript.js';

const SUCCESS_SESSION_STATUSES = new Set(['completed', 'stopped']);
const FAILURE_SESSION_STATUSES = new Set(['failed', 'expired']);

export function createTranslationCommandLifecycle({
  translationCommandApiClient,
  onError = () => {},
  now = Date.now
} = {}) {
  assertTranslationCommandApiClient(translationCommandApiClient);

  const sessions = new Map();

  return Object.freeze({
    recordSessionStarted(sessionRecord) {
      const state = stateForSession(sessions, sessionRecord);

      if (!state.startPromise) {
        state.startPromise = runCommand(onError, 'startTranslationExecution', async () => {
          const ids = commandIdsForSession(sessionRecord);
          const startedAt = timestampOrNow(sessionRecord?.startedAt, now);

          await translationCommandApiClient.createTranslationRequest({
            id: ids.requestId,
            sessionId: sessionRecord.id,
            sourceTranscriptRevisionId: ids.sourceTranscriptRevisionId,
            targetLanguageCode: targetLanguageCodeFor(sessionRecord),
            sourceTranscriptSnapshot: null,
            createdAt: timestampOrNow(sessionRecord?.createdAt, now)
          });
          const execution = await translationCommandApiClient.createTranslationExecution({
            id: ids.executionId,
            translationRequestId: ids.requestId,
            startedAt
          });
          if (executionMayStart(execution)) {
            await translationCommandApiClient.updateTranslationExecution(ids.executionId, {
              transition: 'start',
              startedAt
            });
          }

          state.executionId = ids.executionId;
        });
      }

      return state.startPromise;
    },

    recordFinalTranscriptItems(sessionRecord, transcriptItems = []) {
      const state = stateForSession(sessions, sessionRecord);
      rememberFinalTranscriptItems(state, transcriptItems);

      return state.outputChain;
    },

    recordSessionFinalized(sessionRecord) {
      const state = stateForSession(sessions, sessionRecord);

      if (state.finalizePromise) {
        return state.finalizePromise;
      }

      state.finalizePromise = state.outputChain.then(async () => {
        const startResult = await this.recordSessionStarted(sessionRecord);

        if (!startResult.ok || state.outputFailed) {
          return { ok: false };
        }

        const ids = commandIdsForSession(sessionRecord);
        const completedAt = timestampOrNow(sessionRecord?.endedAt ?? sessionRecord?.updatedAt, now);

        if (SUCCESS_SESSION_STATUSES.has(sessionRecord?.status)) {
          const outputResult = await createFinalTranslationOutput({
            state,
            sessionRecord,
            ids,
            completedAt,
            translationCommandApiClient,
            onError,
            now
          });

          if (!outputResult.ok) {
            return outputResult;
          }

          return runCommand(onError, 'completeTranslationExecution', () =>
            translationCommandApiClient.updateTranslationExecution(ids.executionId, {
              transition: 'complete',
              completedAt
            })
          );
        }

        if (FAILURE_SESSION_STATUSES.has(sessionRecord?.status)) {
          return runCommand(onError, 'failTranslationExecution', () =>
            translationCommandApiClient.updateTranslationExecution(ids.executionId, {
              transition: 'fail',
              failureInfo: {
                reason: sessionRecord?.failureReason || 'unknown_error',
                category: sessionRecord?.failureCategory || 'unknown'
              },
              completedAt
            })
          );
        }

        return { ok: true };
      });

      return state.finalizePromise;
    }
  });
}

function stateForSession(sessions, sessionRecord) {
  assertSessionRecord(sessionRecord);

  let state = sessions.get(sessionRecord.id);
  if (!state) {
    state = {
      executionId: null,
      startPromise: null,
      outputChain: Promise.resolve({ ok: true }),
      finalItemsById: new Map(),
      hasSuccessfulOutput: false,
      outputFailed: false,
      finalizePromise: null
    };
    sessions.set(sessionRecord.id, state);
  }

  return state;
}

async function runCommand(onError, operation, command) {
  try {
    return { ok: true, value: await command() };
  } catch (error) {
    onError(error, { operation });
    return { ok: false, error };
  }
}

function commandIdsForSession(sessionRecord) {
  const sessionId = sessionRecord.id;
  const targetLanguageCode = targetLanguageCodeFor(sessionRecord);

  return {
    requestId: `legacy-request:${sessionId}:${targetLanguageCode}`,
    executionId: `legacy-execution:${sessionId}:${targetLanguageCode}`,
    sourceTranscriptRevisionId: `source-revision:${sessionId}:final`
  };
}

async function createFinalTranslationOutput({
  state,
  sessionRecord,
  ids,
  completedAt,
  translationCommandApiClient,
  onError,
  now
}) {
  const translationItems = finalItemsForStream(state, 'translation');
  const translatedText = formatTranscriptArticleText(translationItems);

  if (!translatedText) {
    return { ok: true };
  }

  const sourceItems = finalItemsForStream(state, 'source');
  const sourceText = formatTranscriptArticleText(sourceItems);
  const snapshot = {
    revisionId: ids.sourceTranscriptRevisionId,
    items: sourceItems.map(copyTranscriptItem),
    ...(sourceText ? { sourceText } : {})
  };

  const result = await runCommand(onError, 'createTranslationOutput', () =>
    translationCommandApiClient.createTranslationOutput({
      id: `live-output:${sessionRecord.id}:${targetLanguageCodeFor(sessionRecord)}`,
      executionId: ids.executionId,
      sessionId: sessionRecord.id,
      requestId: ids.requestId,
      sequence: 0,
      translatedText,
      targetLanguageCode: targetLanguageCodeFor(sessionRecord),
      providerMetadata: null,
      createdAt: timestampOrNow(sessionRecord?.endedAt ?? sessionRecord?.updatedAt, now),
      completedAt,
      ...(sourceText ? { sourceText } : {}),
      sourceTranscriptMetadata: {
        revisionId: ids.sourceTranscriptRevisionId,
        snapshot
      }
    })
  );

  if (result.ok) {
    state.hasSuccessfulOutput = true;
  } else {
    state.outputFailed = true;
  }

  return result;
}

function rememberFinalTranscriptItems(state, transcriptItems = []) {
  for (const item of transcriptItems) {
    if (!isFinalTranscriptItem(item)) {
      continue;
    }

    state.finalItemsById.set(item.id, copyTranscriptItem(item));
  }
}

function finalItemsForStream(state, stream) {
  return [...state.finalItemsById.values()]
    .filter((item) => item.stream === stream)
    .sort((first, second) => sequenceValue(first) - sequenceValue(second));
}

function isFinalTranscriptItem(item) {
  return ['source', 'translation'].includes(item?.stream) &&
    item.status === 'final' &&
    typeof item.text === 'string' &&
    item.text.trim().length > 0;
}

function copyTranscriptItem(item) {
  return { ...item };
}

function sequenceValue(item) {
  return Number.isFinite(item?.sequence) ? item.sequence : 0;
}

function targetLanguageCodeFor(sessionRecord) {
  return sessionRecord?.targetLanguageCode || 'unknown-language';
}

function executionMayStart(execution) {
  return !execution?.status || execution.status === 'created' || execution.status === 'queued';
}

function timestampOrNow(timestamp, now) {
  return timestamp ?? now();
}

function assertTranslationCommandApiClient(client) {
  if (!client) {
    throw new TypeError('translationCommandApiClient is required.');
  }

  for (const method of [
    'createTranslationRequest',
    'createTranslationExecution',
    'updateTranslationExecution',
    'createTranslationOutput'
  ]) {
    if (typeof client[method] !== 'function') {
      throw new TypeError(`translationCommandApiClient.${method} must be a function.`);
    }
  }
}

function assertSessionRecord(sessionRecord) {
  if (!sessionRecord || typeof sessionRecord.id !== 'string' || sessionRecord.id.trim() === '') {
    throw new TypeError('sessionRecord.id must be a non-empty string.');
  }
}
