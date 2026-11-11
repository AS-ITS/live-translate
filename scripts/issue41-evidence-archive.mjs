import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeRamGate } from './issue41-ram-gate.mjs';

export const EVIDENCE_FILES = Object.freeze([
  'summary.json', 'evidence.json', 'resources.ndjson', 'options.json', 'runner.log', 'version.json'
]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const CLOUD_ZERO_EVIDENCE_FILES = Object.freeze([
  'summary.json', 'evidence.json', 'options.json', 'runner.log',
  'zero-write-audit.log', 'zero-write-audit-playwright.json',
  'server-fetch-audit.ndjson', 'audit-coverage-matrix.json'
]);

export function archiveCloudZeroAuditEvidence({ project, runDir, runId,
  archiveRoot = join(project, 'artifacts/issue41-cloud-zero') }) {
  if (!/^[a-z0-9-]+$/u.test(runId)) throw new Error('Invalid Run ID.');
  const evidence = JSON.parse(readFileSync(join(runDir, 'evidence.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
  if (summary.runId !== runId || !evidence.auditCoverage) throw new Error('Incomplete Cloud Zero evidence.');
  const destination = join(archiveRoot, runId);
  if (existsSync(destination)) throw new Error('Cloud Zero archive already exists.');
  mkdirSync(destination, { recursive: true });
  const files = {};
  for (const name of CLOUD_ZERO_EVIDENCE_FILES) {
    const source = join(runDir, name);
    if (!existsSync(source)) throw new Error(`Missing Cloud Zero evidence: ${name}`);
    copyFileSync(source, join(destination, name));
    const bytes = readFileSync(source);
    files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify({ runId, files }, null, 2)}\n`);
  for (const [name, expected] of Object.entries(files)) {
    const bytes = readFileSync(join(destination, name));
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new Error(`Cloud Zero archive checksum mismatch: ${name}`);
    }
  }
  return destination;
}

function git(project, args) {
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git version snapshot failed: ${args[0]}`);
  return result.stdout;
}

export function versionSnapshot(project) {
  return {
    head: git(project, ['rev-parse', 'HEAD']).trim(),
    worktreeStatus: git(project, ['status', '--porcelain=v1', '--untracked-files=all']).trimEnd(),
    trackedDiffSha256: sha256(git(project, ['diff', 'HEAD', '--binary'])),
    runnerSha256: sha256(readFileSync(join(project, 'scripts/issue41-local-runner.mjs'))),
    analyzerSha256: sha256(readFileSync(join(project, 'scripts/issue41-ram-gate.mjs'))),
    archiveStepSha256: sha256(readFileSync(join(project, 'scripts/issue41-evidence-archive.mjs')))
  };
}

function recomputeGate(dir) {
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const evidence = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'));
  const options = JSON.parse(readFileSync(join(dir, 'options.json'), 'utf8'));
  const rows = readFileSync(join(dir, 'resources.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const actual = analyzeRamGate(rows, evidence.barrierCompletedAt, {
    minimumCaptureMs: (options.ramGateMinutes || 40) * 60_000
  });
  return { matchesSummary: JSON.stringify(actual) === JSON.stringify(summary.ramGate), verdict: actual.verdict };
}

export function verifyEvidenceArchive(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const evidenceFiles = [...EVIDENCE_FILES,
    ...(manifest.files['server-fetch-audit.ndjson'] ? ['server-fetch-audit.ndjson'] : [])];
  for (const name of evidenceFiles) {
    const bytes = readFileSync(join(dir, name));
    if (bytes.length !== manifest.files[name]?.bytes || sha256(bytes) !== manifest.files[name]?.sha256) {
      throw new Error(`Archive checksum mismatch: ${name}`);
    }
  }
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  if (summary.runId !== manifest.runId) throw new Error('Archive Run ID mismatch.');
  let recomputed;
  try { recomputed = recomputeGate(dir); }
  catch { recomputed = { matchesSummary: false }; }
  if (manifest.ramGateRecomputation.matchesSummary !== recomputed.matchesSummary) {
    throw new Error('Archive RAM Gate recomputation changed.');
  }
  return manifest;
}

export function archiveRunEvidence({ project, runDir, runId, archiveRoot = join(project, 'artifacts/issue41-ram-gate') }) {
  if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('Invalid Run ID.');
  const destination = join(archiveRoot, runId);
  if (existsSync(destination)) throw new Error(`Evidence archive already exists: ${destination}`);
  const files = {};
  const options = JSON.parse(readFileSync(join(runDir, 'options.json'), 'utf8'));
  const evidenceFiles = [...EVIDENCE_FILES,
    ...(options.ramGateMinutes ? ['server-fetch-audit.ndjson'] : [])];
  for (const name of evidenceFiles) {
    const bytes = readFileSync(join(runDir, name));
    files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const initialVersion = JSON.parse(readFileSync(join(runDir, 'version.json'), 'utf8'));
  let ramGateRecomputation;
  try { ramGateRecomputation = recomputeGate(runDir); }
  catch { ramGateRecomputation = { matchesSummary: false, verdict: 'NOT_RECOMPUTABLE' }; }
  const manifest = {
    runId,
    archivedAt: new Date().toISOString(),
    files,
    versionStableDuringRun: JSON.stringify(initialVersion) === JSON.stringify(versionSnapshot(project)),
    ramGateRecomputation
  };
  mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  for (const name of evidenceFiles) {
    writeFileSync(join(destination, name), readFileSync(join(runDir, name)), { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  verifyEvidenceArchive(destination);
  if (!manifest.versionStableDuringRun) throw new Error(`Worktree changed during run; raw files retained at ${destination}`);
  if (!ramGateRecomputation.matchesSummary) throw new Error(`RAM Gate cannot be recomputed; raw files retained at ${destination}`);
  return destination;
}
