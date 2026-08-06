import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTranscriptPolishingCoordinator,
  mergeStableCues,
  segmentRangeFor,
  thresholdReached,
  transcriptPolishingInputHash
} from '../../src/lib/transcriptPolishing.js';

const cue = (overrides = {}) => ({
  cueId: 'cue-1', sequence: 1, status: 'final', sourceText: '原文', translationText: 'A translated sentence.', ...overrides
});

test('polishing threshold uses minimum characters or elapsed interval', () => {
  assert.equal(thresholdReached([cue()], 0, 1000, 30000, 200), false);
  assert.equal(thresholdReached([cue({ translationText: 'x'.repeat(200) })], 0, 1000, 30000, 200), true);
  assert.equal(thresholdReached([cue()], 0, 30000, 30000, 200), true);
});

test('stable cues merge by cue id and ignore partial or untranslated cues', () => {
  assert.deepEqual(mergeStableCues([cue()], [
    cue({ cueId: 'cue-1', translationText: 'updated' }),
    cue({ cueId: 'partial', status: 'partial' }),
    cue({ cueId: 'source-only', translationText: '' })
  ]), [cue({ translationText: 'updated' })]);
});

test('input hash and segment range are deterministic', () => {
  const cues = [cue({ segmentId: 'segment-1' }), cue({ cueId: 'cue-2', sequence: 2, segmentId: 'segment-2' })];
  assert.equal(transcriptPolishingInputHash(cues), transcriptPolishingInputHash(structuredClone(cues)));
  assert.deepEqual(segmentRangeFor(cues), { fromSequence: 1, toSequence: 2, segmentIds: ['segment-1', 'segment-2'] });
});

test('coordinator enforces single flight and submits dirty content after completion', async () => {
  const submissions = [];
  let resolveFirst;
  const coordinator = createTranscriptPolishingCoordinator({
    intervalMs: 1,
    minChars: 1,
    now: () => 10,
    submit(input) {
      submissions.push(input);
      if (submissions.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ ok: true });
    }
  });

  const first = coordinator.add([cue()], { force: true });
  await coordinator.add([cue({ cueId: 'cue-2', sequence: 2, translationText: 'next' })], { force: true });
  assert.equal(submissions.length, 1);
  resolveFirst({ ok: true });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submissions.length, 2);
});
