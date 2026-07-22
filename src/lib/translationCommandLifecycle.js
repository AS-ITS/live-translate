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
          await translationCommandApiClient.createTranslationExecution({
            id: ids.executionId,
            translationRequestId: ids.requestId,
            startedAt
          });
          await translationCommandApiClient.updateTranslationExecution(ids.executionId, {
            transition: 'start',
            startedAt
          });

          state.executionId = ids.executionId;
        });
      }

      return state.startPromise;
    },

    recordFinalTranscriptItems(sessionRecord, transcriptItems = []) {
      const state = stateForSession(sessions, sessionRecord);
      const translationItems = transcriptItems.filter(isPersistableTranslationItem);

      if (translationItems.length === 0) {
        return state.outputChain;
      }

      state.outputChain = state.outputChain.then(async () => {
        const startResult = await this.recordSessionStarted(sessionRecord);

        if (!startResult.ok) {
          return startResult;
        }

        for (const item of translationItems) {
          const outputId = outputIdForItem(sessionRecord, item);

          if (state.outputIds.has(outputId)) {
            continue;
          }

          state.outputIds.add(outputId);
          const result = await runCommand(onError, 'createTranslationOutput', () =>
            translationCommandApiClient.createTranslationOutput({
              id: outputId,
              executionId: state.executionId,
              sequence: item.sequence,
              translatedText: item.text,
              targetLanguageCode: targetLanguageCodeFor(sessionRecord),
              providerMetadata: null,
              createdAt: timestampOrNow(item.finalizedAt, now)
            })
          );

          if (result.ok) {
            state.hasSuccessfulOutput = true;
          } else {
            state.outputFailed = true;
          }
        }

        return { ok: !state.outputFailed };
      });

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
      outputIds: new Set(),
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

function outputIdForItem(sessionRecord, item) {
  return `legacy-output:${sessionRecord.id}:${targetLanguageCodeFor(sessionRecord)}:${item.id}`;
}

function isPersistableTranslationItem(item) {
  return item?.stream === 'translation' && item.status === 'final' && typeof item.text === 'string' && item.text.length > 0;
}

function targetLanguageCodeFor(sessionRecord) {
  return sessionRecord?.targetLanguageCode || 'unknown-language';
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
