import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../../public/webrtc-poc.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../public/webrtc-poc.js', import.meta.url), 'utf8');

test('WebRTC PoC page is self-contained and exposes Device/Viewer controls', () => {
  assert.match(page, /webrtc-poc\.js/);
  assert.match(page, /Device/); assert.match(page, /Viewer/);
  for (const control of ['meetingId', 'share', 'participantId', 'signalingUrl', 'start', 'send', 'update', 'replay', 'stop']) assert.match(page, new RegExp(`id="${control}"`));
});

test('WebRTC PoC uses the fixed signaling contract and real peer/data channel APIs', () => {
  for (const contract of ['/join', '/signal', 'participantId', 'after=', '/stop']) assert.match(script, new RegExp(contract.replace(/[?]/g, '\\$&')));
assert.match(script, /shareToken/); assert.match(script, /shareCode/); assert.match(script, /error\.code/);
  for (const term of ['new RTCPeerConnection', 'createDataChannel', 'createOffer', 'createAnswer', 'addIceCandidate', 'getStats', 'selected', 'nominated']) assert.match(script, new RegExp(term));
  assert.doesNotMatch(script, /WebSocket|EventSource|fake peer/i);
});

test('protocol covers snapshot buffering, cue updates, replay and revocation', () => {
  for (const type of ['snapshot', 'cue.append', 'cue.update', 'replay.request', 'replay.response', 'revoked']) assert.match(script, new RegExp(type.replace('.', '\\.'), 'g'));
  assert.match(script, /if \(!state\.snapshot\)/);
  assert.match(script, /sequence gap/);
  assert.match(script, /state\.cues\.values\(\)\]\.map/);
  assert.match(page, /Send cue\.update/);
  assert.match(script, /function updateCue/);
  assert.match(script, /type: 'cue\.update'/);
  assert.match(script, /candidateClass/);
  assert.match(script, /host.*srflx.*prflx/);
  assert.match(script, /relay/);
  assert.match(page, /Synthetic process time/);
  assert.match(page, /Real end-to-end cue latency/);
  assert.match(page, /Recording gap/);
});
