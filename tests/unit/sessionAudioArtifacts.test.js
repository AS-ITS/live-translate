import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFileSessionAudioArtifactRepository,
  sanitizeAudioArtifactsForDTO
} from '../../src/infrastructure/sessionAudioArtifacts.js';

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
