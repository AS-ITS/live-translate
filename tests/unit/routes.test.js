import assert from 'node:assert/strict';
import test from 'node:test';

function setHash(hash) {
  globalThis.window = { location: { hash } };
}

test('live recording routes resolve to the independent page', async () => {
  const { MEETING_MANAGEMENT_HASH, pageInfoFromLocation, canonicalHashForLocation } = await import('../../src/app/routes.js');

  setHash('#live?meetingId=meeting-1');
  assert.equal(pageInfoFromLocation().page, 'live-recording');
  assert.equal(canonicalHashForLocation(), '#live?meetingId=meeting-1');

  setHash('#live-recording?meetingId=meeting-1');
  assert.equal(pageInfoFromLocation().page, 'meetings');
  assert.equal(MEETING_MANAGEMENT_HASH, '#meetings');
  assert.equal(canonicalHashForLocation(), MEETING_MANAGEMENT_HASH);
});

test('settings route has an explicit meeting management return target', async () => {
  const { GEMINI_SETTINGS_HASH, MEETING_MANAGEMENT_HASH, pageInfoFromLocation, canonicalHashForLocation } = await import('../../src/app/routes.js');

  setHash(GEMINI_SETTINGS_HASH);
  assert.equal(pageInfoFromLocation().page, 'settings');
  assert.equal(canonicalHashForLocation(), GEMINI_SETTINGS_HASH);

  setHash(MEETING_MANAGEMENT_HASH);
  assert.equal(pageInfoFromLocation().page, 'meetings');
  assert.equal(canonicalHashForLocation(), MEETING_MANAGEMENT_HASH);
});

test('Gemini settings remembers the previous internal page and rejects public Viewer returns', async () => {
  const {
    MEETING_MANAGEMENT_HASH,
    consumeGeminiSettingsReturnLocation,
    rememberGeminiSettingsReturnLocation,
  } = await import('../../src/app/routes.js');

  assert.equal(rememberGeminiSettingsReturnLocation('#live?meetingId=meeting-1'), '#live?meetingId=meeting-1');
  assert.equal(consumeGeminiSettingsReturnLocation(), '#live?meetingId=meeting-1');
  assert.equal(consumeGeminiSettingsReturnLocation(), MEETING_MANAGEMENT_HASH);
  assert.equal(rememberGeminiSettingsReturnLocation('#viewer?code=PUBLIC'), MEETING_MANAGEMENT_HASH);
  assert.equal(rememberGeminiSettingsReturnLocation('#settings'), MEETING_MANAGEMENT_HASH);
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
