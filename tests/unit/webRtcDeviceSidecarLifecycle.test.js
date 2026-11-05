import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcDeviceSidecarLease } from '../../src/webrtc/useWebRtcDeviceSidecar.js';

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

test('stopped lifecycle revokes only the owned Sidecar', () => {
  const ref = { current: null };
  const status = { current: 'stopped' };
  const lease = createWebRtcDeviceSidecarLease(ref, status);
  const current = transport();
  lease.attach(current);
  lease.dispose();
  assert.deepEqual(current.stops, [{ revoke: true }]);
});
