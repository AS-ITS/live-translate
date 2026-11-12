import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareViewerCueState, observeViewerFinalState, readViewerCueStore } from '../e2e/issue41ViewerFinalStateContract.js';

const cue = { cueId: 'cue-1', meetingId: 'meeting-1', segmentId: 'segment-1',
 sourceText: 'source', translatedText: 'translation', status: 'final',
 sourceVersion: 4, translationVersion: 4 };
const hostEvents = [
 { stage: 'WEBRTC_CUE_PUBLISH', eventType: 'cue.append', sourceId: 'host-1', sequence: 2, transportResult: 'no_open_channel' },
 { stage: 'WEBRTC_CUE_PUBLISH', eventType: 'cue.update', sourceId: 'host-1', sequence: 4, transportResult: 'sent' }
];
const viewerEvents = [
 { stage: 'VIEWER_STORE_UPDATED', messageType: 'snapshot', sequence: 3, transportResult: 'updated' },
 { stage: 'VIEWER_STORE_UPDATED', messageType: 'cue.update', sequence: 4, transportResult: 'updated' }
];
const store = (cues = [cue], sequence = 4) => ({ available: true,
 hostCursor: { sourceId: 'host-1', sequence }, cues });
async function observe({ hostCues = [cue], viewerStore = store(), events = viewerEvents,
 onWait = () => {}, timeoutMs = 10, readHostCues = async () => hostCues,
 readHostEvents = async () => hostEvents } = {}) {
 let now = 0;
 return observeViewerFinalState({ hostEvents, readHostEvents, readHostCues,
  readViewerStore: async () => viewerStore, readViewerEvents: async () => events,
  timeoutMs, intervalMs: 5, stableMs: 0, now: () => now,
  wait: async (ms) => { now += ms; onWait((next) => { viewerStore = next; }); } });
}

test('complete snapshot covers append missing from transport', async () => {
 const result = await observe();
 assert.equal(result.verdict, 'PASS');
 assert.equal(result.snapshotCoversMissingAppend, true);
 assert.deepEqual(result.missingAppend, [2]);
 assert.equal(result.storeCursorSequence, 4);
 assert.equal(JSON.stringify(result).includes('"translation"'), false);
});

test('missing Cue fails', async () => {
 const result = await observe({ viewerStore: store([]) });
 assert.equal(result.verdict, 'FAIL');
 assert.equal(result.failureCode, 'VIEWER_DATA_MISMATCH');
 assert.equal(result.missingCueCount, 1);
});

test('stale side version fails', async () => {
 const result = await observe({ viewerStore: store([{ ...cue, translationVersion: 3 }]) });
 assert.equal(result.verdict, 'FAIL');
 assert.deepEqual(result.differingFields, ['translationVersion']);
});

test('different content fails despite matching versions', async () => {
 const result = await observe({ viewerStore: store([{ ...cue, translatedText: 'different' }]) });
 assert.equal(result.verdict, 'FAIL');
 assert.deepEqual(result.differingFields, ['translatedText']);
});

test('delayed Store synchronization passes within deadline', async () => {
 let waits = 0;
 const result = await observe({ viewerStore: store([], 0),
  onWait: (setStore) => { if (++waits === 1) setStore(store()); } });
 assert.equal(result.verdict, 'PASS');
 assert.equal(waits, 1);
});

test('never synchronized Store fails after deadline', async () => {
 const result = await observe({ viewerStore: store([], 0) });
 assert.equal(result.verdict, 'FAIL');
 assert.equal(result.storeApplied, false);
});

test('missing field is explicitly unverifiable', () => {
 const { translatedText, ...incomplete } = cue;
 const result = compareViewerCueState([cue], [incomplete]);
 assert.equal(result.verdict, 'UNVERIFIABLE');
 assert.deepEqual(result.unverifiableFields, ['translatedText']);
});

test('snapshot event alone cannot pass without the committed Viewer Store', async () => {
 const result = await observe({ viewerStore: { available: false }, events: viewerEvents });
 assert.equal(result.verdict, 'FAIL');
 assert.equal(result.failureCode, 'TEST_INSTRUMENTATION_FAILURE');
 assert.equal(result.storeApplied, false);
});

test('Viewer Store reader reads committed MeetingViewerPage state', () => {
 const previous = globalThis.document;
 const detail = { hostCursor: { sourceId: 'host-1', sequence: 4 }, cues: [cue] };
 const component = { type: { name: 'MeetingViewerPage' }, memoizedState: { memoizedState: detail } };
 globalThis.document = { querySelector: () => ({ '__reactFiber$mock': { return: component } }) };
 try {
  assert.deepEqual(readViewerCueStore(), { available: true, ...detail });
 } finally {
  globalThis.document = previous;
 }
});

test('Host changing during a comparison retries against a stable baseline', async () => {
 let reads = 0;
 let waits = 0;
 const oldCue = { ...cue, sourceText: 'old' };
 const result = await observe({ readHostCues: async () => ++reads === 1 ? [oldCue] : [cue],
  onWait: () => { waits += 1; } });
 assert.equal(result.verdict, 'PASS');
 assert.equal(waits, 1);
});

test('matching Cue content cannot pass with an older Viewer cursor', async () => {
 const result = await observe({ viewerStore: store([cue], 3) });
 assert.equal(result.verdict, 'FAIL');
 assert.equal(result.storeApplied, false);
});

test('matching sequence from another Host source cannot pass', async () => {
 const result = await observe({ viewerStore: { ...store(),
  hostCursor: { sourceId: 'host-other', sequence: 4 } } });
 assert.equal(result.verdict, 'FAIL');
 assert.equal(result.storeApplied, false);
});

test('Host publish cursor advancing during observation must be rechecked', async () => {
 let reads = 0;
 const newer = [...hostEvents, { ...hostEvents[1], sequence: 5 }];
 const result = await observe({ readHostEvents: async () => ++reads === 1 ? hostEvents : newer });
 assert.equal(result.verdict, 'FAIL');
 assert.equal(result.hostPublishSequence, 5);
});
