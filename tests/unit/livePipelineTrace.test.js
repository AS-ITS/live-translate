import assert from 'node:assert/strict';
import test from 'node:test';
import { createLivePipelineTrace } from '../../src/lib/livePipelineTrace.js';

test('development pipeline trace records bounded structured turn entries', () => {
  const logs = [];
  const trace = createLivePipelineTrace({
    enabled: true,
    limit: 2,
    now: () => '2026-10-01T00:00:00.000Z',
    logger: (...args) => logs.push(args)
  });

  trace.record({ stage: 'PCM_CAPTURED', recordingId: 'recording-1', audioTurnId: 'turn-1', pcmSequence: 1, pcmBytes: 320 });
  trace.record({ stage: 'CUE_STATE', recordingId: 'recording-1', audioTurnId: 'turn-1', cueId: 'cue-1', cueAction: 'append', sourceText: '第一句' });
  trace.record({ stage: 'CUE_STATE', recordingId: 'recording-1', audioTurnId: 'turn-2', cueAction: 'drop' });

  const entries = trace.get();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].cueId, 'cue-1');
  assert.equal(entries[1].dropReason, 'unspecified_drop');
  assert.equal(trace.getTurn('turn-1').length, 1);
  assert.equal(logs.length, 2);
  trace.clear();
  assert.deepEqual(trace.get(), []);
});

test('production-disabled pipeline trace retains and logs nothing', () => {
  const logs = [];
  const trace = createLivePipelineTrace({ enabled: false, logger: (...args) => logs.push(args) });
  assert.equal(trace.record({ stage: 'NORMALIZED', sourceText: 'secret transcript' }), null);
  assert.deepEqual(trace.get(), []);
  assert.deepEqual(logs, []);
});
