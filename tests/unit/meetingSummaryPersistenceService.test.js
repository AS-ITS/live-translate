import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingSummaryPersistenceService } from '../../src/application/meetingSummaryPersistenceService.js';
import { createMemoryMeetingSummaryRepository } from '../../src/infrastructure/meetingSummaryRepositoryAdapter.js';

function createService({ summaryService = { async generate() { return { summary: { title: 'Meeting', overview: 'Overview', keyPoints: ['Topic'], decisions: ['Decision'], actionItems: ['Action'] } }; } } } = {}) {
  let id = 0;
  return createMeetingSummaryPersistenceService({
    summaryRepository: createMemoryMeetingSummaryRepository(),
    summaryService,
    sessionRepository: { async getSessionRecord() { return { sessionRecord: { id: 'session-1' } }; } },
    model: 'gemini-3.5-flash-lite',
    idGenerator: () => `summary-${++id}`,
    clock: (() => { let time = 100; return () => ++time; })()
  });
}

test('persists a completed summary with session association and metadata', async () => {
  const service = createService();
  const result = await service.generateAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1' });
  assert.deepEqual({
    summaryId: result.summaryId, sessionId: result.sessionId, status: result.status,
    model: result.model, topics: result.topics, decisions: result.decisions,
    actionItems: result.actionItems, createdAt: result.createdAt, completedAt: result.completedAt
  }, {
    summaryId: 'summary-1', sessionId: 'session-1', status: 'completed', model: 'gemini-3.5-flash-lite',
    topics: ['Topic'], decisions: ['Decision'], actionItems: ['Action'], createdAt: 101, completedAt: 102
  });
});
test('retains failed records and retries with a new summary record', async () => {
  let fail = true;
  const service = createService({ summaryService: { async generate() { if (fail) { fail = false; throw new Error('provider failed'); } return { summary: { title: 'Retry', overview: 'ok', keyPoints: [], decisions: [], actionItems: [] } }; } } });
  await assert.rejects(service.generateAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1' }), /provider failed/);
  const completed = await service.generateAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1' });
  const records = await service.listBySessionId('session-1');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(records.map((record) => [record.summaryId, record.status]), [['summary-2', 'completed'], ['summary-1', 'failed']]);
});

test('completed summary is idempotent and only one active summary is allowed', async () => {
  let calls = 0;
  const service = createService({ summaryService: { async generate() { calls += 1; return { summary: { title: 'Once', overview: 'ok', keyPoints: [], decisions: [], actionItems: [] } }; } } });
  const first = await service.generateAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1' });
  const second = await service.generateAndPersist({ sessionId: 'session-1', meetingId: 'meeting-1' });
  assert.equal(second.summaryId, first.summaryId);
  assert.equal(calls, 1);
});
