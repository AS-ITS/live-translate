const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4'
];

const IDLE_STATE = {
  status: 'idle',
  blob: null,
  mimeType: '',
  extension: '',
  fileName: '',
  errorMessage: ''
};

export function createMicrophoneRecordingController(options = {}) {
  const MediaRecorderImpl = options.MediaRecorderImpl || globalThis.MediaRecorder;
  const BlobImpl = options.BlobImpl || globalThis.Blob;
  const collectChunks = options.collectChunks !== false;
  const preferredMimeTypes = options.preferredMimeTypes || PREFERRED_MIME_TYPES;
  const requireSupportedMimeType = options.requireSupportedMimeType === true;
  const timesliceMs = Number.isFinite(options.timesliceMs) && options.timesliceMs > 0
    ? options.timesliceMs
    : 1000;
  const now = options.now || (() => Date.now());
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
  const diagnostics = options.diagnostics || null;

  let recorder = null;
  let chunks = [];
  let sessionId = '';
  let startedAt = null;
  let selectedMimeType = '';
  let state = { ...IDLE_STATE };

  function setState(patch) {
    state = { ...state, ...patch };
    onStateChange?.(getState());
    return getState();
  }

  function getState() {
    return { ...state };
  }

  async function start(input = {}) {
    resetRecordingMetadata(input);

    if (!isRecordingSupported(MediaRecorderImpl, BlobImpl)) {
      return fail('此瀏覽器不支援本機錄音。');
    }

    if (!input.stream) {
      return fail('無法取得麥克風音訊進行錄音。');
    }

    if (requireSupportedMimeType && !selectedMimeType) {
      return fail('此瀏覽器不支援 WebM 語音錄音。');
    }

    chunks = [];
    return startRecorder(input.stream, { beginDiagnostics: true });
  }

  async function pause() {
    if (!recorder) {
      if (state.status === 'recording') {
        return setState({ status: 'paused' });
      }
      return getState();
    }

    await stopRecorder();
    if (state.status !== 'error') {
      setState({ status: 'paused' });
    }
    return getState();
  }

  async function resume(input = {}) {
    if (state.status === 'recording') {
      return getState();
    }

    if (!isRecordingSupported(MediaRecorderImpl, BlobImpl)) {
      return fail('此瀏覽器不支援本機錄音。');
    }

    if (!input.stream) {
      return fail('無法取得麥克風音訊進行錄音。');
    }

    return startRecorder(input.stream);
  }

  async function finalize() {
    if (state.status === 'ready') {
      return getState();
    }
    diagnostics?.beginFinalize?.();

    if (recorder) {
      setState({ status: 'finalizing' });
      await stopRecorder();
    }

    if (state.status === 'error') {
      return getState();
    }

    if (chunks.length === 0) {
      recorder = null;
      return setState({ ...IDLE_STATE });
    }

    const mimeType = selectedMimeType || chunks.find((chunk) => chunk?.type)?.type || '';
    const extension = extensionForMimeType(mimeType);
    const blob = new BlobImpl(chunks, mimeType ? { type: mimeType } : undefined);
    diagnostics?.finishFinalize?.(blob);
    return setState({
      status: 'ready',
      blob,
      mimeType: blob.type || mimeType,
      extension,
      fileName: buildRecordingFileName({ sessionId, startedAt, extension }),
      errorMessage: ''
    });
  }

  async function cleanup({ discard = false } = {}) {
    if (recorder) {
      await stopRecorder();
    }

    recorder = null;

    if (discard) {
      chunks = [];
      sessionId = '';
      startedAt = null;
      selectedMimeType = '';
      return setState({ ...IDLE_STATE });
    }

    if (state.status === 'recording' || state.status === 'finalizing') {
      return setState({ status: chunks.length > 0 ? 'paused' : 'idle' });
    }

    return getState();
  }

  function resetRecordingMetadata(input) {
    recorder = null;
    sessionId = input.sessionId || '';
    startedAt = input.startedAt ?? now();
    selectedMimeType = chooseSupportedMimeType(MediaRecorderImpl, preferredMimeTypes);
    state = { ...IDLE_STATE };
  }

  function startRecorder(stream, { beginDiagnostics = false } = {}) {
    try {
      recorder = selectedMimeType
        ? new MediaRecorderImpl(stream, { mimeType: selectedMimeType })
        : new MediaRecorderImpl(stream);
    } catch (error) {
      recorder = null;
      return fail(error?.message || '無法啟動本機錄音。');
    }

    const recorderMimeType = recorder.mimeType || selectedMimeType;
    if (beginDiagnostics) diagnostics?.reset?.({ mimeType: recorderMimeType });
    selectedMimeType = recorderMimeType;
    recorder.ondataavailable = (event) => {
      if (collectChunks && event?.data && dataHasContent(event.data)) {
        diagnostics?.recordRecorderChunk?.(event.data);
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      fail(event?.error?.message || event?.message || '本機錄音發生錯誤。');
    };

    try {
      recorder.start(timesliceMs);
    } catch (error) {
      recorder = null;
      return fail(error?.message || '無法啟動本機錄音。');
    }

    return setState({
      status: 'recording',
      blob: null,
      mimeType: recorderMimeType,
      extension: extensionForMimeType(recorderMimeType),
      fileName: '',
      errorMessage: ''
    });
  }

  function stopRecorder() {
    const activeRecorder = recorder;
    recorder = null;

    if (!activeRecorder || activeRecorder.state === 'inactive') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const previousStop = activeRecorder.onstop;
      activeRecorder.onstop = (event) => {
        if (typeof previousStop === 'function') {
          previousStop.call(activeRecorder, event);
        }
        resolve();
      };

      try {
        activeRecorder.stop();
      } catch {
        resolve();
      }
    });
  }

  function fail(message) {
    return setState({
      status: 'error',
      blob: null,
      errorMessage: message || '本機錄音發生錯誤。'
    });
  }

  return {
    start,
    pause,
    resume,
    finalize,
    cleanup,
    getState,
    getDiagnostics: () => diagnostics?.snapshot?.() || null
  };
}

export function chooseSupportedMimeType(MediaRecorderImpl = globalThis.MediaRecorder, preferredMimeTypes = PREFERRED_MIME_TYPES) {
  if (!MediaRecorderImpl || typeof MediaRecorderImpl.isTypeSupported !== 'function') {
    return '';
  }

  return preferredMimeTypes.find((mimeType) => MediaRecorderImpl.isTypeSupported(mimeType)) || '';
}

export function extensionForMimeType(mimeType = '') {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'm4a';
  return 'webm';
}

export function buildRecordingFileName({ sessionId = '', startedAt = null, extension = 'webm' } = {}) {
  const safeSessionId = sanitizeFilePart(sessionId) || 'session';
  const stamp = timestampForFileName(startedAt);
  return `live-translate-input-audio-${safeSessionId}-${stamp}.${extension || 'webm'}`;
}

function isRecordingSupported(MediaRecorderImpl, BlobImpl) {
  return typeof MediaRecorderImpl === 'function' && typeof BlobImpl === 'function';
}

function dataHasContent(data) {
  return typeof data.size !== 'number' || data.size > 0;
}

function sanitizeFilePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function timestampForFileName(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}
