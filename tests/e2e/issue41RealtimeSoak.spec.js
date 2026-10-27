import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { serializeEffectiveGlossary } from '../../src/lib/glossaryRevision.js';
import { installE2EAuth, localE2EAuthSession } from './authBootstrap.js';

const shortValidation = process.env.ISSUE41_SHORT_VALIDATION === 'true';
const evidenceFile = process.env.ISSUE41_EVIDENCE_FILE;
const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.use({ trace: 'on' });

test('issue41 real-time 20-minute local meeting soak', async ({ page, browser }) => {
  test.setTimeout(shortValidation ? 180_000 : 23 * 60_000);
  const auth = localE2EAuthSession();
  expect(auth, 'a local Supabase Auth user is required').toBeTruthy();
  expect(auth.profile.email.endsWith('@example.com')).toBe(true);
  expect(process.env.AUTH_ALLOWED_EMAIL_DOMAINS).toBe('example.com');
  expect(supabaseUrl, 'isolated local Supabase is required').toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
  expect(publishableKey).toBeTruthy();
  const evidence = { mode: shortValidation ? 'short-validation' : 'real-time-soak',
    startedAt: new Date().toISOString(), api: [], browserErrors: [], cues: [], viewer: [] };
  const save = () => { if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)); };
  const headers = { Authorization: `Bearer ${auth.token}` };
  const dbHeaders = { apikey: publishableKey, Authorization: `Bearer ${auth.token}` };
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
  const cueRows = (segmentId) => dbRows('subtitle_cues', `select=id,session_id,segment_id,sequence,source_text,translated_text&segment_id=eq.${segmentId}&order=sequence.asc`);
  const segments = (meetingId) => dbRows('meeting_segments', `select=id,meeting_id,sequence,status,checkpoint&meeting_id=eq.${meetingId}&order=sequence.asc`);
  page.on('pageerror', (error) => { evidence.browserErrors.push(error.name); save(); });

  await installE2EAuth(page);
  await page.addInitScript(() => {
    window.__issue41Tracks = [];
    window.__issue41Contexts = [];
    window.__issue41Processors = [];
    window.__issue41PcmCount = 0;
    window.__issue41ProcessorCounts = {};
    window.__issue41LastPcmAt = null;
    window.__issue41MaxPcmGapMs = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => {
        const track = { kind: 'audio', enabled: true, readyState: 'live', stopped: false,
          stop() { this.stopped = true; this.readyState = 'ended'; },
          addEventListener() {}, removeEventListener() {} };
        window.__issue41Tracks.push(track);
        return { active: true, getTracks: () => [track] };
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
    class MediaRecorderFixture {
      static isTypeSupported() { return true; }
      constructor(stream, options = {}) { this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { if (this.state === 'inactive') return; this.state = 'inactive'; this.onstop?.({}); }
    }
    window.MediaRecorder = MediaRecorderFixture;
    window.__issue41PcmTimer = setInterval(() => {
      const index = window.__issue41Processors.length - 1;
      const processor = window.__issue41Processors[index];
      if (window.__issue41Tracks.at(-1)?.readyState !== 'live' ||
          window.__issue41Contexts.at(-1)?.state !== 'running' ||
          typeof processor?.onaudioprocess !== 'function') return;
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1600).fill(0.25) } });
      const now = Date.now();
      if (window.__issue41LastPcmAt) window.__issue41MaxPcmGapMs = Math.max(
        window.__issue41MaxPcmGapMs, now - window.__issue41LastPcmAt);
      window.__issue41LastPcmAt = now;
      window.__issue41PcmCount += 1;
      window.__issue41ProcessorCounts[index] = (window.__issue41ProcessorCounts[index] || 0) + 1;
    }, 500);
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
    targetLanguageCode: 'en', echoTargetLanguage: false, shouldRecordInputAudio: false
  });
  const meetingId = created.meeting.id;
  evidence.meetingId = meetingId;
  evidence.initialSegmentId = created.segment.id;
  const share = await apiJson('POST', `/meetings/${meetingId}/shares`, { role: 'viewer' });
  expect(share.url || share.codeUrl).toBeTruthy();
  const viewer = await browser.newPage();
  viewer.on('pageerror', (error) => { evidence.browserErrors.push(`viewer:${error.name}`); save(); });
  await viewer.goto(`/${share.url || share.codeUrl}`);
  await page.bringToFront();
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
  await page.getByRole('button', { name: '開始' }).click();
  await expect(page.getByText('聆聽中')).toBeVisible();
  const listeningAt = Date.now();
  evidence.listeningAt = new Date(listeningAt).toISOString();
  await expect.poll(() => page.evaluate(() => window.__issue41PcmCount)).toBeGreaterThan(0);
  await expect.poll(async () => (await dbRows('sessions', `select=id,meeting_id,segment_id&meeting_id=eq.${meetingId}`)).length).toBeGreaterThan(0);
  evidence.sessions = await dbRows('sessions', `select=id,meeting_id,segment_id&meeting_id=eq.${meetingId}`);

  const emitCue = async (source, translation, segmentId) => {
    await page.evaluate(({ sourceText, translatedText }) => {
      window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({ serverContent: {
        inputTranscription: { text: sourceText }, outputTranscription: { text: translatedText }, turnComplete: true
      } });
    }, { sourceText: source, translatedText: translation });
    await expect.poll(async () => (await cueRows(segmentId)).find((row) =>
      row.source_text === source && row.translated_text === translation) || null,
    { timeout: 30_000 }).not.toBeNull();
    const row = (await cueRows(segmentId)).find((item) => item.source_text === source);
    expect(row.segment_id).toBe(segmentId);
    expect(Number.isSafeInteger(row.sequence)).toBe(true);
    await expect(viewer.getByTestId('meeting-viewer-cue-row').filter({ hasText: source }))
      .toContainText(translation, { timeout: 30_000 });
    evidence.cues.push({ id: row.id, sessionId: row.session_id, segmentId: row.segment_id,
      sequence: row.sequence, source, translation });
    evidence.viewer.push({ segmentId, source, translation, receivedAt: new Date().toISOString() });
    save();
    return row;
  };
  const first = await emitCue('issue41 before rollover', 'issue41 first translation', created.segment.id);
  if (!shortValidation) {
    const firstNext = await emitCue('issue41 before rollover again', 'issue41 next translation', created.segment.id);
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
    expect(second.segment_id).not.toBe(first.segment_id);
    const secondNext = await emitCue('issue41 after rollover again', 'issue41 continuing translation', next.id);
    expect(secondNext.sequence).toBeGreaterThan(second.sequence);
    await expect.poll(() => Date.now() - listeningAt, { timeout: 6 * 60_000, intervals: [30_000] }).toBeGreaterThanOrEqual(20 * 60_000);
    evidence.elapsedMs = Date.now() - listeningAt;
  }
  evidence.segments = (await segments(meetingId)).map((row) => ({ id: row.id, sequence: row.sequence,
    status: row.status, checkpointRevision: row.checkpoint?.revision ?? null }));
  expect(evidence.segments[0].checkpointRevision).not.toBeNull();
  evidence.pcm = await page.evaluate(() => ({ callbacks: window.__issue41PcmCount,
    processorCounts: window.__issue41ProcessorCounts, maxGapMs: window.__issue41MaxPcmGapMs,
    lastCallbackAgeMs: Date.now() - window.__issue41LastPcmAt }));
  expect(evidence.pcm.callbacks).toBeGreaterThan(0);
  if (!shortValidation) {
    expect(evidence.pcm.callbacks).toBeGreaterThan(1000);
    expect(evidence.pcm.maxGapMs).toBeLessThan(10_000);
    expect(evidence.pcm.lastCallbackAgeMs).toBeLessThan(5_000);
  }
  await page.getByRole('button', { name: '結束會議' }).click();
  await expect.poll(() => page.evaluate(() => ({ tracks: window.__issue41Tracks.filter((track) => !track.stopped).length,
    contexts: window.__issue41Contexts.filter((context) => context.state !== 'closed').length,
    providers: window.__mockGoogleGenAI.liveSessions.filter((session) => !session.closed).length }))).toEqual({ tracks: 0, contexts: 0, providers: 0 });
  evidence.resourcesReleased = true;
  evidence.result = shortValidation ? 'SHORT_VALIDATION_PASS_NO_ROLLOVER_CLAIM' : 'REAL_TIME_SOAK_PASS';
  evidence.finishedAt = new Date().toISOString();
  save();
  await viewer.close();
});
