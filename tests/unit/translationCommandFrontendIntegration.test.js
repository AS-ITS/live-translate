import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandLifecycle } from '../../src/lib/translationCommandLifecycle.js';
import { formatTranslationCommandPersistenceError } from '../../src/lib/translationCommandError.js';

test('formats translation command persistence errors with operation, status, and safe code', () => {
  assert.equal(
    formatTranslationCommandPersistenceError(
      { status: 409, code: 'translation_execution_conflict' },
      { operation: 'createTranslationOutput' }
    ),
    '翻譯紀錄保存失敗：儲存最終翻譯結果（HTTP 409，錯誤代碼：translation_execution_conflict）。即時翻譯仍可繼續。'
  );
});

test('records session start through translation request, execution creation, and execution start update', async () => {
  const calls = [];
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient(calls),
    now: () => 1000
  });
  const record = sessionRecord();

  await lifecycle.recordSessionStarted(record);

  assert.deepEqual(calls, [
    [
      'createTranslationRequest',
      {
        id: 'legacy-request:session-1:ja',
        sessionId: 'session-1',
        sourceTranscriptRevisionId: 'source-revision:session-1:final',
        targetLanguageCode: 'ja',
        sourceTranscriptSnapshot: null,
        createdAt: 900
      }
    ],
    [
      'createTranslationExecution',
      {
        id: 'legacy-execution:session-1:ja',
        translationRequestId: 'legacy-request:session-1:ja',
        startedAt: 900
      }
    ],
    [
      'updateTranslationExecution',
      'legacy-execution:session-1:ja',
      {
        transition: 'start',
        startedAt: 900
      }
    ]
  ]);
});

test('does not restart an existing running execution after lifecycle recreation', async () => {
  const calls = [];
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient(calls, {
      createTranslationExecution(command) {
        calls.push(['createTranslationExecution', command]);
        return { ...command, status: 'running' };
      }
    }),
    now: () => 1000
  });

  await lifecycle.recordSessionStarted(sessionRecord());

  assert.equal(calls.filter((call) => call[0] === 'updateTranslationExecution').length, 0);
});

test('records article-level translation output and completes execution after dependent commands finish', async () => {
  const calls = [];
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient(calls),
    now: () => 1000
  });
  const record = sessionRecord();
  const item = translationItem();

  await lifecycle.recordSessionStarted(record);
  await lifecycle.recordFinalTranscriptItems(record, [
    sourceItem({ text: 'Hello.' }),
    item,
    translationItem({ id: 'translation-2', text: '世界。', sequence: 2, finalizedAt: 1150 })
  ]);
  await lifecycle.recordSessionFinalized({ ...record, status: 'stopped', endedAt: 1200 });

  assert.deepEqual(calls.map((call) => call[0]), [
    'createTranslationRequest',
    'createTranslationExecution',
    'updateTranslationExecution',
    'createTranslationOutput',
    'updateTranslationExecution'
  ]);
  assert.deepEqual(calls[3], [
    'createTranslationOutput',
    {
      id: 'live-output:session-1:ja',
      executionId: 'legacy-execution:session-1:ja',
      sessionId: 'session-1',
      requestId: 'legacy-request:session-1:ja',
      sequence: 0,
      translatedText: 'こんにちは世界。',
      targetLanguageCode: 'ja',
      providerMetadata: null,
      createdAt: 1200,
      completedAt: 1200,
      sourceText: 'Hello.',
      sourceTranscriptMetadata: {
        revisionId: 'source-revision:session-1:final',
        snapshot: {
          revisionId: 'source-revision:session-1:final',
          items: [sourceItem({ text: 'Hello.' })],
          sourceText: 'Hello.'
        }
      }
    }
  ]);
  assert.deepEqual(calls[4], [
    'updateTranslationExecution',
    'legacy-execution:session-1:ja',
    {
      transition: 'complete',
      completedAt: 1200
    }
  ]);
});

test('completes a stopped session without formal output when there are no final translations', async () => {
  const calls = [];
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient(calls),
    now: () => 1000
  });
  const record = sessionRecord();

  await lifecycle.recordSessionStarted(record);
  await lifecycle.recordSessionFinalized({ ...record, status: 'stopped', endedAt: 1200 });

  assert.deepEqual(calls.at(-1), [
    'updateTranslationExecution',
    'legacy-execution:session-1:ja',
    {
      transition: 'complete',
      completedAt: 1200
    }
  ]);
  assert.equal(calls.filter((call) => call[0] === 'createTranslationOutput').length, 0);
});

test('records failed terminal session as execution failure without output', async () => {
  const calls = [];
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient(calls),
    now: () => 1000
  });
  const record = sessionRecord();

  await lifecycle.recordSessionStarted(record);
  await lifecycle.recordSessionFinalized({
    ...record,
    status: 'failed',
    endedAt: 1200,
    failureReason: 'unexpected_close',
    failureCategory: 'provider'
  });

  assert.deepEqual(calls.at(-1), [
    'updateTranslationExecution',
    'legacy-execution:session-1:ja',
    {
      transition: 'fail',
      failureInfo: {
        reason: 'unexpected_close',
        category: 'provider'
      },
      completedAt: 1200
    }
  ]);
});

test('does not mutate command inputs', async () => {
  const calls = [];
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient(calls),
    now: () => 1000
  });
  const record = sessionRecord({ nested: { preserved: true } });
  const item = translationItem({ nested: { preserved: true } });
  const beforeRecord = JSON.stringify(record);
  const beforeItem = JSON.stringify(item);

  await lifecycle.recordSessionStarted(record);
  await lifecycle.recordFinalTranscriptItems(record, [item]);

  assert.equal(JSON.stringify(record), beforeRecord);
  assert.equal(JSON.stringify(item), beforeItem);
});

test('uses injected client without touching global fetch', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('global fetch should not be used');
  };

  try {
    const lifecycle = createTranslationCommandLifecycle({
      translationCommandApiClient: fakeClient(calls),
      now: () => 1000
    });

    await lifecycle.recordSessionStarted(sessionRecord());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 3);
});

test('client rejection is reported and resolved without skipping caller cleanup', async () => {
  const errors = [];
  let cleanupCalled = false;
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient([], {
      createTranslationRequest() {
        return Promise.reject(new Error('persistence unavailable'));
      }
    }),
    onError(error, context) {
      errors.push([error.message, context.operation]);
    },
    now: () => 1000
  });

  await lifecycle.recordSessionStarted(sessionRecord());
  cleanupCalled = true;

  assert.equal(cleanupCalled, true);
  assert.deepEqual(errors, [['persistence unavailable', 'startTranslationExecution']]);
});

test('does not duplicate lifecycle operations', async () => {
  const calls = [];
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient(calls),
    now: () => 1000
  });
  const record = sessionRecord();
  const item = translationItem();
  const finalized = { ...record, status: 'stopped', endedAt: 1200 };

  await lifecycle.recordSessionStarted(record);
  await lifecycle.recordSessionStarted(record);
  await lifecycle.recordFinalTranscriptItems(record, [item]);
  await lifecycle.recordFinalTranscriptItems(record, [item]);
  await lifecycle.recordSessionFinalized(finalized);
  await lifecycle.recordSessionFinalized(finalized);

  assert.equal(calls.filter((call) => call[0] === 'createTranslationRequest').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'createTranslationExecution').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'createTranslationOutput').length, 1);
  assert.equal(
    calls.filter((call) => call[0] === 'updateTranslationExecution' && call[2].transition === 'start').length,
    1
  );
  assert.equal(
    calls.filter((call) => call[0] === 'updateTranslationExecution' && call[2].transition === 'complete').length,
    1
  );
});

test('does not create a formal output for partial-only transcript items', async () => {
  const calls = [];
  const lifecycle = createTranslationCommandLifecycle({
    translationCommandApiClient: fakeClient(calls),
    now: () => 1000
  });
  const record = sessionRecord();

  await lifecycle.recordFinalTranscriptItems(record, [
    { ...translationItem(), status: 'partial' },
    { ...sourceItem(), status: 'partial' }
  ]);
  await lifecycle.recordSessionFinalized({ ...record, status: 'completed', endedAt: 1200 });

  assert.equal(calls.filter((call) => call[0] === 'createTranslationOutput').length, 0);
  assert.equal(
    calls.filter((call) => call[0] === 'updateTranslationExecution' && call[2].transition === 'complete').length,
    1
  );
});

function fakeClient(calls, overrides = {}) {
  return {
    createTranslationRequest:
      overrides.createTranslationRequest ||
      async function createTranslationRequest(command) {
        calls.push(['createTranslationRequest', command]);
        return command;
      },
    createTranslationExecution:
      overrides.createTranslationExecution ||
      async function createTranslationExecution(command) {
        calls.push(['createTranslationExecution', command]);
        return command;
      },
    updateTranslationExecution:
      overrides.updateTranslationExecution ||
      async function updateTranslationExecution(executionId, command) {
        calls.push(['updateTranslationExecution', executionId, command]);
        return { executionId, ...command };
      },
    createTranslationOutput:
      overrides.createTranslationOutput ||
      async function createTranslationOutput(command) {
        calls.push(['createTranslationOutput', command]);
        return command;
      }
  };
}

function sessionRecord(overrides = {}) {
  return {
    id: 'session-1',
    startedAt: 900,
    createdAt: 900,
    targetLanguageCode: 'ja',
    targetLanguageLabel: 'Japanese',
    ...overrides
  };
}

function translationItem(overrides = {}) {
  return {
    id: 'translation-1',
    stream: 'translation',
    status: 'final',
    text: 'こんにちは',
    sequence: 1,
    startedAt: 1000,
    finalizedAt: 1100,
    ...overrides
  };
}

function sourceItem(overrides = {}) {
  return {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'Hello.',
    sequence: 0,
    startedAt: 900,
    finalizedAt: 1000,
    ...overrides
  };
}
