import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeHostViewerEnvelope } from '../../src/lib/hostViewerAuthority.js';

const meetingId = 'meeting-1';
const segments = [
  { id: 'segment-1', sessionId: 'session-1', sequence: 1 },
  { id: 'segment-2', sessionId: 'session-2', sequence: 2 },
];
const initial = () => ({ meeting: { id: meetingId }, segments, cues: [] });
const cue = (cueId, segment = segments[0], version = 1) => ({
  cueId, meetingId, sessionId: segment.sessionId, segmentId: segment.id,
  sequence: 1, sourceText: `${cueId}-${version}`, sourceVersion: version,
});
const packet = (type, sequence, fields = {}) => ({
  type, meetingId, sourceId: 'host-1', sequence, ...fields,
});

test('Viewer accepts Host Segment transition without cloud Segment rows', () => {
  const local = { meeting: { id: meetingId }, segments: [], cues: [] };
  const switching = mergeHostViewerEnvelope(local, packet('segment.transition', 1, {
    segment: { segmentId: 'local-1', segmentSequence: 1, status: 'switching' }
  }));
  assert.equal(switching.hostSegment.status, 'switching');
  const ready = mergeHostViewerEnvelope(switching, packet('segment.transition', 2, {
    segment: { segmentId: 'local-2', segmentSequence: 2, status: 'ready' }
  }));
  assert.equal(ready.hostSegment.segmentId, 'local-2');
  assert.equal(ready.hostCursor.sequence, 2);
  assert.equal(mergeHostViewerEnvelope(ready, packet('segment.transition', 2, {
    segment: { segmentId: 'unexpected', segmentSequence: 3, status: 'ready' }
  })), ready);
});

test('Host snapshot, live cue, replay and stale snapshot keep latest revisions and segment order', () => {
  let detail = mergeHostViewerEnvelope(initial(), packet('snapshot', 2, { cues: [cue('first')] }));
  detail = mergeHostViewerEnvelope(detail, packet('cue.update', 3, { cue: cue('first', segments[0], 2) }));
  detail = mergeHostViewerEnvelope(detail, packet('cue.append', 4, { cue: cue('second', segments[1]) }));
  const before = detail;
  detail = mergeHostViewerEnvelope(detail, packet('snapshot', 2, { cues: [cue('first')] }));
  assert.equal(detail, before);
  detail = mergeHostViewerEnvelope(detail, packet('replay.response', 6, { toSequence: 6, events: [
    packet('cue.append', 6, { cue: cue('third', segments[1]) }),
    packet('cue.update', 5, { cue: cue('first', segments[0], 3) }),
  ] }));
  assert.deepEqual(detail.cues.map(({ cueId, segmentSequence }) => [cueId, segmentSequence]),
    [['first', 1], ['second', 2], ['third', 2]]);
  assert.equal(detail.cues[0].sourceText, 'first-3');
  assert.equal(detail.hostCursor.sequence, 6);
});

test('Host packets reject foreign meeting, session, segment and Cue identity reuse', () => {
  let detail = mergeHostViewerEnvelope(initial(), packet('cue.append', 1, { cue: cue('first') }));
  for (const invalid of [
    { ...packet('cue.append', 2, { cue: cue('foreign') }), meetingId: 'meeting-2' },
    packet('cue.append', 2, { cue: { ...cue('foreign'), sessionId: 'wrong' } }),
    packet('cue.append', 2, { cue: { ...cue('foreign'), segmentId: '' } }),
    packet('cue.update', 2, { cue: cue('first', segments[1], 2) }),
  ]) assert.equal(mergeHostViewerEnvelope(detail, invalid), detail);
  assert.equal(detail.cues.length, 1);
});

test('Host reload may publish a fresh source snapshot without discarding existing Cue versions', () => {
  let detail = mergeHostViewerEnvelope(initial(), packet('snapshot', 5, { cues: [cue('first', segments[0], 3)] }));
  detail = mergeHostViewerEnvelope(detail, { ...packet('snapshot', 1, { cues: [cue('first'), cue('second')] }), sourceId: 'host-2' });
  assert.equal(detail.cues[0].sourceText, 'first-3');
  assert.equal(detail.cues.length, 2);
  assert.equal(detail.hostCursor.sourceId, 'host-2');
});

test('new local Segment Cue does not wait for cloud metadata', () => {
  const first = packet('snapshot', 1, { cues: [cue('first')] });
  let detail = mergeHostViewerEnvelope({ ...initial(), segments: [segments[0]] }, first);
  const second = packet('cue.append', 2, { cue: cue('second', segments[1]) });
  detail = mergeHostViewerEnvelope(detail, second);
  assert.equal(detail.hostCursor.sequence, 2);
  const third = packet('cue.append', 3, { cue: cue('third') });
  detail = mergeHostViewerEnvelope(detail, third);
  assert.deepEqual(detail.cues.map((item) => item.cueId), ['first', 'third', 'second']);
  assert.equal(detail.hostCursor.sequence, 3);
  assert.equal(mergeHostViewerEnvelope(detail, second), detail);
});
test('Host only snapshot, append, update and replay survive local-only metadata', () => {
  let detail = { meeting: { id: meetingId }, segments: [], cues: [] };
  detail = mergeHostViewerEnvelope(detail, packet('snapshot', 1, { cues: [cue('first')] }));
  detail = mergeHostViewerEnvelope(detail, packet('cue.update', 2, { cue: cue('first', segments[0], 2) }));
  detail = mergeHostViewerEnvelope(detail, packet('replay.response', 4, {
    fromSequence: 2, toSequence: 4, events: [
      packet('cue.append', 3, { cue: { ...cue('second', segments[1]), segmentSequence: 2 } }),
      packet('cue.update', 4, { cue: cue('first', segments[0], 3) }),
    ],
  }));
  assert.deepEqual(detail.cues.map(({ cueId, sourceText }) => [cueId, sourceText]),
    [['first', 'first-3'], ['second', 'second-1']]);
  assert.equal(detail.hostCursor.sequence, 4);
  assert.equal(mergeHostViewerEnvelope(detail, packet('cue.append', 5, {
    cue: { ...cue('third', segments[0]), sessionId: 'wrong' },
  })), detail);
});
test('local-only Host snapshot rejects conflicting session ownership for one Segment', () => {
  const detail = { meeting: { id: meetingId }, segments: [], cues: [] };
  const snapshot = packet('snapshot', 1, { cues: [
    cue('first'), { ...cue('second'), sessionId: 'another-session' },
  ] });
  assert.equal(mergeHostViewerEnvelope(detail, snapshot), detail);
});

test('invalid replay Cue cannot acknowledge later sequence or switch source', () => {
  const detail = mergeHostViewerEnvelope(initial(), packet('snapshot', 1, { cues: [cue('first')] }));
  const invalid = packet('cue.append', 2, { cue: { ...cue('bad'), sessionId: 'wrong' } });
  const later = packet('cue.append', 3, { cue: cue('later') });
  assert.equal(mergeHostViewerEnvelope(detail, packet('replay.response', 3, {
    fromSequence: 1, toSequence: 3, events: [invalid, later],
  })), detail);
  assert.equal(mergeHostViewerEnvelope(detail, later), detail);
  assert.equal(mergeHostViewerEnvelope(detail, { ...later, sourceId: 'host-2' }), detail);
  const reloaded = mergeHostViewerEnvelope(detail, {
    ...packet('snapshot', 1, { cues: [cue('first'), cue('later')] }), sourceId: 'host-2',
  });
  assert.equal(reloaded.hostCursor.sourceId, 'host-2');
  assert.equal(reloaded.hostCursor.sequence, 1);
});

test('Replay skips an already accepted live sequence and applies the remaining gap', () => {
  let detail = mergeHostViewerEnvelope(initial(), packet('snapshot', 1, { cues: [cue('first')] }));
  detail = mergeHostViewerEnvelope(detail, packet('cue.update', 2, { cue: cue('first', segments[0], 3) }));
  detail = mergeHostViewerEnvelope(detail, packet('replay.response', 3, {
    fromSequence: 1, toSequence: 3, events: [
      packet('cue.update', 2, { cue: cue('first', segments[0], 2) }),
      packet('cue.append', 3, { cue: cue('second', segments[1]) }),
    ],
  }));
  assert.equal(detail.cues[0].sourceText, 'first-3');
  assert.equal(detail.cues[1].cueId, 'second');
  assert.equal(detail.hostCursor.sequence, 3);
});
