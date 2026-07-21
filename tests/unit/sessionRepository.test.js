import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemorySessionRepository, SESSION_REPOSITORY_METHODS } from '../../src/lib/sessionRepository.js';

test('memory repository exposes the SessionRepository interface', () => {
  const repository = createMemorySessionRepository();

  for (const method of SESSION_REPOSITORY_METHODS) {
    assert.equal(typeof repository[method], 'function');
  }
});

test('createSessionRecord creates deterministic active record', () => {
  const repository = createMemorySessionRepository({
    now: () => 1000,
    idFactory: () => 'session-1'
  });

  const record = repository.createSessionRecord({
    startedAt: 900,
    targetLanguageCode: 'zh-Hant'
  });

  assert.equal(record.id, 'session-1');
  assert.equal(record.status, 'active');
  assert.equal(record.createdAt, 1000);
  assert.equal(repository.listSessionRecords().length, 1);
});

test('createSessionRecord rejects duplicate ids', () => {
  const repository = createMemorySessionRepository({ now: 1000 });

  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'en'
  });

  assert.throws(
    () =>
      repository.createSessionRecord({
        id: 'session-1',
        startedAt: 950,
        targetLanguageCode: 'ja'
      }),
    /already exists/
  );
});

test('updateSessionRecord patches a record without mutating returned snapshots', () => {
  const repository = createMemorySessionRepository({ now: () => 1000 });
  const created = repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'en'
  });

  created.status = 'mutated-outside';

  const updated = repository.updateSessionRecord('session-1', {
    failureReason: 'unexpected_close',
    lastLifecycleState: 'reconnecting'
  });

  assert.equal(updated.status, 'active');
  assert.equal(updated.failureReason, 'unexpected_close');
  assert.equal(updated.lastLifecycleState, 'reconnecting');
  assert.equal(repository.getSessionRecord('session-1').sessionRecord.status, 'active');
});

test('appendTranscriptItem stores item with sessionId and updates summary', () => {
  const repository = createMemorySessionRepository({ now: 1000 });

  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'en'
  });

  const item = repository.appendTranscriptItem('session-1', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'hello',
    sequence: 1,
    startedAt: 100,
    finalizedAt: 200
  });
  const detail = repository.getSessionRecord('session-1');

  assert.equal(item.sessionId, 'session-1');
  assert.deepEqual(detail.transcriptItems, [item]);
  assert.deepEqual(detail.sessionRecord.transcriptSummary, {
    totalItems: 1,
    sourceFinalCount: 1,
    translationFinalCount: 0,
    sourcePartialCount: 0,
    translationPartialCount: 0,
    hasTranscript: true
  });
});

test('appendTranscriptItem preserves transcript item fields', () => {
  const repository = createMemorySessionRepository({ now: 1000 });

  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'fr'
  });

  const item = repository.appendTranscriptItem('session-1', {
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

test('appendTranscriptItem persists source-only multi-language detection metadata as an isolated copy', () => {
  const repository = createMemorySessionRepository({ now: 1000 });
  const sourceLanguageDetection = {
    detectedLanguageCodes: ['en', 'ja'],
    coverage: 'complete'
  };

  repository.createSessionRecord({ id: 'session-1', startedAt: 900, targetLanguageCode: 'fr' });
  const item = repository.appendTranscriptItem('session-1', {
    id: 'source-1', stream: 'source', status: 'final', text: 'Hello こんにちは', sequence: 1,
    startedAt: 300, finalizedAt: 400, sourceLanguageDetection
  });
  sourceLanguageDetection.detectedLanguageCodes.push('zh-Hant');
  item.sourceLanguageDetection.detectedLanguageCodes[0] = 'mutated';

  const stored = repository.getSessionRecord('session-1').transcriptItems[0];
  assert.deepEqual(stored.sourceLanguageDetection, {
    detectedLanguageCodes: ['en', 'ja'],
    coverage: 'complete'
  });
  assert.equal(repository.getSessionRecord('session-1').sessionRecord.sourceLanguageDetection, undefined);
});

test('finalizeSessionRecord finalizes with computed transcript summary', () => {
  const repository = createMemorySessionRepository({ now: () => 2500 });

  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 1000,
    targetLanguageCode: 'en'
  });
  repository.appendTranscriptItem('session-1', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'hello',
    sequence: 1,
    startedAt: 100,
    finalizedAt: 200
  });

  const finalized = repository.finalizeSessionRecord('session-1', {
    status: 'stopped',
    failureReason: 'user_stop'
  });

  assert.equal(finalized.status, 'stopped');
  assert.equal(finalized.endedAt, 2500);
  assert.equal(finalized.durationMs, 1500);
  assert.equal(finalized.failureReason, 'user_stop');
  assert.equal(finalized.transcriptSummary.totalItems, 1);
});

test('finalizeSessionRecord rejects already terminal records', () => {
  const repository = createMemorySessionRepository({ now: 1200 });

  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 1000,
    targetLanguageCode: 'en'
  });
  repository.finalizeSessionRecord('session-1', { status: 'completed' });

  assert.throws(() => repository.finalizeSessionRecord('session-1', { status: 'failed' }), /Cannot finalize/);
});

test('listSessionRecords returns cloned lightweight records', () => {
  const repository = createMemorySessionRepository({ now: 1000 });

  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'en'
  });

  const records = repository.listSessionRecords();
  records[0].status = 'mutated';
  records[0].transcriptSummary.totalItems = 99;

  const [stored] = repository.listSessionRecords();
  assert.equal(stored.status, 'active');
  assert.equal(stored.transcriptSummary.totalItems, 0);
});

test('getSessionRecord returns cloned detail with transcript items', () => {
  const repository = createMemorySessionRepository({ now: 1000 });

  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'en'
  });
  repository.appendTranscriptItem('session-1', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'hello',
    sequence: 1,
    startedAt: 100,
    finalizedAt: 200
  });

  const detail = repository.getSessionRecord('session-1');
  detail.sessionRecord.status = 'mutated';
  detail.transcriptItems[0].text = 'mutated';

  const stored = repository.getSessionRecord('session-1');
  assert.equal(stored.sessionRecord.status, 'active');
  assert.equal(stored.transcriptItems[0].text, 'hello');
});

test('getSessionRecord returns null for missing record', () => {
  const repository = createMemorySessionRepository();

  assert.equal(repository.getSessionRecord('missing'), null);
});

test('deleteSessionRecord removes record and transcript items', () => {
  const repository = createMemorySessionRepository({ now: 1000 });

  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'en'
  });
  repository.appendTranscriptItem('session-1', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'hello',
    sequence: 1,
    startedAt: 100,
    finalizedAt: 200
  });

  assert.equal(repository.deleteSessionRecord('session-1'), true);
  assert.equal(repository.getSessionRecord('session-1'), null);
  assert.deepEqual(repository.listSessionRecords(), []);
});

test('deleteSessionRecord returns false for missing record', () => {
  const repository = createMemorySessionRepository();

  assert.equal(repository.deleteSessionRecord('missing'), false);
});

test('repository throws for missing record mutations', () => {
  const repository = createMemorySessionRepository();

  assert.throws(() => repository.updateSessionRecord('missing', {}), /not found/);
  assert.throws(() => repository.appendTranscriptItem('missing', {}), /not found/);
  assert.throws(() => repository.finalizeSessionRecord('missing', {}), /not found/);
});

test('repository does not log or transform transcript text', () => {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args);

  try {
    const repository = createMemorySessionRepository({ now: 1000 });
    const text = '  private transcript text  ';

    repository.createSessionRecord({
      id: 'session-1',
      startedAt: 900,
      targetLanguageCode: 'en'
    });
    repository.appendTranscriptItem('session-1', {
      id: 'source-1',
      stream: 'source',
      status: 'final',
      text,
      sequence: 1,
      startedAt: 100,
      finalizedAt: 200
    });

    assert.equal(repository.getSessionRecord('session-1').transcriptItems[0].text, text);
    assert.deepEqual(logged, []);
  } finally {
    console.log = originalLog;
  }
});
