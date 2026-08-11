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
