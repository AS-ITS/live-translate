import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observePauseStage } from '../../src/features/live/pauseStageDiagnostics.js';
import { attachPauseDiagnostics, capturePauseConsole, createPauseDiagnostics, summarizePauseDiagnostics, writePauseArtifact } from '../e2e/issue41PauseDiagnostics.js';

const emitConsole = (diagnostics) => (entry) => capturePauseConsole({
  text: () => `ISSUE41_PAUSE ${JSON.stringify(entry)}`, type: () => 'info'
}, diagnostics);

test('Mock Provider normal Pause records each completed stage without changing results', async () => {
  const diagnostics = createPauseDiagnostics();
  const emit = emitConsole(diagnostics);
  const provider = { stop: async () => true };
  assert.equal(await observePauseStage('MEDIA_RECORDER_PAUSE_DRAIN', async () => ({ status: 'paused' }), { emit }).then((value) => value.status), 'paused');
  assert.equal(await observePauseStage('SESSION_STOP_PROVIDER_CLOSE', () => provider.stop(), { emit }), true);
  assert.equal(await observePauseStage('SESSION_SNAPSHOT_FLUSH', async () => 'saved', { emit }), 'saved');
  observePauseStage('UI_PAUSED_TRANSITION', () => undefined, { emit });
  assert.equal(diagnostics.stages.filter((entry) => entry.status === 'DONE').length, 4);
  assert.deepEqual(summarizePauseDiagnostics(diagnostics, { endEnabled: true }).unfinishedStages, []);
});

test('a never-settling Mock Provider close retains START and identifies every unfinished stage', async () => {
  const diagnostics = createPauseDiagnostics();
  const emit = emitConsole(diagnostics);
  observePauseStage('SESSION_STOP_PROVIDER_CLOSE', () => new Promise(() => {}), { emit });
  observePauseStage('PCM_EPOCH_SEAL', () => new Promise(() => {}), { emit });
  const summary = summarizePauseDiagnostics(diagnostics, { endEnabled: false });
  assert.equal(summary.firstUnfinishedStage, 'SESSION_STOP_PROVIDER_CLOSE');
  assert.deepEqual(summary.unfinishedStages, ['SESSION_STOP_PROVIDER_CLOSE', 'PCM_EPOCH_SEAL']);
  assert.deepEqual(summary.timeline.map((entry) => entry.status), ['START', 'START']);
});

test('rejection records ERROR with no sensitive message and propagates original error', async () => {
  const diagnostics = createPauseDiagnostics();
  const error = Object.assign(new Error('Bearer secret-token transcript'), { code: 'PROVIDER_CLOSE_FAILED' });
  await assert.rejects(observePauseStage('SESSION_STOP_PROVIDER_CLOSE', () => Promise.reject(error),
    { emit: emitConsole(diagnostics) }), (received) => received === error);
  assert.equal(diagnostics.stages.at(-1).status, 'ERROR');
  assert.equal(diagnostics.stages.at(-1).errorCode, 'PROVIDER_CLOSE_FAILED');
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-token|transcript/u);
});

test('Cue flush failure records the pending operation without exposing error text', async () => {
  const diagnostics = createPauseDiagnostics();
  let phase = 'SUBTITLE_CUE_FINALIZE';
  const failure = new Error('private transcript text');
  await assert.rejects(observePauseStage('CUE_PUBLISH_FLUSH', async () => {
    phase = 'LOCAL_CUE_MUTATION_FLUSH';
    throw failure;
  }, { emit: emitConsole(diagnostics), phase: () => phase }), (error) => error === failure);
  const failureEvent = summarizePauseDiagnostics(diagnostics, {}).timeline.at(-1);
  assert.equal(failureEvent.phase, 'LOCAL_CUE_MUTATION_FLUSH');
  assert.equal(failureEvent.errorCode, 'Error');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private transcript text/u);
});

test('passed and failed artifacts retain only allowlisted diagnostics', () => {
  const diagnostics = createPauseDiagnostics();
  capturePauseConsole({ text: () => 'raw transcript and token', type: () => 'error' }, diagnostics);
  capturePauseConsole({ text: () => 'ISSUE41_PAUSE {"stage":"MEDIA_RECORDER_PAUSE_DRAIN","status":"START","errorMessage":"secret-token"}', type: () => 'info' }, diagnostics);
  const dir = mkdtempSync(join(tmpdir(), 'issue41-pause-artifact-'));
  for (const status of ['passed', 'failed']) {
    const path = join(dir, `${status}.json`);
    writePauseArtifact(path, diagnostics, { endEnabled: false }, status);
    const artifact = readFileSync(path, 'utf8');
    assert.equal(JSON.parse(artifact).testStatus, status);
    assert.doesNotMatch(artifact, /raw transcript|secret-token/u);
  }
});
test('failed fetch records its phase and redacts query values', async () => {
  const listeners = new Map();
  const diagnostics = createPauseDiagnostics();
  attachPauseDiagnostics({ on: (name, listener) => listeners.set(name, listener) }, diagnostics);
  await listeners.get('requestfailed')({
    url: () => 'http://127.0.0.1:3000/api/meetings?token=secret-token&cursor=private',
    method: () => 'GET', resourceType: () => 'fetch',
    failure: () => ({ errorText: 'net::ERR_ABORTED' }),
    response: async () => ({ status: () => 503 })
  });
  assert.deepEqual(diagnostics.requestfailed[0], {
    at: diagnostics.requestfailed[0].at, stage: 'BEFORE_PAUSE',
    url: 'http://127.0.0.1:3000/api/meetings?token=%5BREDACTED%5D&cursor=%5BREDACTED%5D',
    method: 'GET', resourceType: 'fetch', reason: 'net::ERR_ABORTED', httpStatus: 503
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-token|private/u);
});
