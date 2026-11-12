import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { resolveInputAudioDownloadState } from '../../src/lib/audioArtifactDownloadState.js';

test('one original-audio download prefers the complete local artifact over duplicate cloud artifacts', () => {
  const state = resolveInputAudioDownloadState({
    inputArtifact: { status: 'ready', downloadUrl: 'blob:complete-local' },
    localUrl: '',
    cloudAudioArtifacts: [
      { id: 'cloud-1', kind: 'source_webm', status: 'ready', segmentSequence: 0 },
      { id: 'cloud-2', kind: 'source_webm', status: 'ready', segmentSequence: 1 }
    ]
  });

  assert.equal(state.source, 'local');
  assert.equal(state.downloadUrl, 'blob:complete-local');
  assert.equal(state.cloudArtifact, null);
  assert.equal(state.processing, false);
});

test('sealed local recording remains the download source without a prebuilt Blob or cloud fallback', () => {
  const state = resolveInputAudioDownloadState({
    inputArtifact: { status: 'sealed', meetingId: 'meeting-1' },
    cloudAudioArtifacts: [{ id: 'legacy-cloud', status: 'ready' }]
  });
  assert.equal(state.source, 'local');
  assert.equal(state.available, true);
  assert.equal(state.downloadUrl, '');
  assert.equal(state.cloudArtifact, null);
});

test('cloud fallback exposes only the latest complete artifact and existing audio overrides disabled preference', () => {
  const state = resolveInputAudioDownloadState({
    inputArtifact: { status: 'disabled' },
    localUrl: '',
    cloudAudioArtifacts: [
      { id: 'cloud-1', kind: 'source_webm', status: 'ready', segmentSequence: 0, createdAt: 1 },
      { id: 'cloud-2', kind: 'source_webm', status: 'ready', segmentSequence: 2, createdAt: 2 }
    ]
  });

  assert.equal(state.source, 'cloud');
  assert.equal(state.cloudArtifact.id, 'cloud-2');
  assert.equal(state.disabled, false);
});

test('pending original audio reports processing while disabled-without-artifact reports not enabled', () => {
  const processing = resolveInputAudioDownloadState({
    inputArtifact: { status: 'processing' },
    cloudAudioArtifacts: []
  });
  const disabled = resolveInputAudioDownloadState({
    inputArtifact: { status: 'disabled' },
    cloudAudioArtifacts: []
  });

  assert.equal(processing.processing, true);
  assert.equal(processing.available, false);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.available, false);
});

test('audio download UI no longer renders per-segment original-audio labels', () => {
  const source = fs.readFileSync(new URL('../../src/features/history/AudioArtifactDownloads.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /下載第 .*段原始語音/u);
  assert.doesNotMatch(source, /readyCloudArtifacts\.map/u);
});
