import assert from 'node:assert/strict';
import test from 'node:test';
import { createSegmentTransitionLock } from '../../src/lib/segmentTransitionLock.js';

test('segment transition lock rejects a second transition for the same segment', () => {
  const lock = createSegmentTransitionLock();
  const release = lock.tryAcquire('meeting-1:segment-1');

  assert.equal(typeof release, 'function');
  assert.equal(lock.isLocked('meeting-1:segment-1'), true);
  assert.equal(lock.tryAcquire('meeting-1:segment-1'), null);
  assert.equal(typeof lock.tryAcquire('meeting-1:segment-2'), 'function');
});

test('segment transition lock can be reused after release', () => {
  const lock = createSegmentTransitionLock();
  const release = lock.tryAcquire('meeting-1:segment-1');

  release();
  release();

  assert.equal(lock.isLocked('meeting-1:segment-1'), false);
  assert.equal(typeof lock.tryAcquire('meeting-1:segment-1'), 'function');
});

test('segment transition lock validates keys', () => {
  const lock = createSegmentTransitionLock();

  assert.throws(() => lock.tryAcquire(''), /non-empty string/);
  assert.throws(() => lock.isLocked(null), /non-empty string/);
});
