import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingReadQueryService } from '../../src/application/meetingReadQueryService.js';

test('meeting detail and viewer reads return stable 410 after the v2 purge deadline', async () => {
  const meeting = {
    id: 'meeting-1',
    status: 'completed',
    lifecycleContractVersion: 2,
    purgeAt: '2020-01-01T00:00:00.000Z'
  };
  const repository = {
    async getMeeting() { return meeting; },
    async listMeetingSegments() { throw new Error('must not read expired content'); },
    async listMeetings() { return []; }
  };
  const service = createMeetingReadQueryService({ meetingRepository: repository });

  await assert.rejects(() => service.getMeetingDetail('meeting-1'), (error) => error.code === 'meeting_content_expired' && error.status === 410);
  await assert.rejects(() => service.getMeetingViewerPage('meeting-1'), (error) => error.code === 'meeting_content_expired' && error.status === 410);
});
