import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEnvelope,
  buildSubtitleEnvelope,
  createEnvelope,
  createReplayRequest,
  createSubtitleDataChannelAdapter,
  createSubtitleSource,
  createSubtitleState,
  mergeSubtitleEnvelope,
  SUBTITLE_ENVELOPE_TYPES
} from '../../src/webrtc/subtitleDataChannel.js';

test('Host Segment transition reaches live Viewer and survives snapshot and replay', () => {
  const source = createSubtitleSource({ meetingId: 'm-1', sourceId: 'host-1' });
  const switching = source.transition({ segmentId: 'segment-1', segmentSequence: 1, status: 'switching' });
  const ready = source.transition({ segmentId: 'segment-2', segmentSequence: 2, status: 'ready' });
  assert.equal(switching.sequence, 1);
  assert.equal(ready.sequence, 2);
  assert.equal(source.transition({ segmentId: 'segment-2', segmentSequence: 2, status: 'ready' }), null);
  assert.deepEqual(source.snapshot().segment, ready.segment);
  const replay = source.replay(createReplayRequest({ meetingId: 'm-1', requestId: 'r-1', afterSequence: 0 }));
  assert.deepEqual(replay.events.map((event) => event.type), ['segment.transition', 'segment.transition']);
  assert.throws(() => source.transition({ segmentId: 'segment-3', segmentSequence: 3, status: 'unknown' }),
    /Segment transition/u);
});

test('canonical cue envelopes support one-sided and late-arriving subtitle content', () => {
  const sourceOnly = buildSubtitleEnvelope(SUBTITLE_ENVELOPE_TYPES.cueAppend, {
    meetingId: 'm-1',
    sourceId: 'source-1',
    sequence: 1,
    cue: { cueId: 'source-first', rawSource: '原始逐字稿', sourceVersion: 8, sourceStatus: 'partial' }
  });
  assert.equal(assertEnvelope(sourceOnly), sourceOnly);
  assert.equal(sourceOnly.cue.rawSource, '原始逐字稿');

  const sourceUpdated = buildSubtitleEnvelope(SUBTITLE_ENVELOPE_TYPES.cueUpdate, {
    ...sourceOnly,
    type: undefined,
    sequence: 2,
    cue: { ...sourceOnly.cue, translatedText: 'Original transcript', translationVersion: 1, translationStatus: 'final' }
  });
  assert.equal(assertEnvelope(sourceUpdated), sourceUpdated);

  const translationOnly = buildSubtitleEnvelope(SUBTITLE_ENVELOPE_TYPES.cueAppend, {
    meetingId: 'm-1',
    sourceId: 'source-1',
    sequence: 3,
    cue: { cueId: 'translation-first', translatedText: 'Translation first', translationVersion: 4, translationStatus: 'partial' }
  });
  assert.equal(assertEnvelope(translationOnly), translationOnly);

  const translationUpdated = buildSubtitleEnvelope(SUBTITLE_ENVELOPE_TYPES.cueUpdate, {
    ...translationOnly,
    type: undefined,
    sequence: 4,
    cue: { ...translationOnly.cue, rawSource: '後到原文', sourceVersion: 1, sourceStatus: 'final' }
  });
  assert.equal(assertEnvelope(translationUpdated), translationUpdated);
});

test('canonical cue publication keeps rawSource and treats refinement metadata as optional', () => {
  const withoutRefinement = buildSubtitleEnvelope(SUBTITLE_ENVELOPE_TYPES.cueAppend, {
    meetingId: 'm-1', sourceId: 'source-1', sequence: 1,
    cue: { cueId: 'c-1', rawSource: '原始內容', sourceText: '舊欄位', sourceVersion: 1 }
  });
  assert.equal(withoutRefinement.cue.rawSource, '原始內容');
  assert.equal(withoutRefinement.cue.sourceText, '原始內容');

  const withRefinement = buildSubtitleEnvelope(SUBTITLE_ENVELOPE_TYPES.cueUpdate, {
    meetingId: 'm-1', sourceId: 'source-1', sequence: 2,
    cue: { cueId: 'c-1', rawSource: '原始內容', refinedSource: '潤飾內容', sourceVersion: 2 }
  });
  assert.equal(withRefinement.cue.rawSource, '原始內容');
  assert.equal(withRefinement.cue.sourceText, '原始內容');
  assert.equal(withRefinement.cue.refinedSource, '潤飾內容');
});

test('canonical cue publication rejects a completely empty cue', () => {
  assert.throws(() => buildSubtitleEnvelope(SUBTITLE_ENVELOPE_TYPES.cueAppend, {
    meetingId: 'm-1', sourceId: 'source-1', sequence: 1,
    cue: { cueId: 'empty', rawSource: '', translatedText: '' }
  }), /content/i);
});

test('source revision remains monotonic when side versions arrive out of order', () => {
  const source = createSubtitleSource({ meetingId: 'm-1', sourceId: 'source-1' });
  const append = source.append({ cueId: 'c-1', revision: 1, rawSource: '原文', sourceVersion: 8 });
  const update = source.update({
    cueId: 'c-1', revision: 2, rawSource: '原文', sourceVersion: 8,
    translatedText: 'translation', translationVersion: 1
  });
  assert.equal(append.type, SUBTITLE_ENVELOPE_TYPES.cueAppend);
  assert.equal(update.type, SUBTITLE_ENVELOPE_TYPES.cueUpdate);
  assert.equal(update.cue.revision, 2);
});

test('source creates bounded snapshot and replay envelopes', () => {
  const source = createSubtitleSource({ meetingId: 'm-1', sourceId: 'source-1', maxHistory: 2 });
  source.append({ cueId: 'c-1', revision: 1, sourceText: 'one' });
  source.append({ cueId: 'c-2', revision: 1, sourceText: 'two' });
  source.append({ cueId: 'c-3', revision: 1, sourceText: 'three' });
  assert.equal(source.history.length, 2);
  assert.deepEqual(source.snapshot().cues.map((cue) => cue.cueId), ['c-1', 'c-2', 'c-3']);
  const replay = source.replay(createReplayRequest({ meetingId: 'm-1', requestId: 'r-1', afterSequence: 1 }));
  assert.equal(replay.type, SUBTITLE_ENVELOPE_TYPES.replayResponse);
  assert.equal(replay.sourceId, 'source-1');
  assert.deepEqual(replay.events.map((event) => event.sequence), [2, 3]);
  assert.equal(createEnvelope(SUBTITLE_ENVELOPE_TYPES.meetingStopped, { meetingId: 'm-1' }).type, 'meeting.stopped');
});

test('source sends snapshot when replay cursor predates bounded history', () => {
  const source = createSubtitleSource({ meetingId: 'm-1', sourceId: 'source-1', maxHistory: 2 });
  for (let index = 1; index <= 4; index += 1) source.append({ cueId: `c-${index}`, revision: 1, sourceText: `text-${index}` });
  const recovered = source.replay(createReplayRequest({ meetingId: 'm-1', requestId: 'gap',
    sourceId: 'source-1', afterSequence: 1 }));
  assert.equal(recovered.type, 'snapshot');
  assert.deepEqual(recovered.cues.map((cue) => cue.cueId), ['c-1', 'c-2', 'c-3', 'c-4']);
});

test('source replays the same stream cursor and snapshots a replacement stream', () => {
  const source = createSubtitleSource({ meetingId: 'm-1', sourceId: 'source-current' });
  source.append({ cueId: 'c-1', revision: 1, sourceText: 'one' });
  source.append({ cueId: 'c-2', revision: 1, sourceText: 'two' });

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
  assert.equal(source.append({ cueId: 'c-1', revision: 1, sourceText: 'one' }).sequence, 1);
  assert.equal(source.update({ cueId: 'c-1', revision: 1, sourceText: 'duplicate' }), null);
  assert.equal(source.update({ cueId: 'c-1', revision: 2, sourceText: 'updated' }).sequence, 2);
  assert.throws(() => source.append({ cueId: 'c-2', meetingId: 'm-2', revision: 1, sourceText: 'two' }), /meetingId/);
});

test('merge accepts append/update once, rejects cross-meeting and out-of-order packets', () => {
  const append = createEnvelope('cue.append', { meetingId: 'm-1', sequence: 1, cue: { cueId: 'c-1', revision: 1, sourceText: 'one' } });
  const update = createEnvelope('cue.update', { meetingId: 'm-1', sequence: 2, cue: { cueId: 'c-1', revision: 2, sourceText: 'two' } });
  let state = mergeSubtitleEnvelope(createSubtitleState('m-1'), append);
  state = mergeSubtitleEnvelope(state, append);
  state = mergeSubtitleEnvelope(state, update);
  assert.equal(state.cues[0].sourceText, 'two');
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

test('DataChannel liveness ping and pong require a bounded request id', () => {
  const ping = createEnvelope(SUBTITLE_ENVELOPE_TYPES.livenessPing, {
    meetingId: 'm-1', requestId: 'ping-1', sentAt: 123,
  });
  const pong = createEnvelope(SUBTITLE_ENVELOPE_TYPES.livenessPong, {
    meetingId: 'm-1', requestId: 'ping-1', sentAt: 124,
  });
  assert.equal(assertEnvelope(ping).type, 'liveness.ping');
  assert.equal(assertEnvelope(pong).requestId, 'ping-1');
  assert.throws(() => createEnvelope(SUBTITLE_ENVELOPE_TYPES.livenessPing, { meetingId: 'm-1' }), /requestId/u);
});
