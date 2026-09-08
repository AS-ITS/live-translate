import assert from 'node:assert/strict';
import test from 'node:test';
import { clearMeetingAudioPreference, getMeetingAudioPreference, hasConfirmedMeetingAudioPreference, meetingAudioPreferenceKey, setMeetingAudioPreference } from '../../src/lib/meetingAudioPreferences.js';

function storage() { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }; }

test('meeting audio preference uses a meeting-scoped browser storage key', () => {
  const store = storage();
  assert.equal(meetingAudioPreferenceKey('meeting-1'), 'live-translate:meeting-audio:meeting-1');
  assert.equal(setMeetingAudioPreference('meeting-1', { inputDeviceId: 'mic-1', inputDeviceLabel: 'Desk Microphone', outputDeviceId: 'speaker-1', outputDeviceLabel: 'Headphones' }, store), true);
  const preference = getMeetingAudioPreference('meeting-1', store);
  assert.equal(preference.inputDeviceId, 'mic-1');
  assert.equal(preference.outputDeviceLabel, 'Headphones');
  assert.equal(hasConfirmedMeetingAudioPreference(preference), true);
  clearMeetingAudioPreference('meeting-1', store);
  assert.equal(getMeetingAudioPreference('meeting-1', store), null);
});
