import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundTranslationSummary } from '../../src/features/live/backgroundTranslationState.js';

test('reports queued background translation and its update time', () => {
  const summary = backgroundTranslationSummary([
    { refinement: { status: 'queued', requestedAt: '2026-09-13T00:00:00.000Z' } }
  ]);

  assert.deepEqual(summary, {
    pending: true,
    status: 'queued',
    updatedAt: '2026-09-13T00:00:00.000Z',
    startedAtMs: Date.parse('2026-09-13T00:00:00.000Z')
  });
});

test('reports processing when any background execution is running', () => {
  const summary = backgroundTranslationSummary([
    { refinement: { status: 'queued', requestedAt: '2026-09-13T00:00:00.000Z' } },
    { refinement: { status: 'running', startedAt: '2026-09-13T00:01:00.000Z' } }
  ]);

  assert.equal(summary.status, 'processing');
  assert.equal(summary.pending, true);
});

test('ignores completed and failed background executions', () => {
  assert.deepEqual(backgroundTranslationSummary([
    { refinement: { status: 'completed' } },
    { refinement: { status: 'failed' } }
  ]), { pending: false });
});
