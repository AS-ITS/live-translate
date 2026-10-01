import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveCueLatencyTracker } from '../../src/lib/liveCueLatency.js';

test('records Live source/translation and Viewer publication latency for one Cue', () => {
  const logs = [];
  const tracker = createLiveCueLatencyTracker({ enabled: true, logger: (...args) => logs.push(args) });
  const audioTurnId = 'audio-turn-1';
  const cueId = 'cue-1';

  tracker.recordAudioTurnStarted({ audioTurnId, at: 1_000 });
  tracker.linkAudioTurn({ fromAudioTurnId: audioTurnId, toAudioTurnId: 'provider-turn-1' });
  const providerTurnId = 'provider-turn-1';
  tracker.recordCueEvent({ audioTurnId: providerTurnId, stream: 'source', text: '我們今天', isFinal: false }, { at: 1_020 });
  tracker.recordCueEvent({ audioTurnId: providerTurnId, stream: 'translation', text: 'Today', isFinal: false }, { at: 1_035 });
  tracker.recordCueEvent({ audioTurnId: providerTurnId, stream: 'source', text: '我們今天討論', isFinal: true }, { at: 1_100 });
  tracker.recordViewerPublished({
    cue: { cueId, audioTurnId: providerTurnId, sourceStatus: 'finalized', translationStatus: 'pending' },
    at: 1_112
  });
  tracker.recordCueEvent({ audioTurnId: providerTurnId, stream: 'translation', text: 'Today we discuss', isFinal: true }, { at: 1_150 });
  const result = tracker.recordViewerPublished({
    cue: { cueId, audioTurnId: providerTurnId, sourceStatus: 'finalized', translationStatus: 'finalized' },
    at: 1_164
  });

  assert.deepEqual(result, {
    audioTurnId: providerTurnId,
    audioTurnStartedAt: 1_000,
    firstSourcePartialAt: 1_020,
    firstTranslationPartialAt: 1_035,
    sourceFinalAt: 1_100,
    cueId,
    viewerFirstPublishedAt: 1_112,
    translationFinalAt: 1_150,
    viewerTranslationUpdatedAt: 1_164,
    audioToFirstSourceMs: 20,
    audioToFirstTranslationMs: 35,
    sourceFinalToViewerMs: 12,
    translationFinalToViewerMs: 14
  });
  assert.equal(logs.length, 2);
  assert.equal(logs[1][0], '[live-cue-latency]');
});

test('production-disabled tracker does not retain or log measurements', () => {
  const logs = [];
  const tracker = createLiveCueLatencyTracker({ enabled: false, logger: (...args) => logs.push(args) });
  tracker.recordAudioTurnStarted({ audioTurnId: 'audio-turn-1', at: 1 });
  tracker.recordCueEvent({ audioTurnId: 'audio-turn-1', stream: 'source', text: 'hello' }, { at: 2 });
  tracker.recordViewerPublished({ cue: { cueId: 'cue-1', audioTurnId: 'audio-turn-1' }, at: 3 });
  assert.equal(tracker.snapshot('audio-turn-1'), null);
  assert.deepEqual(logs, []);
});
