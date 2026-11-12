import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectIssue41OwnershipEvidence } from '../e2e/issue41OwnershipEvidence.js';

function consoleMessage(payload, type = 'info') {
  return { type: () => type, text: () => `ISSUE41_PCM_OWNERSHIP ${JSON.stringify(payload)}` };
}

test('ownership console diagnostics persist safe fields without pageerror, including on test failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'issue41-ownership-evidence-'));
  try {
    const evidenceFile = join(directory, 'evidence.json');
    const evidence = { browserErrors: [] };
    const page = new EventEmitter();
    collectIssue41OwnershipEvidence(page, evidence,
      () => writeFileSync(evidenceFile, JSON.stringify(evidence)));

    page.emit('console', consoleMessage({ status: 'INTEGRITY_UNRESOLVED', reason: 7,
      openErrorName: 'NoModificationAllowedError', openErrorCode: 7,
      recordingId: 'sensitive-recording', token: 'sensitive-token', pcm: 'sensitive-pcm',
      subtitle: 'sensitive-subtitle', message: 'sensitive-error' }));
    assert.deepEqual(JSON.parse(readFileSync(evidenceFile, 'utf8')), {
      browserErrors: [], ownershipDiagnostics: [{ status: 'INTEGRITY_UNRESOLVED', reason: 7,
        openErrorName: 'NoModificationAllowedError', openErrorCode: 7 }]
    });

    // A later assertion failure must not erase the already persisted diagnostic.
    assert.throws(() => assert.fail('synthetic test failure'), /synthetic test failure/u);
    assert.equal(JSON.parse(readFileSync(evidenceFile, 'utf8')).ownershipDiagnostics.length, 1);

    page.emit('console', consoleMessage({ status: 'INTEGRITY_UNRESOLVED',
      reason: 'pause_boundary_conflict', token: 'sensitive-token' }));
    assert.deepEqual(JSON.parse(readFileSync(evidenceFile, 'utf8')).ownershipDiagnostics[1],
      { status: 'INTEGRITY_UNRESOLVED', reason: 'pause_boundary_conflict' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ownership collector ignores unrelated, malformed, and unsafe console messages', () => {
  const page = new EventEmitter();
  const evidence = {};
  let saves = 0;
  collectIssue41OwnershipEvidence(page, evidence, () => { saves += 1; });
  page.emit('console', consoleMessage({ status: 'INTEGRITY_UNRESOLVED', reason: 'safe' }, 'debug'));
  page.emit('console', { type: () => 'info', text: () => 'ISSUE41_PCM_OWNERSHIP {broken' });
  page.emit('console', consoleMessage({ status: 'INTEGRITY_UNRESOLVED', reason: 'unsafe text with spaces' }));
  page.emit('console', consoleMessage({ status: 'INTEGRITY_UNRESOLVED', reason: 'safe',
    openErrorName: 'Error', openErrorCode: 'unsafe code with spaces' }));
  assert.equal(saves, 0);
  assert.equal(evidence.ownershipDiagnostics, undefined);
});
