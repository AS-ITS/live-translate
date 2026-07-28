import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSessionRecord,
  createTranscriptItemForSession,
  finalizeSessionRecord,
  isTerminalSessionStatus,
  summarizeTranscriptItems,
  updateSessionRecord
} from '../../src/lib/sessionRecords.js';

test('create active session record', () => {
  const record = createSessionRecord(
    {
      startedAt: 1000,
      targetLanguageCode: 'zh-Hant',
      targetLanguageLabel: 'Traditional Chinese',
      sourceLanguageCode: 'zh-Hant',
      selectedInputDeviceId: 'device-1',
      inputDeviceLabelSnapshot: 'Studio Mic'
    },
    { now: 1100, idFactory: () => 'session-1' }
  );

  assert.deepEqual(record, {
    id: 'session-1',
    startedAt: 1000,
    endedAt: null,
    durationMs: null,
    targetLanguageCode: 'zh-Hant',
    targetLanguageLabel: 'Traditional Chinese',
    sourceLanguageCode: 'zh-Hant',
    meetingId: null,
    segmentId: null,
    status: 'active',
    failureReason: null,
    failureCategory: null,
    lastLifecycleState: 'listening',
    selectedInputDeviceId: 'device-1',
    inputDeviceLabelSnapshot: 'Studio Mic',
    transcriptSummary: {
      totalItems: 0,
      sourceFinalCount: 0,
      translationFinalCount: 0,
      sourcePartialCount: 0,
      translationPartialCount: 0,
      hasTranscript: false
    },
    createdAt: 1100,
    updatedAt: 1100
  });
});

test('create active session record can reference a meeting segment', () => {
  const record = createSessionRecord(
    {
      id: 'session-1',
      startedAt: 1000,
      targetLanguageCode: 'en',
      meetingId: 'meeting-1',
      segmentId: 'segment-1'
    },
    { now: 1100 }
  );

  assert.equal(record.meetingId, 'meeting-1');
  assert.equal(record.segmentId, 'segment-1');
});

test('injected idFactory is deterministic', () => {
  const record = createSessionRecord(
    {
      startedAt: 1000,
      targetLanguageCode: 'ja'
    },
    { now: 1000, idFactory: () => 'fixed-session-id' }
  );

  assert.equal(record.id, 'fixed-session-id');
});

test('update does not mutate original', () => {
  const original = createSessionRecord(
    {
      id: 'session-1',
      startedAt: 1000,
      targetLanguageCode: 'en'
    },
    { now: 1000 }
  );
  const updated = updateSessionRecord(
    original,
    {
      lastLifecycleState: 'reconnecting',
      failureReason: 'unexpected_close'
    },
    { now: 1200 }
  );

  assert.notEqual(updated, original);
  assert.equal(original.lastLifecycleState, 'listening');
  assert.equal(original.failureReason, null);
  assert.equal(original.updatedAt, 1000);
  assert.equal(updated.lastLifecycleState, 'reconnecting');
  assert.equal(updated.failureReason, 'unexpected_close');
  assert.equal(updated.updatedAt, 1200);
});

test('finalize stopped session', () => {
  const record = createSessionRecord(
    {
      id: 'session-1',
      startedAt: 1000,
      targetLanguageCode: 'en'
    },
    { now: 1000 }
  );
  const finalized = finalizeSessionRecord(
    record,
    {
      status: 'stopped',
      failureReason: 'user_stop'
    },
    { now: 2500 }
  );

  assert.equal(finalized.status, 'stopped');
  assert.equal(finalized.endedAt, 2500);
  assert.equal(finalized.durationMs, 1500);
  assert.equal(finalized.failureReason, 'user_stop');
  assert.equal(finalized.failureCategory, null);
  assert.equal(record.status, 'active');
  assert.equal(record.endedAt, null);
});

test('finalize failed session with failure reason/category', () => {
  const record = createSessionRecord(
    {
      id: 'session-1',
      startedAt: 1000,
      targetLanguageCode: 'en'
    },
    { now: 1000 }
  );
  const finalized = finalizeSessionRecord(
    record,
    {
      status: 'failed',
      failureReason: 'unexpected_close',
      failureCategory: 'provider'
    },
    { now: 1800 }
  );

  assert.equal(finalized.status, 'failed');
  assert.equal(finalized.failureReason, 'unexpected_close');
  assert.equal(finalized.failureCategory, 'provider');
  assert.equal(finalized.durationMs, 800);
});

test('finalize expired session', () => {
  const record = createSessionRecord(
    {
      id: 'session-1',
      startedAt: 1000,
      targetLanguageCode: 'en'
    },
    { now: 1000 }
  );
  const finalized = finalizeSessionRecord(
    record,
    {
      status: 'expired',
      failureReason: 'token_expired',
      failureCategory: 'token'
    },
    { now: 3000 }
  );

  assert.equal(finalized.status, 'expired');
  assert.equal(finalized.failureReason, 'token_expired');
  assert.equal(finalized.failureCategory, 'token');
  assert.equal(finalized.durationMs, 2000);
});

test('durationMs calculated from ISO timestamps', () => {
  const record = createSessionRecord(
    {
      id: 'session-1',
      startedAt: '2026-07-09T10:00:00.000Z',
      targetLanguageCode: 'en'
    },
    { now: '2026-07-09T10:00:00.000Z' }
  );
  const finalized = finalizeSessionRecord(record, { status: 'completed' }, { now: '2026-07-09T10:00:03.500Z' });

  assert.equal(finalized.durationMs, 3500);
});

test('terminal status detection', () => {
  assert.equal(isTerminalSessionStatus('active'), false);
  assert.equal(isTerminalSessionStatus('completed'), true);
  assert.equal(isTerminalSessionStatus('stopped'), true);
  assert.equal(isTerminalSessionStatus('failed'), true);
  assert.equal(isTerminalSessionStatus('expired'), true);
  assert.equal(isTerminalSessionStatus('idle'), false);
});

test('cannot finalize already terminal record', () => {
  const record = finalizeSessionRecord(
    createSessionRecord(
      {
        id: 'session-1',
        startedAt: 1000,
        targetLanguageCode: 'en'
      },
      { now: 1000 }
    ),
    { status: 'completed' },
    { now: 1200 }
  );

  assert.throws(() => finalizeSessionRecord(record, { status: 'failed' }, { now: 1300 }), /Cannot finalize/);
});

test('cannot finalize non-active record', () => {
  const record = updateSessionRecord(
    createSessionRecord(
      {
        id: 'session-1',
        startedAt: 1000,
        targetLanguageCode: 'en'
      },
      { now: 1000 }
    ),
    { status: 'reconnecting' },
    { now: 1100 }
  );

  assert.throws(() => finalizeSessionRecord(record, { status: 'failed' }, { now: 1300 }), /Cannot finalize/);
});

test('create transcript item with sessionId', () => {
  const item = createTranscriptItemForSession('session-1', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'hello',
    sequence: 1,
    startedAt: 100,
    finalizedAt: 200
  });

  assert.equal(item.sessionId, 'session-1');
});

test('transcript item preserves sequence/stream/status/timing', () => {
  const item = createTranscriptItemForSession('session-1', {
    id: 'translation-2',
    stream: 'translation',
    status: 'partial',
    text: 'bonjour',
    sequence: 2,
    startedAt: 300,
    finalizedAt: undefined,
    languageCode: 'fr'
  });

  assert.deepEqual(item, {
    id: 'translation-2',
    sessionId: 'session-1',
    stream: 'translation',
    status: 'partial',
    text: 'bonjour',
    sequence: 2,
    startedAt: 300,
    finalizedAt: undefined,
    languageCode: 'fr'
  });
});

test('summarize transcript items counts source/translation final/partial', () => {
  const summary = summarizeTranscriptItems([
    { stream: 'source', status: 'final', text: 'hello' },
    { stream: 'source', status: 'partial', text: 'hello wor' },
    { stream: 'translation', status: 'final', text: 'bonjour' },
    { stream: 'translation', status: 'partial', text: 'bon' }
  ]);

  assert.deepEqual(summary, {
    totalItems: 4,
    sourceFinalCount: 1,
    translationFinalCount: 1,
    sourcePartialCount: 1,
    translationPartialCount: 1,
    hasTranscript: true
  });
});

test('empty transcript summary', () => {
  assert.deepEqual(summarizeTranscriptItems(), {
    totalItems: 0,
    sourceFinalCount: 0,
    translationFinalCount: 0,
    sourcePartialCount: 0,
    translationPartialCount: 0,
    hasTranscript: false
  });
});

test('transcript text is not logged or transformed', () => {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args);

  try {
    const text = '  secret phrase stays exactly as-is  ';
    const item = createTranscriptItemForSession('session-1', {
      id: 'source-1',
      stream: 'source',
      status: 'final',
      text,
      sequence: 1,
      startedAt: 100,
      finalizedAt: 200
    });

    summarizeTranscriptItems([item]);

    assert.equal(item.text, text);
    assert.deepEqual(logged, []);
  } finally {
    console.log = originalLog;
  }
});
