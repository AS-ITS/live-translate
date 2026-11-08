import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyViewerUpdate, observeViewerUpdate, viewerUpdateTimeline } from '../e2e/issue41ViewerUpdateContract.js';

const append = { stage: 'WEBRTC_CUE_PUBLISH', eventType: 'cue.append', sequence: 2, transportResult: 'sent' };
const update = { stage: 'WEBRTC_CUE_PUBLISH', eventType: 'cue.update', sequence: 3,
  revision: 2, transportResult: 'sent' };
const received = { stage: 'VIEWER_STORE_UPDATED', messageType: 'cue.update', sequence: 3,
  transportResult: 'updated' };

test('natural Gemini run without a host update remains NOT_OBSERVED', async () => {
  let reads = 0;
  const result = await observeViewerUpdate({ hostEvents: [append], readViewerEvents: async () => {
    reads += 1;
    return [{ stage: 'VIEWER_STORE_UPDATED', messageType: 'cue.append', sequence: 2 }];
  } });
  assert.equal(reads, 1);
  assert.equal(result.hostUpdatePublished, false);
  assert.equal(result.viewerUpdateReceived, false);
  assert.equal(result.verdict, 'NOT_OBSERVED');
});

test('host update passes only after the matching viewer update arrives', async () => {
  let reads = 0;
  const result = await observeViewerUpdate({ hostEvents: [append, update],
    readViewerEvents: async () => ++reads === 1 ? [] : [received],
    timeoutMs: 100, intervalMs: 0, wait: async () => {} });
  assert.equal(reads, 2);
  assert.equal(result.hostUpdatePublished, true);
  assert.equal(result.viewerUpdateReceived, true);
  assert.equal(result.verdict, 'PASS');
});

test('published update missing at viewer fails after the bounded wait', async () => {
  let now = 0;
  const result = await observeViewerUpdate({ hostEvents: [append, update],
    readViewerEvents: async () => [{ ...received, sequence: 4 }],
    timeoutMs: 10, intervalMs: 10, now: () => now, wait: async (ms) => { now += ms; } });
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.missingSequences, [3]);
  assert.equal(result.viewerUpdateReceived, false);
});

test('timeline includes only safe publish and receive metadata', () => {
  const timeline = viewerUpdateTimeline([{ ...update, sourceText: 'secret words' }],
    [{ ...received, translatedText: 'private translation' }]);
  assert.equal(JSON.stringify(timeline).includes('secret'), false);
  assert.equal(JSON.stringify(timeline).includes('private'), false);
  assert.equal(classifyViewerUpdate([update], [received]).verdict, 'PASS');
});
