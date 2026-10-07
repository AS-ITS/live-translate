import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCandidate, createSignalingService } from '../../server/webrtc/signalingService.js';

const share = (id, role = 'viewer', overrides = {}) => ({
  id, role, meetingId: 'meeting-1', scope: ['webrtc:signal'], ...overrides,
});

test('rejects unauthorized, mismatched, revoked, and expired shares', () => {
  const service = createSignalingService({ clock: () => 1_000 });
  for (const invalid of [
    share('wrong-meeting', 'viewer', { meetingId: 'meeting-2' }),
    share('wrong-scope', 'viewer', { scope: ['meeting:read'] }),
    share('revoked', 'viewer', { revoked: true }),
    share('expired', 'viewer', { expiresAt: 1_000 }),
  ]) assert.throws(() => service.join({ meetingId: 'meeting-1', share: invalid }), { code: 'share_unauthorized' });
  assert.throws(() => service.join({ meetingId: 'meeting-1', share: share('role'), role: 'recorder' }), { code: 'share_unauthorized' });
});

test('enforces the per-meeting viewer cap', () => {
  const service = createSignalingService({ maxViewersPerMeeting: 2 });
  service.join({ meetingId: 'meeting-1', share: share('viewer-1') });
  service.join({ meetingId: 'meeting-1', share: share('viewer-2') });
  assert.throws(() => service.join({ meetingId: 'meeting-1', share: share('viewer-3') }), { code: 'viewer_cap_reached' });
  service.join({ meetingId: 'meeting-1', share: share('host', 'host') });
});

test('enforces signaling message byte size and TTL', () => {
  let time = 1_000;
  const service = createSignalingService({ clock: () => time, maxMessageBytes: 10, messageTtlMs: 100 });
  service.join({ meetingId: 'meeting-1', share: share('sender') });
  service.join({ meetingId: 'meeting-1', share: share('receiver') });
  assert.throws(() => service.send({ meetingId: 'meeting-1', participantId: 'sender', type: 'offer', payload: '01234567890' }), { code: 'message_too_large' });
  service.send({ meetingId: 'meeting-1', participantId: 'sender', type: 'offer', payload: 'ok' });
  time += 101;
  assert.deepEqual(service.receive({ meetingId: 'meeting-1', participantId: 'receiver' }), []);
});

test('supports bounded offer, answer, and ICE candidate exchange', () => {
  const service = createSignalingService({ iceServers: [{ urls: ['stun:stun.example.test'] }] });
  service.join({ meetingId: 'meeting-1', share: share('a') });
  service.join({ meetingId: 'meeting-1', share: share('b') });
  service.send({ meetingId: 'meeting-1', participantId: 'a', type: 'offer', payload: { sdp: 'offer' } });
  service.send({ meetingId: 'meeting-1', participantId: 'b', type: 'answer', payload: { sdp: 'answer' } });
  service.send({ meetingId: 'meeting-1', participantId: 'a', type: 'ice-candidate', payload: { candidate: 'candidate' } });
  assert.deepEqual(service.receive({ meetingId: 'meeting-1', participantId: 'b' }).map(({ type }) => type), ['offer', 'ice-candidate']);
  assert.deepEqual(service.receive({ meetingId: 'meeting-1', participantId: 'a' }).map(({ type }) => type), ['answer']);
  assert.deepEqual(service.getIceConfiguration(), { iceServers: [{ urls: ['stun:stun.example.test'] }], relayPolicy: 'direct-first' });
});

test('classifies direct candidates versus TURN relay candidates', () => {
  assert.equal(classifyCandidate('candidate:1 1 UDP 1 192.0.2.1 1000 typ host'), 'direct-candidate');
  assert.equal(classifyCandidate({ type: 'srflx' }), 'direct-candidate');
  assert.equal(classifyCandidate({ type: 'relay' }), 'turn-relay');
});
