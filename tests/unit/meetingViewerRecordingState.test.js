import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMeetingReadQueryService,
  viewerRecordingState
} from '../../src/application/meetingReadQueryService.js';

test('viewer recording state distinguishes waiting, active, paused, recovering, and ended', () => {
  assert.equal(viewerRecordingState({ status: 'created' }, []), 'waiting');
  assert.equal(viewerRecordingState({ status: 'active' }, [{ status: 'active' }]), 'active');
  assert.equal(viewerRecordingState({ status: 'active' }, [{ status: 'completed' }]), 'paused');
  assert.equal(viewerRecordingState({ status: 'interrupted' }, [{ status: 'interrupted' }]), 'recovering');
  assert.equal(viewerRecordingState({ status: 'completed' }, [{ status: 'completed' }]), 'ended');
  assert.equal(viewerRecordingState({ status: 'failed' }, [{ status: 'failed' }]), 'ended');
});

test('optimized viewer snapshot exposes authoritative paused state', async () => {
  const meeting = { id: 'meeting-1', status: 'active', ownerUserId: 'owner-1' };
  const repository = {
    async listMeetings() { return []; },
    async getMeeting() { return meeting; },
    async listMeetingSegments(meetingId, ownerUserId) {
      assert.equal(meetingId, meeting.id);
      assert.equal(ownerUserId, meeting.ownerUserId);
      return [{ id: 'segment-1', status: 'completed', sequence: 0 }];
    },
    async getMeetingViewerPage() {
      return { cues: [], hasMore: false, nextCursor: null };
    }
  };

  const service = createMeetingReadQueryService({ meetingRepository: repository });
  const snapshot = await service.getMeetingViewerPage(meeting.id);

  assert.equal(snapshot.recordingState, 'paused');
  assert.equal(snapshot.meeting.status, 'active');
});
