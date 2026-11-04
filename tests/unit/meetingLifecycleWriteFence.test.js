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

test('lifecycle v2 write headers include the authoritative lifecycle version', () => {
  setMeetingLifecycleWriteFence({
    meetingId: 'meeting-2',
    sessionId: 'session-2',
    segmentId: 'segment-2',
    leaseId: 'lease-2',
    fenceToken: 5,
    lifecycleVersion: 9
  });

  assert.equal(
    meetingLifecycleWriteHeaders('meeting-2', 'segment-2')['x-meeting-lifecycle-version'],
    '9'
  );
  clearMeetingLifecycleWriteFence('meeting-2');
});

test('Host local-only token headers carry local identity without a cloud lease', () => {
  setMeetingLifecycleWriteFence({
    localOnly: true, meetingId: 'meeting-3', sessionId: 'local-session', segmentId: 'local-segment'
  });
  assert.deepEqual(meetingLifecycleWriteHeaders('meeting-3', 'local-segment'), {
    'x-host-local-recording': '1',
    'x-meeting-session-id': 'local-session',
    'x-meeting-segment-id': 'local-segment'
  });
  clearMeetingLifecycleWriteFence('meeting-3');
});
