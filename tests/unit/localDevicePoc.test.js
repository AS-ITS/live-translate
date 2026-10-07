import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalDevicePocService, normalizeAllowedOrigins, readLocalDevicePocFixture } from '../../scripts/local-device-poc-service.js';

const PREVIEW_ORIGIN = 'https://preview.example.test';
const PRODUCTION_ORIGIN = 'https://app.example.test';
const LOCAL_FIXTURE_ORIGIN = 'http://127.0.0.1:5175';

test('persists pending and ACK, deduplicates immutable packets, and recovers in order after restart', async (t) => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'live-translate-local-device-poc-')), 'fixture.json');
  let service = await createLocalDevicePocService({ stateFile, allowedOrigins: [LOCAL_FIXTURE_ORIGIN], failPostAfterPendingAt: 1 });
  t.after(async () => service.close());
  const first = packet(1);
  const disconnected = await post(service.origin, LOCAL_FIXTURE_ORIGIN, first);
  assert.equal(disconnected.status, 503);
  assert.equal(disconnected.body.error.code, 'simulated_channel_disconnect');
  assert.deepEqual((await readLocalDevicePocFixture(stateFile)).meetings['meeting-poc'].journal.map((entry) => entry.status), ['pending']);

  const port = service.port;
  await service.close();
  service = await createLocalDevicePocService({ stateFile, allowedOrigins: [LOCAL_FIXTURE_ORIGIN], port });
  const acknowledged = await post(service.origin, LOCAL_FIXTURE_ORIGIN, first);
  assert.deepEqual(acknowledged.body.acknowledgement, { operationId: 'operation-1', status: 'acknowledged', replayed: true });
  assert.equal((await post(service.origin, LOCAL_FIXTURE_ORIGIN, first)).body.acknowledgement.replayed, true);

  const operationConflict = await post(service.origin, LOCAL_FIXTURE_ORIGIN, { ...first, cue: { ...first.cue, sourceText: 'different text' } });
  assert.equal(operationConflict.status, 409);
  assert.equal(operationConflict.body.error.code, 'operation_conflict');
  const cueConflict = await post(service.origin, LOCAL_FIXTURE_ORIGIN, { ...packet(2), cue: { ...first.cue, sourceText: 'different text' } });
  assert.equal(cueConflict.status, 409);
  assert.equal(cueConflict.body.error.code, 'immutable_resource_conflict');

  assert.equal((await post(service.origin, LOCAL_FIXTURE_ORIGIN, packet(2))).status, 200);
  const viewer = await fetch(`${service.origin}/device/viewer/meeting-poc`, { headers: { Origin: LOCAL_FIXTURE_ORIGIN } });
  assert.deepEqual((await viewer.json()).cues.map((cue) => cue.cueId), ['cue-1', 'cue-2']);
  assert.deepEqual((await readLocalDevicePocFixture(stateFile)).meetings['meeting-poc'].journal.map((entry) => entry.status), ['pending', 'acknowledged', 'pending', 'acknowledged']);
});

test('requires HTTPS external origins and limits HTTP to an explicit loopback fixture', async (t) => {
  assert.throws(() => normalizeAllowedOrigins('*'), /Wildcard origins are forbidden/);
  assert.throws(() => normalizeAllowedOrigins(LOCAL_FIXTURE_ORIGIN), /must be HTTPS/);
  assert.deepEqual([...normalizeAllowedOrigins([PREVIEW_ORIGIN, PRODUCTION_ORIGIN])], [PREVIEW_ORIGIN, PRODUCTION_ORIGIN]);
  const stateFile = join(await mkdtemp(join(tmpdir(), 'live-translate-local-device-origin-')), 'fixture.json');
  await assert.rejects(() => createLocalDevicePocService({ stateFile, allowedOrigins: [PREVIEW_ORIGIN] }), /HTTP mode is limited/);
  await assert.rejects(() => createLocalDevicePocService({ stateFile, allowedOrigins: [LOCAL_FIXTURE_ORIGIN], tlsCertFile: 'only-cert' }), /configured together/);
  const service = await createLocalDevicePocService({ stateFile, allowedOrigins: [LOCAL_FIXTURE_ORIGIN] });
  t.after(() => service.close());
  const forbidden = await post(service.origin, 'https://attacker.example', packet(1));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'origin_forbidden');
  assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
  assert.equal((await post(service.origin, LOCAL_FIXTURE_ORIGIN, packet(1))).status, 200);
  const viewer = await fetch(`${service.origin}/device/viewer/meeting-poc`, { headers: { Origin: LOCAL_FIXTURE_ORIGIN } });
  assert.equal(viewer.status, 200);
  assert.equal(viewer.headers.get('access-control-allow-origin'), LOCAL_FIXTURE_ORIGIN);
});

test('stop persists and rejects later anonymous Viewer reads', async (t) => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'live-translate-local-device-stop-')), 'fixture.json');
  const service = await createLocalDevicePocService({ stateFile, allowedOrigins: [LOCAL_FIXTURE_ORIGIN] });
  t.after(() => service.close());
  assert.equal((await post(service.origin, LOCAL_FIXTURE_ORIGIN, packet(1))).status, 200);
  assert.equal((await post(service.origin, LOCAL_FIXTURE_ORIGIN, packet(1, 'stop'))).status, 200);
  const viewer = await fetch(`${service.origin}/device/viewer/meeting-poc`, { headers: { Origin: LOCAL_FIXTURE_ORIGIN } });
  assert.equal(viewer.status, 409);
  assert.equal((await viewer.json()).error.code, 'meeting_stopped');
});

function packet(sequence, kind = 'cue.append') {
  return { meetingId: 'meeting-poc', operation: { operationId: kind === 'stop' ? `operation-stop-${sequence}` : `operation-${sequence}`, kind }, chunk: { chunkId: `chunk-${sequence}`, sequence, contentHash: `sha256:${sequence}` }, cue: { cueId: `cue-${sequence}`, sequence, sourceText: `Cue ${sequence}`, translatedText: `Translation ${sequence}` }, checkpoint: { checkpointId: `checkpoint-${sequence}`, cueSequence: sequence } };
}
async function post(origin, requestOrigin, body) {
  const response = await fetch(`${origin}/device/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
