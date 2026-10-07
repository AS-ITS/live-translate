import test from 'node:test';
import assert from 'node:assert/strict';
import { warmUpMicrophoneInput } from '../../src/features/live/useLiveRecordingController.js';

test('warmUpMicrophoneInput requests the selected microphone', async () => {
  const stream = { id: 'selected-stream' };
  const requestedDeviceIds = [];

  const result = await warmUpMicrophoneInput({
    inputDeviceId: 'mic-1',
    requestStream: async (deviceId) => {
      requestedDeviceIds.push(deviceId);
      return stream;
    }
  });

  assert.equal(result, stream);
  assert.deepEqual(requestedDeviceIds, ['mic-1']);
});

test('warmUpMicrophoneInput falls back to the default microphone when the selected device is missing', async () => {
  const stream = { id: 'default-stream' };
  const requestedDeviceIds = [];
  let fallbackCount = 0;

  const result = await warmUpMicrophoneInput({
    inputDeviceId: 'missing-mic',
    requestStream: async (deviceId) => {
      requestedDeviceIds.push(deviceId);
      if (deviceId) throw new DOMException('Missing microphone.', 'NotFoundError');
      return stream;
    },
    onInputDeviceFallback: () => {
      fallbackCount += 1;
    }
  });

  assert.equal(result, stream);
  assert.deepEqual(requestedDeviceIds, ['missing-mic', '']);
  assert.equal(fallbackCount, 1);
});

test('warmUpMicrophoneInput preserves permission errors', async () => {
  const error = new DOMException('Denied.', 'NotAllowedError');

  await assert.rejects(
    () => warmUpMicrophoneInput({
      inputDeviceId: 'mic-1',
      requestStream: async () => {
        throw error;
      }
    }),
    error
  );
});
