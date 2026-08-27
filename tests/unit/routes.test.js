import assert from 'node:assert/strict';
import test from 'node:test';

function setHash(hash) {
  globalThis.window = { location: { hash } };
}

test('live recording routes resolve to the independent page', async () => {
  const { pageInfoFromLocation, canonicalHashForLocation } = await import('../../src/app/routes.js');

  setHash('#live?meetingId=meeting-1');
  assert.equal(pageInfoFromLocation().page, 'live-recording');
  assert.equal(canonicalHashForLocation(), '#live?meetingId=meeting-1');

  setHash('#meeting-workspace?meetingId=meeting-1&tab=live');
  assert.equal(canonicalHashForLocation(), '#live?meetingId=meeting-1');

  setHash('#live-recording?meetingId=meeting-1');
  assert.equal(canonicalHashForLocation(), '#live?meetingId=meeting-1');
});
