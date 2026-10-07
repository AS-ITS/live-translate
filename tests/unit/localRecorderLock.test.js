import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalRecorderLock } from '../../src/lib/localRecorderLock.js';

test('Web Lock uses one exclusive origin/profile lock per Meeting', async () => {
  const calls = [];
  const lock = createLocalRecorderLock({
    namePrefix: 'test:',
    locks: {
      async request(name, options, callback) {
        calls.push({ name, options });
        return callback({ name });
      }
    }
  });

  assert.equal(await lock.run('meeting-1', () => 'started'), 'started');
  assert.deepEqual(calls, [{ name: 'test:meeting-1', options: { mode: 'exclusive', ifAvailable: true } }]);
});

test('lock conflict returns stable recorder_already_active error', async () => {
  const lock = createLocalRecorderLock({
    locks: { async request(_name, _options, callback) { return callback(null); } }
  });

  await assert.rejects(lock.run('meeting-1', () => 'never'), (error) => error.code === 'recorder_already_active' && error.status === 409);
});

test('missing Web Locks fails closed instead of claiming cross-profile ownership', async () => {
  const lock = createLocalRecorderLock({ locks: null });
  assert.equal(lock.available, false);
  await assert.rejects(lock.run('meeting-1', () => 'never'), (error) => error.code === 'recorder_lock_unavailable' && error.status === 503);
});
