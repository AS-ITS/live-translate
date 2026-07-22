const DEFAULT_AUDIO_INPUT_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1
};

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

export function isMissingSelectedInputError(error) {
  return error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError';
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
