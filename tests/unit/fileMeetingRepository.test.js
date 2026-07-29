import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createFileMeetingRepository } from '../../src/infrastructure/fileMeetingRepository.js';

test('file meeting repository persists meetings and segments across reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-meeting-repo-'));
  const filePath = join(directory, 'meetings.json');
  const fs = await import('node:fs/promises');
  const repository = createFileMeetingRepository({ filePath, fileSystem: fs });

  await repository.createMeeting({ id: 'meeting-1', createdAt: 1000 });
  await repository.updateMeeting((await repository.getMeeting('meeting-1')).activate(1100));
  const segment = await repository.createMeetingSegment({
    id: 'segment-1',
    meetingId: 'meeting-1',
    sequence: 0,
    createdAt: 1100
  });
  await repository.updateMeetingSegment(
    segment.activate(1110).withLiveSession('session-1').complete({
      endedAt: 1200,
      checkpoint: { transcriptItemId: 'source-2', offsetMs: 2000 }
    })
  );

  const reloaded = createFileMeetingRepository({ filePath, fileSystem: fs });
  const meeting = await reloaded.getMeeting('meeting-1');
  const segments = await reloaded.listMeetingSegments('meeting-1');

  assert.equal(meeting.status, 'active');
  assert.deepEqual(segments.map((item) => item.id), ['segment-1']);
  assert.equal(segments[0].status, 'completed');
  assert.equal(segments[0].liveSessionId, 'session-1');
  assert.deepEqual(segments[0].checkpoint, { transcriptItemId: 'source-2', offsetMs: 2000 });
});

test('file meeting repository rejects invalid storage shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-meeting-repo-'));
  const filePath = join(directory, 'meetings.json');
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, JSON.stringify({ meetings: [] }), 'utf8');

  const repository = createFileMeetingRepository({ filePath, fileSystem: fs });
  await assert.rejects(repository.listMeetings(), /storage shape is invalid/);
});

test('file meeting repository writes deterministic schema wrapper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-meeting-repo-'));
  const filePath = join(directory, 'meetings.json');
  const fs = await import('node:fs/promises');
  const repository = createFileMeetingRepository({ filePath, fileSystem: fs });

  await repository.createMeeting({ id: 'meeting-1', createdAt: 1000 });
  await repository.createMeetingSegment({ id: 'segment-1', meetingId: 'meeting-1', sequence: 0, createdAt: 1000 });

  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.meetings[0].id, 'meeting-1');
  assert.deepEqual(stored.segments['meeting-1'].map((segment) => segment.id), ['segment-1']);
});

test('file meeting repository preserves duplicate and missing behavior', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-meeting-repo-'));
  const filePath = join(directory, 'meetings.json');
  const fs = await import('node:fs/promises');
  const repository = createFileMeetingRepository({ filePath, fileSystem: fs });

  await repository.createMeeting({ id: 'meeting-1', createdAt: 1000 });
  await repository.createMeetingSegment({ id: 'segment-1', meetingId: 'meeting-1', sequence: 0, createdAt: 1000 });

  await assert.rejects(repository.createMeeting({ id: 'meeting-1', createdAt: 1000 }), /already exists/);
  await assert.rejects(
    repository.createMeetingSegment({ id: 'segment-2', meetingId: 'missing', sequence: 0, createdAt: 1000 }),
    /Meeting not found/
  );
  await assert.rejects(
    repository.createMeetingSegment({ id: 'segment-2', meetingId: 'meeting-1', sequence: 0, createdAt: 1000 }),
    /sequence already exists/
  );
  assert.equal(await repository.updateMeeting({ id: 'missing', createdAt: 1000 }), null);
  assert.equal(
    await repository.updateMeetingSegment({ id: 'missing', meetingId: 'meeting-1', sequence: 1, createdAt: 1000 }),
    null
  );
});
