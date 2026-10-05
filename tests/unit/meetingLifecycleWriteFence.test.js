import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearMeetingLifecycleWriteFence,
  meetingLifecycleWriteHeaders,
  setMeetingLifecycleWriteFence
} from '../../src/lib/meetingLifecycleWriteFence.js';

test('meeting lifecycle write headers bind session, segment, lease, and fence', () => {
  setMeetingLifecycleWriteFence({
    meetingId: 'meeting-1',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    leaseId: 'lease-1',
    fenceToken: 4
  });

  assert.deepEqual(meetingLifecycleWriteHeaders('meeting-1', 'segment-1'), {
    'x-meeting-session-id': 'session-1',
    'x-meeting-segment-id': 'segment-1',
    'x-meeting-lease-id': 'lease-1',
    'x-meeting-fence-token': '4'
  });
  assert.deepEqual(meetingLifecycleWriteHeaders('meeting-1', 'segment-old'), {});

  clearMeetingLifecycleWriteFence('meeting-1');
  assert.deepEqual(meetingLifecycleWriteHeaders('meeting-1', 'segment-1'), {});
});
