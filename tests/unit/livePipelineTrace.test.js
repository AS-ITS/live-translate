import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureLivePipelineTrace,
  createLivePipelineTrace,
  livePipelineTrace
} from '../../src/lib/livePipelineTrace.js';
import { exposeLiveTranslateDebug } from '../../src/lib/liveSession.js';

test('development pipeline trace records bounded structured turn entries', () => {
  const logs = [];
  const trace = createLivePipelineTrace({
    enabled: true,
    limit: 2,
    now: () => '2026-10-01T00:00:00.000Z',
    logger: (...args) => logs.push(args)
  });

  trace.record({ stage: 'PCM_CAPTURED', recordingId: 'recording-1', audioTurnId: 'turn-1', pcmSequence: 1, pcmBytes: 320 });
  trace.record({
    stage: 'CUE_UPDATED',
    recordingId: 'recording-1',
    audioTurnId: 'turn-1',
    cueId: 'cue-1',
    cueAction: 'append',
    sourceText: '第一句',
    isLateTranscript: true,
    turnComplete: true,
    providerTurnIndex: 7,
    providerTurnId: 'provider-turn-7',
    turnKey: 'local:turn-1',
    turnIdentitySource: 'local'
  });
  trace.record({ stage: 'EVENT_DROPPED', recordingId: 'recording-1', audioTurnId: 'turn-2', cueAction: 'drop' });

  const entries = trace.get();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].cueId, 'cue-1');
  assert.equal(entries[0].isLateTranscript, true);
  assert.equal(entries[0].turnComplete, true);
  assert.equal(entries[0].providerTurnIndex, 7);
  assert.equal(entries[0].providerTurnId, 'provider-turn-7');
  assert.equal(entries[1].dropReason, 'unspecified_drop');
  assert.equal(trace.getTurn('turn-1').length, 1);
  assert.equal(logs.length, 2);
  trace.clear();
  assert.deepEqual(trace.get(), []);
});

test('trace bounds text fields and isolates logger failures', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => { throw new Error('sink down'); } });
  const entry = trace.record({ stage: 'TRANSCRIPT_NORMALIZED', sourceText: 'x'.repeat(2000), translationText: 'y'.repeat(2000), reason: 'z'.repeat(2000) });
  assert.match(entry.sourceText, /\.\.\.\[truncated\]$/u);
  assert.match(entry.translationText, /\.\.\.\[truncated\]$/u);
  assert.match(entry.reason, /\.\.\.\[truncated\]$/u);
  assert.doesNotThrow(() => trace.record({ stage: 'CUE_UPDATED', cueId: 'cue-1' }));
});

test('production-disabled pipeline trace retains and logs nothing', () => {
  const logs = [];
  const trace = createLivePipelineTrace({ enabled: false, logger: (...args) => logs.push(args) });
  assert.equal(trace.record({ stage: 'NORMALIZED', sourceText: 'secret transcript' }), null);
  assert.deepEqual(trace.get(), []);
  assert.deepEqual(logs, []);
  assert.equal(trace.isEnabled(), false);
});

test('runtime opt-in enables trace independently of build mode and disabling discards entries', () => {
  const trace = createLivePipelineTrace({ enabled: false, logger: () => {} });
  trace.setEnabled(true);
  trace.record({ stage: 'PCM_SENT', pcmSequence: 1, pcmBytes: 320 });
  assert.equal(trace.isEnabled(), true);
  assert.equal(trace.get().length, 1);
  trace.setEnabled(false);
  assert.equal(trace.isEnabled(), false);
  assert.deepEqual(trace.get(), []);
});

test('trace allowlist excludes secrets and PCM audio content', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  trace.record({
    stage: 'PCM_SENT',
    pcmSequence: 1,
    pcmBytes: 320,
    transportResult: 'sent',
    apiKey: 'secret-api-key',
    token: 'secret-token',
    Authorization: 'Bearer secret',
    credentials: { password: 'secret' },
    pcmAudioContent: new Uint8Array([1, 2, 3])
  });
  const serialized = JSON.stringify(trace.get());
  assert.equal(serialized.includes('secret-api-key'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('Bearer secret'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('pcmAudioContent'), false);
});

test('full debug trace API is exposed only while runtime trace is enabled', () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    configureLivePipelineTrace(true);
    exposeLiveTranslateDebug();
    assert.equal(typeof window.__liveTranslateDebug.getPipelineTrace, 'function');
    assert.equal(typeof window.__liveTranslateDebug.getTurnTrace, 'function');
    assert.equal(typeof window.__liveTranslateDebug.clearPipelineTrace, 'function');
    assert.equal(typeof window.__liveTranslateDebug.exportPipelineTrace, 'function');
    assert.equal(typeof window.__liveTranslateDebug.getSnapshot, 'function');

    livePipelineTrace.record({ stage: 'PCM_CAPTURED', audioTurnId: 'turn-debug' });
    assert.equal(window.__liveTranslateDebug.getTurnTrace('turn-debug').length, 1);

    configureLivePipelineTrace(false);
    exposeLiveTranslateDebug();
    assert.equal(window.__liveTranslateDebug.getPipelineTrace, undefined);
    assert.equal(window.__liveTranslateDebug.getTurnTrace, undefined);
    assert.equal(window.__liveTranslateDebug.clearPipelineTrace, undefined);
    assert.equal(window.__liveTranslateDebug.exportPipelineTrace, undefined);
  } finally {
    configureLivePipelineTrace(false);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('trace does not infer logical-turn identity from Cue identity', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  const entry = trace.record({ stage: 'CUE_CREATED', cueId: 'cue-only' });
  assert.equal(entry.turnKey, null);
  assert.equal(entry.audioTurnId, null);
});

test('trace export preserves bounded sequence and before/after transcript evidence', () => {
  const trace = createLivePipelineTrace({ enabled: true, limit: 2, logger: () => {} });
  trace.record({ stage: 'TRANSCRIPT_NORMALIZED', eventSequence: 7, sourceText: '這一句' });
  trace.record({
    stage: 'CUE_UPDATED',
    cueId: 'cue-1',
    beforeSourceText: '這一句',
    afterSourceText: '這一句不能消失。',
    beforeTranslationText: 'this sentence',
    afterTranslationText: 'this sentence cannot disappear'
  });
  trace.record({ stage: 'EVENT_DROPPED', dropReason: 'duplicate_event' });

  const entries = trace.get();
  assert.deepEqual(entries.map((entry) => entry.traceSequence), [2, 3]);
  assert.equal(entries[0].beforeSourceText, '這一句');
  assert.equal(entries[0].afterSourceText, '這一句不能消失。');
  assert.equal(entries[0].beforeTranslationText, 'this sentence');
  assert.equal(entries[0].afterTranslationText, 'this sentence cannot disappear');

  const exported = JSON.parse(trace.exportJson());
  assert.equal(exported.entryCount, 2);
  assert.deepEqual(exported.entries, entries);
  assert.equal(JSON.stringify(exported).includes('undefined'), false);
});

test('trace preserves bounded local terminal replay provenance', () => {
  const trace = createLivePipelineTrace({ enabled: true, logger: () => {} });
  trace.record({
    stage: 'CUE_UPDATED',
    eventId: 'tail:terminal-final',
    originEventId: 'tail',
    providerEventId: 'tail',
    normalizedEventId: 'tail:terminal-final',
    terminalStatus: 'local-final',
    terminalReason: 'local-silence',
    localFinalize: true,
    isTerminalReplay: true,
    sourceText: '消失。'
  });

  const entry = trace.get()[0];
  assert.equal(entry.originEventId, 'tail');
  assert.equal(entry.terminalStatus, 'local-final');
  assert.equal(entry.terminalReason, 'local-silence');
  assert.equal(entry.localFinalize, true);
  assert.equal(entry.isTerminalReplay, true);
});
