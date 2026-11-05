import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalMeetingOwnerAccess } from '../../src/lib/localMeetingOwnerAccess.js';
import { createLocalMeetingPersistence } from '../../src/lib/localMeetingPersistence.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';

function fixture() {
  let currentUser = 'owner';
  const manifestStore = createInMemoryLocalMeetingManifestStore();
  const ownerAccess = createLocalMeetingOwnerAccess({
    getUserId: async () => currentUser,
    createStorageIdentity: () => 'storage-identity-1'
  });
  const persistence = createLocalMeetingPersistence({
    manifestStore,
    chunkStore: { async write() {}, async read() { return new Blob([]); } },
    ownerAccess
  });
  return { manifestStore, ownerAccess, persistence, switchTo: (user) => { currentUser = user; } };
}

test('new local meeting binds verified owner and storage identity; another account and admin cannot read', async () => {
  const { manifestStore, persistence, switchTo } = fixture();
  await persistence.startLifecycle({ meetingId: 'meeting-1', recordingId: 'session-1', segmentId: 'segment-1' });
  assert.deepEqual(
    (({ ownerUserId, storageIdentity }) => ({ ownerUserId, storageIdentity }))(await manifestStore.getRecording('meeting-1')),
    { ownerUserId: 'owner', storageIdentity: 'storage-identity-1' }
  );
  assert.deepEqual(await persistence.listCues('meeting-1'), []);
  switchTo('other-account');
  await assert.rejects(persistence.listCues('meeting-1'), { code: 'local_owner_forbidden' });
  switchTo('super_admin');
  await assert.rejects(persistence.restore('meeting-1'), { code: 'local_owner_forbidden' });
  switchTo('owner');
  assert.equal((await persistence.restore('meeting-1')).recording.recordingId, 'session-1');
});

test('switching accounts while an asynchronous read is pending rejects its result', async () => {
  const { manifestStore, ownerAccess, persistence, switchTo } = fixture();
  await persistence.startLifecycle({ meetingId: 'meeting-1', recordingId: 'session-1', segmentId: 'segment-1' });
  let finish;
  const pending = ownerAccess.withOwner('meeting-1', manifestStore, () => new Promise((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  switchTo('other-account');
  finish('sensitive content');
  await assert.rejects(pending, { code: 'local_owner_forbidden' });
});

test('unbound legacy content stays unclaimed and unreadable', async () => {
  const { manifestStore, persistence } = fixture();
  await manifestStore.saveRecording({ meetingId: 'legacy', recordingId: 'session-old', segmentId: 'segment-old',
    segmentNumber: 1, captureEpoch: 1, providerEpoch: 0, state: 'paused' });
  await assert.rejects(persistence.listCues('legacy'), { code: 'local_owner_forbidden' });
  await assert.rejects(persistence.startLifecycle({ meetingId: 'legacy', recordingId: 'new', segmentId: 'new' }),
    { code: 'local_owner_forbidden' });
  assert.equal((await manifestStore.getRecording('legacy')).ownerUserId, null);
});
