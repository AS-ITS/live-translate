import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioUploadController } from '../../src/lib/audioUploadController.js';

function refs() {
  return {
    chunks: { input: { current: [] }, translation: { current: [] } },
    metadata: { input: { current: { sessionId: 'session-1', startedAt: 1000 } }, translation: { current: { sessionId: 'session-1', startedAt: 1000 } } },
    segments: { current: { input: { nextIndex: 0, lastFlushedAt: 0, inFlight: false, currentPromise: null }, translation: { nextIndex: 0, lastFlushedAt: 0, inFlight: false, currentPromise: null } } },
    retryTimers: { current: { input: null, translation: null } },
    retryAttempts: { current: { input: 0, translation: 0 } }
  };
}

test('audio upload controller flushes a segment and advances its index', async () => {
  const state = refs();
  state.chunks.input.current = [new Uint8Array([1, 2, 3, 4])];
  const calls = [];
  const controller = createAudioUploadController({
    ...state,
    getActiveSessionId: () => 'session-1',
    setError: () => {},
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; },
    now: () => 10_000
  });

  assert.equal(await controller.flush('input', { force: true }), true);
  assert.equal(calls[0].url, '/api/sessions/session-1/audio/input/segments/0');
  assert.equal(calls[0].init.headers['Content-Type'], 'audio/wav');
  assert.equal(state.chunks.input.current.length, 0);
  assert.equal(state.segments.current.input.nextIndex, 1);
});

test('audio upload controller restores chunks and schedules retry for transient failures', async () => {
  const state = refs();
  const original = new Uint8Array([5, 6]);
  state.chunks.input.current = [original];
  const timers = [];
  const controller = createAudioUploadController({
    ...state,
    getActiveSessionId: () => 'session-1',
    setError: () => {},
    fetchImpl: async () => ({ ok: false, status: 503 }),
    windowImpl: { setTimeout: (fn, delay) => { timers.push({ fn, delay }); return 1; }, clearTimeout: () => {} },
    now: () => 10_000
  });

  await assert.rejects(controller.flush('input', { force: true }), /HTTP 503/);
  assert.deepEqual(state.chunks.input.current, [original]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5000);
});

test('failed input upload keeps a bounded retry backlog and reports discarded PCM', async () => {
  const state = refs();
  state.chunks.input.current = [new Uint8Array([1, 2, 3, 4])];
  const errors = [];
  const controller = createAudioUploadController({
    ...state,
    getActiveSessionId: () => 'session-1',
    setError: (message) => errors.push(message),
    fetchImpl: async () => {
      state.chunks.input.current.push(new Uint8Array([5, 6, 7, 8]), new Uint8Array([9, 10, 11, 12]));
      return { ok: false, status: 503 };
    },
    windowImpl: { setTimeout: () => 1, clearTimeout: () => {} },
    maxInputBufferedBytes: 8,
    now: () => 10_000
  });
  await assert.rejects(controller.flush('input', { force: true }), /HTTP 503/);
  assert.equal(state.chunks.input.current.reduce((sum, chunk) => sum + chunk.byteLength, 0), 8);
  assert.match(errors.at(-1), /已捨棄/);
});
