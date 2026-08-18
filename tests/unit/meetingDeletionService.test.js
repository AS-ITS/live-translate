import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingDeletionService } from '../../src/application/meetingDeletionService.js';

function dependencies({ meetingStatus = 'completed', sessionStatuses = ['stopped'] } = {}) {
  const deletedSessions = [];
  const deletedAudio = [];
  const deletedShares = [];
  const meeting = { id: 'meeting-1', status: meetingStatus };
  const segments = [
    { id: 'segment-1', status: 'completed', sequence: 0 },
    { id: 'segment-2', status: 'completed', sequence: 1 }
  ];
  const records = sessionStatuses.map((status, index) => ({
    id: `session-${index + 1}`,
    meetingId: 'meeting-1',
    status,
    audioArtifacts: { translation: { storagePath: `session-${index + 1}/translation.wav` } }
  }));

  return {
    deletedSessions,
    deletedAudio,
    deletedShares,
    service: createMeetingDeletionService({
      meetingRepository: {
        async getMeeting() { return meeting; },
        async listMeetingSegments() { return segments; },
        async deleteMeeting() { return meeting; }
      },
      sessionRepository: {
        async listSessionRecords() { return records; },
        async deleteSessionRecord(id) { deletedSessions.push(id); return true; }
      },
      sessionAudioArtifactRepository: {
        async deleteMany(artifacts) { deletedAudio.push(artifacts); }
      },
      async revokeMeetingShares(id) { deletedShares.push(id); }
    })
  };
}

test('deletes all sessions, audio, segments, and shares for a meeting', async () => {
  const setup = dependencies({ sessionStatuses: ['stopped', 'failed'] });
  const result = await setup.service.deleteMeeting({ meetingId: 'meeting-1' });

  assert.equal(result.deletedSessionCount, 2);
  assert.equal(result.deletedSegmentCount, 2);
  assert.deepEqual(setup.deletedSessions, ['session-1', 'session-2']);
  assert.equal(setup.deletedAudio.length, 2);
  assert.deepEqual(setup.deletedShares, ['meeting-1']);
});

test('rejects deletion while a meeting or session is active', async () => {
  await assert.rejects(
    dependencies({ meetingStatus: 'active' }).service.deleteMeeting({ meetingId: 'meeting-1' }),
    (error) => error.code === 'meeting_delete_active_not_allowed'
  );
  await assert.rejects(
    dependencies({ sessionStatuses: ['active'] }).service.deleteMeeting({ meetingId: 'meeting-1' }),
    (error) => error.code === 'meeting_delete_active_not_allowed'
  );
});
