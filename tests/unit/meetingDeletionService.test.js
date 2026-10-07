import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingDeletionService } from '../../src/application/meetingDeletionService.js';

function dependencies({ meetingStatus = 'completed', sessionStatuses = ['stopped'], meetingOverrides = {} } = {}) {
  const deletedSessions = [];
  const deletedAudio = [];
  const deletedMeetingAudio = [];
  const deletedShares = [];
  const meeting = { id: 'meeting-1', status: meetingStatus, ...meetingOverrides };
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
    deletedMeetingAudio,
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
      async deleteMeetingAudio(id) { deletedMeetingAudio.push(id); },
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
  assert.deepEqual(setup.deletedMeetingAudio, ['meeting-1']);
  assert.deepEqual(setup.deletedShares, ['meeting-1']);
});

test('rejects deletion while a resumable meeting or session is active', async () => {
  await assert.rejects(
    dependencies({ meetingStatus: 'active' }).service.deleteMeeting({ meetingId: 'meeting-1' }),
    (error) => error.code === 'meeting_delete_active_not_allowed'
  );
  await assert.rejects(
    dependencies({ meetingStatus: 'created', sessionStatuses: ['active'] }).service.deleteMeeting({ meetingId: 'meeting-1' }),
    (error) => error.code === 'meeting_delete_active_not_allowed'
  );
});

test('deletes a completed meeting even when an older session snapshot remains active', async () => {
  const setup = dependencies({ meetingStatus: 'completed', sessionStatuses: ['active'] });
  const result = await setup.service.deleteMeeting({ meetingId: 'meeting-1' });
  assert.equal(result.deletedSessionCount, 1);
  assert.deepEqual(setup.deletedSessions, ['session-1']);
});

test('allows only a system administrator to delete an expired meeting', async () => {
  const expiredMeeting = {
    retentionPolicyVersion: 2,
    purgeAt: '2000-01-01T00:00:00.000Z'
  };

  await assert.rejects(
    dependencies({ meetingOverrides: expiredMeeting }).service.deleteMeeting({
      meetingId: 'meeting-1',
      actorUserId: 'owner-1',
      actorRole: 'member'
    }),
    (error) => error.code === 'auth_forbidden'
  );

  const setup = dependencies({ meetingOverrides: expiredMeeting });
  const result = await setup.service.deleteMeeting({
    meetingId: 'meeting-1',
    actorUserId: 'admin-1',
    actorRole: 'super_admin'
  });
  assert.equal(result.deletedSessionCount, 1);
});

test('returns meeting_not_found without attempting cascade deletion', async () => {
  const deleted = [];
  const service = createMeetingDeletionService({
    meetingRepository: {
      async getMeeting() { return null; },
      async listMeetingSegments() { return []; },
      async deleteMeeting() { deleted.push('meeting'); }
    },
    sessionRepository: {
      async listSessionRecords() { return []; },
      async deleteSessionRecord() { deleted.push('session'); }
    }
  });

  await assert.rejects(
    service.deleteMeeting({ meetingId: 'missing-meeting' }),
    (error) => error.code === 'meeting_not_found'
  );
  assert.deepEqual(deleted, []);
});

test('cleans export artifacts before meeting cascade and stops on storage failure', async () => {
  const events = [];
  const service = createMeetingDeletionService({
    meetingRepository: {
      async getMeeting() { return { id: 'meeting-1', status: 'completed' }; },
      async listMeetingSegments() { return []; },
      async deleteMeeting() { events.push('meeting'); }
    },
    sessionRepository: {
      async listSessionRecords() { return []; },
      async deleteSessionRecord() { events.push('session'); }
    },
    async deleteMeetingExports(id) { events.push(`exports:${id}`); }
  });

  await service.deleteMeeting({ meetingId: 'meeting-1' });
  assert.deepEqual(events, ['exports:meeting-1', 'meeting']);

  const failingService = createMeetingDeletionService({
    meetingRepository: {
      async getMeeting() { return { id: 'meeting-1', status: 'completed' }; },
      async listMeetingSegments() { return []; },
      async deleteMeeting() { events.push('should-not-delete'); }
    },
    sessionRepository: {
      async listSessionRecords() { return []; },
      async deleteSessionRecord() { events.push('should-not-delete'); }
    },
    async deleteMeetingExports() { throw Object.assign(new Error('storage down'), { code: 'export_storage_delete_failed' }); }
  });
  await assert.rejects(failingService.deleteMeeting({ meetingId: 'meeting-1' }), (error) => error.code === 'export_storage_delete_failed');
  assert.equal(events.includes('should-not-delete'), false);
});
