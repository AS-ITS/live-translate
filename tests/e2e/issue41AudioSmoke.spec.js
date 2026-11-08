import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installE2EAuth, localE2EAuthSession } from './authBootstrap.js';
import { attachPauseDiagnostics, createPauseDiagnostics, pauseUiState, summarizePauseDiagnostics, writePauseArtifact } from './issue41PauseDiagnostics.js';
import { attachCueMutationDiagnostics, createCueMutationDiagnostics, writeCueMutationArtifact } from './issue41CueMutationDiagnostics.js';
import { observeViewerUpdate, viewerUpdateTimeline } from './issue41ViewerUpdateContract.js';
import { classifyViewerAppend, viewerAppendTimeline } from './issue41ViewerAppendContract.js';
import { observeViewerFinalState, readViewerCueStore } from './issue41ViewerFinalStateContract.js';
import { installHostViewerHarness } from './hostViewerHarness.js';

const pauseDiagnosticsByPage = new WeakMap();
const cueMutationDiagnosticsByPage = new WeakMap();
test.afterEach(async ({ page }, testInfo) => {
  if (!testInfo.title.includes('real Gemini audio')) return;
  const diagnostics = pauseDiagnosticsByPage.get(page);
  if (!diagnostics) return;
  const uiState = await pauseUiState(page).catch(() => ({ unavailable: true }));
  writePauseArtifact(testInfo.outputPath('pause-diagnostics.json'), diagnostics, uiState, testInfo.status);
  if (evidencePath) writePauseArtifact(join(dirname(evidencePath), 'pause-diagnostics.json'),
    diagnostics, uiState, testInfo.status);
  const cueMutations = cueMutationDiagnosticsByPage.get(page) || [];
  writeCueMutationArtifact(testInfo.outputPath('cue-mutation-diagnostics.json'), cueMutations, testInfo.status);
  if (evidencePath) writeCueMutationArtifact(join(dirname(evidencePath), 'cue-mutation-diagnostics.json'),
    cueMutations, testInfo.status);
});

const evidencePath = process.env.ISSUE41_EVIDENCE_FILE;
const save = (value, path = evidencePath) => { if (path) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

test('issue41 Viewer Store reader observes committed snapshot and update', async ({ page }) => {
  const cue = { cueId: 'cue-1', meetingId: 'meeting-local', sessionId: 'session-1',
    segmentId: 'segment-1', sequence: 1, status: 'final', sourceText: 'source',
    translatedText: 'translation', sourceVersion: 1, translationVersion: 1 };
  await installHostViewerHarness(page, { code: 'LOCALONLY', meetingId: cue.meetingId,
    lifecycle: { lifecycleContractVersion: 2, recordingState: 'waiting', cloudStatus: 'created' },
    cues: [cue] });
  await page.goto('/#viewer?code=LOCALONLY');
  await expect.poll(async () => {
    const store = await page.evaluate(readViewerCueStore);
    return store.available && store.cues?.find((item) => item.cueId === cue.cueId)?.sourceVersion === 1
      ? store.hostCursor?.sequence : null;
  }).toBe(1);
  await page.evaluate((updated) => window.__hostPublish(updated, 'cue.update'),
    { ...cue, sourceText: 'updated', sourceVersion: 2 });
  await expect.poll(async () => {
    const store = await page.evaluate(readViewerCueStore);
    const actual = store.cues?.find((item) => item.cueId === cue.cueId);
    return store.available && actual?.sourceText === 'updated' && actual.sourceVersion === 2
      ? store.hostCursor?.sequence : null;
  }).toBe(2);
});

test('issue41 virtual microphone produces timed non-silent PCM', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto('/');
  const pcm = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioContext({ sampleRate: 16000 });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    const { createMicrophoneRecordingController } = await import('/src/lib/microphoneRecording.js');
    const recorder = createMicrophoneRecordingController();
    const recordingStart = await recorder.start({ stream });
    const startedAt = performance.now();
    let frames = 0;
    let voicedFrames = 0;
    let peak = 0;
    processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      frames += samples.length;
      for (const sample of samples) {
        const absolute = Math.abs(sample);
        if (absolute > 0.01) voicedFrames += 1;
        peak = Math.max(peak, absolute);
      }
    };
    await new Promise((resolve) => setTimeout(resolve, 4500));
    const endedAt = performance.now();
    const recording = await recorder.finalize();
    processor.disconnect();
    source.disconnect();
    sink.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    return { elapsedMs: Math.round(endedAt - startedAt), sampleRate: context.sampleRate,
      frames, voicedFrames, peak: Number(peak.toFixed(4)),
      recorderStarted: recordingStart.status === 'recording',
      recorderStatus: recording.status, recorderBytes: recording.blob?.size || 0,
      tracksStopped: stream.getTracks().every((track) => track.readyState === 'ended') };
  });
  expect(pcm.sampleRate).toBe(16000);
  expect(pcm.elapsedMs).toBeGreaterThanOrEqual(4000);
  expect(pcm.frames).toBeGreaterThan(32000);
  expect(pcm.voicedFrames).toBeGreaterThan(1000);
  expect(pcm.peak).toBeGreaterThan(0.03);
  expect(pcm.recorderStarted).toBe(true);
  expect(pcm.recorderStatus).toBe('ready');
  expect(pcm.recorderBytes).toBeGreaterThan(0);
  expect(pcm.tracksStopped).toBe(true);
  save({ mode: 'LOCAL_VIRTUAL_MIC', VIRTUAL_MIC_VERDICT: 'PASS', pcm },
    process.env.ISSUE41_VIRTUAL_MIC_EVIDENCE_FILE);
});

test('issue41 real Gemini audio reaches local Cue and Viewer', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const pauseDiagnostics = createPauseDiagnostics();
  pauseDiagnosticsByPage.set(page, pauseDiagnostics);
  attachPauseDiagnostics(page, pauseDiagnostics);
  const cueMutationDiagnostics = createCueMutationDiagnostics();
  cueMutationDiagnosticsByPage.set(page, cueMutationDiagnostics);
  attachCueMutationDiagnostics(page, cueMutationDiagnostics);
  const auth = localE2EAuthSession();
  expect(auth).toBeTruthy();
  const key = process.env.ISSUE41_TEST_GEMINI_KEY;
  expect(key).toMatch(/^AIza[\w-]{20,}$/u);
  const environment = new URL(process.env.SUPABASE_URL);
  expect(environment.hostname).toBe('127.0.0.1');
  expect(process.env.VITE_SUPABASE_URL).toBe(environment.origin);
  const evidence = { mode: 'REAL_GEMINI_AUDIO_SMOKE', startedAt: new Date().toISOString(),
    lateFinal: 'NOT_OBSERVED', nonPrefixRevision: 'NOT_OBSERVED', checks: {}, events: [] };
  const trace = async () => page.evaluate(async () => {
    const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
    const safe = (value) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(String(value || '')) ? value : null;
    const safeSourceId = (value) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(String(value || '')) ? value : null;
    return livePipelineTrace.get().map((event) => ({
    stage: safe(event.stage), timestamp: event.timestamp, cueId: safe(event.cueId), sourceId: safeSourceId(event.sourceId), providerEventId: safe(event.providerEventId),
      eventType: safe(event.eventType), messageType: safe(event.messageType), eventSequence: event.eventSequence,
      sourceVersion: event.sourceVersion, translationVersion: event.translationVersion,
      reason: safe(event.reason), dropReason: safe(event.dropReason), decision: safe(event.decision),
      sourceStatus: safe(event.sourceStatus), translationStatus: safe(event.translationStatus),
      sourceTextLength: event.sourceTextLength, translationTextLength: event.translationTextLength,
      beforeSourceTextLength: event.beforeSourceTextLength, afterSourceTextLength: event.afterSourceTextLength,
      beforeTranslationTextLength: event.beforeTranslationTextLength,
      afterTranslationTextLength: event.afterTranslationTextLength,
      sequence: event.sequence, revision: event.revision, snapshotRevision: event.snapshotRevision,
      signalingCursorAfter: event.signalingCursorAfter, persistenceState: safe(event.persistenceState),
      pcmBytes: event.pcmBytes, pcmSampleCount: event.pcmSampleCount,
      pcmCaptureTimestampMs: event.pcmCaptureTimestampMs, transportResult: safe(event.transportResult),
      httpStatus: event.httpStatus, errorCode: safe(event.errorCode)
    }));
  });
  const local = async (meetingId) => page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const [cues, checkpoints, recording] = await Promise.all([
      store.listCues(id), store.listCheckpoints(id), store.getRecording(id)
    ]);
    return { cues: cues.map(({ cue }) => ({ cueId: cue.cueId, sequence: cue.sequence, status: cue.status,
      sourceLength: (cue.sourceText || '').length, translationLength: (cue.translatedText || '').length,
      sourceVersion: cue.sourceVersion, translationVersion: cue.translationVersion })),
    checkpoints: checkpoints.map((row) => ({ segmentId: row.segmentId, revision: row.checkpoint?.revision,
      cursor: row.checkpoint?.cursor })), recordingState: recording?.state };
  }, meetingId);
  const readHostCues = async (meetingId) => page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const { hostViewerCuesFromLocalRecords } = await import('/src/webrtc/useWebRtcDeviceSidecar.js');
    const records = await createIndexedDbLocalMeetingManifestStore().listCues(id);
    return hostViewerCuesFromLocalRecords(id, records);
  }, meetingId);
  const headers = { Authorization: `Bearer ${auth.token}` };
  const api = async (method, path, data) => {
    const response = await page.request.fetch(`/api${path}`, { method, headers, data });
    const body = await response.json();
    expect(response.ok(), `${method} ${path}: HTTP ${response.status()} ${body?.error?.code || ''}`).toBe(true);
    return body;
  };
  let viewer;
  try {
    await installE2EAuth(page);
    const created = await api('POST', '/meetings', { draft: true, name: `Issue 41 audio ${Date.now()}`,
      sourceLanguageCode: 'en', targetLanguageCode: 'zh-Hant', echoTargetLanguage: false,
      shouldRecordInputAudio: true });
    const meetingId = created.meeting.id;
    const share = await api('POST', `/meetings/${meetingId}/shares`, { role: 'viewer' });
    evidence.meetingId = meetingId;
    await page.goto('/#meetings');
    expect(await page.evaluate(async () => (await import('/src/lib/supabaseAuth.js')).supabase?.supabaseUrl))
      .toBe(environment.origin);
    await page.evaluate((id) => sessionStorage.setItem(`live-translate:meeting-audio:${id}`, JSON.stringify({
      inputDeviceId: '', outputDeviceId: '', inputDeviceLabel: 'Chromium WAV',
      outputDeviceLabel: 'Browser default', permissionStatus: 'confirmed', confirmedAt: new Date().toISOString()
    })), meetingId);
    await page.goto(`/#live?meetingId=${meetingId}`);
    await expect(page.getByTestId('live-session-toolbar')).toContainText(created.meeting.name);
    await page.evaluate(() => { window.location.hash = '#settings'; });
    await page.getByRole('textbox', { name: 'Gemini API Key' }).fill(key);
    await page.getByRole('button', { name: '設定金鑰' }).click();
    await page.evaluate((id) => { window.location.hash = `#live?meetingId=${id}`; }, meetingId);
    await expect(page.getByRole('button', { name: '開始錄製' })).toBeEnabled();
    await page.evaluate(async () => (await import('/src/lib/livePipelineTrace.js')).livePipelineTrace.setEnabled(true));
    viewer = await browser.newPage();
    await viewer.goto(`/${share.url || share.codeUrl}`);
    await viewer.evaluate(async () => (await import('/src/lib/livePipelineTrace.js')).livePipelineTrace.setEnabled(true));
    const captureStartedAt = Date.now();
    await page.getByRole('button', { name: '開始錄製' }).click();
    await expect(page.getByRole('button', { name: '停止錄音' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await local(meetingId)).cues.filter((cue) =>
      cue.sourceLength > 0 && cue.translationLength > 0 && cue.status === 'final').length,
    { timeout: 75_000 }).toBeGreaterThan(0);
    const captureEndedAt = Date.now();
    expect(captureEndedAt - captureStartedAt).toBeGreaterThanOrEqual(4000);
    evidence.capture = { startedAt: new Date(captureStartedAt).toISOString(),
      endedAt: new Date(captureEndedAt).toISOString(), elapsedMs: captureEndedAt - captureStartedAt };
    evidence.beforeStop = await local(meetingId);
    evidence.events = await trace();
    expect(evidence.events.some((event) => event.stage === 'PCM_SENT' && event.pcmBytes > 0)).toBe(true);
    expect(evidence.events.some((event) => event.stage === 'PROVIDER_EVENT')).toBe(true);
    expect(evidence.events.some((event) => event.stage === 'CUE_FINALIZED')).toBe(true);
    expect(evidence.events.some((event) => event.stage === 'LOCAL_CUE_SAVED')).toBe(true);
    expect(evidence.events.some((event) => event.stage === 'VIEWER_PUBLISH_SUCCEEDED')).toBe(true);
    const readViewerEvents = async () => viewer.evaluate(async () => {
      const { livePipelineTrace } = await import('/src/lib/livePipelineTrace.js');
      return livePipelineTrace.get().filter((entry) => entry.stage === 'VIEWER_STORE_UPDATED')
        .map((entry) => ({ stage: entry.stage, timestamp: entry.timestamp, messageType: entry.messageType,
          sequence: entry.sequence, decision: entry.decision, transportResult: entry.transportResult }));
    });
    const recordViewerUpdate = async (hostEvents) => {
      const observation = await observeViewerUpdate({ hostEvents, readViewerEvents });
      evidence.viewerEvents = observation.viewerEvents;
      evidence.viewerUpdateContract = {
        hostUpdatePublished: observation.hostUpdatePublished,
        viewerUpdateReceived: observation.viewerUpdateReceived,
        verdict: observation.verdict,
        publishedSequences: observation.publishedSequences,
        missingSequences: observation.missingSequences,
        timeline: viewerUpdateTimeline(hostEvents, observation.viewerEvents)
      };
      evidence.VIEWER_UPDATE_CONTRACT_VERDICT = observation.verdict;
      evidence.checks.viewerUpdate = observation.verdict;
    };
    await recordViewerUpdate(evidence.events);
    const recordViewerAppend = async (hostEvents) => {
      const viewerEvents = await readViewerEvents();
      const observation = classifyViewerAppend(hostEvents, viewerEvents);
      evidence.viewerAppendContract = {
        hostAppendPublished: observation.hostAppendPublished,
        viewerAppendReceived: observation.viewerAppendReceived,
        verdict: observation.verdict,
        publishedSequences: observation.publishedSequences,
        missingSequences: observation.missingSequences,
        firstFailureStage: observation.firstFailureStage,
        timeline: viewerAppendTimeline(hostEvents, viewerEvents)
      };
    };
    await expect(viewer.locator('body')).toContainText(/字幕|翻譯/u);
    evidence.checks.viewerLive = 'PASS';
    await page.getByRole('button', { name: '停止錄音' }).click();
    try {
      await expect(page.getByRole('button', { name: '結束會議' })).toBeEnabled({ timeout: 30_000 });
    } catch (error) {
      const uiState = await pauseUiState(page).catch(() => ({ unavailable: true }));
      evidence.pauseTimeout = summarizePauseDiagnostics(pauseDiagnostics, uiState);
      console.info('ISSUE41_PAUSE_TIMEOUT', JSON.stringify(evidence.pauseTimeout));
      throw error;
    }
    await recordViewerUpdate(await trace());
    const hostEventsAtPause = await trace();
    await recordViewerAppend(hostEventsAtPause);
    evidence.viewerFinalStateContract = await observeViewerFinalState({
      hostEvents: hostEventsAtPause,
      readHostEvents: trace,
      readHostCues: () => readHostCues(meetingId),
      readViewerStore: () => viewer.evaluate(readViewerCueStore),
      readViewerEvents
    });
    evidence.SNAPSHOT_RECOVERY_CONTRACT_VERDICT = evidence.viewerFinalStateContract.verdict;
    evidence.SNAPSHOT_COVERS_MISSING_APPEND = evidence.viewerFinalStateContract.snapshotCoversMissingAppend;
    evidence.VIEWER_FINAL_STATE_MATCH = evidence.viewerFinalStateContract.verdict === 'PASS';
    evidence.checks.viewerFinalState = evidence.viewerFinalStateContract.verdict;
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '結束會議' }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 30_000 })
      .toBe(`#meeting-detail?meetingId=${encodeURIComponent(meetingId)}&from=history`);
    await recordViewerUpdate(await trace());
    await page.reload();
    const afterReload = await local(meetingId);
    expect(afterReload.cues.length).toBeGreaterThanOrEqual(evidence.beforeStop.cues.length);
    expect(afterReload.cues.some((cue) => cue.sourceLength > 0 && cue.translationLength > 0)).toBe(true);
    evidence.afterReload = afterReload;
  await expect(page.getByRole('heading', { name: created.meeting.name })).toBeVisible();
    const exportNav = page.getByRole('navigation', { name: '會議內容目錄' });
    await exportNav.getByRole('button', { name: '匯出' }).click();
  const exportPanel = page.getByRole('region', { name: '本機字幕匯出' });
  await expect(exportPanel.getByRole('button', { name: '開始匯出' })).toBeEnabled();
  const expectedExport = await page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const { exportCuesToTxt } = await import('/src/lib/subtitleCueExport.js');
    const records = await createIndexedDbLocalMeetingManifestStore().listCues(id);
    return exportCuesToTxt(records.map((record) => record.cue), { stream: 'translation' });
  }, meetingId);
    const downloadPromise = page.waitForEvent('download');
  await exportPanel.getByRole('button', { name: '開始匯出' }).click();
    const download = await downloadPromise;
    const exported = readFileSync(await download.path());
  expect(exported.toString('utf8')).toBe(expectedExport);
    evidence.export = { bytes: exported.length, sha256: createHash('sha256').update(exported).digest('hex') };
    evidence.checks.sourceTranslationFinal = 'PASS';
    evidence.checks.writerAck = 'PASS';
    evidence.checks.reloadLocal = 'PASS';
    evidence.checks.export = 'PASS';
    expect(evidence.checks.viewerFinalState).toBe('PASS');
    expect(evidence.viewerUpdateContract.verdict).not.toBe('FAIL');
    expect(cueMutationDiagnostics).toEqual([]);
    expect((await trace()).filter((event) =>
      /local_cue_revision_conflict|versioned_state_regression|persistence/i
        .test(`${event.reason || ''} ${event.dropReason || ''} ${event.errorCode || ''}`))).toEqual([]);
    evidence.REAL_GEMINI_AUDIO_SMOKE_VERDICT = 'PASS';
  } finally {
    if (page && !page.isClosed()) {
      const latest = await trace().catch(() => []);
      if (latest.length > evidence.events.length) evidence.events = latest;
    }
    evidence.conflicts = evidence.events.filter((event) =>
      /local_cue_revision_conflict|versioned_state_regression|persistence/i
        .test(`${event.reason || ''} ${event.dropReason || ''} ${event.errorCode || ''}`));
    save(evidence);
    await viewer?.close();
  }
});
