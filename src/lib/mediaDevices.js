const DEFAULT_AUDIO_INPUT_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1
};

export const DEFAULT_MICROPHONE_PERMISSION_TIMEOUT_MS = 15000;

export function labelForDevice(device, fallbackLabel) {
  return device?.label?.trim() || fallbackLabel;
}

export function normalizeMediaDevices(devices = []) {
  const inputs = [];
  const outputs = [];

  for (const device of devices) {
    if (device.kind === 'audioinput') {
      inputs.push(normalizeDevice(device, `麥克風 ${inputs.length + 1}`));
    }

    if (device.kind === 'audiooutput') {
      outputs.push(normalizeDevice(device, `揚聲器 ${outputs.length + 1}`));
    }
  }

  return { inputs, outputs };
}

export function audioInputDevices(devices = []) {
  return normalizeMediaDevices(devices).inputs;
}

export function audioOutputDevices(devices = []) {
  return normalizeMediaDevices(devices).outputs;
}

export function buildAudioInputConstraints(inputDeviceId = '') {
  return {
    audio: {
      ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
      ...DEFAULT_AUDIO_INPUT_CONSTRAINTS
    }
  };
}

export function requestAudioInputStream(inputDeviceId = '', {
  timeoutMs = DEFAULT_MICROPHONE_PERMISSION_TIMEOUT_MS,
  mediaDevices = globalThis.navigator?.mediaDevices
} = {}) {
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    return Promise.reject(new DOMException('Microphone access is unavailable.', 'NotSupportedError'));
  }

  let request;
  try {
    request = Promise.resolve(mediaDevices.getUserMedia(buildAudioInputConstraints(inputDeviceId)));
  } catch (error) {
    return Promise.reject(error);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return request;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DOMException('Microphone permission request timed out.', 'TimeoutError'));
      void request.then((stream) => stopMediaStream(stream)).catch(() => {});
    }, timeoutMs);

    request.then((stream) => {
      if (settled) {
        stopMediaStream(stream);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(stream);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function isMissingSelectedInputError(error) {
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
    return true;
  }

  return error?.name === 'TypeError' && /invalid constraint/i.test(error?.message || '');
}

export function supportsOutputDeviceSelection() {
  return Boolean(globalThis.HTMLMediaElement?.prototype?.setSinkId);
}

function normalizeDevice(device, fallbackLabel) {
  return {
    deviceId: device.deviceId,
    groupId: device.groupId,
    kind: device.kind,
    label: labelForDevice(device, fallbackLabel)
  };
}

function stopMediaStream(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop?.();
}
