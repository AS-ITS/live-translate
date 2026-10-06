import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingReadQueryService } from '../../src/application/meetingReadQueryService.js';
import { createPcm16WavBytes } from '../../src/lib/audio.js';

test('expired recording still returns settings but neither segments nor audio', async () => {
  const expired = { id: 'meeting-expired', name: 'settings retained', status: 'completed',
    retentionPolicyVersion: 2, purgeAt: '2000-01-01T00:30:00.000Z' };
  let contentReads = 0;
  const service = createMeetingReadQueryService({ meetingRepository: {
    async listMeetings() { return [expired]; },
    async getMeeting() { return expired; },
    async listMeetingSegments() { contentReads += 1; return []; }
  } });
  const history = await service.listMeetingHistory();
  const detail = await service.getMeetingDetail(expired.id);
  assert.equal(history[0].contentState, 'expired');
  assert.equal(detail.meeting.name, 'settings retained');
  assert.equal(detail.meeting.contentState, 'expired');
  assert.deepEqual(detail.cues, []);
  assert.deepEqual(detail.cloudAudioArtifacts, []);
  assert.equal(contentReads, 0);
  await assert.rejects(service.getMeetingViewerPage(expired.id), { code: 'meeting_content_expired', status: 410 });
});

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

test('meeting detail exposes ready private Storage artifacts by segment without a permanent URL', async () => {
  const service = createMeetingReadQueryService({
    meetingRepository: {
      async listMeetings() { return []; },
      async getMeeting(id) { return { id, status: 'completed' }; },
      async listMeetingSegments(meetingId) {
        return [{ id: 'segment-1', meetingId, sequence: 2, status: 'completed', checkpoint: { durableChunks: [] } }];
      }
    },
    sessionRepository: { async listSessionRecords() { return []; } },
    meetingAudioService: {
      async listMeetingArtifacts(meetingId) {
        return [{
          id: 'artifact-1',
          meetingId,
          segmentId: 'segment-1',
          kind: 'source_webm',
          status: 'ready',
          fileName: 'recording.webm',
          byteSize: 321,
          mimeType: 'audio/webm',
          createdAt: '2026-09-09T00:00:00.000Z'
        }];
      }
    }
  });

  const detail = await service.getMeetingDetail('meeting-1');

  assert.deepEqual(detail.cloudAudioArtifacts, [{
    id: 'artifact-1',
    meetingId: 'meeting-1',
    segmentId: 'segment-1',
    segmentSequence: 2,
    kind: 'source_webm',
    status: 'ready',
    fileName: 'recording.webm',
    byteSize: 321,
    mimeType: 'audio/webm',
    createdAt: '2026-09-09T00:00:00.000Z'
  }]);
  assert.equal('downloadUrl' in detail.cloudAudioArtifacts[0], false);
});

test('meeting detail normalizes legacy glossary aliases in meeting and segment snapshots', async () => {
  const service = createMeetingReadQueryService({
    meetingRepository: {
      async listMeetings() { return []; },
      async getMeeting(id) {
        return {
          id,
          status: 'active',
          targetLanguageCode: 'en',
          glossaryEntries: [{ source: 'microphone', target: 'Alan speak', replacementAliases: { en: ['mic'] } }]
        };
      },
      async listMeetingSegments(meetingId) {
        return [{
          id: 'segment-1', meetingId, sequence: 0, status: 'active',
          settingsSnapshot: {
            targetLanguageCode: 'en',
            glossaryEntries: [{ source: 'microphone', target: 'Alan speak', replacementAliases: { en: ['mic'] } }]
          },
          checkpoint: { durableChunks: [] }
        }];
      }
    }
  });

  const detail = await service.getMeetingDetail('meeting-1');

  assert.deepEqual(detail.meeting.glossaryEntries[0].replacementAliases, ['mic']);
  assert.deepEqual(detail.segments[0].settingsSnapshot.glossaryEntries[0].replacementAliases, ['mic']);
});
