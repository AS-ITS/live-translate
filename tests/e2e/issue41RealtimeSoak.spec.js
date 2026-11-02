import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { serializeEffectiveGlossary } from '../../src/lib/glossaryRevision.js';
import { installE2EAuth, localE2EAuthSession } from './authBootstrap.js';

const shortValidation = process.env.ISSUE41_SHORT_VALIDATION === 'true';
const recordingOnly = process.env.ISSUE41_RECORDING_ONLY === 'true';
const recordingSoak = recordingOnly && !shortValidation;
const recordingContract = recordingOnly && process.env.ISSUE41_ROLLOVER_CONTRACT === 'true';
const soakMinutes = Number(process.env.ISSUE41_RECORDING_SOAK_MINUTES || 20);
if (recordingSoak && ![20, 40, 130].includes(soakMinutes)) throw new Error('Unsupported recording soak duration');
const evidenceFile = process.env.ISSUE41_EVIDENCE_FILE;
const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
const seriesFile = process.env.ISSUE41_RESOURCE_FILE;

test.use({ trace: 'on' });

test(recordingOnly ? (recordingContract ? 'issue41 recording-only controlled rollover contract' : recordingSoak ? `issue41 recording-only ${soakMinutes}-minute real-time soak` : 'issue41 recording-only local smoke') : 'issue41 real-time 20-minute local meeting soak', async ({ page, browser }) => {
  test.setTimeout(shortValidation ? 240_000 : (soakMinutes + 8) * 60_000);
  const auth = localE2EAuthSession();
  expect(auth, 'a local Supabase Auth user is required').toBeTruthy();
  expect(auth.profile.email.endsWith('@example.com')).toBe(true);
  expect(process.env.AUTH_ALLOWED_EMAIL_DOMAINS).toBe('example.com');
  expect(supabaseUrl, 'isolated local Supabase is required').toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
  expect(publishableKey).toBeTruthy();
  expect(serviceKey, 'isolated service key is required for the zero-write inventory').toBeTruthy();
const evidence = { mode: recordingContract ? 'recording-rollover-contract' : recordingSoak ? `recording-${soakMinutes}min-soak` : recordingOnly ? 'recording-only' : shortValidation ? 'short-validation' : 'real-time-soak',
    startedAt: new Date().toISOString(), api: [], browserErrors: [], cues: [], viewer: [] };
  const save = () => { if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)); };
  const headers = { Authorization: `Bearer ${auth.token}` };
  const dbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const apiJson = async (method, path, data) => {
    const response = await page.request.fetch(`/api${path}`, { method, headers, data });
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
  const segments = (meetingId) => dbRows('meeting_segments', `select=id,meeting_id,session_id,sequence,status,checkpoint&meeting_id=eq.${meetingId}&order=sequence.asc`);
  const localState = (meetingId) => page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const cues = await store.listCues(id);
    const transcripts = await store.listTranscriptItems(id);
    const checkpoints = await store.listCheckpoints(id);
    const recording = await store.getRecording(id);
    const chunks = await store.list(id);
    const retention = await store.getRetention(id);
    return { cues: cues.map((row) => row.cue), transcripts, checkpoints: checkpoints.map((row) => ({ segmentId: row.segmentId, revision: row.checkpoint?.revision })),
      recording, chunks: chunks.map((row) => ({ segmentId: row.segmentId, byteSize: row.byteSize, state: row.state })), retention };
  }, meetingId);
  const storageObjects = async (bucket) => {
    const response = await page.request.post(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
      headers: { ...dbHeaders, 'content-type': 'application/json' }, data: { prefix: '', limit: 1000 }
    });
    expect(response.ok(), `Storage ${bucket}: HTTP ${response.status()}`).toBe(true);
    return response.json();
  };
  const cloudInventory = async (meetingId) => {
    const [cues, events, segmentRows, sessionRows, audio, exports] = await Promise.all([
      dbRows('subtitle_cues', 'select=id'),
      dbRows('meeting_events', `select=id,payload&meeting_id=eq.${meetingId}`),
      segments(meetingId),
      dbRows('sessions', `select=id,transcript_items,payload&meeting_id=eq.${meetingId}`),
      storageObjects('meeting-audio'), storageObjects('meeting-exports')
    ]);
    return { cues: cues.length, contentEvents: events.filter((row) => JSON.stringify(row.payload || {}).match(/cue|transcript|translation|audio|checkpoint/i)).length,
      checkpoints: segmentRows.filter((row) => row.checkpoint && Object.keys(row.checkpoint).length).length,
      sessionContent: sessionRows.filter((row) => (row.transcript_items?.length || 0) > 0 || JSON.stringify(row.payload || {}).match(/sourceText|translatedText|transcript|translation|summary/i)).length,
      audioObjects: audio.length, exportObjects: exports.length, segments: segmentRows.length, sessions: sessionRows.length };
  };
  page.on('pageerror', (error) => { evidence.browserErrors.push(error.name); save(); });
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
  if (recordingContract) await page.addInitScript(() => {
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
    let shortened = false;
    window.setTimeout = (callback, delay, ...args) => {
      if (!shortened && delay === 15 * 60_000) {
        shortened = true;
        window.__issue41ControlledRolloverTimer = true;
        return nativeSetTimeout(callback, 15_000, ...args);
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
  });
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
  evidence.cloudBefore = await cloudInventory(meetingId);
  save();
  const share = recordingOnly ? null : await apiJson('POST', `/meetings/${meetingId}/shares`, { role: 'viewer' });
  if (!recordingOnly) expect(share.url || share.codeUrl).toBeTruthy();
  await page.goto('/#meetings');
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
  await expect(page.getByRole('button', { name: '開始' })).toBeEnabled();
  if (recordingOnly) {
    evidence.startPreconditions = await page.evaluate(async (id) => {
      const { hasLiveCredential } = await import('/src/lib/liveCredentialHolder.js');
      const { getMeetingAudioPreference, hasConfirmedMeetingAudioPreference } = await import('/src/lib/meetingAudioPreferences.js');
      return { credentialPresent: hasLiveCredential(), audioConfirmed: hasConfirmedMeetingAudioPreference(getMeetingAudioPreference(id)) };
    }, meetingId);
    save();
    expect(evidence.startPreconditions).toEqual({ credentialPresent: true, audioConfirmed: true });
  }
  await page.getByRole('button', { name: '開始' }).click();
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
    await expect.poll(async () => (await dbRows('sessions', `select=id,meeting_id,segment_id&meeting_id=eq.${meetingId}`)).length)
      .toBeGreaterThan(0);
  const startedSegments = await segments(meetingId);
  expect(startedSegments).toHaveLength(1);
  initialSegmentId = startedSegments[0].id;
  evidence.initialSegmentId = initialSegmentId;
  save();
    if (recordingSoak || recordingContract) {
      const captureStart = await page.evaluate(() => window.__issue41PcmStartedAt);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const system = await browser.newBrowserCDPSession();
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
        const active = authoritative.find((segment) => segment.status === 'active');
        const row = {
          at: new Date(at).toISOString(), elapsedMs: at - captureStart,
          chromiumRssBytes, jsHeapBytes: metrics.metrics.find((item) => item.name === 'JSHeapUsedSize')?.value ?? 'NOT_MEASURED',
          ...browserState, audioChunks: local.chunks.length,
          audioBytes: local.chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0),
          segmentId: active?.id ?? null, sessionId: active?.session_id ?? null,
          segmentCount: authoritative.length, recordingState: local.recording?.state ?? null,
        pcmJournalPendingWrites: browserState.pcmJournalPendingWrites,
        pcmJournalPendingScope: 'worker_requests_only'
        };
        if (seriesFile) appendFileSync(seriesFile, `${JSON.stringify(row)}\n`);
        if (active?.id && active.id !== lastSegmentId) {
          evidence.rolloverObservations.push({ at: row.at, elapsedMs: row.elapsedMs,
            oldSegmentId: lastSegmentId, newSegmentId: active.id, sessionId: active.session_id,
            segments: authoritative.map((segment) => ({ id: segment.id, sessionId: segment.session_id, sequence: segment.sequence, status: segment.status })) });
          lastSegmentId = active.id;
          save();
        }
        return row;
      };
    const requiredCaptureMs = recordingContract ? 45_000 : soakMinutes * 60_000;
      while (Date.now() - captureStart < requiredCaptureMs) {
        const row = await sample();
        expect(row.liveTracks, 'the MediaRecorder source must remain live').toBeGreaterThan(0);
        expect(row.lastCallbackAgeMs, 'PCM input must remain live').toBeLessThan(5_000);
        nextSampleAt += recordingContract ? 5_000 : 30_000;
        await page.waitForTimeout(Math.max(0, Math.min(nextSampleAt - Date.now(), recordingContract ? 5_000 : 30_000)));
      }
      await sample();
      const preStopSegments = await segments(meetingId);
      const authoritativeSessions = await dbRows('sessions', `select=id,meeting_id,segment_id,current_segment_id,recording_id&meeting_id=eq.${meetingId}`);
      evidence.preStopSegments = preStopSegments.map((segment) => ({ id: segment.id, sessionId: segment.session_id, sequence: segment.sequence, status: segment.status }));
      evidence.preStopSessions = authoritativeSessions;
      evidence.captureElapsedMs = Date.now() - captureStart;
      save();
      expect(evidence.captureElapsedMs).toBeGreaterThanOrEqual(requiredCaptureMs);
    const requiredRollovers = recordingContract ? 1 : Math.floor((soakMinutes - 1) / 15);
    expect(evidence.rolloverObservations.length, 'product scheduled 15-minute rollovers').toBeGreaterThanOrEqual(requiredRollovers);
      expect(evidence.rolloverObservations[0].elapsedMs).toBeGreaterThan(recordingContract ? 10_000 : 840_000);
      expect(evidence.rolloverObservations[0].elapsedMs).toBeLessThan(recordingContract ? 40_000 : 1_020_000);
      if (recordingContract) expect(await page.evaluate(() => window.__issue41ControlledRolloverTimer)).toBe(true);
    expect(preStopSegments.length).toBe(requiredRollovers + 1);
      expect(authoritativeSessions.length).toBe(1);
    expect(preStopSegments.every((segment) => segment.session_id === authoritativeSessions[0].id)).toBe(true);
      expect(preStopSegments.filter((segment) => segment.status === 'active').length).toBe(1);
    expect(preStopSegments.find((segment) => segment.status === 'active')?.id).toBe(evidence.rolloverObservations.at(-1).newSegmentId);
    expect(authoritativeSessions[0].current_segment_id).toBe(evidence.rolloverObservations.at(-1).newSegmentId);
      if (recordingContract) {
        expect(evidence.lifecycleResponses?.filter((entry) => entry.meetingId === meetingId && entry.command === 'rollover' && entry.method === 'POST' && entry.status === 201)).toHaveLength(1);
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
    await expect.poll(() => evidence.lifecycleResponses?.filter((entry) => entry.meetingId === meetingId && entry.command === 'stop' && entry.method === 'POST' && entry.status === 200).length ?? 0, { timeout: 30_000 }).toBe(1);
    evidence.barrierCompletedAt = new Date().toISOString();
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
    if (recordingSoak || recordingContract) {
      expect(beforeReload.recording?.recordingId).toBe(evidence.preStopSessions[0].recording_id);
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
    const restored = await localState(meetingId);
    evidence.restored = { recordingState: restored.recording?.state, chunks: restored.chunks };
    const exported = await page.evaluate(async ({ id, isSoak }) => {
      const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
      const { createIndexedDbLocalMeetingManifestStore, createOpfsChunkStore } = await import('/src/lib/localMeetingStorage.js');
      const chunks = await createIndexedDbLocalMeetingManifestStore().list(id);
      const chunkStore = createOpfsChunkStore();
      const actualChunks = await Promise.all(chunks.map(async (chunk) => ({ expected: chunk.byteSize, actual: (await chunkStore.read(chunk.path)).size })));
      const artifacts = await createLocalMeetingPersistence().listFinalizedAudioArtifacts(id);
      const audio = [];
      for (const artifact of artifacts) {
        const context = new AudioContext();
        const decoded = await context.decodeAudioData(await artifact.blob.arrayBuffer());
        await context.close();
        audio.push({ kind: artifact.kind, bytes: artifact.blob.size, mimeType: artifact.mimeType,
          durationMs: Math.round(decoded.duration * 1000), segments: artifact.captureSegmentCount });
      }
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
      return { actualChunks, audio, perSegment };
    }, { id: meetingId, isSoak: recordingSoak || recordingContract });
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
    expect(evidence.cloudAfter.sessions).toBeGreaterThanOrEqual(1);
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
  await expect.poll(async () => (await dbRows('sessions', `select=id,meeting_id,segment_id&meeting_id=eq.${meetingId}`)).length).toBeGreaterThan(0);
  evidence.sessions = await dbRows('sessions', `select=id,meeting_id,segment_id&meeting_id=eq.${meetingId}`);
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
    await expect.poll(async () => (await segments(meetingId)).find((row) => row.sequence === 1) || null,
      { timeout: 17 * 60_000, intervals: [1000, 5000, 15_000] }).not.toBeNull();
    const next = (await segments(meetingId)).find((row) => row.sequence === 1);
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
  evidence.segments = (await segments(meetingId)).map((row) => ({ id: row.id, sessionId: row.session_id,
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
  expect(evidence.cloudAfter.segments).toBeGreaterThanOrEqual(1);
  expect(evidence.cloudAfter.sessions).toBeGreaterThanOrEqual(1);
  expect(evidence.browserErrors).toEqual([]);
  evidence.result = shortValidation ? 'SHORT_VALIDATION_PASS_NO_ROLLOVER_CLAIM' : 'REAL_TIME_SOAK_PASS';
  evidence.finishedAt = new Date().toISOString();
  save();
  await viewer.close();
});
