import assert from 'node:assert/strict';
import test from 'node:test';
import { isMeetingContentExpired, meetingContentExpiredError } from '../../src/lib/meetingRetention.js';

test('only successful, database-anchored retention expires; legacy dates remain compatible', () => {
  const now = Date.parse('2026-09-24T01:00:00.000Z');
  assert.equal(isMeetingContentExpired({ retentionPolicyVersion: 2, status: 'completed', purgeAt: '2026-09-24T00:59:59.000Z' }, now), true);
  assert.equal(isMeetingContentExpired({ retentionPolicyVersion: 2, status: 'active', purgeAt: '2026-09-24T00:00:00.000Z' }, now), false);
  assert.equal(isMeetingContentExpired({ status: 'completed', purgeAt: '2026-09-24T00:00:00.000Z' }, now), false);
});

test('expired content exposes stable HTTP 410 error', () => {
  const error = meetingContentExpiredError();
  assert.equal(error.code, 'meeting_content_expired');
  assert.equal(error.status, 410);
});
