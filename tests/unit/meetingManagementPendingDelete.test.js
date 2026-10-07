import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingDeleteDescription } from '../../src/lib/meetingManagement.js';

test('pending delete description is derived at render time', () => {
  const meeting = { isPendingDelete: true, expiresAt: '2026-10-07T12:00:00.000Z' };
  assert.equal(pendingDeleteDescription(meeting, Date.parse('2026-10-07T12:00:00.000Z')), '已到刪除時間，可刪除');
  assert.equal(pendingDeleteDescription(meeting, Date.parse('2026-10-07T13:24:00.000Z')), '已超過刪除時間 1 小時 24 分鐘，可刪除');
});
