import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyViewerAppend, observeViewerAppend, viewerAppendTimeline } from '../e2e/issue41ViewerAppendContract.js';

const append = { stage: 'WEBRTC_CUE_PUBLISH', eventType: 'cue.append', sequence: 2,
 timestamp: '2026-11-07T05:50:39.397Z', transportResult: 'sent' };
const received = { stage: 'VIEWER_STORE_UPDATED', messageType: 'cue.append', sequence: 2,
 timestamp: '2026-11-07T05:50:39.717Z', transportResult: 'updated' };

test('matching published append is received', async () => {
 const result = await observeViewerAppend({ hostEvents: [append], readViewerEvents: async () => [received] });
 assert.equal(result.verdict, 'PASS');
 assert.equal(result.hostAppendPublished, true);
 assert.equal(result.viewerAppendReceived, true);
 assert.deepEqual(result.missingSequences, []);
});

test('delayed matching append passes after bounded observation', async () => {
 let reads = 0;
 const result = await observeViewerAppend({ hostEvents: [append],
 readViewerEvents: async () => ++reads === 1 ? [] : [received],
 timeoutMs: 100, intervalMs: 0, wait: async () => {} });
 assert.equal(reads, 2);
 assert.equal(result.verdict, 'PASS');
});

test('missing append fails even if a later snapshot and update arrive', async () => {
 let now = 0;
 const viewerEvents = [{ ...received, messageType: 'snapshot', sequence: 3 },
 { ...received, messageType: 'cue.update', sequence: 4 }];
 const result = await observeViewerAppend({ hostEvents: [{ ...append, transportResult: 'no_open_channel' }],
 readViewerEvents: async () => viewerEvents, timeoutMs: 10, intervalMs: 10,
 now: () => now, wait: async (ms) => { now += ms; } });
 assert.equal(result.verdict, 'FAIL');
 assert.deepEqual(result.missingSequences, [2]);
 assert.equal(result.viewerAppendReceived, false);
 assert.equal(result.firstFailureStage, 'HOST_TRANSPORT');
 assert.equal(classifyViewerAppend([append], viewerEvents).firstFailureStage, 'VIEWER_RECEIVE_OR_STORE');
 const timeline = viewerAppendTimeline([{ ...append, sourceText: 'secret words' }], viewerEvents);
 assert.equal(JSON.stringify(timeline).includes('secret'), false);
});

test('no host append cannot pass from a viewer event alone', () => {
 assert.equal(classifyViewerAppend([], [received]).verdict, 'NOT_OBSERVED');
});
