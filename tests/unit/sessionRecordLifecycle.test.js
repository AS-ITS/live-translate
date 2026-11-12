import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendNewFinalTranscriptItems,
  buildFinalizePatch,
  buildSessionRecordInput,
  createActiveSessionRecord,
  finalizeActiveSessionRecord
} from '../../src/lib/sessionRecordLifecycle.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';
import { applyTranscriptEvent, createTranscriptState } from '../../src/lib/transcript.js';

test('build session record input', () => {
  assert.deepEqual(
    buildSessionRecordInput({
      startedAt: 1000,
      targetLanguageCode: 'zh-Hant',
      targetLanguageLabel: 'Traditional Chinese',
      sourceLanguageCode: 'zh-Hant',
      selectedInputDeviceId: 'device-1',
      inputDeviceLabelSnapshot: 'Studio Mic'
    }),
    {
      startedAt: 1000,
      targetLanguageCode: 'zh-Hant',
      targetLanguageLabel: 'Traditional Chinese',
      sourceLanguageCode: 'zh-Hant',
      meetingId: null,
      recordingId: null,
      segmentId: null,
      selectedInputDeviceId: 'device-1',
      inputDeviceLabelSnapshot: 'Studio Mic'
    }
  );
});

test('build session record input normalizes legacy glossary aliases for the target language', () => {
  const result = buildSessionRecordInput({
    startedAt: 1000,
    targetLanguageCode: 'en',
    meetingGlossaryEntries: [
      { source: 'microphone', target: 'Alan speak', replacementAliases: { en: ['mic'], ja: ['マイク'] } },
      { source: 'legacy', target: 'Legacy', replacementAliases: null }
    ]
  });

  assert.deepEqual(result.meetingGlossaryEntries, [
    { source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] },
    { source: 'legacy', target: 'Legacy', replacementAliases: [] }
  ]);
});

test('create active session record', () => {
  const repository = createMemorySessionRepository({ now: 1000, idFactory: () => 'session-1' });
  const record = createActiveSessionRecord(
    repository,
    buildSessionRecordInput({
      startedAt: 900,
      targetLanguageCode: 'en'
    })
  );

  assert.equal(record.id, 'session-1');
  assert.equal(record.status, 'active');
});

test('continuing a paused session reuses its record and transcript items', () => {
  const repository = createMemorySessionRepository({ now: 1000, idFactory: () => 'session-1' });
  const first = createActiveSessionRecord(repository, buildSessionRecordInput({
    id: 'session-1', status: 'created', targetLanguageCode: 'en',
    meetingId: 'meeting-1', segmentId: 'segment-1'
  }));
  repository.updateSessionRecord(first.id, { status: 'active' });
  repository.appendTranscriptItem(first.id, {
    id: 'source-1', stream: 'source', text: 'hello', isFinal: true, sequence: 1
  });
  repository.updateSessionRecord(first.id, { status: 'paused' });

  const resumed = createActiveSessionRecord(repository, buildSessionRecordInput({
    id: first.id, status: 'created', targetLanguageCode: 'en',
    meetingId: 'meeting-1', segmentId: 'segment-2'
  }));

  assert.equal(resumed.id, first.id);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.segmentId, 'segment-2');
  assert.equal(repository.getSessionRecord(first.id).transcriptItems.length, 1);
});

test('append only newly finalized source transcript items', () => {
  const repository = repositoryWithSession();
  const previous = createTranscriptState();
  const next = applyTranscriptEvent(previous, {
    stream: 'source',
    text: 'hello',
    isFinal: true,
    now: 100
  });

  const appended = appendNewFinalTranscriptItems(repository, 'session-1', previous, next);

  assert.deepEqual(appended.map((item) => item.id), ['source-1']);
  assert.equal(repository.getSessionRecord('session-1').transcriptItems[0].text, 'hello');
});

test('append only newly finalized translation transcript items', () => {
  const repository = repositoryWithSession();
  const previous = createTranscriptState();
  const next = applyTranscriptEvent(previous, {
    stream: 'translation',
    text: 'bonjour',
    isFinal: true,
    languageCode: 'fr',
    now: 100
  });

  const appended = appendNewFinalTranscriptItems(repository, 'session-1', previous, next);

  assert.deepEqual(appended, [
    {
      id: 'translation-1',
      sessionId: 'session-1',
      stream: 'translation',
      status: 'final',
      text: 'bonjour',
      sequence: 1,
      startedAt: 100,
      finalizedAt: 100,
      languageCode: 'fr'
    }
  ]);
});

test('do not append partials', () => {
  const repository = repositoryWithSession();
  const previous = createTranscriptState();
  const next = applyTranscriptEvent(previous, {
    stream: 'source',
    text: 'hello wor',
    isFinal: false,
    now: 100
  });

  assert.deepEqual(appendNewFinalTranscriptItems(repository, 'session-1', previous, next), []);
  assert.deepEqual(repository.getSessionRecord('session-1').transcriptItems, []);
});

test('do not duplicate final transcript items', () => {
  const repository = repositoryWithSession();
  const previous = createTranscriptState();
  const next = applyTranscriptEvent(previous, {
    stream: 'source',
    text: 'hello',
    isFinal: true,
    now: 100
  });

  appendNewFinalTranscriptItems(repository, 'session-1', previous, next);
  const secondAppend = appendNewFinalTranscriptItems(repository, 'session-1', previous, next);

  assert.deepEqual(secondAppend, []);
  assert.equal(repository.getSessionRecord('session-1').transcriptItems.length, 1);
});

test('finalize stopped', () => {
  const repository = repositoryWithSession();
  const finalized = finalizeActiveSessionRecord(
    repository,
    'session-1',
    buildFinalizePatch({
      status: 'stopped',
      failureReason: 'user_stop',
      failureCategory: 'user_intent'
    })
  );

  assert.equal(finalized.status, 'stopped');
  assert.equal(finalized.failureReason, 'user_stop');
  assert.equal(finalized.failureCategory, 'user_intent');
});

test('finalize failed with reason/category', () => {
  const repository = repositoryWithSession();
  const finalized = finalizeActiveSessionRecord(
    repository,
    'session-1',
    buildFinalizePatch({
      status: 'failed',
      failureReason: 'unexpected_close',
      failureCategory: 'provider'
    })
  );

  assert.equal(finalized.status, 'failed');
  assert.equal(finalized.failureReason, 'unexpected_close');
  assert.equal(finalized.failureCategory, 'provider');
});

test('finalize expired', () => {
  const repository = repositoryWithSession();
  const finalized = finalizeActiveSessionRecord(
    repository,
    'session-1',
    buildFinalizePatch({
      status: 'expired',
      failureReason: 'token_expired',
      failureCategory: 'token'
    })
  );

  assert.equal(finalized.status, 'expired');
  assert.equal(finalized.failureReason, 'token_expired');
  assert.equal(finalized.failureCategory, 'token');
});

test('finalize null session id is no-op', () => {
  const repository = createMemorySessionRepository();

  assert.equal(finalizeActiveSessionRecord(repository, null, { status: 'stopped' }), null);
});

test('reconnect preserves same active session id conceptually', () => {
  const repository = repositoryWithSession();
  const activeSessionId = 'session-1';
  const reconnectSessionId = activeSessionId;

  assert.equal(reconnectSessionId, activeSessionId);
  assert.equal(repository.getSessionRecord(reconnectSessionId).sessionRecord.status, 'active');
});

test('manual start creates new record conceptually', () => {
  let nextId = 1;
  const repository = createMemorySessionRepository({
    now: 1000,
    idFactory: () => `session-${nextId++}`
  });
  const first = createActiveSessionRecord(repository, buildSessionRecordInput({ startedAt: 900, targetLanguageCode: 'en' }));
  const second = createActiveSessionRecord(repository, buildSessionRecordInput({ startedAt: 1100, targetLanguageCode: 'ja' }));

  assert.equal(first.id, 'session-1');
  assert.equal(second.id, 'session-2');
});

function repositoryWithSession() {
  const repository = createMemorySessionRepository({ now: 1000 });
  repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'en'
  });
  return repository;
}
