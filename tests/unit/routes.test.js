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

  setHash('#live-recording?meetingId=meeting-1');
  assert.equal(pageInfoFromLocation().page, 'meetings');
  assert.equal(canonicalHashForLocation(), '#meetings');
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

test('removed routes fall back to meeting management', async () => {
  const { pageInfoFromLocation, canonicalHashForLocation } = await import('../../src/app/routes.js');

  for (const hash of ['#history', '#meeting', '#retranslate', '#live-recording', '#translation-history', '#watch', '#record', '#dead-letter-queue']) {
    setHash(hash);
    assert.equal(pageInfoFromLocation().page, 'meetings');
    assert.equal(canonicalHashForLocation(), '#meetings');
  }
});

test('meeting viewer routes preserve token and short code identifiers', async () => {
  const { pageInfoFromLocation, canonicalHashForLocation } = await import('../../src/app/routes.js');

  setHash('#viewer?code=5BRGBZ27');
  assert.equal(pageInfoFromLocation().page, 'viewer');
  assert.equal(pageInfoFromLocation().shareCode, '5BRGBZ27');
  assert.equal(canonicalHashForLocation(), '#viewer?code=5BRGBZ27');
});
