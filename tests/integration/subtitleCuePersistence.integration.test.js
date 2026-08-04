import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createMeetingCheckpointService } from '../../src/application/meetingCheckpointService.js';
import { createFileMeetingRepository } from '../../src/infrastructure/fileMeetingRepository.js';
import { createFileSessionRepository } from '../../src/infrastructure/fileSessionRepository.js';
import { createSessionReadRepository } from '../../src/repositories/sessionReadRepository.js';

test('file-backed final Cues survive reload and Session detail excludes partial checkpoint state', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'live-translate-cues-'));
  const meetingPath = join(directory, 'meetings.json');
  const sessionPath = join(directory, 'sessions.json');
  try {
    const meetings = createFileMeetingRepository({ filePath: meetingPath, fileSystem: fs });
    const sessions = createFileSessionRepository({ filePath: sessionPath, fileSystem: fs, now: () => 1, idFactory: () => 'session-1' });
    const service = createMeetingCheckpointService({ meetingRepository: meetings, sessionRepository: sessions, idGenerator: (prefix) => `${prefix}-1`, clock: () => 1000 });
    const { meeting, segment } = await service.createMeeting({ liveSessionId: 'live-1' });
    await sessions.createSessionRecord({ id: 'session-1', startedAt: 1, targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant', meetingId: meeting.id, segmentId: segment.id });
    await service.updateCheckpoint({
      meetingId: meeting.id,
      segmentId: segment.id,
      checkpoint: {
        idempotencyKey: 'cue-checkpoint-1',
        durableChunks: [],
        finalCues: [cue({ sessionId: 'session-1', segmentId: segment.id })],
        cueCheckpoint: { currentCue: { status: 'partial', sourceText: 'draft' }, pendingCues: [], nextSequence: 2, processedEventIds: ['event-1'] },
        pendingPartial: null
      }
    });

    const reloadedMeetings = createFileMeetingRepository({ filePath: meetingPath, fileSystem: fs });
    const reloadedSessions = createFileSessionRepository({ filePath: sessionPath, fileSystem: fs, now: () => 2 });
    const readRepository = createSessionReadRepository({ sessionRepository: reloadedSessions, meetingRepository: reloadedMeetings });
    const detail = await readRepository.getSessionDetail('session-1');
    assert.deepEqual(detail.cues.map(({ cueId, sequence }) => ({ cueId, sequence })), [{ cueId: 'cue:session-1:segment-1:1', sequence: 1 }]);
    assert.equal(detail.cues[0].status, 'final');
    assert.equal(detail.cues.some((item) => item.status === 'partial'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function cue(overrides = {}) {
  return {
    cueId: 'cue:session-1:segment-1:1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
    startTimeMs: 100, endTimeMs: 300, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    sourceText: '你好', translatedText: 'hello', status: 'final', finalizedReason: 'turnComplete', ...overrides
  };
}
