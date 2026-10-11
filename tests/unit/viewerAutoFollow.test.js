import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isViewerAtLatestPosition,
  resolveViewerAutoFollow,
  scrollViewerToLatest
} from '../../src/lib/viewerAutoFollow.js';

function viewport({ scrollHeight = 0, scrollTop = 0, clientHeight = 300 } = {}) {
  return {
    scrollHeight,
    scrollTop,
    clientHeight,
    scrollTo({ top }) {
      this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
    }
  };
}

test('Viewer follows the latest position while twenty Cues are appended', () => {
  const list = viewport();
  for (let cue = 1; cue <= 20; cue += 1) {
    list.scrollHeight = cue * 84;
    scrollViewerToLatest(list);
    assert.equal(isViewerAtLatestPosition(list), true);
  }
});

test('Partial to Final height changes remain anchored to the latest Cue', () => {
  const list = viewport({ scrollHeight: 420, scrollTop: 120 });
  list.scrollHeight = 560;
  scrollViewerToLatest(list);
  assert.equal(list.scrollTop, 260);
  assert.equal(isViewerAtLatestPosition(list), true);
});

test('programmatic layout and viewport changes do not disable auto-follow', () => {
  const list = viewport({ scrollHeight: 720, scrollTop: 420 });
  assert.equal(resolveViewerAutoFollow({ following: true, userInitiated: false, viewport: list }), true);
  list.clientHeight = 240;
  scrollViewerToLatest(list);
  assert.equal(isViewerAtLatestPosition(list), true);
});

test('manual upward scrolling disables auto-follow', () => {
  const list = viewport({ scrollHeight: 900, scrollTop: 200 });
  assert.equal(resolveViewerAutoFollow({ following: true, userInitiated: true, viewport: list }), false);
});

test('new Cue layout does not force a manually paused reader to the bottom', () => {
  const list = viewport({ scrollHeight: 984, scrollTop: 200 });
  assert.equal(resolveViewerAutoFollow({ following: false, userInitiated: false, viewport: list }), false);
  assert.equal(list.scrollTop, 200);
});

test('return to latest scrolls immediately and restores auto-follow', () => {
  const list = viewport({ scrollHeight: 984, scrollTop: 200 });
  scrollViewerToLatest(list);
  assert.equal(list.scrollTop, 684);
  assert.equal(resolveViewerAutoFollow({ following: false, userInitiated: false, viewport: list }), true);
});
