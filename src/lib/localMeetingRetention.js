import { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } from './localMeetingStorage.js';

const RECORDER_LOCK_PREFIX = 'live-translate:meeting:';
const CONTENT_LOCK_PREFIX = 'live-translate:meeting-content:';

export function createLocalMeetingRetention({
  manifestStore = createIndexedDbLocalMeetingManifestStore(),
  chunkStore = createOpfsChunkStore(),
  locks = globalThis.navigator?.locks,
  now = () => Date.now()
} = {}) {
  function expired(record) {
    const deadline = Date.parse(record?.expiresAt || '');
    return record?.deleted === true || (Number.isFinite(deadline) && deadline <= now());
  }

  async function assertReadable(meetingId) {
    const record = await manifestStore.getRetention(meetingId);
    if (expired(record)) {
      const error = new Error('錄製資料已到期');
      error.code = record?.deleted ? 'meeting_deleted' : 'meeting_content_expired';
      error.status = 410;
      throw error;
    }
  }

  async function withRead(meetingId, work) {
    await assertReadable(meetingId);
    if (!locks?.request) throw new Error('Browser content lock is unavailable.');
    return locks.request(`${CONTENT_LOCK_PREFIX}${meetingId}`, { mode: 'shared' }, async () => {
      await assertReadable(meetingId);
      return work();
    });
  }

  async function observeMeeting(meeting) {
    if (!meeting?.id) return null;
    const recording = await manifestStore.getRecording(meeting.id);
    return manifestStore.saveRetention({
      meetingId: meeting.id,
      recordingId: recording?.recordingId || null,
      seenInCloud: true,
      ...(meeting.status === 'completed' && (meeting.expiresAt || meeting.purgeAt)
        ? { expiresAt: meeting.expiresAt || meeting.purgeAt } : {})
    });
  }

  async function syncMeetings(meetings) {
    const present = new Set();
    for (const meeting of meetings) {
      if (!meeting?.id) continue;
      present.add(meeting.id);
      await observeMeeting(meeting);
    }
    for (const record of await manifestStore.listRetentions()) {
      if (record.seenInCloud && !present.has(record.meetingId)) {
        await manifestStore.saveRetention({ meetingId: record.meetingId, deleted: true });
      }
    }
    return check();
  }

  async function check(onlyMeetingId = null) {
    const records = onlyMeetingId
      ? [await manifestStore.getRetention(onlyMeetingId)].filter(Boolean)
      : await manifestStore.listRetentions();
    const result = { cleared: 0, deferred: 0, failed: 0 };
    for (const record of records) {
      if (!expired(record) || record.physicalCleared) continue;
      if (!locks?.request) { result.deferred += 1; continue; }
      try {
        await locks.request(`${RECORDER_LOCK_PREFIX}${record.meetingId}`,
          { mode: 'exclusive', ifAvailable: true }, async (recorderLock) => {
            if (!recorderLock) { result.deferred += 1; return; }
            await locks.request(`${CONTENT_LOCK_PREFIX}${record.meetingId}`,
              { mode: 'exclusive', ifAvailable: true }, async (contentLock) => {
                if (!contentLock) { result.deferred += 1; return; }
                const latest = await manifestStore.getRetention(record.meetingId);
                if (!expired(latest) || latest.physicalCleared) return;
                // Remove OPFS first. A failed IDB transaction leaves a retryable
                // index; deleting the index first could orphan audio forever.
                await chunkStore.removeMeeting(record.meetingId);
                await manifestStore.clearMeetingContent(record.meetingId);
                result.cleared += 1;
              });
          });
      } catch (error) {
        result.failed += 1;
        await manifestStore.saveRetention({ meetingId: record.meetingId,
          cleanupError: error?.code || error?.name || 'cleanup_failed' });
      }
    }
    return result;
  }

  return Object.freeze({ assertReadable, withRead, observeMeeting, syncMeetings, check });
}
