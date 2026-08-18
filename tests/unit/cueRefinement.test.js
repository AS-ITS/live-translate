import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCueRefinementExecutionStates, completedCueRefinementOutputs } from '../../src/lib/cueRefinement.js';

const cue = (overrides = {}) => ({
  cueId: 'cue-1',
  status: 'final',
  refinement: { status: 'queued', executionId: 'execution-1', version: 1, inputHash: 'hash-1' },
  ...overrides
});

test('completed refinement outputs include refinedItems without translatedText', () => {
  const outputs = completedCueRefinementOutputs({
    translationHistory: {
      outputs: [
        { operation: 'transcript_polishing', refinedItems: [{ cueId: 'cue-1' }] },
        { operation: 'transcript_polishing', translatedText: 'polished' },
        { operation: 'transcript', refinedItems: [{ cueId: 'cue-2' }] }
      ]
    }
  });

  assert.equal(outputs.length, 2);
});

test('execution state updates only the active Cue status and records failures', () => {
  const cues = [cue(), cue({ cueId: 'cue-2', refinement: { status: 'queued', executionId: 'execution-2' } })];
  const active = applyCueRefinementExecutionStates(cues, [
    { id: 'execution-1', status: 'running' },
    { id: 'execution-2', status: 'failed', completedAt: '2026-08-18T03:00:00.000Z', failureInfo: { reason: 'provider_error' } }
  ]);

  assert.equal(active[0].refinement.status, 'running');
  assert.equal(active[1].refinement.status, 'failed');
  assert.deepEqual(active[1].refinement.failure, { reason: 'provider_error' });
});
