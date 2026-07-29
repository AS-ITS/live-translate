import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createFileSessionRepository } from '../../src/infrastructure/fileSessionRepository.js';

test('file session repository persists records and transcript items across reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-session-repo-'));
  const filePath = join(directory, 'sessions.json');
  const repository = createFileSessionRepository({ filePath, fileSystem: await import('node:fs/promises'), now: () => 1000 });

  await repository.createSessionRecord({
    id: 'session-1',
    startedAt: 900,
    targetLanguageCode: 'ja',
    meetingId: 'meeting-1',
    segmentId: 'segment-1'
  });
  await repository.appendTranscriptItem('session-1', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'Hello',
    sequence: 0,
    startedAt: 900,
    finalizedAt: 950
  });
  await repository.finalizeSessionRecord('session-1', { status: 'stopped', endedAt: 1200 });

  const reloaded = createFileSessionRepository({ filePath, fileSystem: await import('node:fs/promises'), now: () => 2000 });
  const detail = await reloaded.getSessionRecord('session-1');

  assert.equal(detail.sessionRecord.status, 'stopped');
  assert.equal(detail.sessionRecord.meetingId, 'meeting-1');
  assert.equal(detail.sessionRecord.segmentId, 'segment-1');
  assert.equal(detail.sessionRecord.durationMs, 300);
  assert.deepEqual(detail.transcriptItems.map((item) => item.text), ['Hello']);
});

test('file session repository rejects invalid storage shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-session-repo-'));
  const filePath = join(directory, 'sessions.json');
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, JSON.stringify({ records: [] }), 'utf8');

  const repository = createFileSessionRepository({ filePath, fileSystem: fs });
  await assert.rejects(repository.listSessionRecords(), /storage shape is invalid/);
});

test('file session repository writes deterministic schema wrapper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-session-repo-'));
  const filePath = join(directory, 'sessions.json');
  const fs = await import('node:fs/promises');
  const repository = createFileSessionRepository({ filePath, fileSystem: fs, now: () => 1000 });

  await repository.createSessionRecord({ id: 'session-1', startedAt: 900, targetLanguageCode: 'en' });

  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.records[0].id, 'session-1');
  assert.deepEqual(stored.transcriptItems['session-1'], []);
});
