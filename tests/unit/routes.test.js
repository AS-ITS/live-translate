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

test('translation history routes preserve record selection and content section', async () => {
  const { pageInfoFromLocation, canonicalHashForLocation } = await import('../../src/app/routes.js');

  setHash('#translation-history?recordType=session&recordId=session-1&section=translation');
  assert.equal(pageInfoFromLocation().page, 'translation-history');
  assert.equal(pageInfoFromLocation().recordType, 'session');
  assert.equal(pageInfoFromLocation().recordId, 'session-1');
  assert.equal(pageInfoFromLocation().historySection, 'translation');
  assert.equal(canonicalHashForLocation(), '#translation-history?recordType=session&recordId=session-1&section=translation');

  setHash('#history?recordType=meeting&recordId=meeting-1&section=source');
  assert.equal(pageInfoFromLocation().page, 'translation-history');
  assert.equal(pageInfoFromLocation().recordType, 'meeting');
  assert.equal(pageInfoFromLocation().recordId, 'meeting-1');
  assert.equal(pageInfoFromLocation().historySection, 'source');
  assert.equal(canonicalHashForLocation(), '#translation-history?recordType=meeting&recordId=meeting-1&section=source');

  setHash('#translation-history?recordType=meeting&recordId=meeting-1&section=overview');
  assert.equal(pageInfoFromLocation().recordType, 'meeting');
  assert.equal(pageInfoFromLocation().recordId, 'meeting-1');
  assert.equal(pageInfoFromLocation().historySection, 'overview');
  assert.equal(canonicalHashForLocation(), '#translation-history?recordType=meeting&recordId=meeting-1&section=overview');
});

test('meeting detail routes stay on the standalone record page', async () => {
  const { pageInfoFromLocation, canonicalHashForLocation } = await import('../../src/app/routes.js');

  setHash('#meeting-detail?meetingId=meeting-1&from=meetings');
  assert.equal(pageInfoFromLocation().page, 'meeting-detail');
  assert.equal(pageInfoFromLocation().meetingId, 'meeting-1');
  assert.equal(pageInfoFromLocation().meetingDetailFrom, 'meetings');
  assert.equal(canonicalHashForLocation(), '#meeting-detail?meetingId=meeting-1&from=meetings');

  setHash('#meeting-detail?meetingId=meeting-1');
  assert.equal(canonicalHashForLocation(), '#meeting-detail?meetingId=meeting-1&from=meetings');
});
