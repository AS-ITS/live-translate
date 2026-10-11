import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureViewerScrollAnchor,
  countUnseenViewerCues,
  isViewerAtLatestPosition,
  resolveViewerAutoFollow,
  restoreViewerScrollAnchor,
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

test('history anchor survives prepends and Cue height revisions', () => {
  const cues = [{ cueId: 'a' }, { cueId: 'b' }, { cueId: 'c' }];
  const anchor = captureViewerScrollAnchor({ cues, offsets: [0, 100, 200], scrollTop: 140 });
  const list = viewport({ scrollHeight: 520, scrollTop: 140, clientHeight: 200 });
  const merged = [{ cueId: 'older' }, ...cues];

  assert.deepEqual(anchor, { cueId: 'b', offset: 40 });
  assert.equal(restoreViewerScrollAnchor(list, anchor, merged, [0, 80, 210, 330]), true);
  assert.equal(list.scrollTop, 250);
});

test('unseen count uses stable Cue IDs and ignores revisions', () => {
  const seen = new Set(['cue-1']);
  const cues = [
    { cueId: 'cue-1', sourceVersion: 2 },
    { cueId: 'cue-2', sourceVersion: 1 },
    { cueId: 'cue-2', sourceVersion: 2 }
  ];

  assert.equal(countUnseenViewerCues(cues, seen), 1);
});
