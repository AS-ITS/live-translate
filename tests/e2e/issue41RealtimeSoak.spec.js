import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFileSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { serializeEffectiveGlossary } from '../../src/lib/glossaryRevision.js';
import { installE2EAuth, localE2EAuthSession } from './authBootstrap.js';
import { databaseSnapshot, installWriteAudit, recordedWrites, rolledBackRecordingWriteControl } from './issue41DbWriteAudit.js';
import { evaluateCloudZeroWrite, evaluateNormalCloudContentWrite, classifyCloudContentRequest, classifyServerSupabaseWrite, redactCloudAuditEvidence } from './issue41CloudZeroWriteContract.js';
import { attachPauseDiagnostics, createPauseDiagnostics } from './issue41PauseDiagnostics.js';
import { collectIssue41OwnershipEvidence } from './issue41OwnershipEvidence.js';
import { PROVISIONAL_RAM_THRESHOLDS } from '../../scripts/issue41-ram-gate.mjs';
import { assertCommittedLocalRolloverOperation } from './issue41RolloverOperation.mjs';

const shortValidation = process.env.ISSUE41_SHORT_VALIDATION === 'true';
const recordingOnly = process.env.ISSUE41_RECORDING_ONLY === 'true';
const zeroWriteAudit = process.env.ISSUE41_ZERO_WRITE_AUDIT === 'true';
const coreAcceptance = process.env.ISSUE41_CORE_ACCEPTANCE === 'true';
if (coreAcceptance && (!zeroWriteAudit || !shortValidation || recordingOnly)) {
  throw new Error('Core acceptance requires short Local-only audit with Host/Viewer enabled.');
}
const recordingSoak = recordingOnly && !shortValidation;
const recordingContract = recordingOnly && process.env.ISSUE41_ROLLOVER_CONTRACT === 'true';
const authExpirySmoke = recordingContract && process.env.ISSUE41_AUTH_EXPIRY_SMOKE === 'true';
const ram2Diagnostic = recordingContract && process.env.ISSUE41_RAM2_DIAGNOSTIC === 'true';
const ram10Diagnostic = recordingOnly && process.env.ISSUE41_RAM10_DIAGNOSTIC === 'true';
const ramAttributionSmoke = recordingOnly && process.env.ISSUE41_RAM_ATTRIBUTION_SMOKE === 'true';
const ramAbcSmoke = recordingOnly && process.env.ISSUE41_RAM_ABC_SMOKE === 'true';
const ramAbcMode = recordingOnly ? process.env.ISSUE41_RAM_ABC_MODE || null : null;
const ramProfileC = recordingOnly && process.env.ISSUE41_RAM_3C_PROFILE === 'true';
if (ramAbcMode && !['A', 'B', 'C'].includes(ramAbcMode)) throw new Error('Invalid RAM ABC mode');
const soakMinutes = Number(process.env.ISSUE41_RECORDING_SOAK_MINUTES || 20);
const naturalRollover21 = recordingSoak && soakMinutes === 21;
const ramGateMode = recordingSoak && [40, 130].includes(soakMinutes) && !zeroWriteAudit;
const localRamMeasurement = naturalRollover21 || ramGateMode || recordingContract || ramAttributionSmoke || ramAbcSmoke || Boolean(ramAbcMode) || ramProfileC;
const recordingSmoke = recordingOnly && shortValidation && !recordingContract && !localRamMeasurement;

function installCoreContinueRolloverClock() {
  const nativeSetTimeout = window.setTimeout.bind(window);
  const clock = { armed: false, shortened: 0, delayMs: null };
  window.__issue41CoreRolloverClock = clock;
  window.__issue41ArmContinueRolloverClock = () => { clock.armed = true; };
  window.setTimeout = (callback, delay, ...args) => {
    if (clock.armed && clock.shortened === 0 && delay === 15 * 60_000) {
      clock.shortened += 1;
      clock.delayMs = 15_000;
      return nativeSetTimeout(callback, clock.delayMs, ...args);
    }
    return nativeSetTimeout(callback, delay, ...args);
  };
}

function attributeHostRenderer({ pageTargetId, pageTargets, hostPageCount, rendererPids,
  expectedTargetId, expectedRendererPid }) {
  let reason = null;
  if (!pageTargetId || !pageTargets.some((entry) => entry.targetId === pageTargetId))
    reason = 'HOST_TARGET_NOT_IN_BROWSER_TARGETS';
  else if (pageTargets.length !== 1 || hostPageCount !== 1) reason = 'MULTIPLE_PAGE_TARGETS';
  else if (rendererPids.length !== 1) reason = 'RENDERER_COUNT_NOT_ONE';
  else if (expectedTargetId && expectedTargetId !== pageTargetId) reason = 'HOST_TARGET_CHANGED';
  else if (expectedRendererPid && expectedRendererPid !== rendererPids[0]) reason = 'RENDERER_PID_CHANGED';
  return { method: reason ? 'UNATTRIBUTED' : 'ISOLATED_SINGLE_PAGE_SINGLE_RENDERER', reason,
    rendererPid: reason ? null : rendererPids[0] };
}
if (recordingSoak && ![20, 21, 40, 130].includes(soakMinutes) && !((ram10Diagnostic || ramAbcMode) && soakMinutes === 10)) throw new Error('Unsupported recording soak duration');
const evidenceFile = process.env.ISSUE41_EVIDENCE_FILE;
const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
const seriesFile = process.env.ISSUE41_RESOURCE_FILE;

async function runRecordingRam10Diagnostic({ page, browser, meetingId, initialSegmentId, localState, evidence, save }) {
  const cdp = await page.context().newCDPSession(page);
  const system = await browser.newBrowserCDPSession();
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  evidence.ram10 = { samples: [], snapshots: [], cuePhaseMinutes: 5, pcmMinutes: 10 };
  const startedAt = Date.now();
  let nextCueAt = startedAt;
  let lastPcmCount = 0;
  const snapshot = async (minute) => {
    const file = join(dirname(evidenceFile), `heap-${minute}min.heapsnapshot`);
    const stream = createWriteStream(file);
    const onChunk = ({ chunk }) => stream.write(chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    let gc = 'CDP HeapProfiler.collectGarbage';
    try {
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    } catch (error) {
      gc = `UNRELIABLE: ${error.message}`;
      throw error;
    } finally {
      cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      stream.end();
      await once(stream, 'finish');
      evidence.ram10.snapshots.push({ minute, file, gc, at: new Date().toISOString() });
      save();
    }
  };
  const sample = async (minute) => {
    const [metrics, processInfo, local, browserState] = await Promise.all([
      cdp.send('Performance.getMetrics'),
      system.send('SystemInfo.getProcessInfo').catch(() => null),
      localState(meetingId),
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const opfs = { files: 0, bytes: 0 };
        const walk = async (directory) => {
          for await (const handle of directory.values()) {
            if (handle.kind === 'directory') await walk(handle);
            else { opfs.files += 1; opfs.bytes += (await handle.getFile()).size; }
          }
        };
        await walk(root);
        const stores = {};
        for (const database of await indexedDB.databases()) {
          if (!database.name) continue;
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(database.name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          for (const name of db.objectStoreNames) {
            if (!/claim|operation/i.test(name)) continue;
            stores[`${database.name}/${name}`] = await new Promise((resolve, reject) => {
              const request = db.transaction(name, 'readonly').objectStore(name).count();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
          }
          db.close();
        }
        return { opfs, stores, pcmCount: window.__issue41PcmCount,
          lastPcmAgeMs: Date.now() - window.__issue41LastPcmAt,
          journalQueue: window.__issue41JournalWorkerPending?.size ?? 'NOT_MEASURED',
          liveTracks: window.__issue41Tracks.filter((track) => track.readyState === 'live').length };
      })
    ]);
    const rendererPid = processInfo?.processInfo?.find((entry) => entry.type === 'renderer')?.id ?? null;
    let rendererRssBytes = 'NOT_MEASURED';
    if (rendererPid !== null) {
      try { rendererRssBytes = Number(execFileSync('ps', ['-p', String(rendererPid), '-o', 'rss='], { encoding: 'utf8' }).trim()) * 1024; }
      catch { rendererRssBytes = 'NOT_MEASURED'; }
    }
    const metric = (name) => metrics.metrics.find((entry) => entry.name === name)?.value ?? 'NOT_MEASURED';
    const row = { minute, elapsedMs: Date.now() - startedAt, at: new Date().toISOString(),
      jsHeapBytes: metric('JSHeapUsedSize'), jsHeapTotalBytes: metric('JSHeapTotalSize'),
      rendererPid, rendererRssBytes, cueCount: local.cues.length,
      transcriptCount: local.transcripts.length, journalQueue: browserState.journalQueue,
      claimsOperations: browserState.stores, opfs: browserState.opfs,
      pcmCount: browserState.pcmCount, lastPcmAgeMs: browserState.lastPcmAgeMs,
      liveTracks: browserState.liveTracks,
      externalMemoryBytes: 'NOT_MEASURED_BY_CDP_PERFORMANCE' };
    evidence.ram10.samples.push(row);
    if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify({ phase: 'ram10_sample', ...row })}\n`);
    save();
    expect(row.liveTracks).toBeGreaterThan(0);
    expect(row.pcmCount).toBeGreaterThan(lastPcmCount);
    lastPcmCount = row.pcmCount;
    return row;
  };
  await sample(0);
  await snapshot(0);
  for (let minute = 1; minute <= 10; minute += 1) {
    while (Date.now() - startedAt < minute * 60_000) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 5 * 60_000 && Date.now() >= nextCueAt) {
        await page.evaluate((sequence) => window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
          serverContent: { inputTranscription: { text: `ram10 cue ${sequence}` },
            outputTranscription: { text: `ram10 translation ${sequence}` }, turnComplete: true }
        }), Math.floor(elapsed / 10_000));
        nextCueAt = Date.now() + 10_000;
      }
      await page.waitForTimeout(Math.min(1000, Math.max(1, minute * 60_000 - (Date.now() - startedAt))));
    }
    await sample(minute);
    if (minute === 5 || minute === 10) await snapshot(minute);
  }
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600_000);
  expect(evidence.ram10.samples[5].cueCount).toBeGreaterThan(0);
  expect(evidence.ram10.samples[10].cueCount).toBe(evidence.ram10.samples[5].cueCount);
  await page.getByRole('button', { name: '結束會議' }).click();
  evidence.ram10.localSegments = (await localState(meetingId)).segments.length;
  evidence.ram10.initialSegmentId = initialSegmentId;
  evidence.result = 'RAM10_DIAGNOSTIC_CAPTURED';
  evidence.finishedAt = new Date().toISOString();
  save();
}

if (process.env.ISSUE41_FIXTURE_CLOCK_CONTRACT === 'true') {
  test('issue41 fixture clock contract', async ({ page }) => {
    await page.addInitScript(installCoreContinueRolloverClock);
    await page.goto('data:text/html,<title>fixture clock</title>');
    const clock = await page.evaluate(() => {
      const schedule = () => {
        const timer = window.setTimeout(() => {}, 15 * 60_000);
        window.clearTimeout(timer);
        return { ...window.__issue41CoreRolloverClock };
      };
      const initial = schedule();
      window.__issue41ArmContinueRolloverClock();
      const continued = schedule();
      const subsequent = schedule();
      return { initial, continued, subsequent };
    });
    expect(clock.initial).toEqual({ armed: false, shortened: 0, delayMs: null });
    expect(clock.continued).toEqual({ armed: true, shortened: 1, delayMs: 15_000 });
    expect(clock.subsequent).toEqual(clock.continued);
  });
}

test.use({ trace: localRamMeasurement ? 'off' : 'on' });

test(ramProfileC ? "issue41 RAM-3C isolated profile" : ramAbcSmoke ? "issue41 A/B/C RAM mode smoke" : ramAbcMode ? `issue41 RAM diagnostic ${ramAbcMode}` : ramAttributionSmoke ? 'issue41 Host RAM attribution smoke' : zeroWriteAudit ? 'issue41 isolated zero recording write audit' : recordingOnly ? (recordingContract ? 'issue41 recording-only controlled rollover contract' : recordingSoak ? `issue41 recording-only ${soakMinutes}-minute real-time soak` : 'issue41 recording-only local smoke') : 'issue41 real-time 20-minute local meeting soak', async ({ page, browser }) => {
  test.setTimeout(ramProfileC ? 480_000 : recordingContract ? 540_000 : shortValidation ? 240_000 : (soakMinutes + 8) * 60_000);
  const auth = localE2EAuthSession();
  expect(auth, 'a local Supabase Auth user is required').toBeTruthy();
  expect(auth.profile.email.endsWith('@example.com')).toBe(true);
  expect(process.env.AUTH_ALLOWED_EMAIL_DOMAINS).toBe('example.com');
  expect(supabaseUrl, 'isolated local Supabase is required').toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
  expect(publishableKey).toBeTruthy();
  expect(serviceKey, 'isolated service key is required for the zero-write inventory').toBeTruthy();
const evidence = { mode: recordingContract ? 'recording-rollover-contract' : recordingSoak ? `recording-${soakMinutes}min-soak` : recordingOnly ? 'recording-only' : shortValidation ? 'short-validation' : 'real-time-soak',
    startedAt: new Date().toISOString(), api: [], browserErrors: [], cues: [], viewer: [] };
  if (coreAcceptance) {
    const fetchDiagnostics = createPauseDiagnostics();
    attachPauseDiagnostics(page, fetchDiagnostics);
    evidence.failedFetches = fetchDiagnostics.requestfailed;
  }
  if (zeroWriteAudit || ramGateMode) evidence.cloudZeroWrite = { status: 'NOT_VERIFIED' };
  const save = () => {
    if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(
      zeroWriteAudit || ramGateMode ? redactCloudAuditEvidence(evidence) : evidence, null, 2));
  };
  if (ramGateMode) {
    const recordRuntimeTermination = (kind) => {
      if (evidence.finishedAt || evidence.runtimeTermination) return;
      evidence.runtimeTermination = { kind, at: new Date().toISOString() };
      save();
    };
    page.on('crash', () => recordRuntimeTermination('renderer_crash'));
    browser.on('disconnected', () => recordRuntimeTermination('browser_disconnected'));
  }
  const dbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const auditRequests = [];
  if (zeroWriteAudit) {
    evidence.auditCoverage = installWriteAudit();
    evidence.dbBefore = databaseSnapshot();
  }
  const apiJson = async (method, path, data) => {
    if (method !== 'GET') auditRequests.push({ method, path: `/api${path}` });
    const token = page.url().startsWith('http') ? await page.evaluate(async () => {
      const { supabase } = await import('/src/lib/supabaseAuth.js');
      return (await supabase.auth.getSession()).data.session?.access_token || null;
    }) : auth.token;
    expect(token, 'E2E API request requires a current browser session').toBeTruthy();
    const response = await page.request.fetch(`/api${path}`, {
      method, headers: { Authorization: `Bearer ${token}` }, data
    });
    evidence.api.push({ method, path: path.replace(/\?.*$/u, ''), status: response.status() });
    save();
    const payload = await response.json();
    expect(response.ok(), `${method} ${path}: HTTP ${response.status()} ${payload?.error?.code || ''}`).toBe(true);
    return payload;
  };
  const dbRows = async (table, query) => {
    const response = await page.request.get(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: dbHeaders });
    expect(response.ok(), `DB ${table}: HTTP ${response.status()}`).toBe(true);
    return response.json();
  };
  const cloudSegments = (meetingId) => dbRows('meeting_segments', `select=id,meeting_id,session_id,sequence,status,checkpoint&meeting_id=eq.${meetingId}&order=sequence.asc`);
  const localState = (meetingId) => page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const cues = await store.listCues(id);
    const transcripts = await store.listTranscriptItems(id);
    const checkpoints = await store.listCheckpoints(id);
    const segments = await store.listSegments(id);
    const recording = await store.getRecording(id);
    const chunks = await store.list(id);
    const retention = await store.getRetention(id);
    return { cues: cues.map((row) => row.cue), transcripts, checkpoints: checkpoints.map((row) => ({ segmentId: row.segmentId, revision: row.checkpoint?.revision })), segments,
      recording, chunks: chunks.map((row) => ({ segmentId: row.segmentId, byteSize: row.byteSize, state: row.state })), retention };
  }, meetingId);
  const segments = async (meetingId) => (await localState(meetingId)).segments.map((row) => ({
    id: row.segmentId, sequence: row.sequence, status: row.status, recordingId: row.recordingId
  }));
  const storageObjects = async (bucket) => {
    const response = await page.request.post(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
      headers: { ...dbHeaders, 'content-type': 'application/json' }, data: { prefix: '', limit: 1000 }
    });
    expect(response.ok(), `Storage ${bucket}: HTTP ${response.status()}`).toBe(true);
    return response.json();
  };
  if (zeroWriteAudit) {
    evidence.storageBefore = {
      audio: await storageObjects('meeting-audio'),
      exports: await storageObjects('meeting-exports')
    };
    const storagePath = `issue41-policy-probe-${Date.now()}`;
    const upload = await page.request.post(`${supabaseUrl}/storage/v1/object/meeting-audio/${storagePath}`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${auth.token}`,
        'content-type': 'audio/wav' },
      data: Buffer.from('issue41-policy-probe-not-audio')
    });
    if (upload.ok()) throw new Error('AUTHENTICATED_STORAGE_UPLOAD_SUCCEEDED: stop Cloud Zero Gate');
    const objects = await storageObjects('meeting-audio');
    evidence.authenticatedStorageDenial = {
      status: upload.status(), objectAbsent: !objects.some((item) => item.name === storagePath)
    };
    save();
    expect(evidence.authenticatedStorageDenial.objectAbsent).toBe(true);
  }
  if (zeroWriteAudit || localRamMeasurement) page.on('request', (request) => {
    if (request.method() === 'GET') return;
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') || path.startsWith('/rest/v1/') || path.startsWith('/storage/v1/')) {
      auditRequests.push({ method: request.method(), path });
    }
  });
  const cloudInventory = async (meetingId) => {
    const [cues, events, segmentRows, sessionRows, audio, exports] = await Promise.all([
      dbRows('subtitle_cues', 'select=id'),
      dbRows('meeting_events', `select=id,payload&meeting_id=eq.${meetingId}`),
      cloudSegments(meetingId),
      dbRows('sessions', `select=id,transcript_items,payload&meeting_id=eq.${meetingId}`),
      storageObjects('meeting-audio'), storageObjects('meeting-exports')
    ]);
    return { cues: cues.length, contentEvents: events.filter((row) => JSON.stringify(row.payload || {}).match(/cue|transcript|translation|audio|checkpoint/i)).length,
      checkpoints: segmentRows.filter((row) => row.checkpoint && Object.keys(row.checkpoint).length).length,
      sessionContent: sessionRows.filter((row) => (row.transcript_items?.length || 0) > 0 || JSON.stringify(row.payload || {}).match(/sourceText|translatedText|transcript|translation|summary/i)).length,
      audioObjects: audio.length, exportObjects: exports.length, segments: segmentRows.length, sessions: sessionRows.length };
  };
  page.on('pageerror', (error) => { evidence.browserErrors.push(error.name); save(); });
  if (coreAcceptance) collectIssue41OwnershipEvidence(page, evidence, save);
  if (recordingOnly) page.on('response', (response) => {
    const request = response.request();
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    const match = /^\/api\/meetings\/([^/]+)\/recording\/(start|rollover|stop|end)$/u.exec(path);
    if (!match) return;
    (evidence.lifecycleResponses ||= []).push({ meetingId: match[1], command: match[2], method: request.method(), path, status: response.status() });
    save();
  });

  await installE2EAuth(page);
  if (coreAcceptance || zeroWriteAudit) await page.addInitScript(installCoreContinueRolloverClock);
  if (ramAbcMode || ramAbcSmoke || ramProfileC || naturalRollover21 || ramGateMode || recordingContract || ramAttributionSmoke) await page.addInitScript((mode) => {
    const originalDebug = console.debug.bind(console);
    window.__issue41DiagnosticMode = mode;
    console.debug = (...args) => {
      if (window.__issue41DiagnosticMode === 'A') originalDebug(...args);
    };
  }, ramProfileC || naturalRollover21 || ramGateMode || recordingContract || ramAttributionSmoke ? 'C' : ramAbcMode || 'A');
  if (localRamMeasurement) await page.addInitScript(() => { window.__issue41BoundMockPcm = true; });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__issue41JournalWorkerPending = new Set();
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.issue41Journal = String(url).includes('durablePcmJournal.worker');
        if (this.issue41Journal) this.addEventListener('message', (event) => {
          window.__issue41JournalWorkerPending.delete(event.data?.id);
        });
      }
      postMessage(message, transfer) {
        if (this.issue41Journal && message?.id != null) window.__issue41JournalWorkerPending.add(message.id);
        return super.postMessage(message, transfer);
      }
    };
  });
  if (recordingContract && !zeroWriteAudit) await page.addInitScript((ram2) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeRecorderStart = MediaRecorder.prototype.start;
    const nativeRecorderStop = MediaRecorder.prototype.stop;
    window.__issue41RecorderTransitions = [];
    let nextRecorderId = 0;
    MediaRecorder.prototype.start = function (...args) {
      this.__issue41RecorderId ??= ++nextRecorderId;
      const result = nativeRecorderStart.apply(this, args);
      window.__issue41RecorderTransitions.push({ recorderId: this.__issue41RecorderId, event: 'start', at: Date.now(), mimeType: this.mimeType });
      return result;
    };
    MediaRecorder.prototype.stop = function (...args) {
      const recorderId = this.__issue41RecorderId;
      window.__issue41RecorderTransitions.push({ recorderId, event: 'stop-requested', at: Date.now() });
      this.addEventListener('stop', () => {
        window.__issue41RecorderTransitions.push({ recorderId, event: 'stop-completed', at: Date.now() });
      }, { once: true });
      return nativeRecorderStop.apply(this, args);
    };
    let shortened = 0;
    window.setTimeout = (callback, delay, ...args) => {
      if (shortened < (ram2 ? 2 : 1) && delay === 15 * 60_000) {
        shortened += 1;
        window.__issue41ControlledRolloverTimer = true;
        return nativeSetTimeout(callback, 15_000, ...args);
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
  }, ram2Diagnostic || zeroWriteAudit);
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.__issue41Tracks = [];
    window.__issue41NativeContexts = [];
    window.__issue41Contexts = [];
    window.__issue41Processors = [];
    window.__issue41PcmCount = 0;
    window.__issue41ProcessorCounts = {};
    window.__issue41LastPcmAt = null;
    window.__issue41MaxPcmGapMs = 0;
    window.__issue41Frames = 0;
    window.__issue41LateBatches = 0;
    window.__issue41SkippedBatches = 0;
    window.__issue41PcmStartedAt = null;
    window.__issue41NextPcmAt = null;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => {
        const context = new NativeAudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.frequency.value = 220;
        oscillator.connect(destination);
        oscillator.start();
        window.__issue41NativeContexts.push(context);
        const track = destination.stream.getAudioTracks()[0];
        const originalStop = track.stop.bind(track);
        track.stop = () => { track.stopped = true; originalStop(); oscillator.stop(); void context.close(); };
        window.__issue41Tracks.push(track);
        return destination.stream;
      }
    } });
    class AudioContextFixture {
      constructor() { this.sampleRate = 16000; this.currentTime = 0; this.destination = {}; this.state = 'running'; window.__issue41Contexts.push(this); }
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { const processor = { connect() {}, disconnect() {}, onaudioprocess: null }; window.__issue41Processors.push(processor); return processor; }
      createBuffer() { return { duration: 0, copyToChannel() {} }; }
      createBufferSource() { return { buffer: null, connect() {}, disconnect() {}, start() { this.onended?.(); }, stop() {}, onended: null }; }
    }
    window.AudioContext = AudioContextFixture;
    window.webkitAudioContext = AudioContextFixture;
    AudioContextFixture.prototype.decodeAudioData = async function (bytes) {
      const context = new NativeAudioContext();
      try { return await context.decodeAudioData(bytes); } finally { await context.close(); }
    };
    window.__issue41PcmTimer = setInterval(() => {
      const index = window.__issue41Processors.length - 1;
      const processor = window.__issue41Processors[index];
      if (window.__issue41Tracks.at(-1)?.readyState !== 'live' ||
          window.__issue41Contexts.at(-1)?.state !== 'running' ||
          typeof processor?.onaudioprocess !== 'function') return;
      const now = Date.now();
      if (!window.__issue41PcmStartedAt) { window.__issue41PcmStartedAt = now; window.__issue41NextPcmAt = now; }
      const delay = now - window.__issue41NextPcmAt;
      if (delay > 150) window.__issue41LateBatches += 1;
      if (delay > 200) window.__issue41SkippedBatches += Math.floor(delay / 100);
      window.__issue41NextPcmAt = now + 100;
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1600).fill(0.25) } });
      if (window.__issue41LastPcmAt) window.__issue41MaxPcmGapMs = Math.max(
        window.__issue41MaxPcmGapMs, now - window.__issue41LastPcmAt);
      window.__issue41LastPcmAt = now;
      window.__issue41PcmCount += 1;
      window.__issue41Frames += 1600;
      window.__issue41ProcessorCounts[index] = (window.__issue41ProcessorCounts[index] || 0) + 1;
    }, 100);
  });

  // Fake provider is bundled by vite.e2e.config.js. Only ephemeral-token creation is intercepted,
  // because the real endpoint would contact Gemini; Meeting, Session and Cue routes remain real.
  await page.route('**/api/live-token', async (route) => {
    const body = route.request().postDataJSON();
    const revision = createHash('sha256').update(serializeEffectiveGlossary({
      sourceLanguageCode: body.sourceLanguageCode, targetLanguageCode: body.targetLanguageCode, entries: []
    })).digest('hex');
    const lifecycleVersion = Number(route.request().headers()['x-meeting-lifecycle-version']);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      token: 'issue41-fake-provider-token', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      liveConnectModel: 'gemini-live-e2e-model', liveGlossaryEntries: [],
      effectiveGlossaryRevision: revision, glossaryEntryCount: 0,
      ...(Number.isSafeInteger(lifecycleVersion) ? { authoritativeSegment: {
        meetingId: body.meetingId, sessionId: body.sessionId,
        segmentId: body.segmentId, lifecycleVersion
      } } : {})
    }) });
  });

  await apiJson('GET', '/profile');
  if (coreAcceptance) {
    const denied = await page.request.get('/api/profile');
    expect(denied.status()).toBe(401);
    evidence.unauthenticatedProfileStatus = denied.status();
    save();
  }
  evidence.profileRows = (await dbRows('profiles', `select=id,status,role&id=eq.${auth.profile.id}`))
    .map((row) => ({ id: row.id, status: row.status, role: row.role }));
  save();

  const created = await apiJson('POST', '/meetings', {
    draft: true, name: `Issue 41 ${Date.now()}`, sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en', echoTargetLanguage: false, shouldRecordInputAudio: true
  });
  const meetingId = created.meeting.id;
  evidence.meetingId = meetingId;
  let initialSegmentId = created.segment?.id ?? null;
  evidence.initialSegmentId = initialSegmentId;
  expect(created.meeting.lifecycleContractVersion).toBe(2);
  expect(created.meeting.lifecycleVersion).toBe(0);
  expect(created.segment).toBeNull();
  if (coreAcceptance) expect(recordingOnly).toBe(false);
  const acceptanceShare = coreAcceptance
    ? await apiJson('POST', `/meetings/${meetingId}/shares`, { role: 'viewer' }) : null;
  if (zeroWriteAudit || localRamMeasurement) {
    const entry = await apiJson('POST', '/glossary/entries', {
      source: `Issue 41 稽核 ${Date.now()}`, translations: { en: 'Issue 41 audit' }, scope: 'both'
    });
    expect(entry.entry.id).toBeTruthy();
    expect((await apiJson('GET', '/glossary')).entries.some((row) => row.id === entry.entry.id)).toBe(true);
    if (coreAcceptance || zeroWriteAudit) {
      const updated = await apiJson('PUT', `/glossary/entries/${entry.entry.id}`, {
        source: entry.entry.source, translations: { en: 'Issue 41 updated' }, scope: 'both'
      });
      expect(updated.entry.translations.en).toBe('Issue 41 updated');
      expect((await apiJson('GET', '/glossary')).entries.find((row) => row.id === entry.entry.id)?.translations.en)
        .toBe('Issue 41 updated');
      evidence.dictionaryUpdated = true;
      if (zeroWriteAudit) {
        const selected = [{ source: updated.entry.source, target: updated.entry.translations.en }];
        await apiJson('PATCH', `/meetings/${meetingId}`, { glossaryEntries: selected });
        const detail = await apiJson('GET', `/meetings/${meetingId}`);
        expect(detail.meeting.glossaryEntries).toEqual([{ ...selected[0], replacementAliases: [] }]);
        evidence.dictionaryApplied = true;
      }
    }
    if (!zeroWriteAudit) {
      evidence.auditCoverage = installWriteAudit();
      evidence.dbBefore = databaseSnapshot();
      evidence.storageBefore = {
        audio: await storageObjects('meeting-audio'), exports: await storageObjects('meeting-exports')
      };
    }
    evidence.glossaryEntryId = entry.entry.id;
    save();
  }
  evidence.cloudBefore = await cloudInventory(meetingId);
  save();
  const share = acceptanceShare || (recordingOnly ? null
    : await apiJson('POST', `/meetings/${meetingId}/shares`, { role: 'viewer' }));
  if (!recordingOnly) expect(share.url || share.codeUrl).toBeTruthy();
  await page.goto('/#meetings');
  if (coreAcceptance) {
    const browserSupabaseUrl = await page.evaluate(async () =>
      (await import('/src/lib/supabaseAuth.js')).supabase?.supabaseUrl);
    expect(browserSupabaseUrl).toBe(supabaseUrl);
    evidence.environment = { browserSupabaseUrl, apiSupabaseUrl: supabaseUrl,
      authIssuer: `${supabaseUrl}/auth/v1` };
    save();
  }
  await page.evaluate((id) => sessionStorage.setItem(`live-translate:meeting-audio:${id}`, JSON.stringify({
    inputDeviceId: '', outputDeviceId: '', inputDeviceLabel: '瀏覽器預設麥克風',
    outputDeviceLabel: '瀏覽器預設揚聲器', permissionStatus: 'confirmed', confirmedAt: new Date().toISOString()
  })), meetingId);
  await page.goto(`/#live?meetingId=${meetingId}`);
  await expect(page.getByTestId('live-session-toolbar')).toContainText(created.meeting.name);
  await page.evaluate(() => { window.location.hash = '#settings'; });
  const credential = page.getByRole('textbox', { name: 'Gemini API Key' });
  await credential.fill('issue41-test-key');
  await page.getByRole('button', { name: '設定金鑰' }).click();
  await page.goto(`/#live?meetingId=${meetingId}`);
  await expect(page.getByRole('button', { name: '開始錄製' })).toBeEnabled();
  if (recordingOnly) {
    evidence.startPreconditions = await page.evaluate(async (id) => {
      const { hasLiveCredential } = await import('/src/lib/liveCredentialHolder.js');
      const { getMeetingAudioPreference, hasConfirmedMeetingAudioPreference } = await import('/src/lib/meetingAudioPreferences.js');
      return { credentialPresent: hasLiveCredential(), audioConfirmed: hasConfirmedMeetingAudioPreference(getMeetingAudioPreference(id)) };
    }, meetingId);
    save();
    expect(evidence.startPreconditions).toEqual({ credentialPresent: true, audioConfirmed: true });
  }
 const assertCloudZeroWrite = () => {
  evidence.recordingHttpWrites = auditRequests.flatMap((request) => {
   const route = classifyCloudContentRequest(request);
   return route ? [{ method: request.method, route }] : [];
  });
    expect(process.env.ISSUE41_SERVER_FETCH_AUDIT_FILE, 'Runner must provide the server fetch audit file').toBeTruthy();
    const serverRequests = readFileSync(process.env.ISSUE41_SERVER_FETCH_AUDIT_FILE, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    if (!zeroWriteAudit) {
      evidence.cloudContentWrite = evaluateNormalCloudContentWrite({
        events: evidence.writeEvents, coverage: evidence.auditCoverage,
        before: evidence.dbBefore, after: evidence.dbAfter,
        storageBefore: evidence.storageBefore, storageAfter: evidence.storageAfter,
        cloudBefore: evidence.cloudBefore, cloudAfter: evidence.cloudAfter,
        requests: auditRequests, complete: true
      }, serverRequests);
      if (evidence.evidenceChecks) evidence.evidenceChecks.cloudContentWrite = evidence.cloudContentWrite.status;
      save();
      expect(evidence.cloudContentWrite.status, JSON.stringify(evidence.cloudContentWrite.violations)).toBe('PASS');
      return;
    }
    const serverWrites = serverRequests.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
    const illegalServerRequests = serverWrites.filter((request) => classifyServerSupabaseWrite(request));
    const negative = evidence.negativeControl;
    const negativePass = negative?.database?.observedIllegalWrite === true
      && negative.database.rolledBack === true && negative.database.contentGuardRejected === true
      && negative.rpc.status >= 400
      && negative.storage.status >= 400 && negative.storage.objectAbsent === true
      && negative.legacy.status === 410;
    const matrix = {
      browserApi: { observedVia: 'Playwright page request events', count: auditRequests.length,
        illegalAttempts: evidence.recordingHttpWrites.length },
      apiSupabaseDatabase: { observedVia: 'Server fetch log plus PostgreSQL row triggers',
        outgoingWrites: serverWrites.length, committedWrites: evidence.writeEvents?.length ?? 0,
        triggerTables: evidence.auditCoverage?.monitoredTables?.length ?? 0,
        illegalAttempts: illegalServerRequests.length },
      supabaseRpc: { observedVia: 'Server fetch log and authenticated denied RPC probe',
        outgoing: serverRequests.filter(({ route }) => route.startsWith('/rest/v1/rpc/')).length,
        negativeStatus: negative?.rpc?.status ?? null },
      supabaseStorage: { observedVia: 'storage.objects trigger, object inventory and denied upload probe',
        negativeStatus: negative?.storage?.status ?? null, objectAbsent: negative?.storage?.objectAbsent ?? null },
      legacyEndpoints: { observedVia: 'Authenticated POST to legacy Cue endpoint',
        negativeStatus: negative?.legacy?.status ?? null }
    };
    matrix.complete = matrix.browserApi.count > 0 && matrix.apiSupabaseDatabase.outgoingWrites > 0
      && matrix.apiSupabaseDatabase.triggerTables === evidence.auditCoverage.expectedTables.length
      && matrix.supabaseRpc.outgoing > 0 && negativePass;
    evidence.auditCoverageMatrix = matrix;
    evidence.positiveIllegalAttempts = evidence.recordingHttpWrites.length + illegalServerRequests.length;
    evidence.negativeControlPass = negativePass;
    evidence.serverSupabaseWrites = serverWrites;
    writeFileSync(join(process.env.ISSUE41_RUN_DIR, 'audit-coverage-matrix.json'),
      `${JSON.stringify(matrix, null, 2)}\n`);
  evidence.cloudZeroWrite = evaluateCloudZeroWrite({
   events: evidence.writeEvents, coverage: evidence.auditCoverage,
   before: evidence.dbBefore, after: evidence.dbAfter,
   storageBefore: evidence.storageBefore, storageAfter: evidence.storageAfter,
   cloudBefore: evidence.cloudBefore, cloudAfter: evidence.cloudAfter,
   requests: auditRequests, complete: true
  });
  if (evidence.evidenceChecks) evidence.evidenceChecks.cloudZeroWrite = evidence.cloudZeroWrite.status;
  save();
    expect(matrix.complete, 'All five Cloud Zero channels must be observed').toBe(true);
    expect(evidence.positiveIllegalAttempts, 'Positive flow must have zero illegal attempts').toBe(0);
  expect(evidence.cloudZeroWrite.status, JSON.stringify(evidence.cloudZeroWrite.violations)).toBe('PASS');
 };
  await page.getByRole('button', { name: '開始錄製' }).click();
  if (zeroWriteAudit) {
    expect(!coreAcceptance || !recordingOnly, 'Core acceptance requires the Host/Viewer path').toBe(true);
    let auditViewer = null;
    const opfsSnapshot = (id) => page.evaluate(async (meetingId) => {
      const root = await navigator.storage.getDirectory();
      const journal = await (await (await root.getDirectoryHandle('pcm-journals'))
        .getDirectoryHandle('v1')).getDirectoryHandle(meetingId);
      const pcmFiles = [];
      for await (const [recordingId, directory] of journal.entries()) {
        if (directory.kind !== 'directory') continue;
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind !== 'file' || !/^pcm-\d+\.bin$/u.test(name)) continue;
          const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
          pcmFiles.push({ recordingId, name, bytes: bytes.byteLength });
        }
      }
      const { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } = await import('/src/lib/localMeetingStorage.js');
      const chunks = (await createIndexedDbLocalMeetingManifestStore().list(meetingId))
        .filter((chunk) => chunk.state === 'sealed');
      const chunkStore = createOpfsChunkStore();
      const chunkFiles = await Promise.all(chunks.map(async (chunk) => {
        const bytes = new Uint8Array(await (await chunkStore.read(chunk.path)).arrayBuffer());
        return { segmentId: chunk.segmentId, path: chunk.path, bytes: bytes.byteLength,
          matchesManifest: bytes.byteLength === chunk.byteSize };
      }));
      return { pcmFiles, pcmBytes: pcmFiles.reduce((sum, file) => sum + file.bytes, 0),
        chunkFiles, chunkBytes: chunkFiles.reduce((sum, file) => sum + file.bytes, 0) };
    }, id);
      const ownershipSnapshot = (id) => page.evaluate(async (meetingId) => {
        const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
        const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
        const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
        const store = createIndexedDbLocalMeetingManifestStore();
        const recording = await store.getRecording(meetingId);
        if (!recording) throw new Error('Core ownership recording missing');
        const segments = await store.listSegments(meetingId);
        const pendingTransitions = await store.listPendingSegmentTransitions(meetingId);
        const transitions = await Promise.all(segments.slice(0, -1).map((segment) =>
          store.getSegmentTransition(meetingId, segment.endedByOperationId)));
        const manifestChunks = (await store.list(meetingId)).filter((chunk) => chunk.state === 'sealed')
          .map(({ recordingId, segmentId, path, byteSize }) => ({ recordingId, segmentId, path, byteSize }));
        const client = createDurablePcmJournalClient({ meetingId, recordingId: recording.recordingId,
          existingOnly: true, readOnly: true });
        let journal;
        let epochs;
        let transitionReceipts;
        try {
          const status = await client.open();
          journal = { highestEpoch: status.highestEpoch, tailState: status.tailState,
            unclaimedTailBytes: status.unclaimedTailBytes };
          epochs = await Promise.all(Array.from({ length: journal.highestEpoch }, async (_, index) => {
            const captureEpoch = index + 1;
            const summary = await client.coverage(captureEpoch, 0, 0);
            const coverage = await client.coverage(captureEpoch, 0, summary.endSample ?? 0);
            return { captureEpoch, epochBegun: summary.epochBegun, epochClosed: summary.epochClosed,
              endSample: summary.endSample, complete: coverage.complete, gaps: coverage.gaps };
          }));
          transitionReceipts = await Promise.all(transitions.map(async (transition) => transition && ({
            operationId: transition.operationId,
            receipt: await client.verifiedTransitionReceipt(
              transition.boundaryOperationId || transition.operationId)
          })));
        } finally {
          await client.close();
        }
        const root = await navigator.storage.getDirectory();
        const directory = await (await (await root.getDirectoryHandle('pcm-journals'))
          .getDirectoryHandle('v1')).getDirectoryHandle(meetingId)
          .then((meeting) => meeting.getDirectoryHandle(recording.recordingId));
        const ledger = new Uint8Array(await (await directory.getFileHandle('claims.bin')).getFile()
          .then((file) => file.arrayBuffer()));
        const view = new DataView(ledger.buffer);
        const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const records = [];
        const pcmFiles = new Map();
        for (let offset = 0; offset < ledger.length;) {
          if (offset + 36 > ledger.length) throw new Error(`Core ownership ledger truncated at ${offset}`);
          const length = view.getUint32(offset, true);
          if (length < 2 || offset + 4 + length + 32 > ledger.length) {
            throw new Error(`Core ownership ledger record invalid at ${offset}`);
          }
          const payload = ledger.subarray(offset + 4, offset + 4 + length);
          const value = JSON.parse(new TextDecoder().decode(payload));
          const ledgerHashValid = (await digest(payload)) === [...ledger.subarray(offset + 4 + length,
            offset + 4 + length + 32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
          const ownerSegmentIds = segments.filter((segment, index) =>
            value.captureEpoch >= segment.firstJournalEpoch
            && value.captureEpoch <= (segments[index + 1] ? segment.lastJournalEpoch : journal.highestEpoch))
            .map((segment) => segment.segmentId);
          const record = { ...value, ledgerOffset: offset, ledgerHashValid, ownerSegmentIds,
            segmentId: ownerSegmentIds.length === 1 ? ownerSegmentIds[0] : null };
          if (value.type === 'pcm') {
            const name = `pcm-${String(value.segment).padStart(6, '0')}.bin`;
            if (!pcmFiles.has(name)) pcmFiles.set(name, await (await directory.getFileHandle(name)).getFile());
            const bytes = await pcmFiles.get(name).slice(value.offset, value.offset + value.byteLength).arrayBuffer();
            record.pcmHashValid = bytes.byteLength === value.byteLength
              && (await digest(bytes)) === value.sha256;
            record.pcmFile = name;
          }
          records.push(record);
          offset += 4 + length + 32;
        }
        const pcmFileSizes = [...pcmFiles].map(([name, file]) => ({ name, bytes: file.size }));
        const verifier = await createLocalMeetingPersistence({ manifestStore: store })
          .verifySegmentPcmOwnership(meetingId);
        return { recording, segments, pendingTransitions, transitions, manifestChunks,
          journal, epochs, transitionReceipts, ledgerBytes: ledger.length, records, pcmFileSizes,
          verifier: { status: verifier.status, reason: verifier.reason || null } };
      }, id);
      const assertCoreOwnership = (snapshot, opfs, expectedRecordingId, expectedSegmentIds) => {
        expect(snapshot.recording.recordingId).toBe(expectedRecordingId);
        expect(snapshot.recording.state).toBe('stopped_local');
        expect(snapshot.verifier, 'Product ownership verifier must pass').toMatchObject({ status: 'PASS' });
        expect(snapshot.pendingTransitions).toEqual([]);
        expect(snapshot.journal.tailState).toBe('CLEAN');
        expect(snapshot.journal.unclaimedTailBytes).toBe(0);
        expect(snapshot.segments.map((segment) => segment.segmentId)).toEqual(expectedSegmentIds);
        expect(snapshot.segments.every((segment) => segment.recordingId === expectedRecordingId
          && segment.status === 'ENDED' && segment.provenance === 'native')).toBe(true);
        expect(snapshot.transitions).toHaveLength(snapshot.segments.length - 1);
        expect(snapshot.transitions[0].boundaryOperationId,
          'Continue must own the committed Pause boundary').toMatch(/^pause:/u);
        const epochOwners = new Map();
        snapshot.segments.forEach((segment, index) => {
          const lastEpoch = snapshot.segments[index + 1]
            ? segment.lastJournalEpoch : snapshot.journal.highestEpoch;
          expect(segment.sequence).toBe(index + 1);
          expect(segment.firstJournalEpoch).toBeGreaterThan(0);
          expect(lastEpoch).toBeGreaterThanOrEqual(segment.firstJournalEpoch);
          for (let epoch = segment.firstJournalEpoch; epoch <= lastEpoch; epoch += 1) {
            expect(epochOwners.has(epoch), `Epoch ${epoch} must have one Segment owner`).toBe(false);
            epochOwners.set(epoch, segment.segmentId);
          }
        });
        expect([...epochOwners.keys()].sort((a, b) => a - b)).toEqual(
          Array.from({ length: snapshot.journal.highestEpoch }, (_, index) => index + 1));
        expect(snapshot.records.length).toBeGreaterThan(0);
        expect(snapshot.records.every((record) => record.recordingId === expectedRecordingId
          && record.ledgerHashValid && record.ownerSegmentIds.length === 1
          && record.segmentId === epochOwners.get(record.captureEpoch))).toBe(true);
        const pcmClaims = snapshot.records.filter((record) => record.type === 'pcm');
        expect(pcmClaims.length).toBeGreaterThan(0);
        expect(pcmClaims.every((claim) => claim.pcmHashValid
          && claim.endSample > claim.startSample
          && claim.byteLength === (claim.endSample - claim.startSample) * 2)).toBe(true);
        expect(pcmClaims.reduce((sum, claim) => sum + claim.byteLength, 0)).toBe(opfs.pcmBytes);
        expect(snapshot.pcmFileSizes.reduce((sum, file) => sum + file.bytes, 0)).toBe(opfs.pcmBytes);
        snapshot.epochs.forEach((epoch) => {
          const records = snapshot.records.filter((record) => record.captureEpoch === epoch.captureEpoch);
          const begins = records.filter((record) => record.type === 'begin');
          const ends = records.filter((record) => record.type === 'end');
          expect(begins, `Epoch ${epoch.captureEpoch} BEGIN receipt`).toHaveLength(1);
          expect(ends, `Epoch ${epoch.captureEpoch} END receipt`).toHaveLength(1);
          expect(ends[0].endSample).toBe(epoch.endSample);
          expect(epoch).toMatchObject({ epochBegun: true, epochClosed: true, complete: true, gaps: [] });
        });
        snapshot.transitions.forEach((transition, index) => {
          const predecessor = snapshot.segments[index];
          const successor = snapshot.segments[index + 1];
          const verified = snapshot.transitionReceipts[index];
          expect(transition.phase).toBe('COMMITTED');
          expect(transition.recordingId).toBe(expectedRecordingId);
          expect(transition.predecessorId).toBe(predecessor.segmentId);
          expect(transition.successorId).toBe(successor.segmentId);
          expect(verified.operationId).toBe(transition.operationId);
          expect(verified.receipt, `Transition ${transition.operationId} END receipt`).toEqual(transition.boundary);
          expect(verified.receipt.captureEpoch).toBe(predecessor.lastJournalEpoch);
          expect(successor.firstJournalEpoch).toBe(verified.receipt.captureEpoch + 1);
          expect(snapshot.records.some((record) => record.type === 'end'
            && record.captureEpoch === verified.receipt.captureEpoch
            && record.transitionOperationId === (transition.boundaryOperationId || transition.operationId)))
            .toBe(true);
        });
        expect(snapshot.manifestChunks.length).toBeGreaterThan(0);
        expect(snapshot.manifestChunks.every((chunk) => chunk.recordingId === expectedRecordingId
          && expectedSegmentIds.includes(chunk.segmentId)
          && opfs.chunkFiles.some((file) => file.path === chunk.path
            && file.segmentId === chunk.segmentId && file.bytes === chunk.byteSize
            && file.matchesManifest))).toBe(true);
      };
    const pipelineEvents = () => page.evaluate(async () => {
      const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
      return livePipelineTrace.get().filter(({ stage }) => [
        'CONTINUE_REQUESTED', 'RESUME_SEGMENT_CONFIRMED', 'CONTINUE_READY',
        'SESSION_ROLLOVER_START', 'ROLLOVER_COMMITTED', 'ROLLOVER_FAILED'
      ].includes(stage));
    });
    const providerPcm = () => page.evaluate(() => {
      const sessions = window.__mockGoogleGenAI?.liveSessions || [];
      return sessions.map((session, index) => ({ index, closed: session.closed,
        pcmInputs: session.sentInputs.filter((input) => Boolean(input?.audio)).length }));
    });
    try {
      await page.evaluate(async () => {
        const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
        livePipelineTrace.setEnabled(true);
      });
      await expect.poll(() => page.evaluate(() => window.__issue41PcmCount), { timeout: 30_000 }).toBeGreaterThan(0);
      const first = await localState(meetingId);
      expect(first.recording?.segmentId).toBeTruthy();
      const firstSegmentId = first.recording.segmentId;
      await page.evaluate(() => window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
        serverContent: {
          inputTranscription: { text: 'issue41 audit before' },
          outputTranscription: { text: 'audit before' }, turnComplete: true
        }
      }));
      await expect.poll(async () => (await localState(meetingId)).cues.length).toBeGreaterThan(0);
    if (coreAcceptance) {
      auditViewer = await browser.newPage();
      auditViewer.on('pageerror', (error) => { evidence.browserErrors.push(`viewer:${error.name}`); save(); });
      await auditViewer.goto(`/${share.url || share.codeUrl}`);
      await expect(auditViewer.getByTestId('meeting-viewer-cue-row').filter({ hasText: 'issue41 audit before' }))
        .toContainText('audit before', { timeout: 30_000 });
      evidence.viewer.push({ phase: 'join-snapshot', source: 'issue41 audit before' });
      save();
    }
      await page.getByRole('button', { name: '停止錄音' }).click();
      await expect(page.getByRole('button', { name: '繼續' })).toBeVisible();
      const firstPaused = await localState(meetingId);
      expect(firstPaused.recording).toMatchObject({ recordingId: first.recording.recordingId,
        segmentId: firstSegmentId, state: 'paused' });
      const firstPausedPcm = await page.evaluate(() => window.__issue41PcmCount);
      const firstPausedBytes = (await opfsSnapshot(meetingId)).pcmBytes;
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => window.__issue41PcmCount), 'Pause must stop PCM callbacks').toBe(firstPausedPcm);
      expect((await opfsSnapshot(meetingId)).pcmBytes, 'Pause must stop persisted PCM growth').toBe(firstPausedBytes);
      expect(await page.evaluate(() => window.__issue41CoreRolloverClock.shortened),
        'Initial recording must keep its 15-minute rollover clock').toBe(0);
      await page.evaluate(() => window.__issue41ArmContinueRolloverClock());
      const providerCountBeforeContinue = await page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length);
      const traceSequenceBeforeContinue = Math.max(0, ...(await pipelineEvents()).map((event) => event.traceSequence));
      await page.getByRole('button', { name: '繼續' }).click();
      await expect.poll(async () => (await pipelineEvents()).some((event) => event.stage === 'CONTINUE_READY'
        && event.traceSequence > traceSequenceBeforeContinue && event.sessionId === first.recording.recordingId),
        { message: 'Continue must emit CONTINUE_READY before Cue delivery', timeout: 60_000 }).toBe(true);
      await expect(page.getByRole('button', { name: '停止錄音' }), 'Host must enter listening after Continue')
        .toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await providerPcm()).length,
        { message: 'Continue must create a new Provider session', timeout: 30_000 })
        .toBeGreaterThan(providerCountBeforeContinue);
      const continueProviderIndex = providerCountBeforeContinue;
      await expect.poll(async () => (await providerPcm())[continueProviderIndex]?.pcmInputs || 0,
        { message: 'Continue Provider must send first PCM before Cue delivery', timeout: 30_000 })
        .toBeGreaterThan(0);
      const continueSegmentId = (await localState(meetingId)).recording?.segmentId;
      expect(continueSegmentId, 'Continue Segment ID').toBeTruthy();
      expect(continueSegmentId).not.toBe(firstSegmentId);
      const continueEvents = await pipelineEvents();
      const requested = continueEvents.find((event) => event.stage === 'CONTINUE_REQUESTED'
        && event.traceSequence > traceSequenceBeforeContinue && event.meetingId === meetingId
        && event.sessionId === first.recording.recordingId);
      const resumed = continueEvents.find((event) => event.stage === 'RESUME_SEGMENT_CONFIRMED'
        && event.traceSequence > (requested?.traceSequence || traceSequenceBeforeContinue)
        && event.meetingId === meetingId && event.segmentId === continueSegmentId);
      const ready = continueEvents.find((event) => event.stage === 'CONTINUE_READY'
        && event.traceSequence > (resumed?.traceSequence || traceSequenceBeforeContinue)
        && event.sessionId === first.recording.recordingId);
      expect(requested, 'Continue request belongs to this Meeting and session').toBeTruthy();
      expect(resumed, 'Continue Segment belongs to this Meeting').toBeTruthy();
      expect(ready, 'Continue readiness follows confirmed Segment').toBeTruthy();
      evidence.continueReadiness = { segmentId: continueSegmentId, providerIndex: continueProviderIndex,
        pcmInputs: (await providerPcm())[continueProviderIndex].pcmInputs,
        requested, resumed, ready };
      save();
      expect(await page.evaluate(() => window.__issue41CoreRolloverClock.shortened),
        'Continue must schedule the one shortened product rollover timer').toBe(1);
      await expect.poll(async () => (await pipelineEvents()).some((event) => event.stage === 'SESSION_ROLLOVER_START'
        && event.meetingId === meetingId && event.oldSegmentId === continueSegmentId),
      { message: 'Expected actual SESSION_ROLLOVER_START from Continue Segment', timeout: 60_000 }).toBe(true);
      await expect.poll(async () => (await pipelineEvents()).some((event) => event.stage === 'ROLLOVER_COMMITTED'
        && event.meetingId === meetingId && event.oldSegmentId === continueSegmentId),
      { message: 'Expected actual ROLLOVER_COMMITTED from Continue Segment', timeout: 60_000 }).toBe(true);
      const rolloverEvents = await pipelineEvents();
      const rolloverStart = rolloverEvents.find((event) => event.stage === 'SESSION_ROLLOVER_START'
        && event.oldSegmentId === continueSegmentId);
      const rolloverCommit = rolloverEvents.find((event) => event.stage === 'ROLLOVER_COMMITTED'
        && event.oldSegmentId === continueSegmentId);
      expect(rolloverCommit.traceSequence).toBeGreaterThan(rolloverStart.traceSequence);
      expect(rolloverCommit.newSegmentId).toBeTruthy();
      expect(rolloverCommit.newSegmentId).not.toBe(continueSegmentId);
      const continueSequence = Number(continueSegmentId.match(/:(\d+)$/u)?.[1]);
      const successorSequence = Number(rolloverCommit.newSegmentId.match(/:(\d+)$/u)?.[1]);
      expect(Number.isSafeInteger(continueSequence) && continueSequence > 0).toBe(true);
      expect(successorSequence).toBe(continueSequence + 1);
      expect(rolloverCommit.meetingId).toBe(meetingId);
      const providerCountBeforeRollover = providerCountBeforeContinue + 1;
      await expect.poll(async () => (await localState(meetingId)).recording?.segmentId,
        { message: 'Local current Segment must match committed successor', timeout: 30_000 })
        .toBe(rolloverCommit.newSegmentId);
      await expect.poll(async () => (await providerPcm()).length,
        { message: 'Rollover must create successor Provider session', timeout: 30_000 })
        .toBeGreaterThan(providerCountBeforeRollover);
      const successorProviderIndex = providerCountBeforeRollover;
      await expect.poll(async () => (await providerPcm())[successorProviderIndex]?.pcmInputs || 0,
        { message: 'Rollover Provider must send first PCM before Cue delivery', timeout: 30_000 })
        .toBeGreaterThan(0);
      await expect(page.getByRole('button', { name: '停止錄音' }), 'Host must return to listening after Rollover')
        .toBeVisible({ timeout: 30_000 });
      evidence.rolloverReadiness = { start: rolloverStart, commit: rolloverCommit,
        providerIndex: successorProviderIndex, pcmInputs: (await providerPcm())[successorProviderIndex].pcmInputs,
        acceleratedContract: true };
      save();
      await page.evaluate(() => window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
        serverContent: {
          inputTranscription: { text: 'issue41 audit after' },
          outputTranscription: { text: 'audit after' }, turnComplete: true
        }
      }));
      await expect.poll(async () => (await localState(meetingId)).cues.length, { timeout: 15_000 })
        .toBeGreaterThan(1);
      if (coreAcceptance) {
        await expect(auditViewer.getByTestId('meeting-viewer-cue-row').filter({ hasText: 'issue41 audit after' }))
          .toContainText('audit after', { timeout: 30_000 });
        evidence.viewer.push({ phase: 'subsequent-cue', source: 'issue41 audit after' });
        save();
      }
      await page.getByRole('button', { name: '停止錄音' }).click();
      await expect(page.getByRole('button', { name: '繼續' })).toBeVisible();
      const secondPaused = await localState(meetingId);
      expect(secondPaused.recording).toMatchObject({ recordingId: first.recording.recordingId,
        segmentId: rolloverCommit.newSegmentId, state: 'paused' });
      const secondPausedPcm = await page.evaluate(() => window.__issue41PcmCount);
      const secondPausedBytes = (await opfsSnapshot(meetingId)).pcmBytes;
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => window.__issue41PcmCount), 'Second Pause must stop PCM callbacks').toBe(secondPausedPcm);
      expect((await opfsSnapshot(meetingId)).pcmBytes, 'Second Pause must stop PCM writes').toBe(secondPausedBytes);
      await page.getByRole('button', { name: '繼續' }).click();
      await expect(page.getByRole('button', { name: '停止錄音' })).toBeVisible({ timeout: 30_000 });
      const secondContinueSegmentId = (await localState(meetingId)).recording?.segmentId;
      expect(Number(secondContinueSegmentId.match(/:(\d+)$/u)?.[1])).toBe(successorSequence + 1);
      expect((await localState(meetingId)).recording.recordingId).toBe(first.recording.recordingId);
      await expect.poll(() => page.evaluate(() => window.__issue41PcmCount), { timeout: 30_000 })
        .toBeGreaterThan(secondPausedPcm);

      await page.getByRole('link', { name: '返回會議管理' }).click();
      await expect.poll(async () => (await localState(meetingId)).recording?.state,
        { message: 'Navigation must await the durable Pause barrier', timeout: 60_000 }).toBe('paused');
      await expect(page.getByRole('heading', { name: '會議管理' })).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#meetings');
      const navigationPaused = await localState(meetingId);
      expect(navigationPaused.recording).toMatchObject({ recordingId: first.recording.recordingId,
        segmentId: secondContinueSegmentId, state: 'paused' });
      expect((await apiJson('GET', `/meetings/${meetingId}`)).meeting.status).not.toBe('completed');
      const navigationPausedPcm = await page.evaluate(() => window.__issue41PcmCount);
      const navigationPausedBytes = (await opfsSnapshot(meetingId)).pcmBytes;
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => window.__issue41PcmCount), 'Navigation Pause must stop PCM callbacks')
        .toBe(navigationPausedPcm);
      expect((await opfsSnapshot(meetingId)).pcmBytes, 'Navigation Pause must stop PCM writes')
        .toBe(navigationPausedBytes);
      await page.evaluate((id) => { window.location.hash = `#live?meetingId=${encodeURIComponent(id)}`; }, meetingId);
      await expect(page.getByRole('button', { name: '繼續' })).toBeVisible();
      await page.getByRole('button', { name: '繼續' }).click();
      await expect(page.getByRole('button', { name: '停止錄音' })).toBeVisible({ timeout: 30_000 });
      const navigationContinueSegmentId = (await localState(meetingId)).recording?.segmentId;
      expect(Number(navigationContinueSegmentId.match(/:(\d+)$/u)?.[1])).toBe(successorSequence + 2);
      expect((await localState(meetingId)).recording.recordingId).toBe(first.recording.recordingId);
      evidence.lifecycleResume = { secondContinueSegmentId, navigationContinueSegmentId,
        recordingId: first.recording.recordingId, navigationPausedPcm, navigationPausedBytes };
      save();
      const second = await localState(meetingId);
      expect(second.recording?.segmentId).toBe(navigationContinueSegmentId);
      expect(second.cues.find((cue) => cue.sourceText === 'issue41 audit before')?.segmentId).toBe(firstSegmentId);
      expect(second.cues.find((cue) => cue.sourceText === 'issue41 audit after')?.segmentId)
        .toBe(rolloverCommit.newSegmentId);
      evidence.localBeforeEnd = {
        recordingId: second.recording.recordingId,
        segmentId: second.recording.segmentId,
        cueSegments: second.cues.map((cue) => ({ source: cue.sourceText, segmentId: cue.segmentId })),
        chunkBytes: second.chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0),
        opfs: await opfsSnapshot(meetingId), checkpoints: second.checkpoints
      };
      if (coreAcceptance || zeroWriteAudit) {
        await page.getByRole('button', { name: '停止錄音' }).click();
        await expect(page.getByRole('button', { name: '繼續' })).toBeVisible();
        evidence.finalStop = { at: new Date().toISOString(), continueAvailable: true };
        save();
      }
      let endDialogHandling;
      page.once('dialog', (dialog) => {
        endDialogHandling = (async () => {
          try {
            expect(dialog.type()).toBe('confirm');
            expect(dialog.message()).toBe('確定要結束這場會議嗎？既有逐字稿會保留，之後將無法繼續錄製。');
            await dialog.accept();
          } catch (error) {
            await dialog.dismiss();
            throw error;
          }
        })();
      });
      await page.getByRole('button', { name: '結束會議' }).click();
      expect(endDialogHandling, 'End must show its native confirmation').toBeDefined();
      await endDialogHandling;
      await expect.poll(async () => (await localState(meetingId)).recording?.state,
        { message: 'End must commit stopped_local after the local durable barrier', timeout: 60_000 })
        .toBe('stopped_local');
  const endRoute = `#meeting-detail?meetingId=${encodeURIComponent(meetingId)}&from=history`;
  await expect.poll(() => page.evaluate(() => window.location.hash),
    { message: 'End lifecycle must finish before Reload', timeout: 30_000 }).toBe(endRoute);
  evidence.endBarrier = { at: new Date().toISOString(), recordingState: 'stopped_local', route: endRoute };
  const endOperationId = `end:${meetingId}:${second.recording.recordingId}`;
  let endReceipt = null;
  await expect.poll(async () => {
    endReceipt = await page.evaluate(async ({ id, operationId }) => {
      const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
      return createIndexedDbLocalMeetingManifestStore().getOperation(id, operationId);
    }, { id: meetingId, operationId: endOperationId });
    return endReceipt !== null;
  }, { message: 'End receipt must be durable before assertion', timeout: 30_000 }).toBe(true);
  expect(endReceipt).toMatchObject({
    operationId: endOperationId, type: 'finalize',
    result: { state: 'stopped_local', recordingId: second.recording.recordingId }
  });
  evidence.endReceipt = { operationId: endOperationId, state: endReceipt.result.state,
    finalSequence: endReceipt.result.finalSequence };
      save();
  if (coreAcceptance || zeroWriteAudit) {
        try {
      const afterEnd = await localState(meetingId);
      evidence.localAfterEnd = { opfs: await opfsSnapshot(meetingId),
        recording: afterEnd.recording, cues: afterEnd.cues,
        checkpoints: afterEnd.checkpoints, chunks: afterEnd.chunks };
          save();
          evidence.ownershipBeforeReload = await ownershipSnapshot(meetingId);
          save();
        } catch (error) {
          evidence.ownershipFailure = { stage: 'before_reload_snapshot', message: error.message };
          save();
          throw error;
        }
      }
      await page.reload();
      const restored = await localState(meetingId);
      evidence.localAfterReload = {
        state: restored.recording?.state,
        recordingId: restored.recording?.recordingId,
        segmentId: restored.recording?.segmentId,
        cueSegments: restored.cues.map((cue) => ({ source: cue.sourceText, segmentId: cue.segmentId })),
        chunkBytes: restored.chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0),
        opfs: await opfsSnapshot(meetingId), checkpoints: restored.checkpoints
      };
  if (coreAcceptance || zeroWriteAudit) {
        try {
          evidence.ownershipAfterReload = await ownershipSnapshot(meetingId);
          save();
        const expectedSegmentIds = [firstSegmentId, evidence.continueReadiness.segmentId,
          evidence.rolloverReadiness.commit.newSegmentId, evidence.lifecycleResume.secondContinueSegmentId,
          evidence.lifecycleResume.navigationContinueSegmentId];
        expect(evidence.localAfterReload.cueSegments.every((cue) => expectedSegmentIds.includes(cue.segmentId)))
          .toBe(true);
        expect(evidence.localAfterReload.checkpoints.every((checkpoint) => expectedSegmentIds.includes(checkpoint.segmentId)))
          .toBe(true);
        expect(evidence.localAfterReload.checkpoints).toEqual(evidence.localAfterEnd.checkpoints);
          assertCoreOwnership(evidence.ownershipBeforeReload, evidence.localAfterEnd.opfs,
            second.recording.recordingId, expectedSegmentIds);
          assertCoreOwnership(evidence.ownershipAfterReload, evidence.localAfterReload.opfs,
            second.recording.recordingId, expectedSegmentIds);
          expect(evidence.ownershipAfterReload, 'Reload must preserve Journal ownership')
            .toEqual(evidence.ownershipBeforeReload);
          evidence.ownershipGate = { status: 'PASS', at: new Date().toISOString() };
          save();
        } catch (error) {
          evidence.ownershipFailure = { stage: 'reload_ownership', message: error.message };
          save();
          throw error;
        }
      }
      expect(evidence.localBeforeEnd.opfs.pcmBytes).toBeGreaterThan(0);
      expect(evidence.localAfterReload.opfs.pcmBytes).toBeGreaterThan(0);
      expect(evidence.localAfterReload.opfs.chunkBytes).toBeGreaterThan(0);
      expect(evidence.localAfterReload.opfs.chunkFiles.every((file) => file.matchesManifest)).toBe(true);
      expect(evidence.localAfterReload.checkpoints.length).toBeGreaterThan(0);
      expect(evidence.localAfterReload.cueSegments).toEqual(evidence.localBeforeEnd.cueSegments);
      expect(evidence.localAfterReload.state).toBe('stopped_local');
  expect(restored.recording).toEqual(evidence.localAfterEnd.recording);
  expect(restored.cues).toEqual(evidence.localAfterEnd.cues);
  expect(restored.checkpoints).toEqual(evidence.localAfterEnd.checkpoints);
  expect(restored.chunks).toEqual(evidence.localAfterEnd.chunks);
  expect(evidence.localAfterReload.opfs).toEqual(evidence.localAfterEnd.opfs);
  if (coreAcceptance || zeroWriteAudit) {
    await page.getByRole('navigation', { name: '會議內容目錄' }).getByRole('button', { name: '匯出' }).click();
    const exportPanel = page.getByRole('region', { name: '本機字幕匯出' });
    const expectedExports = await page.evaluate(async (id) => {
      const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
      const { exportCuesToTxt, exportCuesToSrt, exportCuesToVtt } = await import('/src/lib/subtitleCueExport.js');
      const records = await createIndexedDbLocalMeetingManifestStore().listCues(id);
      const cues = records.map((record) => record.cue);
      return {
        txt: exportCuesToTxt(cues, { stream: 'translation' }),
        srt: exportCuesToSrt(cues, { stream: 'translation' }),
        vtt: exportCuesToVtt(cues, { stream: 'translation' })
      };
    }, meetingId);
    evidence.localExports = {};
    for (const format of ['txt', 'srt', 'vtt']) {
      await page.getByLabel('字幕匯出格式').selectOption(format);
      const downloadPromise = page.waitForEvent('download');
      await exportPanel.getByRole('button', { name: '開始匯出' }).click();
      const download = await downloadPromise;
      const bytes = readFileSync(await download.path());
      expect(bytes.toString('utf8')).toBe(expectedExports[format]);
      evidence.localExports[format] = { bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    evidence.localExport = evidence.localExports.txt;
    save();
  }
      expect(evidence.localAfterReload.cueSegments.find((cue) => cue.source === 'issue41 audit before')?.segmentId)
        .toBe(firstSegmentId);
      expect(evidence.localAfterReload.cueSegments.find((cue) => cue.source === 'issue41 audit after')?.segmentId)
        .toBe(rolloverCommit.newSegmentId);
      expect((await apiJson('GET', `/meetings/${meetingId}`)).meeting.status).toBe('completed');
      await page.evaluate((id) => { window.location.hash = `#live?meetingId=${encodeURIComponent(id)}`; }, meetingId);
      await expect(page.getByRole('button', { name: '開始錄製' })).toHaveCount(0);
      const secondDevice = await browser.newContext();
      try {
        const userHeaders = { apikey: publishableKey, Authorization: `Bearer ${auth.token}` };
        const apiOrigin = new URL(page.url()).origin;
        const inspect = async (method, url, headers = userHeaders, data) => {
          const response = await secondDevice.request.fetch(url, { method, headers, data });
          const body = await response.json().catch(() => null);
          return { status: response.status(), code: body?.code || body?.error?.code || null,
            message: body?.message || body?.error?.message || null, body };
        };
        const profile = await inspect('GET', `${apiOrigin}/api/profile`, { Authorization: `Bearer ${auth.token}` });
        expect(profile.status, 'Second device must authenticate through the real Server').toBe(200);
        expect(profile.body?.profile?.id).toBe(auth.profile.id);
        const detail = await inspect('GET', `${apiOrigin}/api/meetings/${meetingId}`,
          { Authorization: `Bearer ${auth.token}` });
        expect(detail.status, 'Second device must read allowed Meeting metadata').toBe(200);
        expect(detail.body?.meeting?.id).toBe(meetingId);
        const meeting = await inspect('GET', `${supabaseUrl}/rest/v1/meetings?select=id,name&id=eq.${meetingId}`);
        expect(meeting.status, 'Second device must use the isolated Supabase project').toBe(200);
        expect(meeting.body?.map((row) => row.id)).toEqual([meetingId]);
        const checked = [];
        const noContent = async (name, method, url, { server = false, data } = {}) => {
          const result = await inspect(method, url, server ? { Authorization: `Bearer ${auth.token}` } : userHeaders, data);
          checked.push({ name, status: result.status, code: result.code, message: result.message,
            rows: Array.isArray(result.body) ? result.body.length : null });
          if (server) {
            expect(result.status, `${name} must use the Local-only Server fence`).toBe(410);
            expect(result.code, `${name} must reject recording content`).toBe('meeting_content_local_only');
          } else if (result.status === 200) {
            expect(result.body, `${name} must contain no cloud recording rows or objects`).toEqual([]);
          } else {
            expect(result.status, `${name} must be an explicit permission denial`).toBe(403);
            expect(result.code, `${name} must be denied by table privileges`).toBe('42501');
          }
        };
        await noContent('subtitle_cues', 'GET', `${supabaseUrl}/rest/v1/subtitle_cues?select=id`);
        await noContent('sessions', 'GET', `${supabaseUrl}/rest/v1/sessions?select=id&meeting_id=eq.${meetingId}`);
        await noContent('meeting_segments', 'GET', `${supabaseUrl}/rest/v1/meeting_segments?select=id&meeting_id=eq.${meetingId}`);
        await noContent('session_transcript', 'GET', `${supabaseUrl}/rest/v1/sessions?select=transcript_items&meeting_id=eq.${meetingId}`);
        await noContent('segment_checkpoint', 'GET', `${supabaseUrl}/rest/v1/meeting_segments?select=checkpoint&meeting_id=eq.${meetingId}`);
        await noContent('meeting_recordings', 'GET', `${supabaseUrl}/rest/v1/meeting_recordings?select=id&meeting_id=eq.${meetingId}`);
        for (const bucket of ['meeting-audio', 'meeting-exports']) {
          await noContent(`storage:${bucket}`, 'POST', `${supabaseUrl}/storage/v1/object/list/${bucket}`,
            { data: { prefix: '', limit: 1000 } });
        }
        for (const path of [
          `/api/meetings/${meetingId}/segments/${firstSegmentId}/cues`,
          `/api/meetings/${meetingId}/segments/${firstSegmentId}/checkpoint`,
          `/api/meetings/${meetingId}/audio/input`,
          `/api/meetings/${meetingId}/audio-artifacts`,
          `/api/meetings/${meetingId}/exports`,
          `/api/sessions/${second.recording.recordingId}`,
          `/api/sessions/${second.recording.recordingId}/audio/input`
        ]) await noContent(path, 'GET', `${apiOrigin}${path}`, { server: true });
        evidence.secondDevice = {
          auth: { status: profile.status, userId: profile.body.profile.id },
          meeting: { serverStatus: detail.status, supabaseStatus: meeting.status, meetingId },
          contentChecks: checked
        };
        save();
      } finally {
        await secondDevice.close();
      }
    if (zeroWriteAudit) {
      const database = rolledBackRecordingWriteControl(meetingId);
      expect(database).toEqual({ observedIllegalWrite: true, before: 0, after: 0,
        persistedAuditRows: 0, rolledBack: true, contentGuardRejected: true });
      const rpc = await page.request.post(`${supabaseUrl}/rest/v1/rpc/resume_legacy_meeting_segment`, {
        headers: { apikey: publishableKey, Authorization: `Bearer ${auth.token}` },
        data: { p_owner_user_id: auth.profile.id, p_meeting_id: meetingId,
          p_source_segment_id: firstSegmentId, p_operation_id: 'issue41-negative-control',
          p_payload_hash: 'negative-control', p_next_live_session_id: 'negative-control',
          p_expected_session_id: null, p_checkpoint: {} }
      });
      const legacy = await page.request.post(`/api/meetings/${meetingId}/segments/${firstSegmentId}/cues`, {
        headers: { Authorization: `Bearer ${auth.token}` }, data: { cue: 'negative-control' }
      });
      evidence.negativeControl = { database, rpc: { status: rpc.status() },
        storage: evidence.authenticatedStorageDenial,
        legacy: { status: legacy.status() } };
      save();
      expect(rpc.ok(), 'Legacy RPC must reject content write').toBe(false);
      expect(evidence.negativeControl.storage.status, 'Authenticated Storage upload must be denied')
        .toBeGreaterThanOrEqual(400);
      expect(evidence.negativeControl.storage.objectAbsent).toBe(true);
      expect(legacy.status(), 'Legacy Cue endpoint must reject content write').toBe(410);
    }
    } finally {
      if (!evidence.localAfterReload) {
        evidence.firstDivergence = { events: await pipelineEvents().catch(() => []),
          providers: await providerPcm().catch(() => []),
          local: await localState(meetingId).catch(() => null) };
      }
      evidence.dbAfter = databaseSnapshot();
      evidence.writeEvents = recordedWrites();
      evidence.storageAfter = {
        audio: await storageObjects('meeting-audio'), exports: await storageObjects('meeting-exports')
      };
  evidence.cloudAfter = await cloudInventory(meetingId);
      save();
    }
 assertCloudZeroWrite();
    evidence.result = 'ZERO_RECORDING_WRITE_PASS';
    if (coreAcceptance) {
      expect(evidence.viewer.map((row) => row.phase)).toEqual(['join-snapshot', 'subsequent-cue']);
      expect(evidence.browserErrors).toEqual([]);
      await auditViewer.close();
      evidence.result = 'LOCAL_CORE_E2E_PASS';
    }
    save();
    return;
  }
  if (localRamMeasurement) {
    await expect.poll(() => page.evaluate(() => window.__issue41PcmCount),
      { timeout: 30_000 }).toBeGreaterThan(0);
    const captureStart = await page.evaluate(async (debugEnabled) => {
      const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
      livePipelineTrace.setEnabled(debugEnabled);
      return window.__issue41PcmStartedAt;
    }, !ramProfileC && !naturalRollover21 && !ramGateMode && !recordingContract && !ramAttributionSmoke && (!ramAbcMode || ramAbcMode === 'A'));
    expect(captureStart, 'real PCM capture start').toBeGreaterThan(0);
    await expect.poll(async () => (await localState(meetingId)).recording?.segmentId,
      { timeout: 30_000 }).toBeTruthy();
    const firstRecording = (await localState(meetingId)).recording;
    initialSegmentId = firstRecording.segmentId;
    evidence.initialSegmentId = initialSegmentId;
    evidence.captureStartedAt = new Date(captureStart).toISOString();
    evidence.ramConfiguration = { intervalMs: 30_000, heapSnapshots: false,
      playwrightTrace: false, thresholds: PROVISIONAL_RAM_THRESHOLDS };
    if (naturalRollover21 || ramGateMode || recordingContract || ramAttributionSmoke) {
      const debug = await page.evaluate(async () => {
        const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
        return { traceEnabled: livePipelineTrace.isEnabled(), consoleMode: window.__issue41DiagnosticMode };
      });
      expect(debug).toEqual({ traceEnabled: false, consoleMode: 'C' });
      evidence.ramConfiguration.debug = debug;
    }
    evidence.rolloverObservations = [];
    save();

    const cdp = await page.context().newCDPSession(page);
    const system = await browser.newBrowserCDPSession();
    await cdp.send('Performance.enable');
    let hostTargetId = null;
    let firstRendererPid = null;
    const memory = async () => {
      const [metrics, processes, target, targets] = await Promise.all([
        cdp.send('Performance.getMetrics'),
        system.send('SystemInfo.getProcessInfo').catch(() => null),
        cdp.send('Target.getTargetInfo').catch(() => null),
        system.send('Target.getTargets').catch(() => null)
      ]);
      const pageTargetId = target?.targetInfo?.targetId ?? null;
      const pageTargets = targets?.targetInfos?.filter((entry) => entry.type === 'page') ?? [];
      const rendererPids = processes?.processInfo?.filter((entry) => entry.type === 'renderer')
        .map((entry) => entry.id) ?? [];
      const hostPageCount = page.context().pages().length;
      const attributed = attributeHostRenderer({ pageTargetId, pageTargets, hostPageCount,
        rendererPids, expectedTargetId: hostTargetId, expectedRendererPid: firstRendererPid });
      let unattributedReason = attributed.reason;
      let chromiumRssBytes = 'UNATTRIBUTED';
      if (!unattributedReason) {
        try {
          chromiumRssBytes = Number(execFileSync('ps', ['-p', String(rendererPids[0]), '-o', 'rss='],
            { encoding: 'utf8' }).trim()) * 1024;
          if (!Number.isFinite(chromiumRssBytes) || chromiumRssBytes <= 0) throw new Error('invalid RSS');
        } catch { unattributedReason = 'RENDERER_RSS_UNAVAILABLE'; }
      }
      if (unattributedReason) chromiumRssBytes = 'UNATTRIBUTED';
      else { hostTargetId ||= pageTargetId; firstRendererPid ||= rendererPids[0]; }
      const attribution = { pageTargetId, pageTargets: pageTargets.map(({ targetId, url }) => ({ targetId, url })),
        hostPageCount, rendererPids, method: unattributedReason ? 'UNATTRIBUTED' : 'ISOLATED_SINGLE_PAGE_SINGLE_RENDERER',
        reason: unattributedReason, initialRendererPid: firstRendererPid };
      if (unattributedReason) {
        evidence.rssAttributionFailure = { at: new Date().toISOString(), ...attribution };
        save();
        throw new Error(`RSS_UNATTRIBUTED:${unattributedReason}`);
      }
      return { rendererPid: unattributedReason ? null : rendererPids[0],
        rendererAlive: !unattributedReason, rssAttribution: attribution,
        chromiumRssBytes, jsHeapBytes: metrics.metrics.find((entry) => entry.name === 'JSHeapUsedSize')?.value ?? 'NOT_MEASURED',
        arrayBufferExternalBytes: 'NOT_MEASURED_BY_CDP_PERFORMANCE' };
    };
  const sampleResourceAttribution = async (phase, secondsAfterBarrier = null) => {
    const [heap, dom, targets] = await Promise.all([
      cdp.send('Runtime.getHeapUsage').catch(() => null),
      cdp.send('Memory.getDOMCounters').catch(() => null),
      system.send('Target.getTargets').catch(() => null)
    ]);
    const row = { phase, at: new Date().toISOString(), secondsAfterBarrier,
      heapUsedBytes: heap?.usedSize ?? 'NOT_MEASURED',
      heapAllocatedBytes: heap?.totalSize ?? 'NOT_MEASURED',
      backingStorageBytes: heap?.backingStorageSize ?? 'NOT_MEASURED',
      embedderHeapBytes: heap?.embedderHeapUsedSize ?? 'NOT_MEASURED',
      documents: dom?.documents ?? 'NOT_MEASURED', nodes: dom?.nodes ?? 'NOT_MEASURED',
      jsEventListeners: dom?.jsEventListeners ?? 'NOT_MEASURED',
      workerTargets: targets?.targetInfos?.filter((target) => target.type === 'worker').length ?? 'NOT_MEASURED' };
    evidence.resourceAttribution ??= [];
    evidence.resourceAttribution.push(row);
    save();
  };
    const browserSample = () => page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const opfs = { files: 0, bytes: 0 };
      const walk = async (directory) => {
        for await (const handle of directory.values()) {
          if (handle.kind === 'directory') await walk(handle);
          else { opfs.files += 1; opfs.bytes += (await handle.getFile()).size; }
        }
      };
      await walk(root);
      const stores = {};
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(info.name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        for (const name of db.objectStoreNames) {
          if (!/claim|operation/i.test(name)) continue;
          stores[`${info.name}/${name}`] = await new Promise((resolve, reject) => {
            const request = db.transaction(name, 'readonly').objectStore(name).count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        }
        db.close();
      }
      const providers = window.__mockGoogleGenAI?.liveSessions || [];
      return { opfs, stores, callbacks: window.__issue41PcmCount,
        lastCallbackAgeMs: Date.now() - window.__issue41LastPcmAt,
        journalQueue: window.__issue41JournalWorkerPending?.size ?? 'NOT_MEASURED',
        providerSessions: providers.length,
        providerPcmInputs: providers.map((session) => session.audioInputCount || session.sentInputs.filter((input) => Boolean(input?.audio)).length),
        liveTracks: window.__issue41Tracks.filter((track) => track.readyState === 'live').length };
    });
    const lightBrowserSample = () => page.evaluate(() => ({
      callbacks: window.__issue41PcmCount,
      frames: window.__issue41Frames,
      lastCallbackAgeMs: Date.now() - window.__issue41LastPcmAt,
      journalQueue: window.__issue41JournalWorkerPending?.size ?? 'NOT_MEASURED',
      liveTracks: window.__issue41Tracks.filter((track) => track.readyState === 'live').length
    }));
    const recordingSample = () => page.evaluate(async (id) => {
      const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
      return createIndexedDbLocalMeetingManifestStore().getRecording(id);
    }, meetingId);
    const journalPcmBytes = () => page.evaluate(async (id) => {
      const root = await navigator.storage.getDirectory();
      const meeting = await (await (await root.getDirectoryHandle('pcm-journals'))
        .getDirectoryHandle('v1')).getDirectoryHandle(id);
      let bytes = 0;
      for await (const [, recording] of meeting.entries()) {
        if (recording.kind !== 'directory') continue;
        for await (const [name, file] of recording.entries()) {
          if (file.kind === 'file' && /^pcm-\d+\.bin$/u.test(name)) bytes += (await file.getFile()).size;
        }
      }
      return bytes;
    }, meetingId);
    const readJournalClaims = () => page.evaluate(async (id) => {
      const root = await navigator.storage.getDirectory();
      const meeting = await (await (await root.getDirectoryHandle('pcm-journals'))
        .getDirectoryHandle('v1')).getDirectoryHandle(id);
      const recordings = [];
      for await (const [recordingId, directory] of meeting.entries()) {
        const pcmFiles = new Map();
        const ledger = new Uint8Array(await (await (await directory.getFileHandle('claims.bin')).getFile()).arrayBuffer());
        const view = new DataView(ledger.buffer);
        const epochs = new Map();
        let cursor = 0;
        let ledgerHashesValid = true;
        let pcmHashesValid = true;
        let pcmBytes = 0;
        let claims = 0;
        while (cursor < ledger.length) {
          if (cursor + 36 > ledger.length) throw new Error('PCM journal ledger truncated');
          const length = view.getUint32(cursor, true);
          if (length < 2 || length > 4096 || cursor + 4 + length + 32 > ledger.length)
            throw new Error('PCM journal ledger record invalid');
          const payload = ledger.subarray(cursor + 4, cursor + 4 + length);
          const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
          if (hash.some((byte, index) => byte !== ledger[cursor + 4 + length + index])) ledgerHashesValid = false;
          const claim = JSON.parse(new TextDecoder().decode(payload));
          if (claim.recordingId !== recordingId || claim.version !== 1) throw new Error('PCM journal identity mismatch');
          const epoch = epochs.get(claim.captureEpoch) || { captureEpoch: claim.captureEpoch,
            claims: 0, bytes: 0, nextSample: 0, gaps: 0, overlaps: 0, ended: false };
          if (claim.type === 'pcm') {
            if (claim.startSample > epoch.nextSample) epoch.gaps += claim.startSample - epoch.nextSample;
            if (claim.startSample < epoch.nextSample) epoch.overlaps += epoch.nextSample - claim.startSample;
            epoch.nextSample = Math.max(epoch.nextSample, claim.endSample);
            if (claim.byteLength !== (claim.endSample - claim.startSample) * 2) throw new Error('PCM claim length mismatch');
            let file = pcmFiles.get(claim.segment);
            if (!file) {
              file = await (await directory.getFileHandle(`pcm-${String(claim.segment).padStart(6, '0')}.bin`)).getFile();
              pcmFiles.set(claim.segment, file);
            }
            const bytes = new Uint8Array(await file.slice(claim.offset, claim.offset + claim.byteLength).arrayBuffer());
            const pcmHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
              .map((byte) => byte.toString(16).padStart(2, '0')).join('');
            if (bytes.length !== claim.byteLength || pcmHash !== claim.sha256) pcmHashesValid = false;
            epoch.claims += 1;
            epoch.bytes += claim.byteLength;
            pcmBytes += claim.byteLength;
            claims += 1;
          } else if (claim.type === 'end') {
            epoch.ended = true;
            epoch.endSample = claim.endSample;
            if (claim.endSample > epoch.nextSample) epoch.gaps += claim.endSample - epoch.nextSample;
            if (claim.endSample < epoch.nextSample) epoch.overlaps += epoch.nextSample - claim.endSample;
          } else if (claim.type !== 'begin') throw new Error('Unknown PCM journal record');
          epochs.set(claim.captureEpoch, epoch);
          cursor += 4 + length + 32;
        }
        recordings.push({ recordingId, ledgerBytes: ledger.length, claims, pcmBytes,
          ledgerHashesValid, pcmHashesValid, epochs: [...epochs.values()] });
      }
      return recordings;
    }, meetingId);
    const releaseFixtureAudioAfterEnd = async () => {
      await expect.poll(() => page.evaluate(() => ({
        liveTracks: window.__issue41Tracks.filter((track) => track.readyState === 'live').length,
        openNativeContexts: window.__issue41NativeContexts.filter((context) => context.state !== 'closed').length,
        openFixtureContexts: window.__issue41Contexts.filter((context) => context.state !== 'closed').length,
        activeProcessors: window.__issue41Processors.filter((processor) => typeof processor.onaudioprocess === 'function').length,
        pendingJournalRequests: window.__issue41JournalWorkerPending.size
      })), { timeout: 10_000 }).toEqual({ liveTracks: 0, openNativeContexts: 0,
        openFixtureContexts: 0, activeProcessors: 0, pendingJournalRequests: 0 });
      const released = await page.evaluate(() => {
        const counts = { tracks: window.__issue41Tracks.length,
          nativeContexts: window.__issue41NativeContexts.length,
          fixtureContexts: window.__issue41Contexts.length,
          processors: window.__issue41Processors.length };
        clearInterval(window.__issue41PcmTimer);
        window.__issue41PcmTimer = null;
        window.__issue41Tracks.length = 0;
        window.__issue41NativeContexts.length = 0;
        window.__issue41Contexts.length = 0;
        window.__issue41Processors.length = 0;
        return counts;
      });
      return { at: new Date().toISOString(), ownership: 'fixture-owned references and timer',
        verifiedStopped: true, released };
    };
    if (ramAttributionSmoke) {
      const firstPcmCount = await page.evaluate(() => window.__issue41PcmCount);
      const first = { at: new Date().toISOString(), ...await memory(), pcmCallbacks: firstPcmCount };
      expect(first.rssAttribution.method).toBe('ISOLATED_SINGLE_PAGE_SINGLE_RENDERER');
      expect(first.chromiumRssBytes).toBeGreaterThan(0);
      expect(first.jsHeapBytes).toBeGreaterThan(0);
      const syntheticAmbiguity = attributeHostRenderer({
        pageTargetId: first.rssAttribution.pageTargetId,
        pageTargets: first.rssAttribution.pageTargets,
        hostPageCount: 1,
        rendererPids: [...first.rssAttribution.rendererPids, -1],
        expectedTargetId: first.rssAttribution.pageTargetId,
        expectedRendererPid: first.rendererPid
      });
      expect(syntheticAmbiguity).toMatchObject({ method: 'UNATTRIBUTED', reason: 'RENDERER_COUNT_NOT_ONE', rendererPid: null });
      await expect.poll(() => page.evaluate(() => window.__issue41PcmCount),
        { timeout: 15_000 }).toBeGreaterThan(firstPcmCount + 20);
      const second = { at: new Date().toISOString(), ...await memory(),
        pcmCallbacks: await page.evaluate(() => window.__issue41PcmCount) };
      expect(second.rssAttribution.pageTargetId).toBe(first.rssAttribution.pageTargetId);
      expect(second.rendererPid).toBe(first.rendererPid);
      evidence.ramAttributionSmoke = { first, second, syntheticAmbiguity };
      save();
      await page.getByRole('button', { name: '結束會議' }).click();
      await expect.poll(async () => (await localState(meetingId)).recording?.state,
        { timeout: 60_000 }).toBe('stopped_local');
      await expect.poll(() => page.evaluate(() => window.location.hash),
        { timeout: 30_000 }).toBe(`#meeting-detail?meetingId=${encodeURIComponent(meetingId)}&from=history`);
      evidence.ramAttributionSmoke.fixtureAudioCleanup = await releaseFixtureAudioAfterEnd();
      evidence.ramAttributionSmoke.afterEnd = { at: new Date().toISOString(), ...await memory() };
      await page.reload();
      const restored = await localState(meetingId);
      const opfs = await browserSample();
      expect(restored.recording?.state).toBe('stopped_local');
      expect(restored.chunks.length).toBeGreaterThan(0);
      expect(opfs.opfs.bytes).toBeGreaterThan(0);
      evidence.ramAttributionSmoke.restored = { state: restored.recording.state,
        chunks: restored.chunks.length, opfs: opfs.opfs };
      evidence.dbAfter = databaseSnapshot();
      evidence.writeEvents = recordedWrites();
      evidence.storageAfter = { audio: await storageObjects('meeting-audio'), exports: await storageObjects('meeting-exports') };
      expect(evidence.writeEvents.filter((event) => event.relation_name !== 'public.observability_metric_buckets')).toEqual([]);
      for (const [relation, before] of Object.entries(evidence.dbBefore.tables)) {
        if (relation !== 'public.observability_metric_buckets') expect(evidence.dbAfter.tables[relation], relation).toEqual(before);
      }
      expect(evidence.storageAfter).toEqual(evidence.storageBefore);
      expect(auditRequests.filter(({ path }) => /\/api\/(?:sessions|meetings\/[^/]+\/(?:recording|segments|complete))(?:\/|$)/u.test(path)
        || /\/rest\/v1\/(?:sessions|meeting_recordings|meeting_segments|subtitle_cues|meeting_events)/u.test(path)
        || path.startsWith('/storage/v1/object/'))).toEqual([]);
      evidence.result = 'RAM_ATTRIBUTION_SMOKE_PASS';
      save();
      return;
    }
    if (ramProfileC) {
      const targets = (await system.send('Target.getTargets')).targetInfos;
      const journalTargets = targets.filter((entry) => entry.type === 'worker'
        && entry.url.includes('durablePcmJournal.worker'));
      evidence.ram3cProfile = { diagnosticOnly: true, forcedGc: false, durationMs: 120_000,
        targetId: (await cdp.send('Target.getTargetInfo')).targetInfo.targetId,
        workerTargets: journalTargets.map(({ targetId, type, url }) => ({ targetId, type, url })),
        snapshots: [], samples: [] };
      save();
      expect(journalTargets, 'one Journal Worker target').toHaveLength(1);
      const { sessionId } = await system.send('Target.attachToTarget',
        { targetId: journalTargets[0].targetId, flatten: false });
      let nextCommandId = 0;
      const pending = new Map();
      const workerListeners = new Map();
      system.on('Target.receivedMessageFromTarget', ({ sessionId: receivedSessionId, message }) => {
        if (receivedSessionId !== sessionId) return;
        const event = JSON.parse(message);
        if (event.id) {
          const request = pending.get(event.id);
          if (!request) return;
          pending.delete(event.id);
          clearTimeout(request.timer);
          if (event.error) request.reject(new Error(`${request.method}: ${event.error.message}`));
          else request.resolve(event.result);
        } else if (event.method) {
          for (const listener of workerListeners.get(event.method) || []) listener(event.params);
        }
      });
      const workerCdp = {
        send(method, params = {}) {
          const id = ++nextCommandId;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error(`WORKER_CDP_TIMEOUT:${method}`));
            }, 120_000);
            pending.set(id, { method, resolve, reject, timer });
            system.send('Target.sendMessageToTarget',
              { sessionId, message: JSON.stringify({ id, method, params }) })
              .catch((error) => { clearTimeout(timer); pending.delete(id); reject(error); });
          });
        },
        on(method, listener) {
          const listeners = workerListeners.get(method) || new Set();
          listeners.add(listener);
          workerListeners.set(method, listeners);
        },
        off(method, listener) { workerListeners.get(method)?.delete(listener); }
      };
      await Promise.all([cdp.send('HeapProfiler.enable'), workerCdp.send('HeapProfiler.enable')]);
      const heapUsage = async () => {
        const [main, worker] = await Promise.all([
          cdp.send('Runtime.getHeapUsage'), workerCdp.send('Runtime.getHeapUsage')
        ]);
        return { main, worker };
      };
      const snapshot = async (label, session) => {
        const file = join(dirname(evidenceFile), `ram3c-${label}.heapsnapshot`);
        const stream = createWriteStream(file);
        const onChunk = ({ chunk }) => stream.write(chunk);
        session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
        try { await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); }
        finally {
          session.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
          stream.end();
          await once(stream, 'finish');
        }
        evidence.ram3cProfile.snapshots.push({ label, file, bytes: stream.bytesWritten,
          at: new Date().toISOString() });
        save();
      };
      evidence.ram3cProfile.before = { at: new Date().toISOString(),
        memory: await memory(), heapUsage: await heapUsage(),
        callbacks: await page.evaluate(() => window.__issue41PcmCount) };
      save();
      await snapshot('main-start', cdp);
      await snapshot('worker-start', workerCdp);
      await Promise.all([cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 }),
        workerCdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 })]);
      const samplingStartedAt = Date.now();
      let priorCallbacks = await page.evaluate(() => window.__issue41PcmCount);
      while (Date.now() - samplingStartedAt < 120_000) {
        await page.waitForTimeout(Math.min(10_000, samplingStartedAt + 120_000 - Date.now()));
        const callbacks = await page.evaluate(() => window.__issue41PcmCount);
        expect(callbacks, 'PCM must continue during profile').toBeGreaterThan(priorCallbacks);
        priorCallbacks = callbacks;
        const row = { at: new Date().toISOString(), elapsedMs: Date.now() - samplingStartedAt,
          callbacks, memory: await memory(), heapUsage: await heapUsage() };
        evidence.ram3cProfile.samples.push(row);
        expect(recordedWrites().filter((event) => event.relation_name !== 'public.observability_metric_buckets')).toEqual([]);
        save();
      }
      const [mainAllocations, workerAllocations] = await Promise.all([
        cdp.send('HeapProfiler.stopSampling'), workerCdp.send('HeapProfiler.stopSampling')
      ]);
      const mainAllocationFile = join(dirname(evidenceFile), 'ram3c-main-allocations.json');
      const workerAllocationFile = join(dirname(evidenceFile), 'ram3c-worker-allocations.json');
      writeFileSync(mainAllocationFile, JSON.stringify(mainAllocations));
      writeFileSync(workerAllocationFile, JSON.stringify(workerAllocations));
      evidence.ram3cProfile.allocations = { main: mainAllocationFile, worker: workerAllocationFile };
      evidence.ram3cProfile.afterSampling = { at: new Date().toISOString(),
        memory: await memory(), heapUsage: await heapUsage(), callbacks: priorCallbacks };
      save();
      await snapshot('main-end', cdp);
      await snapshot('worker-end', workerCdp);
      await page.getByRole('button', { name: '結束會議' }).click();
      await expect.poll(async () => (await localState(meetingId)).recording?.state,
        { timeout: 60_000 }).toBe('stopped_local');
      await page.reload();
      const restored = await localState(meetingId);
      expect(restored.recording?.state).toBe('stopped_local');
      expect(restored.chunks.length).toBeGreaterThan(0);
      evidence.ram3cProfile.restored = { state: restored.recording.state,
        chunks: restored.chunks.length, checkpoints: restored.checkpoints.length };
      evidence.dbAfter = databaseSnapshot();
      evidence.writeEvents = recordedWrites();
      evidence.storageAfter = { audio: await storageObjects('meeting-audio'),
        exports: await storageObjects('meeting-exports') };
      expect(evidence.writeEvents.filter((event) => event.relation_name !== 'public.observability_metric_buckets')).toEqual([]);
      for (const [relation, before] of Object.entries(evidence.dbBefore.tables))
        if (relation !== 'public.observability_metric_buckets') expect(evidence.dbAfter.tables[relation], relation).toEqual(before);
      expect(evidence.storageAfter).toEqual(evidence.storageBefore);
      evidence.result = 'RAM_3C_PROFILE_CAPTURED';
      save();
      return;
    }
    if (ramAbcSmoke || ramAbcMode) {
      const lightObserver = () => page.evaluate(() => ({
        callbacks: window.__issue41PcmCount,
        lastCallbackAgeMs: Date.now() - window.__issue41LastPcmAt,
        journalQueue: window.__issue41JournalWorkerPending?.size ?? 'NOT_MEASURED',
        providerSessions: window.__mockGoogleGenAI?.liveSessions?.length ?? 0,
        liveTracks: window.__issue41Tracks.filter((track) => track.readyState === 'live').length
      }));
      const setMode = (mode) => page.evaluate(async (nextMode) => {
        const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
        window.__issue41DiagnosticMode = nextMode;
        livePipelineTrace.setEnabled(nextMode === 'A');
        return { mode: window.__issue41DiagnosticMode, traceEnabled: livePipelineTrace.isEnabled(),
          observer: nextMode === 'C' ? 'BOUNDED_COUNTERS' : 'FULL_OPFS_IDB' };
      }, mode);
      const captureSample = async (mode, index) => {
        const at = Date.now();
        const [ram, observed, local] = await Promise.all([
          memory(), mode === 'C' ? lightObserver() : browserSample(),
          mode === 'C' ? Promise.resolve(null) : localState(meetingId)
        ]);
        const row = { phase: 'capture', mode, sampleIndex: index, at: new Date(at).toISOString(),
          elapsedMs: at - captureStart, ...ram, ...observed,
          cueCount: local?.cues.length ?? 'END_ONLY',
          opfsChunkCount: local?.chunks.length ?? 'END_ONLY',
          checkpointCount: local?.checkpoints.length ?? 'END_ONLY' };
        expect(row.liveTracks, 'live PCM track').toBeGreaterThan(0);
        expect(row.lastCallbackAgeMs, 'PCM callback age').toBeLessThan(3000);
        expect(row.chromiumRssBytes).toBeGreaterThan(0);
        expect(row.jsHeapBytes).toBeGreaterThan(0);
        if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
        return row;
      };
      const forbiddenHttp = () => auditRequests.filter(({ path }) =>
        /\/api\/(?:sessions|meetings\/[^/]+\/(?:recording|segments|complete))(?:\/|$)/u.test(path)
        || /\/rest\/v1\/(?:sessions|meeting_recordings|meeting_segments|subtitle_cues|meeting_events)/u.test(path)
        || path.startsWith('/storage/v1/object/'));
      evidence.ramAbc = { mode: ramAbcMode || 'SMOKE', samples: [], configurations: [],
        intervalMs: 30_000, durationMs: ramAbcSmoke ? null : 600_000,
        heapSnapshots: false, forcedGc: false, playwrightTrace: false, cueSchedule: 'at start and minute 5' };
      const modes = ramAbcSmoke ? ['A', 'B', 'C'] : [ramAbcMode];
      let lastCallbacks = 0;
      const emitCue = async (index) => {
        const text = `issue41 abc cue ${index}`;
        await expect.poll(() => page.evaluate(() => {
          const provider = window.__mockGoogleGenAI?.liveSessions?.at(-1);
          return provider?.audioInputCount || provider?.sentInputs.filter((input) => Boolean(input?.audio)).length || 0;
        }), { timeout: 30_000 }).toBeGreaterThan(0);
        await page.evaluate((sourceText) => window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
          serverContent: { inputTranscription: { text: sourceText },
            outputTranscription: { text: `translated ${sourceText}` }, turnComplete: true }
        }), text);
        await expect.poll(async () => (await localState(meetingId)).cues
          .find((cue) => cue.sourceText === text)?.segmentId, { timeout: 30_000 }).toBe(initialSegmentId);
      };
      if (!ramAbcSmoke) await emitCue(0);
      const sampleCount = ramAbcSmoke ? 3 : 21;
      for (let index = 0; index < sampleCount; index += 1) {
        if (!ramAbcSmoke) {
          const dueAt = captureStart + index * 30_000;
          if (dueAt > Date.now()) await page.waitForTimeout(dueAt - Date.now());
          if (index === 10) await emitCue(1);
        }
        const mode = ramAbcSmoke ? modes[index] : ramAbcMode;
        const configuration = ramAbcSmoke || index === 0 ? await setMode(mode)
          : await page.evaluate(async (expectedMode) => {
            const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
            return { mode: window.__issue41DiagnosticMode,
              traceEnabled: livePipelineTrace.isEnabled(),
              observer: expectedMode === 'C' ? 'BOUNDED_COUNTERS' : 'FULL_OPFS_IDB' };
          }, mode);
        expect(configuration.mode).toBe(mode);
        expect(configuration.traceEnabled).toBe(mode === 'A');
        evidence.ramAbc.configurations.push({ at: new Date().toISOString(), ...configuration });
        const row = await captureSample(mode, index);
        expect(row.callbacks, 'continuous PCM callbacks').toBeGreaterThan(lastCallbacks);
        lastCallbacks = row.callbacks;
        evidence.ramAbc.samples.push(row);
        expect(recordedWrites().filter((event) => event.relation_name !== 'public.observability_metric_buckets')).toEqual([]);
        expect(forbiddenHttp()).toEqual([]);
        save();
        if (ramAbcSmoke && index < 2) await expect.poll(() => page.evaluate(() => window.__issue41PcmCount),
          { timeout: 15_000 }).toBeGreaterThan(lastCallbacks + 10);
      }
      if (!ramAbcSmoke) expect(Date.now() - captureStart).toBeGreaterThanOrEqual(600_000);
      await page.getByRole('button', { name: '結束會議' }).click();
      await expect.poll(async () => (await localState(meetingId)).recording?.state,
        { timeout: 60_000 }).toBe('stopped_local');
      await expect.poll(() => page.evaluate(() => window.location.hash),
        { timeout: 30_000 }).toBe(`#meeting-detail?meetingId=${encodeURIComponent(meetingId)}&from=history`);
      const afterEnd = await localState(meetingId);
      const barrierAt = Date.now();
      for (const secondsAfterBarrier of ramAbcSmoke ? [0] : [0, 30, 60]) {
        if (secondsAfterBarrier) await page.waitForTimeout(Math.max(0, barrierAt + secondsAfterBarrier * 1000 - Date.now()));
        const row = { phase: 'post_end', mode: ramAbcMode || 'SMOKE', secondsAfterBarrier,
          at: new Date().toISOString(), ...await memory() };
        (evidence.ramAbc.postEnd ||= []).push(row);
        if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
        save();
      }
      await page.reload();
      const restored = await localState(meetingId);
      const finalOpfs = await browserSample();
      const pcmBytes = await page.evaluate(async (id) => {
        const root = await navigator.storage.getDirectory();
        const meeting = await (await (await root.getDirectoryHandle('pcm-journals'))
          .getDirectoryHandle('v1')).getDirectoryHandle(id);
        let bytesRead = 0;
        for await (const [, recording] of meeting.entries()) {
          for await (const [name, handle] of recording.entries()) {
            if (handle.kind === 'file' && name.startsWith('pcm-'))
              bytesRead += (await (await handle.getFile()).arrayBuffer()).byteLength;
          }
        }
        return bytesRead;
      }, meetingId);
      expect(restored.recording?.state).toBe('stopped_local');
      expect(restored.recording?.segmentId).toBe(initialSegmentId);
      expect(restored.chunks).toEqual(afterEnd.chunks);
      expect(restored.chunks.length).toBeGreaterThan(0);
      expect(restored.checkpoints).toEqual(afterEnd.checkpoints);
      if (!ramAbcSmoke) expect(restored.checkpoints.length).toBeGreaterThan(0);
      expect(pcmBytes).toBeGreaterThan(0);
      if (!ramAbcSmoke) {
        for (const index of [0, 1]) expect(restored.cues.find((cue) => cue.sourceText === `issue41 abc cue ${index}`)?.segmentId)
          .toBe(initialSegmentId);
      }
      evidence.ramAbc.durability = { state: restored.recording.state, chunks: restored.chunks.length,
        checkpoints: restored.checkpoints.length, cues: restored.cues.length, pcmBytes,
        opfs: finalOpfs.opfs, callbacks: lastCallbacks };
      evidence.dbAfter = databaseSnapshot();
      evidence.writeEvents = recordedWrites();
      evidence.storageAfter = { audio: await storageObjects('meeting-audio'), exports: await storageObjects('meeting-exports') };
      expect(evidence.writeEvents.filter((event) => event.relation_name !== 'public.observability_metric_buckets')).toEqual([]);
      for (const [relation, before] of Object.entries(evidence.dbBefore.tables))
        if (relation !== 'public.observability_metric_buckets') expect(evidence.dbAfter.tables[relation], relation).toEqual(before);
      expect(evidence.storageAfter).toEqual(evidence.storageBefore);
      expect(forbiddenHttp()).toEqual([]);
      evidence.result = ramAbcSmoke ? 'RAM_ABC_SMOKE_PASS' : `RAM_ABC_${ramAbcMode}_PASS`;
      save();
      return;
    }
    const localRolloverOperation = (oldSegmentId, newSegmentId, segmentNumber) => page.evaluate(async (input) => {
      const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
      const suffix = `:${input.segmentNumber}`;
      if (!input.newSegmentId.startsWith('segment:') || !input.newSegmentId.endsWith(suffix)) return null;
      const sessionId = input.newSegmentId.slice('segment:'.length, -suffix.length);
      if (!sessionId) return null;
      const operationId = `rollover:${sessionId}:${input.oldSegmentId}`;
      return createIndexedDbLocalMeetingManifestStore().getOperation(input.meetingId, operationId);
    }, { meetingId, oldSegmentId, newSegmentId, segmentNumber });
    let previousSegmentId = initialSegmentId;
    let previousSegmentNumber = firstRecording.segmentNumber;
    let previousCallbacks = 0;
    let nextSampleAt = captureStart;
    const cueSegments = [];
    const fullScanIntervalMs = 5 * 60_000;
    let nextFullScanAt = captureStart + fullScanIntervalMs;
    evidence.ramConfiguration = { ...evidence.ramConfiguration, observer: 'bounded-30s-plus-full-5min-v1',
      fullScanIntervalMs, fullScanScope: 'OPFS-and-IndexedDB', fullScanPhase: 'after-memory-sample',
      olsWindowMinutes: 30 };
    evidence.fullScans = [];
      evidence.rolloverDiagnostics = [];
      evidence.providerTrace = [];
      evidence.ramConfiguration.rolloverDiagnostic = { intervalMs: 5_000, beforeMs: 120_000,
        afterMs: 300_000, source: 'read-only CDP and renderer RSS', gateSeriesPhase: 'capture' };
      const unavailable = 'unavailable';
      const metric = (values, name) => values?.find((entry) => entry.name === name)?.value ?? unavailable;
      const rolloverTargets = recordingContract ? [15_000]
        : Array.from({ length: Math.floor(soakMinutes / 15) }, (_, index) => (index + 1) * 15 * 60_000);
      let diagnosticBusy = false;
      let gateSampleBusy = false;
      let traceWindow = null;
      const collectProviderTrace = async () => {
        if (traceWindow === null) return;
        const events = await page.evaluate(async () => {
          const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
          const rows = livePipelineTrace.get().filter(({ stage }) => [
            'PROVIDER_SESSION_CREATING', 'PROVIDER_SESSION_READY',
            'SESSION_ROLLOVER_START', 'ROLLOVER_COMMITTED', 'ROLLOVER_FAILED'
          ].includes(stage));
          livePipelineTrace.setEnabled(false);
          return rows;
        });
        evidence.providerTrace.push({ targetElapsedMs: traceWindow, events });
        traceWindow = null;
      };
      const diagnosticTick = async () => {
        if (diagnosticBusy || gateSampleBusy) return;
        const elapsedMs = Date.now() - captureStart;
        const targetElapsedMs = rolloverTargets.find((target) => elapsedMs >= Math.max(0, target - 120_000)
          && elapsedMs <= target + 300_000);
        if (targetElapsedMs === undefined) {
          await collectProviderTrace();
          return;
        }
        diagnosticBusy = true;
        try {
          if (traceWindow !== targetElapsedMs) {
            await collectProviderTrace();
            await page.evaluate(async () => {
              const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
              livePipelineTrace.setEnabled(true);
            });
            traceWindow = targetElapsedMs;
          }
          const started = Date.now();
          const [performance, heap, dom, processes] = await Promise.all([
            cdp.send('Performance.getMetrics').catch(() => null),
            cdp.send('Runtime.getHeapUsage').catch(() => null),
            cdp.send('Memory.getDOMCounters').catch(() => null),
            system.send('SystemInfo.getProcessInfo').catch(() => null)
          ]);
          const rendererPids = processes?.processInfo?.filter((entry) => entry.type === 'renderer')
            .map((entry) => entry.id) ?? [];
          const rendererPid = rendererPids.length === 1 ? rendererPids[0] : unavailable;
          let chromiumRssBytes = unavailable;
          if (rendererPid !== unavailable) {
            try {
              const rss = Number(execFileSync('ps', ['-p', String(rendererPid), '-o', 'rss='],
                { encoding: 'utf8' }).trim()) * 1024;
              if (Number.isFinite(rss) && rss > 0) chromiumRssBytes = rss;
            } catch { /* A missing renderer is reported as unavailable. */ }
          }
          const row = { phase: 'rollover_diagnostic', at: new Date(started).toISOString(),
            elapsedMs: started - captureStart, targetElapsedMs, rendererPid,
            rendererPidStable: firstRendererPid === null ? unavailable : rendererPid === firstRendererPid,
            chromiumRssBytes, jsHeapUsedBytes: metric(performance?.metrics, 'JSHeapUsedSize'),
            jsHeapAllocatedBytes: metric(performance?.metrics, 'JSHeapTotalSize'),
            heapUsedBytes: heap?.usedSize ?? unavailable, heapAllocatedBytes: heap?.totalSize ?? unavailable,
            backingStorageBytes: heap?.backingStorageSize ?? unavailable,
            embedderHeapBytes: heap?.embedderHeapUsedSize ?? unavailable,
            documents: dom?.documents ?? unavailable, nodes: dom?.nodes ?? unavailable,
            jsEventListeners: dom?.jsEventListeners ?? unavailable,
            sampleDurationMs: Date.now() - started };
          evidence.rolloverDiagnostics.push(row);
          if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
        } finally { diagnosticBusy = false; }
      };
      let diagnosticInFlight = Promise.resolve();
      const diagnosticTimer = setInterval(() => { diagnosticInFlight = diagnosticTick().catch((error) => {
        evidence.rolloverDiagnosticError = error.message;
      }); }, 5_000);
    const fullScan = async (phase) => {
      const started = Date.now();
      const [storage, local] = await Promise.all([browserSample(), localState(meetingId)]);
      const scan = { phase, at: new Date(started).toISOString(), elapsedMs: started - captureStart,
        durationMs: Date.now() - started, opfs: storage.opfs, stores: storage.stores,
        cueCount: local.cues.length, transcriptCount: local.transcripts.length,
        checkpointCount: local.checkpoints.length, audioChunks: local.chunks.length };
      evidence.fullScans.push(scan);
      if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify({ phase: 'storage_scan', ...scan })}\n`);
      save();
      return { storage, local };
    };
    const recordCue = async (segmentId) => {
      await expect(page.getByRole('button', { name: '停止錄音' })).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => {
        const provider = window.__mockGoogleGenAI?.liveSessions?.at(-1);
        return provider?.audioInputCount || provider?.sentInputs.filter((input) => Boolean(input?.audio)).length || 0;
      }), { timeout: 30_000 }).toBeGreaterThan(0);
      const sourceText = `issue41 real-time cue ${cueSegments.length + 1}`;
      await page.evaluate((text) => window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
        serverContent: { inputTranscription: { text }, outputTranscription: { text: `translated ${text}` }, turnComplete: true }
      }), sourceText);
      await expect.poll(async () => (await localState(meetingId)).cues
        .find((cue) => cue.sourceText === sourceText)?.segmentId,
      { timeout: 30_000 }).toBe(segmentId);
      cueSegments.push({ sourceText, segmentId });
      save();
    };
    await recordCue(initialSegmentId);
      const requiredCaptureMs = authExpirySmoke ? 150_000 : recordingContract ? 45_000 : soakMinutes * 60_000;
      if (authExpirySmoke) {
        expect(auth.refreshToken, 'short expiry smoke requires a real refresh token').toBeTruthy();
        expect(auth.expiresAt * 1000 - captureStart).toBeGreaterThan(30_000);
        expect(auth.expiresAt * 1000 - captureStart).toBeLessThan(90_000);
        evidence.authExpiry = {
          initialExpiresAt: new Date(auth.expiresAt * 1000).toISOString(),
          pcmBytesBefore: await journalPcmBytes(),
          refreshObservedAt: null
        };
        save();
      }
      try { while (Date.now() - captureStart < requiredCaptureMs) {
      const at = Date.now();
        gateSampleBusy = true;
        let ram, browserState, recording;
        try { [ram, browserState, recording] = await Promise.all([memory(), lightBrowserSample(), recordingSample()]); }
        finally { gateSampleBusy = false; }
      const row = { phase: 'capture', at: new Date(at).toISOString(), elapsedMs: at - captureStart,
        ...ram, ...browserState, segmentId: recording?.segmentId ?? null,
        segmentNumber: recording?.segmentNumber ?? null, providerEpoch: recording?.providerEpoch ?? null };
      if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
      if (ramGateMode && !evidence.resourceAttribution?.length) await sampleResourceAttribution('baseline');
      expect(row.liveTracks, 'PCM source remains live').toBeGreaterThan(0);
      expect(row.lastCallbackAgeMs, 'PCM input remains live').toBeLessThan(5_000);
      if (authExpirySmoke && at >= auth.expiresAt * 1000 + 5_000 && !evidence.authExpiry.refreshObservedAt) {
        const current = await page.evaluate(async () => {
          const { supabase } = await import('/src/lib/supabaseAuth.js');
          const { data } = await supabase.auth.getSession();
          return { token: data.session?.access_token || null,
            expiresAt: data.session?.expires_at || null, userId: data.session?.user?.id || null };
        });
        expect(current.userId, 'Host remains authenticated after original token expiry').toBe(auth.profile.id);
        expect(current.token, 'Supabase issued a new access token').not.toBe(auth.token);
        expect(current.expiresAt * 1000, 'refreshed token remains valid').toBeGreaterThan(at);
        await expect(page.getByRole('heading', { name: '歡迎回來' })).toHaveCount(0);
        const pcmBytesAfter = await journalPcmBytes();
        expect(pcmBytesAfter, 'PCM Journal grows across auth refresh').toBeGreaterThan(evidence.authExpiry.pcmBytesBefore);
        evidence.authExpiry = { ...evidence.authExpiry,
          refreshObservedAt: new Date(at).toISOString(),
          refreshedExpiresAt: new Date(current.expiresAt * 1000).toISOString(), pcmBytesAfter };
        save();
      }
      if (previousCallbacks) expect(row.callbacks, 'PCM callbacks advance').toBeGreaterThan(previousCallbacks);
      previousCallbacks = row.callbacks;
      if (typeof row.chromiumRssBytes === 'number')
        expect(row.chromiumRssBytes, 'RSS safety stop').toBeLessThanOrEqual(PROVISIONAL_RAM_THRESHOLDS.rssPeakMiB * 1048576);
      if (typeof row.jsHeapBytes === 'number')
        expect(row.jsHeapBytes, 'heap safety stop').toBeLessThanOrEqual(PROVISIONAL_RAM_THRESHOLDS.jsHeapPeakMiB * 1048576);
      if (row.segmentId !== previousSegmentId) {
        const operation = await localRolloverOperation(previousSegmentId, row.segmentId, row.segmentNumber);
        assertCommittedLocalRolloverOperation(operation, recording, {
          meetingId, recordingId: firstRecording.recordingId,
          oldSegmentId: previousSegmentId, oldSegmentNumber: previousSegmentNumber,
          newSegmentId: row.segmentId, newSegmentNumber: row.segmentNumber
        });
        expect(row.segmentNumber).toBe(previousSegmentNumber + 1);
        evidence.rolloverObservations.push({ oldSegmentId: previousSegmentId, newSegmentId: row.segmentId,
          sequence: row.segmentNumber, elapsedMs: row.elapsedMs,
          evidenceSource: 'indexeddb-local-rollover-operation', operationId: operation.operationId });
        previousSegmentId = row.segmentId;
        previousSegmentNumber = row.segmentNumber;
        save();
        await recordCue(row.segmentId);
        }
      if (row.elapsedMs >= (recordingContract ? 30_000 : 16 * 60_000))
        expect(evidence.rolloverObservations.length).toBeGreaterThanOrEqual(1);
      if (!recordingContract && soakMinutes >= 31 && row.elapsedMs >= 31 * 60_000)
        expect(evidence.rolloverObservations.length).toBeGreaterThanOrEqual(2);
      if (Math.floor(row.elapsedMs / 60_000) !== Math.floor((row.elapsedMs - 30_000) / 60_000)) {
        expect(recordedWrites().filter((event) => event.relation_name !== 'public.observability_metric_buckets'),
          'transient recording writes').toEqual([]);
      }
      expect(auditRequests.filter(({ path }) => /\/api\/(?:sessions|meetings\/[^/]+\/(?:recording|segments|complete))(?:\/|$)/u.test(path)
        || /\/rest\/v1\/(?:sessions|meeting_recordings|meeting_segments|subtitle_cues|meeting_events)/u.test(path)
        || path.startsWith('/storage/v1/object/')), 'recording HTTP writes').toEqual([]);
      if (Date.now() >= nextFullScanAt) {
        await fullScan('capture');
        nextFullScanAt += fullScanIntervalMs;
      }
      nextSampleAt += 30_000;
        await page.waitForTimeout(Math.max(0, nextSampleAt - Date.now()));
    } } catch (error) {
      evidence.captureFailure = { at: new Date().toISOString(), name: error.name };
      try { evidence.writeEventsAtFailure = recordedWrites(); }
      catch { evidence.auditReadErrorAtFailure = true; }
      try { evidence.cloudAtFailure = await cloudInventory(meetingId); }
      catch { evidence.cloudReadErrorAtFailure = true; }
      save();
      throw error;
    } finally {
        clearInterval(diagnosticTimer);
        await diagnosticInFlight;
        await collectProviderTrace();
      }
    const captureEndAt = Date.now();
const [endMemory, endBrowser, endRecording] = await Promise.all([memory(), lightBrowserSample(), recordingSample()]);
    if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify({ phase: 'capture',
      at: new Date(captureEndAt).toISOString(), elapsedMs: captureEndAt - captureStart,
      ...endMemory, ...endBrowser, segmentId: endRecording?.segmentId ?? null,
      segmentNumber: endRecording?.segmentNumber ?? null, providerEpoch: endRecording?.providerEpoch ?? null })}\n`);
    evidence.captureElapsedMs = Date.now() - captureStart;
    if (authExpirySmoke) expect(evidence.authExpiry.refreshObservedAt, 'auth refresh observed during capture').toBeTruthy();
      expect(evidence.rolloverObservations).toHaveLength(recordingContract ? 1 : Math.floor(soakMinutes / 15));
    expect(evidence.rolloverObservations[0].elapsedMs).toBeGreaterThanOrEqual(recordingContract ? 10_000 : 14 * 60_000);
    expect(evidence.rolloverObservations[0].elapsedMs).toBeLessThan(recordingContract ? 40_000 : 16 * 60_000);
    if (recordingContract) expect(await page.evaluate(() => window.__issue41ControlledRolloverTimer)).toBe(true);
    if (!recordingContract && soakMinutes >= 31) {
      expect(evidence.rolloverObservations[1].elapsedMs).toBeGreaterThanOrEqual(29 * 60_000);
      expect(evidence.rolloverObservations[1].elapsedMs).toBeLessThan(31 * 60_000);
    }
    evidence.preStopSegments = [initialSegmentId, ...evidence.rolloverObservations.map((entry) => entry.newSegmentId)]
      .map((id, index) => ({ id, sequence: index + 1 }));
    await page.getByRole('button', { name: '結束會議' }).click();
    await expect.poll(async () => (await localState(meetingId)).recording?.state,
      { timeout: 60_000 }).toBe('stopped_local');
    await expect.poll(() => page.evaluate(() => window.location.hash),
      { timeout: 30_000 }).toBe(`#meeting-detail?meetingId=${encodeURIComponent(meetingId)}&from=history`);
    evidence.barrierCompletedAt = new Date().toISOString();
    if (recordingContract) {
      const operationId = `stop:${firstRecording.recordingId}:${previousSegmentId}`;
      let receipt = null;
      await expect.poll(async () => {
        receipt = await page.evaluate(async ({ id, operationId: key }) => {
          const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
          return createIndexedDbLocalMeetingManifestStore().getOperation(id, key);
        }, { id: meetingId, operationId });
        return receipt !== null;
      }, { message: 'End receipt must be durable', timeout: 30_000 }).toBe(true);
      expect(receipt).toMatchObject({ operationId, type: 'finalize',
        result: { state: 'stopped_local', recordingId: firstRecording.recordingId,
          segmentId: previousSegmentId } });
      evidence.endReceipt = { operationId, state: receipt.result.state,
        segmentId: receipt.result.segmentId, finalSequence: receipt.result.finalSequence };
      save();
    }
    const barrierAt = Date.now();
    evidence.fixtureAudioCleanup = await releaseFixtureAudioAfterEnd();
    for (const secondsAfterBarrier of [0, 30, 60]) {
      if (secondsAfterBarrier) await page.waitForTimeout(Math.max(0, barrierAt + secondsAfterBarrier * 1000 - Date.now()));
      const row = { phase: 'post_stop', at: new Date().toISOString(), secondsAfterBarrier, ...await memory() };
      if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
    if (ramGateMode) await sampleResourceAttribution('post_stop', secondsAfterBarrier);
    }
    const beforeReload = await localState(meetingId);
    evidence.pcm = await page.evaluate(() => ({ callbacks: window.__issue41PcmCount,
      frames: window.__issue41Frames, bytes: window.__issue41Frames * 2,
      startedAt: window.__issue41PcmStartedAt, lateBatches: window.__issue41LateBatches,
      skippedBatches: window.__issue41SkippedBatches }));
    expect(evidence.pcm.callbacks).toBeGreaterThan(0);
    expect(evidence.pcm.frames).toBeGreaterThan(0);
    evidence.localAfterEnd = { recording: beforeReload.recording, chunks: beforeReload.chunks,
      cues: beforeReload.cues, checkpoints: beforeReload.checkpoints };
    await page.reload();
    const restored = await localState(meetingId);
    const { storage: opfs } = await fullScan('after_reload');
    evidence.journalClaims = await readJournalClaims();
    expect(evidence.journalClaims).toHaveLength(1);
    expect(evidence.journalClaims[0].recordingId).toBe(restored.recording.recordingId);
    expect(evidence.journalClaims[0].claims).toBeGreaterThan(0);
    expect(evidence.journalClaims[0].ledgerHashesValid).toBe(true);
    expect(evidence.journalClaims[0].pcmHashesValid).toBe(true);
    expect(evidence.journalClaims[0].epochs.every((epoch) => epoch.ended
      && epoch.gaps === 0 && epoch.overlaps === 0)).toBe(true);
    expect(evidence.journalClaims[0].pcmBytes).toBe(evidence.pcm.bytes);
    expect(restored.recording?.state).toBe('stopped_local');
    expect(restored.recording?.segmentId).toBe(previousSegmentId);
    expect(restored.chunks).toEqual(beforeReload.chunks);
    expect(restored.chunks.length).toBeGreaterThan(0);
    expect(restored.checkpoints.length).toBeGreaterThanOrEqual(recordingContract || naturalRollover21 ? 2 : 3);
    expect(opfs.opfs.bytes).toBeGreaterThan(0);
    for (const cue of cueSegments) expect(restored.cues.find((entry) => entry.sourceText === cue.sourceText)?.segmentId).toBe(cue.segmentId);
    expect(restored.cues).toEqual(beforeReload.cues);
    expect(restored.checkpoints).toEqual(beforeReload.checkpoints);
      expect(new Set(evidence.rolloverObservations.map((entry) => entry.newSegmentId)).size).toBe(recordingContract ? 1 : Math.floor(soakMinutes / 15));
    expect(evidence.rolloverObservations[0].oldSegmentId).toBe(initialSegmentId);
    if (!recordingContract && soakMinutes >= 31)
      expect(evidence.rolloverObservations[1].oldSegmentId).toBe(evidence.rolloverObservations[0].newSegmentId);
    try {
      const ownership = await page.evaluate(async (id) => {
        const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
        const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
        const store = createIndexedDbLocalMeetingManifestStore();
        const segments = await store.listSegments(id);
        const verifier = await createLocalMeetingPersistence({ manifestStore: store })
          .verifySegmentPcmOwnership(id);
        return { segments, verifier: { status: verifier.status, reason: verifier.reason || null } };
      }, meetingId);
      const epochs = evidence.journalClaims[0].epochs;
      evidence.segmentOwnership = { verifier: ownership.verifier,
        segments: ownership.segments.map(({ segmentId, status, firstJournalEpoch, lastJournalEpoch }) =>
          ({ segmentId, status, firstJournalEpoch, lastJournalEpoch })),
        journalEpochs: epochs.map(({ captureEpoch, claims }) => ({ captureEpoch, claims })) };
      evidence.segmentOwnershipVerified = ownership.verifier.status === 'PASS'
        && ownership.segments.length === evidence.preStopSegments.length
        && ownership.segments.every((segment, index) => {
          const next = ownership.segments[index + 1];
          return epochs.some((epoch) => epoch.claims > 0
            && epoch.captureEpoch >= segment.firstJournalEpoch
            && epoch.captureEpoch <= (next ? next.firstJournalEpoch - 1 : epochs.at(-1).captureEpoch));
        });
      evidence.oldSegmentsEndedVerified = ownership.segments.length > 1
        && ownership.segments.slice(0, -1).every((segment) => segment.status === 'ENDED');
    } catch (error) { evidence.segmentOwnershipError = error.message; }
    const providerWindows = evidence.providerTrace.map(({ targetElapsedMs, events }) => {
      const creating = events.filter((event) => event.stage === 'PROVIDER_SESSION_CREATING');
      const ready = events.filter((event) => event.stage === 'PROVIDER_SESSION_READY');
      return { targetElapsedMs, creating: creating.length, ready: ready.length,
        ordered: creating.some((start) => ready.some((end) => end.traceSequence > start.traceSequence)) };
    });
    evidence.providerTraceEvidence = providerWindows;
    evidence.evidenceChecks = {
      pcmCallbacksFramesBytes: 'PASS', journalClaimCoverageAndHashes: 'PASS',
      pcmRecordingOwnership: 'PASS', segmentPcmOwnership: evidence.segmentOwnershipVerified ? 'PASS' : 'UNVERIFIED',
      segmentCueOwnership: 'PASS', endDurability: 'PASS', reloadReadback: 'PASS',
      rolloverDurableOperations: 'PASS', oldSegmentEnded: evidence.oldSegmentsEndedVerified ? 'PASS' : 'UNVERIFIED',
      providerStartTrace: providerWindows.length === evidence.rolloverObservations.length
        && providerWindows.every((window) => window.ordered) ? 'PASS' : 'UNVERIFIED'
    };
    evidence.restored = { recordingState: restored.recording.state, chunks: restored.chunks.length,
      checkpoints: restored.checkpoints.length, cues: cueSegments, opfs: opfs.opfs };
    evidence.dbAfter = databaseSnapshot();
    evidence.writeEvents = recordedWrites();
    evidence.storageAfter = { audio: await storageObjects('meeting-audio'), exports: await storageObjects('meeting-exports') };
    evidence.cloudAfter = await cloudInventory(meetingId);
  assertCloudZeroWrite();
      evidence.result = recordingContract ? 'ROLLOVER_CONTRACT_PASS' : `RECORDING_${soakMinutes}MIN_SOAK_PASS`;
    evidence.finishedAt = new Date().toISOString();
    save();
    return;
  }
  if (recordingOnly) {
    try {
    const startState = () => page.evaluate(async (id) => {
      const { hasLiveCredential } = await import('/src/lib/liveCredentialHolder.js');
      const { getMeetingAudioPreference, hasConfirmedMeetingAudioPreference } = await import('/src/lib/meetingAudioPreferences.js');
      return {
        credentialPresent: hasLiveCredential(), audioConfirmed: hasConfirmedMeetingAudioPreference(getMeetingAudioPreference(id)),
        buttons: [...document.querySelectorAll('button')].map((button) => button.textContent.trim()).filter((name) => /錄製|錄音|結束會議/u.test(name)),
        alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent.trim()),
        tracks: window.__issue41Tracks.length, processors: window.__issue41Processors.length,
        pcmCallbacks: window.__issue41PcmCount, providerSessions: window.__mockGoogleGenAI?.liveSessions?.length || 0
      };
    }, meetingId);
    try {
      await expect.poll(() => page.evaluate(() => window.__issue41PcmCount), { timeout: 30_000 }).toBeGreaterThan(0);
    } catch (error) {
      evidence.startFailure = await startState();
      save();
      throw error;
    }
    evidence.startState = await startState();
    evidence.captureStartedAt = new Date().toISOString();
    save();
    if (recordingSmoke) {
      const started = await localState(meetingId);
      expect(started.recording?.meetingId).toBe(meetingId);
      expect(started.recording?.recordingId).toBeTruthy();
      expect(started.recording?.segmentId).toBeTruthy();
      expect(started.recording?.segmentNumber).toBe(1);
      expect(started.recording?.state).toBe('capturing');
      evidence.initialRecordingId = started.recording.recordingId;
      initialSegmentId = started.recording.segmentId;
    } else {
      await expect.poll(async () => (await segments(meetingId)).length)
        .toBeGreaterThan(0);
      const startedSegments = await segments(meetingId);
      expect(startedSegments).toHaveLength(1);
      initialSegmentId = startedSegments[0].id;
      evidence.initialRecordingId = (await localState(meetingId)).recording?.recordingId;
      expect(evidence.initialRecordingId).toBeTruthy();
    }
  evidence.initialSegmentId = initialSegmentId;
  save();
  if (ram10Diagnostic) {
      await runRecordingRam10Diagnostic({ page, browser, meetingId, initialSegmentId, localState, evidence, save });
    return;
  }
  let samplePostStop = null;
  let sampleExport = null;
  let attachRamStage = null;
  if (recordingSoak || recordingContract) {
      const captureStart = await page.evaluate(() => window.__issue41PcmStartedAt);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const system = await browser.newBrowserCDPSession();
  if (ram2Diagnostic || recordingSoak) {
    evidence.ram2Stages = [];
    await page.exposeBinding('__issue41CaptureRamStage', async (_, event) => {
      const sampledAt = Date.now();
      const [metrics, processInfo] = await Promise.all([
        cdp.send('Performance.getMetrics').catch(() => null),
        system.send('SystemInfo.getProcessInfo').catch(() => null)
      ]);
      const rendererPid = processInfo?.processInfo?.find((entry) => entry.type === 'renderer')?.id ?? null;
      let chromiumRssBytes = 'NOT_COMPARABLE';
      if (rendererPid !== null) {
        try { chromiumRssBytes = Number(execFileSync('ps', ['-p', String(rendererPid), '-o', 'rss='], { encoding: 'utf8' }).trim()) * 1024; }
        catch { /* A renderer exit is recorded as incomparable. */ }
      }
      const row = { ...event, sampledAt: new Date(sampledAt).toISOString(), sampleLagMs: sampledAt - event.at,
        rendererPid, chromiumRssBytes,
        jsHeapBytes: metrics?.metrics?.find((item) => item.name === 'JSHeapUsedSize')?.value ?? 'NOT_MEASURED' };
      evidence.ram2Stages.push(row);
      if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify({ phase: 'ram2_stage', ...row })}\n`);
    });
    attachRamStage = () => page.evaluate(() => {
      window.__issue41RamStagePending = [];
      window.__issue41RamStage = (event) => {
        const pending = window.__issue41CaptureRamStage(event);
        window.__issue41RamStagePending.push(pending);
        void pending.catch(() => {});
      };
    });
    await attachRamStage();
  }
    let lastSegmentId = initialSegmentId;
      let nextSampleAt = captureStart;
      evidence.rolloverObservations = [];
      const sample = async () => {
        const at = Date.now();
        const [metrics, processInfo, local, authoritative, browserState] = await Promise.all([
          cdp.send('Performance.getMetrics'),
          system.send('SystemInfo.getProcessInfo').catch(() => null),
          localState(meetingId),
          segments(meetingId),
          page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            let files = 0;
            let bytes = 0;
            const walk = async (directory) => {
              for await (const handle of directory.values()) {
                if (handle.kind === 'directory') await walk(handle);
                else { files += 1; bytes += (await handle.getFile()).size; }
              }
            };
            await walk(root);
            return {
              opfs: { files, bytes }, callbacks: window.__issue41PcmCount,
              frames: window.__issue41Frames, lastCallbackAgeMs: Date.now() - window.__issue41LastPcmAt,
              maxGapMs: window.__issue41MaxPcmGapMs,
              lateBatches: window.__issue41LateBatches, skippedBatches: window.__issue41SkippedBatches,
              processorCounts: { ...window.__issue41ProcessorCounts },
          liveTracks: window.__issue41Tracks.filter((track) => track.readyState === 'live').length,
          pcmJournalPendingWrites: window.__issue41JournalWorkerPending?.size ?? 'NOT_MEASURED'
            };
          })
        ]);
        const renderer = processInfo?.processInfo?.find((entry) => entry.type === 'renderer');
        let chromiumRssBytes = 'NOT_MEASURED';
        if (renderer) {
          try { chromiumRssBytes = Number(execFileSync('ps', ['-p', String(renderer.id), '-o', 'rss='], { encoding: 'utf8' }).trim()) * 1024; }
          catch { /* The renderer may have exited between the CDP and ps calls. */ }
        }
const active = authoritative.find((segment) => segment.status === 'ACTIVE');
      const row = {
          at: new Date(at).toISOString(), elapsedMs: at - captureStart,
        phase: 'capture', rendererPid: renderer?.id ?? null,
        rendererAlive: typeof chromiumRssBytes === 'number',
        chromiumRssBytes, jsHeapBytes: metrics.metrics.find((item) => item.name === 'JSHeapUsedSize')?.value ?? 'NOT_MEASURED',
          ...browserState, audioChunks: local.chunks.length,
          audioBytes: local.chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0),
          segmentId: active?.id ?? null, recordingId: active?.recordingId ?? null,
          segmentCount: authoritative.length, recordingState: local.recording?.state ?? null,
        pcmJournalPendingWrites: browserState.pcmJournalPendingWrites,
        pcmJournalPendingScope: 'worker_requests_only'
        };
        if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
        if (active?.id && active.id !== lastSegmentId) {
          evidence.rolloverObservations.push({ at: row.at, elapsedMs: row.elapsedMs,
            oldSegmentId: lastSegmentId, newSegmentId: active.id, recordingId: active.recordingId,
            segments: authoritative.map((segment) => ({ id: segment.id, recordingId: segment.recordingId, sequence: segment.sequence, status: segment.status })) });
          lastSegmentId = active.id;
          save();
        }
        return row;
      };
  const requiredCaptureMs = ram2Diagnostic ? 60_000 : recordingContract ? 45_000 : soakMinutes * 60_000;
      while (Date.now() - captureStart < requiredCaptureMs) {
        const row = await sample();
        expect(row.liveTracks, 'the MediaRecorder source must remain live').toBeGreaterThan(0);
        expect(row.lastCallbackAgeMs, 'PCM input must remain live').toBeLessThan(5_000);
        nextSampleAt += recordingContract ? 5_000 : 30_000;
        await page.waitForTimeout(Math.max(0, Math.min(nextSampleAt - Date.now(), recordingContract ? 5_000 : 30_000)));
      }
      const lastCaptureRow = await sample();
      const preStopRendererPid = lastCaptureRow.rendererPid;
      const measureRenderer = async () => {
        const at = Date.now();
        const [metrics, processInfo] = await Promise.all([
          cdp.send('Performance.getMetrics').catch(() => null),
          system.send('SystemInfo.getProcessInfo').catch(() => null)
        ]);
        const rendererPid = processInfo?.processInfo?.find((entry) => entry.type === 'renderer')?.id ?? null;
        let chromiumRssBytes = 'NOT_COMPARABLE';
        let rendererAlive = false;
        if (rendererPid !== null) {
          try {
            const rss = Number(execFileSync('ps', ['-p', String(rendererPid), '-o', 'rss='], { encoding: 'utf8' }).trim());
            rendererAlive = Number.isFinite(rss) && rss > 0;
            if (rendererAlive && rendererPid === preStopRendererPid) chromiumRssBytes = rss * 1024;
          } catch { /* A stopped renderer is not comparable to its pre-Stop samples. */ }
        }
        const comparable = rendererAlive && rendererPid === preStopRendererPid;
        return {
          at: new Date(at).toISOString(), elapsedMs: at - captureStart,
          rendererPid, rendererAlive, rendererComparable: comparable,
          chromiumRssBytes,
          jsHeapBytes: comparable
            ? metrics?.metrics?.find((item) => item.name === 'JSHeapUsedSize')?.value ?? 'NOT_MEASURED'
            : 'NOT_COMPARABLE'
        };
      };
      samplePostStop = async (secondsAfterBarrier) => {
        const row = { ...(await measureRenderer()), phase: 'post_stop', secondsAfterBarrier };
        if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
        (evidence.postStopMemorySamples ||= []).push(row);
        save();
      };
      sampleExport = async (phase, marker) => {
        const row = { ...(await measureRenderer()), phase, marker };
        if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
        (evidence.exportMemorySamples ||= []).push(row);
        save();
      };
      const preStopSegments = await segments(meetingId);
 evidence.preStopSegments = preStopSegments.map((segment) => ({ id: segment.id, recordingId: segment.recordingId, sequence: segment.sequence, status: segment.status }));
      evidence.captureElapsedMs = Date.now() - captureStart;
      save();
      expect(evidence.captureElapsedMs).toBeGreaterThanOrEqual(requiredCaptureMs);
  const requiredRollovers = ram2Diagnostic ? 2 : recordingContract ? 1 : Math.floor((soakMinutes - 1) / 15);
    expect(evidence.rolloverObservations.length, 'product scheduled 15-minute rollovers').toBeGreaterThanOrEqual(requiredRollovers);
      expect(evidence.rolloverObservations[0].elapsedMs).toBeGreaterThan(recordingContract ? 10_000 : 840_000);
      expect(evidence.rolloverObservations[0].elapsedMs).toBeLessThan(recordingContract ? 40_000 : 1_020_000);
      if (recordingContract) expect(await page.evaluate(() => window.__issue41ControlledRolloverTimer)).toBe(true);
    expect(preStopSegments.length).toBe(requiredRollovers + 1);
 expect(preStopSegments.every((segment) => segment.recordingId === evidence.initialRecordingId)).toBe(true);
 expect(preStopSegments.filter((segment) => segment.status === 'ACTIVE').length).toBe(1);
 expect(preStopSegments.find((segment) => segment.status === 'ACTIVE')?.id).toBe(evidence.rolloverObservations.at(-1).newSegmentId);
      if (recordingContract) {
    expect(preStopSegments.slice(0, -1).every((segment) => segment.status === 'ENDED')).toBe(true);
      }
    } else {
      await page.waitForTimeout(12_000);
    }
    const journalFiles = () => page.evaluate(async (id) => {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle('pcm-journals');
      const version = await base.getDirectoryHandle('v1');
      const meeting = await version.getDirectoryHandle(id);
      const files = [];
      for await (const [recordingId, directory] of meeting.entries()) {
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind === 'file') files.push({ recordingId, name, bytes: (await handle.getFile()).size });
        }
      }
      return files;
    }, meetingId);
    evidence.journalBeforeStop = await journalFiles();
    evidence.pcm = await page.evaluate(() => ({ callbacks: window.__issue41PcmCount, frames: window.__issue41Frames,
      bytes: window.__issue41Frames * 2, durationMs: window.__issue41Frames / 16,
      startedAt: window.__issue41PcmStartedAt, lastCallbackAgeMs: Date.now() - window.__issue41LastPcmAt,
      lateBatches: window.__issue41LateBatches, skippedBatches: window.__issue41SkippedBatches }));
    const pcmWallMs = Date.now() - evidence.pcm.startedAt;
    evidence.pcm.wallMs = pcmWallMs;
  const diagnoseAudioContainers = () => page.evaluate(async (id) => {
      const { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } = await import('/src/lib/localMeetingStorage.js');
      const chunks = (await createIndexedDbLocalMeetingManifestStore().list(id))
        .filter((chunk) => chunk.state === 'sealed')
        .sort((left, right) => left.sequence - right.sequence);
      const chunkStore = createOpfsChunkStore();
      const groups = [];
      for (const chunk of chunks) {
        const file = await chunkStore.read(chunk.path);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const checksum = `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
        const key = `${chunk.segmentId}\u0000${chunk.mimeType}`;
        if (groups.at(-1)?.key !== key) groups.push({ key, segmentId: chunk.segmentId, mimeType: chunk.mimeType, files: [], parts: [] });
        const group = groups.at(-1);
        group.files.push({ sequence: chunk.sequence, chunkId: chunk.chunkId, manifestBytes: chunk.byteSize,
          opfsBytes: bytes.byteLength, sizeMatches: chunk.byteSize === bytes.byteLength,
          manifestChecksum: chunk.checksum, opfsChecksum: checksum, hashMatches: chunk.checksum === checksum });
        group.parts.push(file);
      }
      const results = [];
      for (const group of groups) {
        const blob = new Blob(group.parts, { type: group.mimeType });
        const firstBytes = new Uint8Array(await group.parts[0].slice(0, 4).arrayBuffer());
        const context = new AudioContext();
        let decode;
        try {
          const audio = await context.decodeAudioData(await blob.arrayBuffer());
          decode = { ok: true, durationMs: Math.round(audio.duration * 1000), sampleRate: audio.sampleRate };
        } catch (error) {
          decode = { ok: false, errorName: error?.name || 'Error', errorMessage: error?.message || '' };
        } finally {
          await context.close();
        }
        results.push({ segmentId: group.segmentId, mimeType: group.mimeType, chunkCount: group.files.length,
          blobBytes: blob.size, firstChunkHasEbmlHeader: firstBytes.length === 4 && firstBytes.every((value, index) => value === [0x1a, 0x45, 0xdf, 0xa3][index]),
          files: group.files, decode });
      }
      return results;
    }, meetingId);
  if (recordingContract) evidence.audioContainerDiagnosis = await diagnoseAudioContainers();
  if (recordingContract) evidence.recorderTransitionsBeforeStop = await page.evaluate(() => window.__issue41RecorderTransitions);
    save();
    expect(evidence.pcm.callbacks).toBeGreaterThan(80);
    expect(evidence.pcm.durationMs / pcmWallMs).toBeGreaterThan(0.75);
    expect(evidence.pcm.durationMs / pcmWallMs).toBeLessThan(1.1);
    expect(evidence.journalBeforeStop.some((file) => file.name.startsWith('pcm-') && file.bytes > 0)).toBe(true);
    await page.getByRole('button', { name: '結束會議' }).click();
    await expect.poll(async () => (await localState(meetingId)).recording?.state, { timeout: 30_000 }).toBe('stopped_local');
    expect((await localState(meetingId)).segments.every((segment) => segment.status === 'ENDED')).toBe(true);
    evidence.barrierCompletedAt = new Date().toISOString();
      if (samplePostStop) {
        const barrierAt = Date.now();
        for (const seconds of [0, 30, 60]) {
          if (seconds > 0) await page.waitForTimeout(Math.max(0, barrierAt + seconds * 1000 - Date.now()));
          await samplePostStop(seconds);
        }
      }
  if (ram2Diagnostic || recordingSoak) {
    await page.evaluate(() => Promise.allSettled(window.__issue41RamStagePending));
    evidence.ram2Stages.push({ stage: 'stop_barrier', state: 'complete', at: Date.parse(evidence.barrierCompletedAt),
      rendererPid: evidence.postStopMemorySamples?.[0]?.rendererPid ?? null,
      chromiumRssBytes: 'SEE_POST_STOP_0', jsHeapBytes: 'SEE_POST_STOP_0' });
    save();
    expect(evidence.ram2Stages.filter((event) => ['opfs_readback', 'decode_audio', 'wav_encode'].includes(event.stage))).toEqual([]);
  }
    evidence.journalAfterStop = await journalFiles();
  if (recordingContract) {
    evidence.audioContainerAfterStop = await diagnoseAudioContainers();
    evidence.recorderTransitionsAfterStop = await page.evaluate(() => window.__issue41RecorderTransitions);
    expect(evidence.audioContainerAfterStop).toHaveLength(evidence.preStopSegments.length);
    expect(evidence.audioContainerAfterStop.every((segment) => segment.firstChunkHasEbmlHeader && segment.decode.ok)).toBe(true);
    expect(evidence.audioContainerAfterStop.every((segment) => segment.files.every((file) => file.sizeMatches && file.hashMatches))).toBe(true);
  }
    if (recordingSoak || recordingContract) {
      evidence.journalClaims = await page.evaluate(async (id) => {
        const root = await navigator.storage.getDirectory();
        const meeting = await (await (await root.getDirectoryHandle('pcm-journals')).getDirectoryHandle('v1')).getDirectoryHandle(id);
        const recordings = [];
        for await (const [recordingId, directory] of meeting.entries()) {
          const bytes = new Uint8Array(await (await directory.getFileHandle('claims.bin')).getFile().then((file) => file.arrayBuffer()));
          const view = new DataView(bytes.buffer);
          const decoder = new TextDecoder();
          const epochs = new Map();
          let cursor = 0;
          let hashesValid = true;
          let records = 0;
          while (cursor < bytes.length) {
            if (cursor + 36 > bytes.length) throw new Error('PCM journal ledger truncated');
            const length = view.getUint32(cursor, true);
            if (length < 2 || cursor + 4 + length + 32 > bytes.length) throw new Error('PCM journal ledger record invalid');
            const payload = bytes.subarray(cursor + 4, cursor + 4 + length);
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
            if (hash.some((value, index) => value !== bytes[cursor + 4 + length + index])) hashesValid = false;
            const record = JSON.parse(decoder.decode(payload));
            const epoch = epochs.get(record.captureEpoch) || { captureEpoch: record.captureEpoch, claims: 0, bytes: 0, nextSample: 0, gaps: 0, overlaps: 0, ended: false };
            if (record.type === 'pcm') {
              if (record.startSample > epoch.nextSample) epoch.gaps += record.startSample - epoch.nextSample;
              if (record.startSample < epoch.nextSample) epoch.overlaps += epoch.nextSample - record.startSample;
              epoch.nextSample = Math.max(epoch.nextSample, record.endSample);
              epoch.claims += 1;
              epoch.bytes += record.byteLength;
            }
            if (record.type === 'end') {
              epoch.ended = true;
              if (record.endSample > epoch.nextSample) epoch.gaps += record.endSample - epoch.nextSample;
              epoch.endSample = record.endSample;
            }
            epochs.set(record.captureEpoch, epoch);
            records += 1;
            cursor += 4 + length + 32;
          }
          recordings.push({ recordingId, records, hashesValid, ledgerBytes: bytes.length, epochs: [...epochs.values()] });
        }
        return recordings;
      }, meetingId);
      save();
      expect(evidence.journalClaims.length).toBe(1);
      expect(evidence.journalClaims[0].hashesValid).toBe(true);
      expect(evidence.journalClaims[0].epochs.filter((epoch) => epoch.claims > 0).length).toBeGreaterThanOrEqual(2);
      expect(evidence.journalClaims[0].epochs.every((epoch) => epoch.gaps === 0 && epoch.overlaps === 0 && epoch.ended)).toBe(true);
    }
    const beforeReload = await localState(meetingId);
    if (recordingSmoke) {
      expect(beforeReload.recording?.recordingId).toBe(evidence.initialRecordingId);
      expect(beforeReload.recording?.segmentId).toBe(initialSegmentId);
      expect(beforeReload.recording?.segmentNumber).toBe(1);
      expect(beforeReload.recording?.state).toBe('stopped_local');
      expect(beforeReload.chunks.every((chunk) => chunk.segmentId === initialSegmentId)).toBe(true);
    }
    if (recordingSoak || recordingContract) {
      expect(beforeReload.recording?.recordingId).toBe(evidence.initialRecordingId);
      expect(evidence.journalClaims[0].recordingId).toBe(beforeReload.recording.recordingId);
    }
    evidence.beforeReload = { recordingState: beforeReload.recording.state, chunks: beforeReload.chunks };
    save();
    expect(beforeReload.chunks.length).toBeGreaterThan(0);
    expect(beforeReload.chunks.every((chunk) => chunk.state === 'sealed' && chunk.byteSize > 0)).toBe(true);
    if (recordingSoak || recordingContract) {
      const chunkSegments = new Set(beforeReload.chunks.map((chunk) => chunk.segmentId));
      expect([...chunkSegments].sort()).toEqual(evidence.preStopSegments.map((segment) => segment.id).sort());
    }
    await page.reload();
    if (attachRamStage) await attachRamStage();
    const restored = await localState(meetingId);
    if (recordingSmoke) {
      expect(restored.recording?.meetingId).toBe(meetingId);
      expect(restored.recording?.recordingId).toBe(evidence.initialRecordingId);
      expect(restored.recording?.segmentId).toBe(initialSegmentId);
      expect(restored.recording?.segmentNumber).toBe(1);
    }
    evidence.restored = { recordingState: restored.recording?.state, chunks: restored.chunks };
const measureExportPhase = async (phase, action) => {
  if (sampleExport) await sampleExport(phase, 'start');
  const pendingSamples = new Set();
  const sampler = sampleExport ? setInterval(() => {
    if (pendingSamples.size) return;
    const pending = sampleExport(phase, 'during');
    pendingSamples.add(pending);
    void pending.then(() => pendingSamples.delete(pending), (error) => {
      pendingSamples.delete(pending);
      evidence.exportMemoryError = error.message;
      save();
    });
  }, 1_000) : null;
  let result;
  try { result = await action(); }
  finally {
    if (sampler) clearInterval(sampler);
    await Promise.allSettled([...pendingSamples]);
  }
  if (sampleExport) {
    await page.evaluate(() => Promise.allSettled(window.__issue41RamStagePending));
    await sampleExport(phase, 'complete');
    await page.waitForTimeout(60_000);
    await sampleExport(phase, 'residual_60s');
  }
  return result;
};
const productAudio = await measureExportPhase('export', () => page.evaluate(async (id) => {
  const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
  const artifacts = await createLocalMeetingPersistence().listFinalizedAudioArtifacts(id);
  window.__issue41ExportArtifacts = artifacts;
  return artifacts.map((artifact) => ({ kind: artifact.kind, bytes: artifact.blob.size,
    mimeType: artifact.mimeType, segments: artifact.captureSegmentCount }));
}, meetingId));
if (sampleExport) {
  expect(evidence.ram2Stages.some((event) => event.stage === 'opfs_readback' && event.state === 'start')).toBe(true);
  expect(evidence.ram2Stages.some((event) => event.stage === 'decode_audio' && event.state === 'start')).toBe(true);
}
const decodedAudio = await measureExportPhase('wav_validation', () => page.evaluate(async () => {
  const results = [];
  for (const artifact of window.__issue41ExportArtifacts) {
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(await artifact.blob.arrayBuffer());
    await context.close();
    results.push({ kind: artifact.kind, durationMs: Math.round(decoded.duration * 1000) });
  }
  return results;
}));
const segmentValidation = await measureExportPhase('segment_validation', () => page.evaluate(async ({ id, isSoak }) => {
  const { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } = await import('/src/lib/localMeetingStorage.js');
  const chunks = await createIndexedDbLocalMeetingManifestStore().list(id);
  const chunkStore = createOpfsChunkStore();
  const actualChunks = await Promise.all(chunks.map(async (chunk) => ({ expected: chunk.byteSize, actual: (await chunkStore.read(chunk.path)).size })));
  const perSegment = [];
  if (isSoak) {
    const { composeLocalMeetingAudioArtifact } = await import('/src/lib/localMeetingAudioExport.js');
    for (const segmentId of [...new Set(chunks.map((chunk) => chunk.segmentId))]) {
      const segmentChunks = chunks.filter((chunk) => chunk.segmentId === segmentId);
      const artifact = await composeLocalMeetingAudioArtifact({ chunks: segmentChunks, readChunk: (path) => chunkStore.read(path) });
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(await artifact.blob.arrayBuffer());
      await context.close();
      perSegment.push({ segmentId, chunks: segmentChunks.length, bytes: artifact.blob.size,
        mimeType: artifact.mimeType, durationMs: Math.round(decoded.duration * 1000) });
    }
  }
  return { actualChunks, perSegment };
}, { id: meetingId, isSoak: recordingSoak || recordingContract }));
const exported = {
  ...segmentValidation,
  audio: productAudio.map((artifact) => ({ ...artifact,
    durationMs: decodedAudio.find((item) => item.kind === artifact.kind)?.durationMs ?? 0 }))
};
    evidence.exported = exported;
    expect(restored.recording?.state).toBe('stopped_local');
    expect(restored.chunks).toEqual(beforeReload.chunks);
    expect(exported.actualChunks.every((chunk) => chunk.expected > 0 && chunk.actual === chunk.expected)).toBe(true);
    const inputAudio = exported.audio.find((item) => item.kind === 'input');
    expect(inputAudio?.bytes).toBeGreaterThan(0);
    expect(inputAudio?.durationMs / pcmWallMs).toBeGreaterThan(0.6);
    expect(inputAudio?.durationMs / pcmWallMs).toBeLessThan(1.4);
    if (recordingSoak || recordingContract) {
    expect(exported.perSegment.length).toBe(evidence.preStopSegments.length);
      expect(exported.perSegment.every((segment) => segment.bytes > 0 && segment.durationMs > 0)).toBe(true);
      const totalSegmentMs = exported.perSegment.reduce((sum, segment) => sum + segment.durationMs, 0);
      expect(totalSegmentMs / pcmWallMs).toBeGreaterThan(0.85);
      expect(totalSegmentMs / pcmWallMs).toBeLessThan(1.15);
      expect(inputAudio.durationMs / totalSegmentMs).toBeGreaterThan(0.95);
      expect(inputAudio.durationMs / totalSegmentMs).toBeLessThan(1.05);
      expect(evidence.pcm.lateBatches).toBe(0);
      expect(evidence.pcm.skippedBatches).toBe(0);
    }
    evidence.cloudAfter = await cloudInventory(meetingId);
    for (const key of ['cues', 'contentEvents', 'checkpoints', 'sessionContent', 'audioObjects', 'exportObjects']) {
      expect(evidence.cloudAfter[key], `Cloud content ${key}`).toBe(evidence.cloudBefore[key]);
    }
    expect(evidence.cloudAfter.sessions).toBe(evidence.cloudBefore.sessions);
    expect(evidence.cloudAfter.segments).toBe(evidence.cloudBefore.segments);
    expect(evidence.browserErrors).toEqual([]);
evidence.result = recordingContract ? 'ROLLOVER_CONTRACT_PASS' : recordingSoak ? `RECORDING_${soakMinutes}MIN_SOAK_PASS` : 'RECORDING_SMOKE_PASS';
    evidence.finishedAt = new Date().toISOString();
    save();
    return;
    } catch (error) {
      evidence.firstFailure = { at: new Date().toISOString(), message: error?.message || String(error) };
      save();
      try {
        evidence.localAtFailure = await localState(meetingId);
      } catch (diagnosticError) { evidence.localDiagnosticError = diagnosticError.message; }
      try {
        const stop = page.getByRole('button', { name: '結束會議' });
        if (await stop.isVisible()) {
          await stop.click({ timeout: 10_000 });
          evidence.failureStopAttempt = 'clicked';
        } else evidence.failureStopAttempt = 'unavailable';
      } catch (stopError) { evidence.failureStopAttempt = stopError.message; }
      try { evidence.cloudAfter = await cloudInventory(meetingId); }
      catch (inventoryError) { evidence.cloudAfterError = inventoryError.message; }
      save();
      throw error;
    }
  }
  await expect(page.getByText('聆聽中')).toBeVisible();
  const listeningAt = Date.now();
  evidence.listeningAt = new Date(listeningAt).toISOString();
  await expect.poll(() => page.evaluate(() => window.__issue41PcmCount)).toBeGreaterThan(0);
  await expect.poll(async () => (await segments(meetingId)).length).toBeGreaterThan(0);
  evidence.localSegments = await segments(meetingId);
  const viewer = await browser.newPage();
  viewer.on('pageerror', (error) => { evidence.browserErrors.push(`viewer:${error.name}`); save(); });
  await viewer.goto(`/${share.url || share.codeUrl}`);
  evidence.viewerJoinAt = new Date().toISOString();
  await page.bringToFront();

  const emitCue = async (source, translation, segmentId) => {
    await page.evaluate(({ sourceText, translatedText }) => {
      window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({ serverContent: {
        inputTranscription: { text: sourceText }, outputTranscription: { text: translatedText }, turnComplete: true
      } });
    }, { sourceText: source, translatedText: translation });
    await expect.poll(async () => (await localState(meetingId)).cues.find((row) =>
      row.segmentId === segmentId && row.sourceText === source && row.translatedText === translation) || null,
    { timeout: 30_000 }).not.toBeNull();
    const row = (await localState(meetingId)).cues.find((item) => item.sourceText === source);
    expect(row.segmentId).toBe(segmentId);
    expect(Number.isSafeInteger(row.sequence)).toBe(true);
    await expect(viewer.getByTestId('meeting-viewer-cue-row').filter({ hasText: source }))
      .toContainText(translation, { timeout: 30_000 });
    evidence.cues.push({ id: row.cueId, sessionId: row.sessionId, segmentId: row.segmentId,
      sequence: row.sequence, source, translation });
    evidence.viewer.push({ segmentId, source, translation, receivedAt: new Date().toISOString() });
    save();
    return row;
  };
  const first = await emitCue('issue41 before rollover', 'issue41 first translation', initialSegmentId);
  await viewer.reload();
  evidence.viewerReconnectAt = new Date().toISOString();
  await expect(viewer.getByTestId('meeting-viewer-cue-row').filter({ hasText: 'issue41 before rollover' }))
    .toContainText('issue41 first translation', { timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  let resourceSampling = false;
  const sampleResources = async () => {
    if (resourceSampling) return;
    resourceSampling = true;
    try {
      const metrics = await cdp.send('Performance.getMetrics');
      const heap = metrics.metrics.find((item) => item.name === 'JSHeapUsedSize')?.value ?? 'NOT_MEASURED';
      const local = await localState(meetingId);
      const opfs = await page.evaluate(async () => {
        let files = 0; let bytes = 0;
        const walk = async (directory) => {
          for await (const handle of directory.values()) {
            if (handle.kind === 'directory') await walk(handle);
            else { files += 1; bytes += (await handle.getFile()).size; }
          }
        };
        await walk(await navigator.storage.getDirectory());
        return { files, bytes };
      });
      let rss = 'NOT_MEASURED';
      try {
        const processInfo = await (await browser.newBrowserCDPSession()).send('SystemInfo.getProcessInfo');
        const renderer = processInfo.processInfo.find((entry) => entry.type === 'renderer');
        if (renderer) rss = Number(execFileSync('ps', ['-p', String(renderer.id), '-o', 'rss='], { encoding: 'utf8' }).trim()) * 1024;
      } catch { /* Chromium may not expose a renderer PID. */ }
      const sample = { at: new Date().toISOString(), elapsedMs: Date.now() - listeningAt,
        chromiumRssBytes: rss, jsHeapBytes: heap, opfs, pcmCallbacks: await page.evaluate(() => window.__issue41PcmCount),
        pcmJournalPendingWrites: 'NOT_MEASURED', segmentCount: (await segments(meetingId)).length,
        cueCount: local.cues.length, viewerReconnects: evidence.viewerReconnectAt ? 1 : 0 };
      if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(sample)}\n`);
    } finally { resourceSampling = false; }
  };
  await sampleResources();
  const resourceTimer = setInterval(() => { void sampleResources().catch((error) => {
    evidence.browserErrors.push(`resource:${error.message}`); save();
  }); }, shortValidation ? 5_000 : 30_000);
  if (!shortValidation) {
  const firstNext = await emitCue('issue41 before rollover again', 'issue41 next translation', initialSegmentId);
    expect(firstNext.sequence).toBeGreaterThan(first.sequence);
    const beforeRolloverPcm = await page.evaluate(() => window.__issue41PcmCount);
    const beforeRolloverProcessors = await page.evaluate(() => window.__issue41Processors.length);
    await expect.poll(async () => (await segments(meetingId)).find((row) => row.sequence === 2) || null,
      { timeout: 17 * 60_000, intervals: [1000, 5000, 15_000] }).not.toBeNull();
    const next = (await segments(meetingId)).find((row) => row.sequence === 2);
    evidence.rollover = { at: new Date().toISOString(), segmentId: next.id, sequence: next.sequence };
    await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions.length)).toBeGreaterThan(1);
    await expect.poll(() => page.evaluate(() => window.__issue41PcmCount)).toBeGreaterThan(beforeRolloverPcm);
    const afterRolloverProcessors = await page.evaluate(() => window.__issue41Processors.length);
    if (afterRolloverProcessors > beforeRolloverProcessors) {
      await expect.poll(() => page.evaluate(() => window.__issue41ProcessorCounts[window.__issue41Processors.length - 1] || 0))
        .toBeGreaterThan(0);
    }
    const second = await emitCue('issue41 after rollover', 'issue41 second translation', next.id);
    expect(second.sequence).toBeGreaterThanOrEqual(0);
    expect(second.segmentId).not.toBe(first.segmentId);
    const secondNext = await emitCue('issue41 after rollover again', 'issue41 continuing translation', next.id);
    expect(secondNext.sequence).toBeGreaterThan(second.sequence);
    await expect.poll(() => Date.now() - listeningAt, { timeout: 6 * 60_000, intervals: [30_000] }).toBeGreaterThanOrEqual(20 * 60_000);
    evidence.elapsedMs = Date.now() - listeningAt;
  }
  clearInterval(resourceTimer);
  evidence.segments = (await segments(meetingId)).map((row) => ({ id: row.id, recordingId: row.recordingId,
    sequence: row.sequence, status: row.status }));
  const localBeforeStop = await localState(meetingId);
  evidence.localBeforeStop = { cues: localBeforeStop.cues.length, transcripts: localBeforeStop.transcripts.length,
    checkpoints: localBeforeStop.checkpoints, audioChunks: localBeforeStop.chunks.length };
  expect(localBeforeStop.cues.length).toBeGreaterThan(0);
  evidence.pcm = await page.evaluate(() => ({ callbacks: window.__issue41PcmCount, frames: window.__issue41Frames,
    bytes: window.__issue41Frames * 2, durationMs: window.__issue41Frames / 16,
    startedAt: window.__issue41PcmStartedAt, lateBatches: window.__issue41LateBatches,
    skippedBatches: window.__issue41SkippedBatches,
    processorCounts: window.__issue41ProcessorCounts, maxGapMs: window.__issue41MaxPcmGapMs,
    lastCallbackAgeMs: Date.now() - window.__issue41LastPcmAt }));
  expect(evidence.pcm.callbacks).toBeGreaterThan(0);
  if (!shortValidation) {
    expect(evidence.pcm.callbacks).toBeGreaterThan(1000);
    expect(evidence.pcm.maxGapMs).toBeLessThan(10_000);
    expect(evidence.pcm.lastCallbackAgeMs).toBeLessThan(5_000);
  }
  const pcmWallMs = Date.now() - evidence.pcm.startedAt;
  expect(evidence.pcm.durationMs / pcmWallMs).toBeGreaterThan(0.8);
  expect(evidence.pcm.durationMs / pcmWallMs).toBeLessThan(1.1);
  await page.getByRole('button', { name: '結束會議' }).click();
  await expect.poll(() => page.evaluate(() => ({ tracks: window.__issue41Tracks.filter((track) => !track.stopped).length,
    contexts: window.__issue41Contexts.filter((context) => context.state !== 'closed').length,
    providers: window.__mockGoogleGenAI.liveSessions.filter((session) => !session.closed).length }))).toEqual({ tracks: 0, contexts: 0, providers: 0 });
  evidence.resourcesReleased = true;
  evidence.barrierCompletedAt = new Date().toISOString();
  await page.reload();
  const restored = await localState(meetingId);
  evidence.restored = { cues: restored.cues.length, transcripts: restored.transcripts.length,
    checkpoints: restored.checkpoints, chunks: restored.chunks.length, retention: restored.retention };
  expect(restored.cues.length).toBeGreaterThanOrEqual(evidence.cues.length);
  expect(restored.chunks.length).toBeGreaterThan(0);
  expect(restored.chunks.every((chunk) => chunk.state === 'sealed' && chunk.byteSize > 0)).toBe(true);
  expect(restored.checkpoints.length).toBeGreaterThan(0);
  const exportResult = await page.evaluate(async (id) => {
    const { exportCuesToTxt, exportCuesToSrt, exportCuesToVtt } = await import('/src/lib/subtitleCueExport.js');
    const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const cues = (await createIndexedDbLocalMeetingManifestStore().listCues(id)).map((row) => row.cue);
    const texts = {};
    for (const stream of ['source', 'translation']) {
      for (const [format, exportFn] of Object.entries({ txt: exportCuesToTxt, srt: exportCuesToSrt, vtt: exportCuesToVtt })) {
        const value = exportFn(cues, { stream });
        texts[`${stream}.${format}`] = { bytes: new Blob([value]).size, containsCue: value.includes('issue41') };
      }
    }
    const artifacts = await createLocalMeetingPersistence().listFinalizedAudioArtifacts(id);
    return { texts, audio: artifacts.map((artifact) => ({ kind: artifact.kind || 'input', bytes: artifact.blob?.size || 0,
      mimeType: artifact.mimeType, segmentCount: artifact.captureSegmentCount })) };
  }, meetingId);
  evidence.exports = exportResult;
  expect(Object.values(exportResult.texts).every((item) => item.bytes > 0 && item.containsCue)).toBe(true);
  expect(exportResult.audio.some((item) => item.kind === 'input' && item.bytes > 0)).toBe(true);
  evidence.cloudAfter = await cloudInventory(meetingId);
  for (const key of ['cues', 'contentEvents', 'checkpoints', 'sessionContent', 'audioObjects', 'exportObjects']) {
    expect(evidence.cloudAfter[key], `Cloud content ${key}`).toBe(evidence.cloudBefore[key]);
  }
  expect(evidence.cloudAfter.segments).toBe(evidence.cloudBefore.segments);
  expect(evidence.cloudAfter.sessions).toBe(evidence.cloudBefore.sessions);
  expect(evidence.browserErrors).toEqual([]);
  evidence.result = shortValidation ? 'SHORT_VALIDATION_PASS_NO_ROLLOVER_CLAIM' : 'REAL_TIME_SOAK_PASS';
  evidence.finishedAt = new Date().toISOString();
  save();
  await viewer.close();
});
