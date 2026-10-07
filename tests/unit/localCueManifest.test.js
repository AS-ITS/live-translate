import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalCueManifest } from '../../src/lib/localCueManifest.js';

const cue = { cueId: 'cue-1', sessionId: 'recording-1', segmentId: 'segment-1', sequence: 1, startTimeMs: 0, endTimeMs: 20, sourceText: 'final text' };

test('local Cue manifest dedupes identical identities and rejects conflicts', () => {
  const manifest = createLocalCueManifest();
  assert.deepEqual(manifest.append(cue), manifest.append(cue));
  assert.throws(() => manifest.append({ ...cue, sourceText: 'different text' }), (error) => error.code === 'local_cue_identity_conflict');
  assert.throws(() => manifest.append({ ...cue, segmentId: 'segment-2' }), (error) => error.code === 'local_cue_identity_conflict');
});
