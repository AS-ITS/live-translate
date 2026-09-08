import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterMeetingManagementItems,
  meetingManagementLastUpdated,
  meetingManagementStatusLabel
} from '../../src/lib/meetingManagement.js';

const meetings = [
  { id: 'one', name: '產品評審', status: 'active', targetLanguageCode: 'ja' },
  { id: 'two', name: '已完成訪談', status: 'completed', targetLanguageCode: 'en' },
  { id: 'three', name: '待錄製會議', status: 'created', targetLanguageCode: 'en' }
];

test('Meeting home maps interrupted state to a resumable label', () => {
  assert.equal(meetingManagementStatusLabel('interrupted'), '已暫停／可繼續');
  assert.equal(meetingManagementStatusLabel('unknown'), 'unknown');
});

test('Meeting home filters by status and searchable meeting metadata', () => {
  assert.deepEqual(filterMeetingManagementItems(meetings, { status: 'completed' }).map(({ id }) => id), ['two']);
  assert.deepEqual(filterMeetingManagementItems(meetings, { query: '日文' }).map(({ id }) => id), []);
  assert.deepEqual(filterMeetingManagementItems(meetings, { query: '評審' }).map(({ id }) => id), ['one']);
  assert.deepEqual(filterMeetingManagementItems(meetings, { query: 'ja' }).map(({ id }) => id), ['one']);
});

test('Meeting home chooses the most recent available timestamp', () => {
  assert.equal(meetingManagementLastUpdated({ updatedAt: 4, endedAt: 3, startedAt: 2 }), 4);
  assert.equal(meetingManagementLastUpdated({ endedAt: 3, startedAt: 2 }), 3);
  assert.equal(meetingManagementLastUpdated({}), null);
});
