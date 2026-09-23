import test from 'node:test';
import assert from 'node:assert/strict';

import { mapMeetingToDetailDTO, mapMeetingToHistoryListItem } from '../../src/readModels/meetingReadModels.js';

test('meeting read models expose lifecycle v2 identity without changing legacy defaults', () => {
  const meeting = {
    id: 'meeting-v2',
    status: 'active',
    lifecycleContractVersion: 2,
    lifecycleVersion: 7
  };
  const segment = {
    id: 'segment-v2',
    meetingId: meeting.id,
    sessionId: 'session-v2',
    lifecycleContractVersion: 2,
    sequence: 0,
    status: 'active',
    checkpoint: {}
  };

  const listItem = mapMeetingToHistoryListItem({ meeting, segments: [segment] });
  const detail = mapMeetingToDetailDTO({ meeting, segments: [segment] });

  assert.equal(listItem.lifecycleContractVersion, 2);
  assert.equal(listItem.lifecycleVersion, 7);
  assert.equal(detail.segments[0].sessionId, 'session-v2');
  assert.equal(detail.segments[0].lifecycleContractVersion, 2);
});
