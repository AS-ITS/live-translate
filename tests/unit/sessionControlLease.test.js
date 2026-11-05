import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionControlLease } from '../../src/lib/sessionControlLease.js';

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function eventTarget() {
  return {
    addEventListener() {},
    removeEventListener() {}
  };
}

test('only one tab can control a Session at a time', () => {
  const sharedStorage = storage();
  const first = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'tab-1' });
  const second = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'tab-2' });

  assert.equal(first.tryAcquire('session-1'), true);
  assert.equal(first.owns('session-1'), true);
  assert.equal(second.tryAcquire('session-2'), false);
  assert.equal(second.owns('session-2'), false);

  first.release();
  assert.equal(second.tryAcquire('session-2'), true);
  assert.equal(second.owns('session-2'), true);

  first.destroy();
  second.destroy();
});

test('an expired lease does not get taken over automatically', () => {
  const sharedStorage = storage();
  let now = 1000;
  const first = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'tab-1', clock: () => now, heartbeatMs: 60000, ttlMs: 100 });
  const second = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'tab-2', clock: () => now, heartbeatMs: 60000, ttlMs: 100 });

  assert.equal(first.tryAcquire('session-1'), true);
  now = 1200;
  assert.equal(second.current(), null);
  assert.equal(second.tryAcquire('session-2'), true);
  assert.equal(second.owns('session-2'), true);

  first.destroy();
  second.destroy();
});

test('destroy releases the tab control lease', () => {
  const sharedStorage = storage();
  const first = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'tab-1' });
  const second = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'tab-2' });

  assert.equal(first.tryAcquire('session-1'), true);
  first.destroy();
  assert.equal(second.tryAcquire('session-2'), true);

  second.destroy();
});

test('an expired foreign lease clears the subscribed readonly state without taking control', async () => {
  const sharedStorage = storage();
  sharedStorage.setItem('live-translate:session-control', JSON.stringify({
    sessionId: 'old-session', tabId: 'closed-tab', updatedAt: Date.now()
  }));
  const lease = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'new-tab', ttlMs: 30 });
  const snapshots = [];
  lease.subscribe((snapshot) => snapshots.push(snapshot));

  assert.equal(snapshots.at(-1)?.sessionId, 'old-session');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(snapshots.at(-1), null);
  assert.equal(lease.isHeldByAnotherTab(), false);
  assert.equal(lease.tryAcquire('new-session'), true);
  lease.destroy();
});

test('a live owner heartbeat keeps the second tab readonly', async () => {
  const sharedStorage = storage();
  const first = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'tab-1', heartbeatMs: 10, ttlMs: 40 });
  const second = createSessionControlLease({ storage: sharedStorage, eventTarget: eventTarget(), tabId: 'tab-2', ttlMs: 40 });
  assert.equal(first.tryAcquire('first-meeting-session'), true);
  const snapshots = [];
  second.subscribe((snapshot) => snapshots.push(snapshot));

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(snapshots.at(-1)?.sessionId, 'first-meeting-session');
  assert.equal(second.tryAcquire('second-meeting-session'), false);
  first.release();
  assert.equal(first.tryAcquire('new-meeting-session'), true);
  first.destroy();
  second.destroy();
});
