import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFileSessionAudioArtifactRepository,
  sanitizeAudioArtifactsForDTO
} from '../../src/infrastructure/sessionAudioArtifacts.js';
import { createPcm16WavBytes } from '../../src/lib/audio.js';

test('file session audio artifact repository stores and reads WAV bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-audio-'));
  try {
    const repository = createFileSessionAudioArtifactRepository({
      directory,
      fileSystem: await import('node:fs/promises'),
      clock: () => 1234
    });

    const metadata = await repository.save({
      sessionId: 'session-1',
      kind: 'translation',
      bytes: Buffer.from('wav-bytes'),
      fileName: 'translated.wav'
    });
    const artifact = await repository.read(metadata);

    assert.equal(metadata.kind, 'translation');
    assert.equal(metadata.mimeType, 'audio/wav');
    assert.equal(metadata.fileName, 'translated.wav');
    assert.equal(metadata.byteLength, 9);
    assert.equal(artifact.bytes.toString('utf8'), 'wav-bytes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('audio artifact DTO exposes download URL without storage path', () => {
  const dto = sanitizeAudioArtifactsForDTO({
    input: {
      kind: 'input',
      mimeType: 'audio/wav',
      byteLength: 10,
      fileName: 'input.wav',
      storagePath: 'session-1/input.wav',
      createdAt: 1234
    }
  }, { sessionId: 'session-1' });

  assert.equal(dto.input.downloadUrl, '/api/sessions/session-1/audio/input');
  assert.equal(dto.input.storagePath, undefined);
});

test('file session audio artifact repository stores segmented WAV and reads one composed artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-audio-'));
  try {
    const repository = createFileSessionAudioArtifactRepository({
      directory,
      fileSystem: await import('node:fs/promises'),
      clock: () => 1234
    });
    const first = await repository.saveSegment({
      sessionId: 'session-1',
      kind: 'translation',
      segmentIndex: 0,
      bytes: createPcm16WavBytes(new Uint8Array([1, 0, 2, 0]), { sampleRate: 24000 })
    });
    const second = await repository.saveSegment({
      sessionId: 'session-1',
      kind: 'translation',
      segmentIndex: 1,
      bytes: createPcm16WavBytes(new Uint8Array([3, 0, 4, 0]), { sampleRate: 24000 })
    });

    const artifact = await repository.read({
      kind: 'translation',
      storageMode: 'segmented',
      mimeType: 'audio/wav',
      byteLength: first.byteLength + second.byteLength,
      fileName: 'translated.wav',
      segments: [second, first],
      createdAt: 1234
    });

    assert.equal(artifact.metadata.storageMode, 'segmented');
    assert.equal(artifact.metadata.segments[0].index, 0);
    assert.equal(artifact.bytes.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(artifact.bytes.readUInt32LE(40), 8);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('audio artifact DTO hides segmented storage paths', () => {
  const dto = sanitizeAudioArtifactsForDTO({
    translation: {
      kind: 'translation',
      storageMode: 'segmented',
      mimeType: 'audio/wav',
      byteLength: 10,
      fileName: 'translation.wav',
      segments: [{ index: 0, byteLength: 10, storagePath: 'session-1/translation-segments/000000.wav', createdAt: 1234 }],
      createdAt: 1234,
      updatedAt: 1234
    }
  }, { sessionId: 'session-1' });

  assert.equal(dto.translation.downloadUrl, '/api/sessions/session-1/audio/translation');
  assert.equal(dto.translation.segments[0].storagePath, undefined);
});
