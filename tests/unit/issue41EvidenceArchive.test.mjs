import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRamGate } from '../../scripts/issue41-ram-gate.mjs';
import { archiveRunEvidence, EVIDENCE_FILES, verifyEvidenceArchive, versionSnapshot } from '../../scripts/issue41-evidence-archive.mjs';

const project = join(dirname(fileURLToPath(import.meta.url)), '../..');
const mib = 1048576;

test('40-minute evidence is retained outside test output and can be checked and recomputed', () => {
  const temp = mkdtempSync(join(tmpdir(), 'issue41-archive-test-'));
  try {
    const runId = 'preflight-fixture-40';
    const runDir = join(temp, 'test-results', runId);
    const archiveRoot = join(temp, 'retained-artifacts');
    mkdirSync(runDir, { recursive: true });
    const barrier = '2026-11-09T01:00:00.000Z';
    const rows = Array.from({ length: 81 }, (_, index) => ({
      at: new Date(Date.parse(barrier) - 2_400_000 + index * 30_000).toISOString(),
      phase: 'capture', elapsedMs: index * 30_000, rendererPid: 42, rendererAlive: true,
      chromiumRssBytes: 300 * mib, jsHeapBytes: 60 * mib
    }));
    rows.push(...[0, 30, 60].map((seconds) => ({
      at: new Date(Date.parse(barrier) + seconds * 1000).toISOString(),
      phase: 'post_stop', secondsAfterBarrier: seconds, rendererPid: 42, rendererAlive: true,
      chromiumRssBytes: 290 * mib, jsHeapBytes: 55 * mib
    })));
    const files = {
      'summary.json': JSON.stringify({ runId, ramGate: analyzeRamGate(rows, barrier) }),
      'evidence.json': JSON.stringify({ barrierCompletedAt: barrier }),
      'resources.ndjson': `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'options.json': JSON.stringify({ ramGateMinutes: 40 }),
      'server-fetch-audit.ndjson': '{"method":"POST","route":"/rest/v1/rpc/create_meeting_with_initial_segment","status":200}\n',
      'runner.log': 'fixture runner completed\n',
      'version.json': JSON.stringify(versionSnapshot(project))
    };
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(runDir, name), contents);
    const destination = archiveRunEvidence({ project, runDir, runId, archiveRoot });
    const manifest = verifyEvidenceArchive(destination);
    assert.deepEqual(Object.keys(manifest.files).sort(), [...EVIDENCE_FILES, 'server-fetch-audit.ndjson'].sort());
    assert.equal(manifest.versionStableDuringRun, true);
    assert.deepEqual(manifest.ramGateRecomputation, { matchesSummary: true, verdict: 'PASS' });
    for (const name of [...EVIDENCE_FILES, 'server-fetch-audit.ndjson']) {
      assert.deepEqual(readFileSync(join(destination, name)), readFileSync(join(runDir, name)));
    }
    writeFileSync(join(destination, 'runner.log'), 'tampered\n');
    assert.throws(() => verifyEvidenceArchive(destination), /checksum mismatch: runner\.log/);

    const changedRunId = 'preflight-changed-version';
    const changedRunDir = join(temp, 'test-results', changedRunId);
    cpSync(runDir, changedRunDir, { recursive: true });
    writeFileSync(join(changedRunDir, 'summary.json'), JSON.stringify({ runId: changedRunId, ramGate: analyzeRamGate(rows, barrier) }));
    writeFileSync(join(changedRunDir, 'version.json'), JSON.stringify({ ...versionSnapshot(project), head: 'different-head' }));
    assert.throws(() => archiveRunEvidence({ project, runDir: changedRunDir, runId: changedRunId, archiveRoot }), /Worktree changed during run/);
    const retained = verifyEvidenceArchive(join(archiveRoot, changedRunId));
    assert.equal(retained.versionStableDuringRun, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
