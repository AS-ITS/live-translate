import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryMeetingSummaryRepository } from '../../src/infrastructure/meetingSummaryRepositoryAdapter.js';

const pending = (summaryId, sessionId = 'session-1') => ({ summaryId, sessionId, status: 'pending', model: 'model', summary: null, topics: [], decisions: [], actionItems: [], createdAt: Number(summaryId.slice(-1)), completedAt: null });

test('repository rejects a second active summary and permits retained failed attempts', () => {
  const repository = createMemoryMeetingSummaryRepository();
  const first = repository.createSummary(pending('summary-1'));
  assert.throws(() => repository.createSummary(pending('summary-2')), /active meeting summary/);
  repository.updateSummary(first.fail());
  assert.equal(repository.createSummary(pending('summary-2')).summaryId, 'summary-2');
});
test('completed summaries are immutable', () => {
  const repository = createMemoryMeetingSummaryRepository();
  const completed = repository.createSummary(pending('summary-1')).complete({ summary: { title: 'Done' }, topics: [], decisions: [], actionItems: [], completedAt: 2 });
  repository.updateSummary(completed);
  assert.throws(() => repository.updateSummary({ ...completed, summary: { title: 'Changed' } }), /immutable/);
});
