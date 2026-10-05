import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnvelope,
  createReplayRequest,
  createSubtitleDataChannelAdapter,
  createSubtitleSource,
  createSubtitleState,
  mergeSubtitleEnvelope,
  SUBTITLE_ENVELOPE_TYPES
} from '../../src/webrtc/subtitleDataChannel.js';

test('source creates bounded snapshot and replay envelopes', () => {
  const source = createSubtitleSource({ meetingId: 'm-1', sourceId: 'source-1', maxHistory: 2 });
  source.append({ cueId: 'c-1', revision: 1, text: 'one' });
  source.append({ cueId: 'c-2', revision: 1, text: 'two' });
  source.append({ cueId: 'c-3', revision: 1, text: 'three' });
  assert.equal(source.history.length, 2);
  assert.deepEqual(source.snapshot().cues.map((cue) => cue.cueId), ['c-1', 'c-2', 'c-3']);
  const replay = source.replay(createReplayRequest({ meetingId: 'm-1', requestId: 'r-1', afterSequence: 1 }));
  assert.equal(replay.type, SUBTITLE_ENVELOPE_TYPES.replayResponse);
  assert.equal(replay.sourceId, 'source-1');
  assert.deepEqual(replay.events.map((event) => event.sequence), [2, 3]);
  assert.equal(createEnvelope(SUBTITLE_ENVELOPE_TYPES.meetingStopped, { meetingId: 'm-1' }).type, 'meeting.stopped');
});

test('source replays the same stream cursor and snapshots a replacement stream', () => {
  const source = createSubtitleSource({ meetingId: 'm-1', sourceId: 'source-current' });
  source.append({ cueId: 'c-1', revision: 1, text: 'one' });
  source.append({ cueId: 'c-2', revision: 1, text: 'two' });

  const replay = source.replay(createReplayRequest({
    meetingId: 'm-1', requestId: 'same-stream', sourceId: 'source-current', afterSequence: 1,
  }));
  assert.equal(replay.type, 'replay.response');
  assert.deepEqual(replay.events.map((event) => event.sequence), [2]);

  const replacement = source.replay(createReplayRequest({
    meetingId: 'm-1', requestId: 'old-stream', sourceId: 'source-old', afterSequence: 99,
  }));
  assert.equal(replacement.type, 'snapshot');
  assert.equal(replacement.sourceId, 'source-current');
  assert.deepEqual(replacement.cues.map((cue) => cue.cueId), ['c-1', 'c-2']);
});

test('source deduplicates cue revisions and keeps monotonic sequence', () => {
  const source = createSubtitleSource({ meetingId: 'm-1' });
  assert.equal(source.append({ cueId: 'c-1', revision: 1, text: 'one' }).sequence, 1);
  assert.equal(source.update({ cueId: 'c-1', revision: 1, text: 'duplicate' }), null);
  assert.equal(source.update({ cueId: 'c-1', revision: 2, text: 'updated' }).sequence, 2);
  assert.throws(() => source.append({ cueId: 'c-2', meetingId: 'm-2', revision: 1 }), /meetingId/);
});

test('merge accepts append/update once, rejects cross-meeting and out-of-order packets', () => {
  const append = createEnvelope('cue.append', { meetingId: 'm-1', sequence: 1, cue: { cueId: 'c-1', revision: 1, text: 'one' } });
  const update = createEnvelope('cue.update', { meetingId: 'm-1', sequence: 2, cue: { cueId: 'c-1', revision: 2, text: 'two' } });
  let state = mergeSubtitleEnvelope(createSubtitleState('m-1'), append);
  state = mergeSubtitleEnvelope(state, append);
  state = mergeSubtitleEnvelope(state, update);
  assert.equal(state.cues[0].text, 'two');
  assert.throws(() => mergeSubtitleEnvelope(state, { ...update, meetingId: 'm-2', sequence: 3 }), /mismatch/);
  assert.throws(() => mergeSubtitleEnvelope(state, { ...append, sequence: 1 }), /Out-of-order/);
});

test('DataChannel adapter waits for open, sends JSON only when open, and safely parses messages', async () => {
  const listeners = new Map();
  const channel = {
    readyState: 'connecting',
    sent: [],
    addEventListener(type, handler) { listeners.set(type, handler); },
    send(raw) { this.sent.push(raw); },
    close() { this.closed = true; }
  };
  const received = [];
  const errors = [];
  const adapter = createSubtitleDataChannelAdapter(channel, { onEnvelope: (packet) => received.push(packet), onError: (error) => errors.push(error) });
  const opened = adapter.open();
  assert.equal(adapter.send(createEnvelope('snapshot', { meetingId: 'm-1', sequence: 0, cues: [] })), false);
  channel.readyState = 'open';
  listeners.get('open')();
  await opened;
  assert.equal(adapter.send(createEnvelope('snapshot', { meetingId: 'm-1', sequence: 0, cues: [] })), true);
  listeners.get('message')({ data: channel.sent[0] });
  listeners.get('message')({ data: '{bad json' });
  assert.equal(received[0].type, 'snapshot');
  assert.equal(errors.length, 1);
  adapter.close();
  assert.equal(channel.closed, true);
});
