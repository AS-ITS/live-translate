import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingReadQueryService } from '../../src/application/meetingReadQueryService.js';
import { createPcm16WavBytes } from '../../src/lib/audio.js';

test('meeting detail exposes whole-meeting audio artifact download metadata from linked session', async () => {
  const service = createMeetingReadQueryService({
    meetingRepository: {
      async listMeetings() {
        return [];
      },
      async getMeeting(id) {
        return { id, status: 'completed', startedAt: 1000, endedAt: 2000, failureInfo: null };
      },
      async listMeetingSegments(meetingId) {
        return [{
          id: 'segment-1',
          meetingId,
          sequence: 0,
          status: 'completed',
          startedAt: 1000,
          endedAt: 2000,
          checkpoint: { durableChunks: [] }
        }];
      }
    },
    sessionRepository: {
      async listSessionRecords() {
        return [{
          id: 'session-1',
          meetingId: 'meeting-1',
          startedAt: 1000,
          audioArtifacts: {
            translation: {
              kind: 'translation',
              mimeType: 'audio/wav',
              byteLength: 48,
              fileName: 'meeting-translation.wav',
              storagePath: 'session-1/translation.wav',
              createdAt: 1234
            }
          }
        }];
      }
    }
  });

  const detail = await service.getMeetingDetail('meeting-1');

  assert.deepEqual(detail.audioArtifacts.translation, {
    kind: 'translation',
    storageMode: 'meeting-composed',
    mimeType: 'audio/wav',
    byteLength: 48,
    fileName: 'live-translate-meeting-meeting-1-translation.wav',
    createdAt: 1234,
    downloadUrl: '/api/meetings/meeting-1/audio/translation'
  });
});
