import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveViewerTransportState } from '../../src/webrtc/viewerTransportState.js';

test('Viewer UI does not remain connected when authoritative WebRTC transport is dead', () => {
  assert.equal(resolveViewerTransportState({
    webRtc: 'reconnecting', fallback: 'connected', webRtcRequired: true, everConnected: true,
  }), 'reconnecting');
  assert.equal(resolveViewerTransportState({
    webRtc: 'failed', fallback: 'failed', webRtcRequired: true, everConnected: true,
  }), 'failed');
  assert.equal(resolveViewerTransportState({
    webRtc: 'failed', fallback: 'connected', webRtcRequired: true, everConnected: true,
  }), 'failed');
  assert.equal(resolveViewerTransportState({
    webRtc: 'connected', fallback: 'reconnecting', webRtcRequired: true, everConnected: true,
  }), 'connected');
});
