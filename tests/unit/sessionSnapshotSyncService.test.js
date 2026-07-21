import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSnapshotSyncService } from '../../src/application/sessionSnapshotSyncService.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('session snapshot sync is idempotent for sessions and transcript items, and persists finalization', () => {
  const repository = createMemorySessionRepository({ now: () => 1000 });
  const service = createSessionSnapshotSyncService({ sessionRepository: repository });
  const snapshot = {
    session: { id: 'session-1', startedAt: 100, endedAt: 200, targetLanguageCode: 'ja', targetLanguageLabel: 'Japanese', status: 'stopped', failureReason: 'user_stop', failureCategory: 'user_intent' },
    transcriptItems: [
      { id: 'source-1', stream: 'source', status: 'final', text: 'hello', sequence: 1 },
      { id: 'translation-1', stream: 'translation', status: 'final', text: 'こんにちは', sequence: 1 }
    ]
  };

  service.sync(snapshot);
  service.sync(snapshot);

  const detail = repository.getSessionRecord('session-1');
  assert.equal(repository.listSessionRecords().length, 1);
  assert.equal(detail.sessionRecord.status, 'stopped');
  assert.equal(detail.sessionRecord.failureReason, 'user_stop');
  assert.deepEqual(detail.transcriptItems.map((item) => item.id), ['source-1', 'translation-1']);
  assert.deepEqual(detail.sessionRecord.transcriptSummary, {
    totalItems: 2, sourceFinalCount: 1, translationFinalCount: 1,
    sourcePartialCount: 0, translationPartialCount: 0, hasTranscript: true
  });
});

test('session snapshot sync rejects invalid input deterministically', () => {
  const service = createSessionSnapshotSyncService({ sessionRepository: createMemorySessionRepository() });
  assert.throws(() => service.sync({ session: { id: '' }, transcriptItems: [] }), (error) => error.code === 'invalid_request');
});

test('session snapshot sync accepts legacy items without detection metadata and rehydrates mixed-language metadata', () => {
  const sourceRepository = createMemorySessionRepository({ now: () => 1000 });
  const sourceService = createSessionSnapshotSyncService({ sessionRepository: sourceRepository });
  const snapshot = {
    session: { id: 'session-1', startedAt: 100, targetLanguageCode: 'ja', status: 'active' },
    transcriptItems: [
      {
        id: 'source-1', stream: 'source', status: 'final', text: 'Hello こんにちは', sequence: 1,
        sourceLanguageDetection: { detectedLanguageCodes: ['en', 'ja'], coverage: 'complete' }
      },
      { id: 'source-legacy', stream: 'source', status: 'final', text: 'legacy', sequence: 2 }
    ]
  };

  sourceService.sync(snapshot);
  const reloadedRepository = createMemorySessionRepository({ now: () => 1000 });
  createSessionSnapshotSyncService({ sessionRepository: reloadedRepository }).sync({
    session: sourceRepository.getSessionRecord('session-1').sessionRecord,
    transcriptItems: sourceRepository.getSessionRecord('session-1').transcriptItems
  });

  const items = reloadedRepository.getSessionRecord('session-1').transcriptItems;
  assert.deepEqual(items[0].sourceLanguageDetection, { detectedLanguageCodes: ['en', 'ja'], coverage: 'complete' });
  assert.equal(items[1].sourceLanguageDetection, undefined);
});
