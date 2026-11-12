import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecordingFileName,
  chooseSupportedMimeType,
  createMicrophoneRecordingController,
  extensionForMimeType
} from '../../src/lib/microphoneRecording.js';
import { createRecordingDiagnostics } from '../../src/lib/recordingDiagnostics.js';

test('chooseSupportedMimeType uses preferred supported recording format', () => {
  const MediaRecorderImpl = mockMediaRecorderClass({
    supportedTypes: new Set(['audio/webm', 'audio/mp4'])
  });

  assert.equal(chooseSupportedMimeType(MediaRecorderImpl), 'audio/webm');
});

test('chooseSupportedMimeType falls back to browser default when support probing is unavailable', () => {
  class MediaRecorderWithoutProbe {}

  assert.equal(chooseSupportedMimeType(MediaRecorderWithoutProbe), '');
});

test('extensionForMimeType maps supported audio containers', () => {
  assert.equal(extensionForMimeType('audio/webm;codecs=opus'), 'webm');
  assert.equal(extensionForMimeType('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(extensionForMimeType('audio/mp4'), 'm4a');
  assert.equal(extensionForMimeType(''), 'webm');
});

test('buildRecordingFileName includes sanitized session id and start timestamp', () => {
  assert.equal(
    buildRecordingFileName({
      sessionId: 'Session:ABC/123',
      startedAt: Date.UTC(2026, 6, 30, 12, 34, 56),
      extension: 'ogg'
    }),
    'live-translate-input-audio-session-abc-123-20260730-123456.ogg'
  );
});

test('controller records start, pause, resume, and finalize chunks into one blob', async () => {
  const recorderInstances = [];
  const MediaRecorderImpl = mockMediaRecorderClass({
    supportedTypes: new Set(['audio/webm;codecs=opus']),
    instances: recorderInstances
  });
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl,
    BlobImpl: Blob,
    now: () => Date.UTC(2026, 6, 30, 1, 2, 3)
  });

  assert.deepEqual(await controller.start({ stream: fakeStream(), sessionId: 'session-1' }), {
    status: 'recording',
    blob: null,
    mimeType: 'audio/webm;codecs=opus',
    extension: 'webm',
    fileName: '',
    errorMessage: ''
  });
  recorderInstances[0].emitChunk(new Blob(['first'], { type: 'audio/webm;codecs=opus' }));
  await controller.pause();
  assert.equal(controller.getState().status, 'paused');

  await controller.resume({ stream: fakeStream() });
  recorderInstances[1].emitChunk(new Blob(['second'], { type: 'audio/webm;codecs=opus' }));

  const finalized = await controller.finalize();
  assert.equal(finalized.status, 'ready');
  assert.equal(finalized.mimeType, 'audio/webm;codecs=opus');
  assert.equal(finalized.extension, 'webm');
  assert.equal(finalized.fileName, 'live-translate-input-audio-session-1-20260730-010203.webm');
  assert.equal(await finalized.blob.text(), 'firstsecond');
  assert.equal(recorderInstances[0].startTimesliceMs, 1000);
});

test('controller records bounded diagnostics without changing recording state shape', async () => {
  const recorderInstances = [];
  const diagnostics = createRecordingDiagnostics({ enabled: true, now: () => 100 });
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ instances: recorderInstances }),
    BlobImpl: Blob,
    diagnostics
  });

  await controller.start({ stream: fakeStream(), sessionId: 'session-diagnostics' });
  recorderInstances[0].emitChunk(new Blob(['first'], { type: 'audio/webm' }));
  const finalized = await controller.finalize();

  assert.equal(finalized.status, 'ready');
  assert.equal(controller.getDiagnostics().chunkCount, 1);
  assert.equal(controller.getDiagnostics().finalizedBlobBytes, 5);
  assert.equal(controller.getState().diagnostics, undefined);
});

test('controller can track recording state without retaining MediaRecorder chunks', async () => {
  const recorderInstances = [];
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ instances: recorderInstances }),
    BlobImpl: Blob,
    collectChunks: false
  });

  await controller.start({ stream: fakeStream(), sessionId: 'session-no-buffer' });
  recorderInstances[0].emitChunk(new Blob(['discarded'], { type: 'audio/webm' }));
  const state = await controller.cleanup({ discard: true });

  assert.equal(state.status, 'idle');
  assert.equal(state.blob, null);
});

test('controller serializes local chunk writes and waits for them before finalize', async () => {
  const recorderInstances = [];
  const writes = [];
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ instances: recorderInstances }),
    BlobImpl: Blob,
    onChunk: async (chunk) => {
      await Promise.resolve();
      writes.push({ sequence: chunk.sequence, text: await chunk.data.text() });
    }
  });

  await controller.start({ stream: fakeStream(), sessionId: 'session-spool' });
  recorderInstances[0].emitChunk(new Blob(['one'], { type: 'audio/webm' }));
  recorderInstances[0].emitChunk(new Blob(['two'], { type: 'audio/webm' }));
  await controller.finalize();

  assert.deepEqual(writes, [{ sequence: 1, text: 'one' }, { sequence: 2, text: 'two' }]);
});

test('local chunk write failure makes finalize independently recoverable', async () => {
  const recorderInstances = [];
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ instances: recorderInstances }),
    BlobImpl: Blob,
    onChunk: async () => { throw new Error('OPFS quota exceeded'); }
  });

  await controller.start({ stream: fakeStream(), sessionId: 'session-spool-error' });
  recorderInstances[0].emitChunk(new Blob(['one'], { type: 'audio/webm' }));
  const state = await controller.finalize();

  assert.equal(state.status, 'error');
  assert.equal(state.errorMessage, 'OPFS quota exceeded');
});

test('controller methods are idempotent around empty pause, finalize, and cleanup', async () => {
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass(),
    BlobImpl: Blob
  });

  assert.equal((await controller.pause()).status, 'idle');
  assert.equal((await controller.finalize()).status, 'idle');
  assert.equal((await controller.cleanup()).status, 'idle');

  await controller.start({ stream: fakeStream(), sessionId: 'session-2', startedAt: 1000 });
  await controller.pause();
  assert.equal((await controller.pause()).status, 'paused');
  assert.equal((await controller.cleanup({ discard: true })).status, 'idle');
  assert.equal(controller.getState().blob, null);
});

test('stale MediaRecorder callbacks from a replaced capture epoch are ignored', async () => {
  const recorderInstances = [];
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ instances: recorderInstances }),
    BlobImpl: Blob
  });

  await controller.start({ stream: fakeStream(), sessionId: 'session-epoch' });
  await controller.pause();
  await controller.resume({ stream: fakeStream() });
  recorderInstances[0].emitChunk(new Blob(['stale'], { type: 'audio/webm' }));
  recorderInstances[1].emitChunk(new Blob(['current'], { type: 'audio/webm' }));

  const finalized = await controller.finalize();
  assert.equal(await finalized.blob.text(), 'current');
});

test('rapid duplicate Start creates one MediaRecorder owner and stale callbacks cannot cross capture epochs', async () => {
  const recorderInstances = [];
  const writes = [];
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ instances: recorderInstances }),
    BlobImpl: Blob,
    onChunk: async (chunk) => writes.push(await chunk.data.text())
  });
  const firstStream = fakeStream();

  await Promise.all([
    controller.start({ stream: firstStream, sessionId: 'session-rapid' }),
    controller.start({ stream: firstStream, sessionId: 'session-rapid' })
  ]);
  assert.equal(recorderInstances.length, 1);

  await controller.pause();
  await controller.resume({ stream: fakeStream() });
  recorderInstances[0].emitChunk(new Blob(['stale'], { type: 'audio/webm' }));
  recorderInstances[1].emitChunk(new Blob(['current'], { type: 'audio/webm' }));
  await controller.finalize();

  assert.deepEqual(writes, ['current']);
});

test('pause waits for the final dataavailable chunk and its asynchronous writer before continuing', async () => {
  const recorderInstances = [];
  const BaseMediaRecorder = mockMediaRecorderClass({ instances: recorderInstances });
  let releaseWrite;
  const writeBarrier = new Promise((resolve) => { releaseWrite = resolve; });
  class FinalChunkMediaRecorder extends BaseMediaRecorder {
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.emitChunk(new Blob(['final'], { type: 'audio/webm' }));
        this.onstop?.({});
      });
    }
  }
  const writes = [];
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: FinalChunkMediaRecorder,
    BlobImpl: Blob,
    onChunk: async (chunk) => {
      await writeBarrier;
      writes.push(await chunk.data.text());
    }
  });

  await controller.start({ stream: fakeStream(), sessionId: 'session-final-chunk' });
  let paused = false;
  const pause = controller.pause().then((state) => { paused = true; return state; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(paused, false);

  releaseWrite();
  assert.equal((await pause).status, 'paused');
  assert.deepEqual(writes, ['final']);
});

test('failed input replacement can resume the previous stream without accepting stale callbacks', async () => {
  const recorderInstances = [];
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ instances: recorderInstances }),
    BlobImpl: Blob
  });
  const originalStream = fakeStream();

  await controller.start({ stream: originalStream, sessionId: 'session-device-recovery' });
  await controller.pause();
  assert.equal((await controller.resume({ stream: null })).status, 'error');
  assert.equal((await controller.resume({ stream: originalStream })).status, 'recording');
  recorderInstances[0].emitChunk(new Blob(['stale'], { type: 'audio/webm' }));
  recorderInstances[1].emitChunk(new Blob(['recovered'], { type: 'audio/webm' }));

  assert.equal(await (await controller.finalize()).blob.text(), 'recovered');
});

test('recorder error becomes independent error state', async () => {
  const recorderInstances = [];
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ instances: recorderInstances }),
    BlobImpl: Blob
  });

  await controller.start({ stream: fakeStream(), sessionId: 'session-error' });
  recorderInstances[0].emitError(new Error('recorder failed'));

  const state = controller.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.errorMessage, 'recorder failed');
});

test('unsupported MediaRecorder reports error without throwing', async () => {
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: undefined,
    BlobImpl: Blob
  });

  const state = await controller.start({ stream: fakeStream(), sessionId: 'session-3' });
  assert.equal(state.status, 'error');
  assert.match(state.errorMessage, /不支援本機錄音/);
});

test('controller can require WebM instead of falling back to another container', async () => {
  const controller = createMicrophoneRecordingController({
    MediaRecorderImpl: mockMediaRecorderClass({ supportedTypes: new Set(['audio/mp4']) }),
    BlobImpl: Blob,
    preferredMimeTypes: ['audio/webm;codecs=opus', 'audio/webm'],
    requireSupportedMimeType: true
  });

  const state = await controller.start({ stream: fakeStream(), sessionId: 'session-webm' });

  assert.equal(state.status, 'error');
  assert.match(state.errorMessage, /WebM/);
});

function fakeStream() {
  return { id: `stream-${Math.random()}` };
}

function mockMediaRecorderClass({ supportedTypes = new Set(['audio/webm;codecs=opus']), instances = [] } = {}) {
  return class MockMediaRecorder {
    static isTypeSupported(mimeType) {
      return supportedTypes.has(mimeType);
    }

    constructor(stream, options = {}) {
      this.stream = stream;
      this.mimeType = options.mimeType || '';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onerror = null;
      this.onstop = null;
      instances.push(this);
    }

    start(timesliceMs) {
      this.state = 'recording';
      this.startTimesliceMs = timesliceMs;
    }

    stop() {
      this.state = 'inactive';
      this.onstop?.({});
    }

    emitChunk(data) {
      this.ondataavailable?.({ data });
    }

    emitError(error) {
      this.onerror?.({ error });
    }
  };
}
