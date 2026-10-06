import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMeetingRetention } from '../../src/lib/localMeetingRetention.js';

function fixture(initialNow = 0) {
  let now = initialNow;
  const records = new Map();
  const recordings = new Map();
  const active = new Map();
  const removed = [];
  let failRemoval = false;
  const manifestStore = {
    getRetention: async (id) => records.get(id) || null,
    listRetentions: async () => [...records.values()],
    getRecording: async (id) => recordings.get(id) || null,
    saveRetention: async (value) => {
      const previous = records.get(value.meetingId) || {};
      const next = { ...previous, ...value,
        deleted: Boolean(previous.deleted || value.deleted),
        expiresAt: previous.expiresAt && value.expiresAt
          ? new Date(Math.min(Date.parse(previous.expiresAt), Date.parse(value.expiresAt))).toISOString()
          : previous.expiresAt || value.expiresAt || null };
      records.set(value.meetingId, next);
      return next;
    },
    clearMeetingContent: async (id) => {
      removed.push(`idb:${id}`);
      records.set(id, { ...records.get(id), physicalCleared: true });
    }
  };
  const locks = {
    async request(name, options, work) {
      const count = active.get(name) || 0;
      if (options.ifAvailable && count) return work(null);
      if (count && options.mode === 'exclusive') throw new Error('exclusive lock was not available');
      active.set(name, count + 1);
      try { return await work({ name }); }
      finally {
        if (count) active.set(name, count);
        else active.delete(name);
      }
    }
  };
  const retention = createLocalMeetingRetention({
    manifestStore,
    chunkStore: { removeMeeting: async (id) => {
      if (failRemoval) { failRemoval = false; throw new Error('OPFS failed'); }
      removed.push(`opfs:${id}`);
    } },
    locks,
    now: () => now
  });
  return { retention, records, recordings, active, removed, setNow: (value) => { now = value; }, failOnce: () => { failRemoval = true; } };
}

test('cross-computer completion keeps one durable deadline and clears only after expiry', async () => {
  const f = fixture(100);
  f.recordings.set('meeting-a', { recordingId: 'capture-a' });
  await f.retention.syncMeetings([{ id: 'meeting-a', status: 'active' }]);
  assert.equal(f.records.get('meeting-a').expiresAt, null);
  await f.retention.syncMeetings([{ id: 'meeting-a', status: 'completed', expiresAt: new Date(200).toISOString() }]);
  await f.retention.syncMeetings([{ id: 'meeting-a', status: 'completed', expiresAt: new Date(300).toISOString() }]);
  assert.equal(f.records.get('meeting-a').expiresAt, new Date(200).toISOString());
  assert.equal(f.records.get('meeting-a').recordingId, 'capture-a');
  assert.equal((await f.retention.check()).cleared, 0);
  f.setNow(200);
  assert.equal((await f.retention.check()).cleared, 1);
  assert.deepEqual(f.removed, ['opfs:meeting-a', 'idb:meeting-a']);
  await assert.rejects(f.retention.assertReadable('meeting-a'), { code: 'meeting_content_expired', status: 410 });
});

test('partial OPFS failure retains index, next check retries; absent cloud meeting is deleted', async () => {
  const f = fixture(100);
  await f.retention.syncMeetings([{ id: 'meeting-a', status: 'active' }]);
  f.failOnce();
  assert.equal((await f.retention.syncMeetings([])).failed, 1);
  assert.deepEqual(f.removed, []);
  assert.equal(f.records.get('meeting-a').physicalCleared, undefined);
  assert.equal((await f.retention.check()).cleared, 1);
  assert.deepEqual(f.removed, ['opfs:meeting-a', 'idb:meeting-a']);
});

test('recording and pre-expiry export locks defer physical cleanup without allowing new reads', async () => {
  const f = fixture(100);
  await f.retention.syncMeetings([{ id: 'meeting-a', status: 'completed', expiresAt: new Date(200).toISOString() }]);
  let releaseExport;
  const exportPromise = f.retention.withRead('meeting-a', () => new Promise((resolve) => { releaseExport = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  f.setNow(200);
  assert.equal((await f.retention.check()).deferred, 1);
  await assert.rejects(f.retention.withRead('meeting-a', async () => null), { status: 410 });
  releaseExport();
  await exportPromise;
  f.active.set('live-translate:meeting:meeting-a', 1);
  assert.equal((await f.retention.check()).deferred, 1);
  f.active.delete('live-translate:meeting:meeting-a');
  assert.equal((await f.retention.check()).cleared, 1);
});
