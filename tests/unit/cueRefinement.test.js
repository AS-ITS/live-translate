import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCueRefinementExecutionStates, applyPolishedItemsToCues, applyRefinementResultToCues, completedCueRefinementOutputs, markCuesCompletedByRefinedOutputs, markCuesCompletedByRefinedSubtitleCues, mergeCuesByIdPreferRefinement, refinedSubtitleCuesForDisplay } from '../../src/lib/cueRefinement.js';

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
        { operation: 'transcript_polishing', refinedCues: [{ sourceCueIds: ['cue-1'] }] },
        { operation: 'transcript_polishing', polishedItems: [{ cueId: 'cue-1', polishedText: 'polished' }] },
        { operation: 'transcript_polishing', translatedText: 'polished' },
        { operation: 'transcript', refinedItems: [{ cueId: 'cue-2' }] }
      ]
    }
  });

  assert.equal(outputs.length, 4);
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

test('completed Cues are not regressed by a stale active execution snapshot', () => {
  const completed = applyCueRefinementExecutionStates([
    cue({ refinement: { status: 'completed', executionId: 'execution-1' } })
  ], [{ id: 'execution-1', status: 'running' }]);

  assert.equal(completed[0].refinement.status, 'completed');
});

test('completed refined subtitle Cues complete their source Cues without affecting new Cues', () => {
  const cues = [
    cue({ cueId: 'cue-1', refinement: { status: 'queued', executionId: 'execution-1' } }),
    cue({ cueId: 'cue-2', refinement: { status: 'pending' } }),
    cue({ cueId: 'cue-3', refinement: { status: 'running', executionId: 'execution-3' } })
  ];
  const completed = markCuesCompletedByRefinedSubtitleCues(cues, [
    { cueId: 'refined-1', sourceCueIds: ['cue-1', 'cue-3'], status: 'final' }
  ]);

  assert.equal(completed[0].refinement.status, 'completed');
  assert.equal(completed[1].refinement.status, 'pending');
  assert.equal(completed[2].refinement.status, 'completed');
});

test('refined subtitle display results keep only matching completed Cues in timeline order', () => {
  const cues = [
    { cueId: 'refined-subtitle:hash:1', sequence: 2, startTimeMs: 200, status: 'final', refinement: { status: 'completed', inputHash: 'hash' } },
    { cueId: 'raw-cue', sequence: 1, status: 'final' },
    { cueId: 'refined-subtitle:old:0', sequence: 1, startTimeMs: 100, status: 'final', refinement: { status: 'completed', inputHash: 'old' } },
    { cueId: 'refined-subtitle:hash:0', sequence: 1, startTimeMs: 100, status: 'final', refinement: { status: 'completed', inputHash: 'hash' } },
    { cueId: 'refined-subtitle:hash:partial', sequence: 3, status: 'partial', refinement: { status: 'completed', inputHash: 'hash' } }
  ];

  assert.deepEqual(refinedSubtitleCuesForDisplay(cues, { inputHash: 'hash' }).map((cue) => cue.cueId), [
    'refined-subtitle:hash:0',
    'refined-subtitle:hash:1'
  ]);
});

test('completed refinement outputs complete source Cues before checkpoint refined Cues arrive', () => {
  const completed = markCuesCompletedByRefinedOutputs([
    cue({ cueId: 'cue-1', refinement: { status: 'pending' } }),
    cue({ cueId: 'cue-2', refinement: { status: 'pending' } })
  ], [{
    operation: 'transcript_polishing',
    completedAt: '2026-08-19T04:00:00.000Z',
    refinedCues: [{ sourceCueIds: ['cue-1'] }]
  }]);

  assert.equal(completed[0].refinement.status, 'completed');
  assert.equal(completed[0].refinement.completedAt, '2026-08-19T04:00:00.000Z');
  assert.equal(completed[1].refinement.status, 'pending');
});

test('polished items apply refined translation and complete only matching Cues', () => {
  const completed = applyPolishedItemsToCues([
    cue({ cueId: 'cue-1', refinement: { status: 'pending' }, translatedText: 'raw translation' }),
    cue({ cueId: 'cue-2', refinement: { status: 'pending' }, translatedText: 'keep pending' })
  ], [{
    operation: 'transcript_polishing',
    completedAt: '2026-08-19T04:00:00.000Z',
    polishedItems: [{ cueId: 'cue-1', polishedText: 'polished translation' }]
  }]);

  assert.equal(completed[0].refinedTranslation, 'polished translation');
  assert.equal(completed[0].refinement.status, 'completed');
  assert.equal(completed[0].refinement.completedAt, '2026-08-19T04:00:00.000Z');
  assert.equal(completed[1].refinement.status, 'pending');
  assert.equal(completed[1].refinedTranslation, undefined);
});

test('polished items without a cue id or text do not complete Cues', () => {
  const cues = [cue({ refinement: { status: 'pending' } })];
  const completed = applyPolishedItemsToCues(cues, [{
    operation: 'transcript_polishing',
    polishedItems: [{ cueId: 'missing', polishedText: 'ignored' }, { cueId: 'cue-1', polishedText: '  ' }]
  }]);

  assert.equal(completed[0], cues[0]);
});

test('refinement success updates the addressed Cue in place after a later Cue arrives', () => {
  const cues = [
    cue({ cueId: 'cue-1', sequence: 1, sessionId: 'session-1', segmentId: 'segment-1', startTimeMs: 0, endTimeMs: 100 }),
    cue({ cueId: 'cue-2', sequence: 2, sessionId: 'session-1', segmentId: 'segment-1', startTimeMs: 100, endTimeMs: 200, refinement: { status: 'pending', version: 1, inputHash: 'hash-2' } })
  ];
  const result = applyRefinementResultToCues(cues, {
    targetCueId: 'cue-1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    refinementJobId: 'job-1',
    version: 1,
    inputHash: 'hash-1',
    fields: ['translation'],
    refinedTranslation: 'first revised'
  }, { sessionId: 'session-1' });

  assert.equal(result.applied, true);
  assert.deepEqual(result.cues.map(({ cueId, sequence }) => ({ cueId, sequence })), [
    { cueId: 'cue-1', sequence: 1 },
    { cueId: 'cue-2', sequence: 2 }
  ]);
  assert.equal(result.cues[0].refinedTranslation, 'first revised');
  assert.equal(result.cues[0].refinement.status, 'completed');
  assert.equal(result.cues[1].refinement.status, 'pending');
});

test('an older polling snapshot cannot overwrite a completed refinement', () => {
  const completed = [cue({ cueId: 'cue-1', refinement: { status: 'completed', version: 1, inputHash: 'hash-1' }, refinedTranslation: 'revised' })];
  const staleSnapshot = [cue({ cueId: 'cue-1', refinement: { status: 'pending', version: 1, inputHash: 'hash-1' } })];

  const merged = mergeCuesByIdPreferRefinement(completed, staleSnapshot);

  assert.equal(merged[0], completed[0]);
  assert.equal(merged[0].refinement.status, 'completed');
  assert.equal(merged[0].refinedTranslation, 'revised');
});

test('missing targetCueId does not append or modify Cues', () => {
  const cues = [cue({ cueId: 'cue-1' })];
  const diagnostics = [];
  const result = applyRefinementResultToCues(cues, {
    targetCueId: 'missing',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    refinementJobId: 'job-1'
  }, { logger: (event) => diagnostics.push(event) });

  assert.equal(result.applied, false);
  assert.equal(result.cues, cues);
  assert.deepEqual(diagnostics[0], {
    event: 'refinement_target_not_found',
    reason: 'target_not_found',
    targetCueId: 'missing',
    availableCueIds: ['cue-1'],
    sessionId: 'session-1',
    segmentId: 'segment-1',
    connectionEpoch: null,
    refinementJobId: 'job-1'
  });
});
