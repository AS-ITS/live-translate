import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcDeviceSidecarLease, publishCommittedLocalCues, viewerSidecarEnabled } from '../../src/webrtc/useWebRtcDeviceSidecar.js';
import { createSubtitleSource, createSubtitleState, mergeSubtitleEnvelope } from '../../src/webrtc/subtitleDataChannel.js';

test('pause flush publishes a second committed Cue before Sidecar closes', () => {
  const meetingId = 'meeting-local';
  const source = createSubtitleSource({ meetingId, sourceId: 'host-1' });
  const first = { cueId: 'cue-1', meetingId, sessionId: 'session-1', segmentId: 'segment-1',
    sequence: 1, revision: 2, sourceVersion: 2, translationVersion: 1,
    status: 'final', sourceText: 'source one', translatedText: 'translation one' };
  const second = { cueId: 'cue-2', meetingId, sessionId: 'session-1', segmentId: 'segment-1',
    sequence: 2, revision: 1, sourceVersion: 1, translationVersion: 1,
    status: 'final', sourceText: 'source two', translatedText: 'translation two' };
  let viewer = createSubtitleState(meetingId);
  viewer = mergeSubtitleEnvelope(viewer, source.append(first));
  assert.equal(viewer.cues.length, 1);
  assert.equal(viewerSidecarEnabled('stopping'), true);
  const records = [first, second].map((cue) => ({ meetingId, cueId: cue.cueId,
    sessionId: cue.sessionId, segmentId: cue.segmentId, sequence: cue.sequence, cue }));
  const committed = publishCommittedLocalCues(meetingId, records, (cue) => {
    const envelope = cue.cueId === first.cueId ? source.update(cue) : source.append(cue);
    if (envelope) viewer = mergeSubtitleEnvelope(viewer, envelope);
  });
  assert.deepEqual(committed.map((cue) => cue.cueId), ['cue-1', 'cue-2']);
  assert.deepEqual(viewer.cues.map((cue) => ({ cueId: cue.cueId, sourceText: cue.sourceText,
    translatedText: cue.translatedText, sourceVersion: cue.sourceVersion,
    translationVersion: cue.translationVersion, status: cue.status })),
    [first, second].map((cue) => ({ cueId: cue.cueId, sourceText: cue.sourceText,
      translatedText: cue.translatedText, sourceVersion: cue.sourceVersion,
      translationVersion: cue.translationVersion, status: cue.status })));
  assert.equal(viewer.sequence, source.snapshot().sequence);
  assert.equal(source.snapshot().cues.length, 2);
  assert.equal(viewerSidecarEnabled('paused'), false);
});

const transport = () => {
  const stops = [];
  return { stops, stop: (options) => { stops.push(options); } };
};

test('cleanup before Sidecar creation and repeated cleanup are safe', () => {
  const ref = { current: null };
  const status = { current: 'paused' };
  const lease = createWebRtcDeviceSidecarLease(ref, status);
  lease.dispose();
  lease.dispose();
  assert.equal(lease.disposed, true);
  assert.equal(ref.current, null);
});

test('multiple Pause and Continue cycles stop each Sidecar once', () => {
  const ref = { current: null };
  const status = { current: 'listening' };
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const lease = createWebRtcDeviceSidecarLease(ref, status);
    const current = transport();
    assert.equal(lease.attach(current), true);
    assert.equal(ref.current, current);
    status.current = 'paused';
    lease.dispose();
    lease.dispose();
    assert.deepEqual(current.stops, [{ revoke: false }]);
    assert.equal(ref.current, null);
    status.current = 'listening';
  }
});

test('old cleanup cannot clear or stop a replacement Sidecar', () => {
  const ref = { current: null };
  const status = { current: 'listening' };
  const oldLease = createWebRtcDeviceSidecarLease(ref, status);
  const oldTransport = transport();
  oldLease.attach(oldTransport);
  const newLease = createWebRtcDeviceSidecarLease(ref, status);
  const newTransport = transport();
  newLease.attach(newTransport);
  oldLease.dispose();
  assert.equal(ref.current, newTransport);
  assert.deepEqual(oldTransport.stops, [{ revoke: false }]);
  assert.deepEqual(newTransport.stops, []);
  newLease.dispose();
  assert.equal(ref.current, null);
  assert.deepEqual(newTransport.stops, [{ revoke: false }]);
});

test('Stop preserves the share and End revokes the owned Sidecar', () => {
  const ref = { current: null };
  const status = { current: 'stopped' };
  const lease = createWebRtcDeviceSidecarLease(ref, status);
  const current = transport();
  lease.attach(current);
  lease.dispose();
  assert.deepEqual(current.stops, [{ revoke: false }]);
  status.current = 'ended';
  const endedLease = createWebRtcDeviceSidecarLease(ref, status);
  const endedTransport = transport();
  endedLease.attach(endedTransport);
  endedLease.dispose();
  assert.deepEqual(endedTransport.stops, [{ revoke: true }]);
});
