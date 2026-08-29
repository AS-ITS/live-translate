import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioInputDevices,
  audioOutputDevices,
  buildAudioInputConstraints,
  isMissingSelectedInputError,
  labelForDevice,
  normalizeMediaDevices,
  requestAudioInputStream,
  supportsOutputDeviceSelection
} from '../../src/lib/mediaDevices.js';

test('buildAudioInputConstraints uses browser default microphone without inputDeviceId', () => {
  assert.deepEqual(buildAudioInputConstraints(), {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    }
  });
});

test('buildAudioInputConstraints includes exact deviceId for selected microphone', () => {
  assert.deepEqual(buildAudioInputConstraints('mic-1'), {
    audio: {
      deviceId: { exact: 'mic-1' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    }
  });
});

test('normalizeMediaDevices separates audio input and output devices', () => {
  const normalized = normalizeMediaDevices([
    mediaDevice({ kind: 'audioinput', deviceId: 'mic-1', label: 'Desk Mic' }),
    mediaDevice({ kind: 'audiooutput', deviceId: 'speaker-1', label: 'Headphones' }),
    mediaDevice({ kind: 'videoinput', deviceId: 'camera-1', label: 'Camera' })
  ]);

  assert.deepEqual(normalized.inputs, [
    { kind: 'audioinput', deviceId: 'mic-1', groupId: 'group-1', label: 'Desk Mic' }
  ]);
  assert.deepEqual(normalized.outputs, [
    { kind: 'audiooutput', deviceId: 'speaker-1', groupId: 'group-1', label: 'Headphones' }
  ]);
  assert.deepEqual(audioInputDevices(normalized.inputs), normalized.inputs);
  assert.deepEqual(audioOutputDevices(normalized.outputs), normalized.outputs);
});

test('empty device labels use fallback labels', () => {
  const normalized = normalizeMediaDevices([
    mediaDevice({ kind: 'audioinput', deviceId: 'mic-1', label: '' }),
    mediaDevice({ kind: 'audiooutput', deviceId: 'speaker-1', label: '   ' })
  ]);

  assert.equal(labelForDevice({ label: '' }, 'Fallback'), 'Fallback');
  assert.equal(normalized.inputs[0].label, '麥克風 1');
  assert.equal(normalized.outputs[0].label, '揚聲器 1');
});

test('isMissingSelectedInputError handles NotFoundError', () => {
  assert.equal(isMissingSelectedInputError({ name: 'NotFoundError' }), true);
});

test('isMissingSelectedInputError handles OverconstrainedError', () => {
  assert.equal(isMissingSelectedInputError({ name: 'OverconstrainedError' }), true);
});

test('isMissingSelectedInputError handles browser Invalid constraint TypeError', () => {
  assert.equal(isMissingSelectedInputError({ name: 'TypeError', message: 'Invalid constraint' }), true);
});

test('isMissingSelectedInputError rejects unrelated errors', () => {
  assert.equal(isMissingSelectedInputError({ name: 'NotAllowedError' }), false);
  assert.equal(isMissingSelectedInputError({ name: 'TypeError', message: 'Invalid state' }), false);
  assert.equal(isMissingSelectedInputError(null), false);
});

test('requestAudioInputStream resolves a permitted stream', async () => {
  const stream = { getTracks: () => [] };
  const mediaDevices = { getUserMedia: async () => stream };

  assert.equal(await requestAudioInputStream('mic-1', { mediaDevices }), stream);
});

test('requestAudioInputStream rejects a stalled permission prompt and cleans up late streams', async () => {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const mediaDevices = {
    getUserMedia: () => new Promise((resolve) => setTimeout(() => resolve({ getTracks: () => tracks }), 20))
  };

  await assert.rejects(() => requestAudioInputStream('', { mediaDevices, timeoutMs: 1 }), { name: 'TimeoutError' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tracks[0].stopped, true);
});

test('supportsOutputDeviceSelection returns false when setSinkId is unavailable', () => {
  const previous = globalThis.HTMLMediaElement;
  Reflect.deleteProperty(globalThis, 'HTMLMediaElement');

  try {
    assert.equal(supportsOutputDeviceSelection(), false);
  } finally {
    if (previous) {
      globalThis.HTMLMediaElement = previous;
    }
  }
});

test('supportsOutputDeviceSelection returns true when setSinkId is available', () => {
  const previous = globalThis.HTMLMediaElement;
  globalThis.HTMLMediaElement = class HTMLMediaElement {};
  globalThis.HTMLMediaElement.prototype.setSinkId = async () => {};

  try {
    assert.equal(supportsOutputDeviceSelection(), true);
  } finally {
    if (previous) {
      globalThis.HTMLMediaElement = previous;
    } else {
      Reflect.deleteProperty(globalThis, 'HTMLMediaElement');
    }
  }
});

function mediaDevice({ kind, deviceId, label }) {
  return {
    kind,
    deviceId,
    label,
    groupId: 'group-1'
  };
}
