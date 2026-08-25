import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCueRefinementCoordinator,
  createTranscriptPolishingCoordinator,
  mergePolishedItemsFromOutputs,
  mergeStableCues,
  segmentRangeFor,
  thresholdReached,
  transcriptPolishingInputHash
} from '../../src/lib/transcriptPolishing.js';
import { createTranscriptPolishingLifecycle } from '../../src/lib/transcriptPolishingLifecycle.js';

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

test('blank and punctuation-only cues are not eligible for provider calls', () => {
  assert.deepEqual(mergeStableCues([
    cue({ cueId: 'blank', translationText: '   ' }),
    cue({ cueId: 'punctuation', translationText: '？！…' }),
    cue({ cueId: 'usable', translationText: 'Hello.' })
  ]), [cue({ cueId: 'usable', translationText: 'Hello.' })]);
});

test('coordinator does not call provider for blank or punctuation-only input', async () => {
  let calls = 0;
  const coordinator = createTranscriptPolishingCoordinator({
    minChars: 1,
    submit: async () => { calls += 1; }
  });
  await coordinator.add([
    cue({ cueId: 'blank', translationText: '   ' }),
    cue({ cueId: 'punctuation', translationText: '？！…' })
  ], { force: true });
  assert.equal(calls, 0);
});

test('polishing response keeps each cue addressable while using batch context', () => {
  const cues = [cue(), cue({ cueId: 'cue-2', sequence: 2, translationText: 'A second sentence.' })];
  assert.deepEqual(cues.map(({ cueId, sequence, sourceText, translationText }) => ({ cueId, sequence, sourceText, translationText })), [
    { cueId: 'cue-1', sequence: 1, sourceText: '原文', translationText: 'A translated sentence.' },
    { cueId: 'cue-2', sequence: 2, sourceText: '原文', translationText: 'A second sentence.' }
  ]);
});

test('input hash and segment range are deterministic', () => {
  const cues = [cue({ segmentId: 'segment-1' }), cue({ cueId: 'cue-2', sequence: 2, segmentId: 'segment-2' })];
  assert.equal(transcriptPolishingInputHash(cues), transcriptPolishingInputHash(structuredClone(cues)));
  assert.deepEqual(segmentRangeFor(cues), { fromSequence: 1, toSequence: 2, segmentIds: ['segment-1', 'segment-2'] });
});

test('polishing outputs merge every batch and prefer the newest replacement', () => {
  assert.deepEqual(mergePolishedItemsFromOutputs([
    {
      id: 'output-1', version: 1, completedAt: '2026-08-07T00:00:01.000Z', operation: 'transcript_polishing',
      polishedItems: [
        { cueId: 'cue-1', sequence: 1, polishedText: 'First polished.' },
        { cueId: 'cue-2', sequence: 2, polishedText: 'Second polished.' }
      ]
    },
    {
      id: 'output-2', version: 2, completedAt: '2026-08-07T00:00:02.000Z', operation: 'transcript_polishing',
      polishedItems: [{ cueId: 'cue-2', sequence: 2, polishedText: 'Second revised.' }, { cueId: 'cue-3', sequence: 3, polishedText: 'Third polished.' }]
    }
  ]), [
    { cueId: 'cue-1', sequence: 1, polishedText: 'First polished.' },
    { cueId: 'cue-2', sequence: 2, polishedText: 'Second revised.' },
    { cueId: 'cue-3', sequence: 3, polishedText: 'Third polished.' }
  ]);
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

test('polishing lifecycle persists an explicit target contract in the request snapshot', async () => {
  const requests = [];
  const lifecycle = createTranscriptPolishingLifecycle({
    now: () => '2026-08-19T00:00:00.000Z',
    apiClient: {
      async createTranslationRequest(request) { requests.push(request); },
      async createTranslationExecution() {}
    }
  });
  await lifecycle.submit({
    sessionId: 'session-1', targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant', connectionEpoch: 7,
    cues: [cue({ cueId: 'cue-a', sequence: 4, segmentId: 'segment-1' }), cue({ cueId: 'cue-b', sequence: 5, segmentId: 'segment-1' })]
  });
  const targets = requests[0].sourceTranscriptSnapshot.refinementTargets;
  assert.deepEqual(targets.map(({ targetCueId, targetSequence, sessionId, segmentId, connectionEpoch, fields }) => ({ targetCueId, targetSequence, sessionId, segmentId, connectionEpoch, fields })), [
    { targetCueId: 'cue-a', targetSequence: 4, sessionId: 'session-1', segmentId: 'segment-1', connectionEpoch: 7, fields: ['translation'] },
    { targetCueId: 'cue-b', targetSequence: 5, sessionId: 'session-1', segmentId: 'segment-1', connectionEpoch: 7, fields: ['translation'] }
  ]);
  assert.equal(targets[0].refinementJobId, `polishing-execution:session-1:${requests[0].inputHash}`);
  assert.equal(targets[0].requestId, `polishing-request:session-1:${requests[0].inputHash}`);
});

test('Cue refinement coordinator submits each Cue with at most two preceding context Cues', async () => {
  const submissions = [];
  const coordinator = createCueRefinementCoordinator({
    submit: async (job) => submissions.push(job)
  });
  const cues = [1, 2, 3, 4].map((sequence) => cue({ cueId: `cue-${sequence}`, sequence }));

  coordinator.enqueue(cues);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(submissions.map(({ cue: submittedCue, contextCues }) => ({
    cueId: submittedCue.cueId,
    context: contextCues.map((item) => item.cueId)
  })), [
    { cueId: 'cue-1', context: [] },
    { cueId: 'cue-2', context: ['cue-1'] },
    { cueId: 'cue-3', context: ['cue-1', 'cue-2'] },
    { cueId: 'cue-4', context: ['cue-2', 'cue-3'] }
  ]);
});

test('Cue refinement coordinator deduplicates identical versions and enforces RPM', async () => {
  let now = 0;
  const scheduled = [];
  const submissions = [];
  const coordinator = createCueRefinementCoordinator({
    maxRequestsPerMinute: 1,
    now: () => now,
    scheduler: {
      set(callback, delayMs) { scheduled.push({ callback, delayMs }); return scheduled.length; },
      clear() {}
    },
    submit: async ({ cue: submittedCue }) => submissions.push(submittedCue.cueId)
  });
  const first = cue({ cueId: 'cue-1', sequence: 1 });
  const second = cue({ cueId: 'cue-2', sequence: 2 });

  coordinator.enqueue([first, first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submissions, ['cue-1']);
  assert.equal(coordinator.state().pendingCount, 1);
  assert.equal(scheduled[0].delayMs, 60000);

  now = 60000;
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submissions, ['cue-1', 'cue-2']);
});

test('submitCue request targets only the current Cue while context remains in refinementItems', async () => {
  const requests = [];
  const lifecycle = createTranscriptPolishingLifecycle({
    now: () => '2026-08-24T00:00:00.000Z',
    apiClient: {
      async createTranslationRequest(request) { requests.push(request); },
      async createTranslationExecution() {}
    }
  });
  await lifecycle.submitCue({
    sessionId: 'session-1',
    targetLanguageCode: 'en',
    sourceLanguageCode: 'zh-Hant',
    cue: cue({ cueId: 'cue-3', sequence: 3, segmentId: 'segment-1' }),
    contextCues: [cue({ cueId: 'cue-1', sequence: 1 }), cue({ cueId: 'cue-2', sequence: 2 })]
  });

  assert.deepEqual(requests[0].sourceTranscriptSnapshot.refinementItems.map((item) => item.cueId), ['cue-1', 'cue-2', 'cue-3']);
  assert.deepEqual(requests[0].sourceTranscriptSnapshot.refinementTargets.map((target) => target.targetCueId), ['cue-3']);
});
