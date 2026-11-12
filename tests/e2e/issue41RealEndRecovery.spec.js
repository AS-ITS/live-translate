import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { serializeEffectiveGlossary } from '../../src/lib/glossaryRevision.js';
import { installE2EAuth, localE2EAuthSession } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  const auth = localE2EAuthSession();
  expect(auth, 'an isolated Local Supabase user is required').toBeTruthy();
  expect(process.env.ISSUE41_ISOLATED_SUPABASE_URL).toBe(process.env.SUPABASE_URL);
  expect(new URL(process.env.SUPABASE_URL).hostname).toBe('127.0.0.1');
  await page.addInitScript(() => {
    window.__mockMicTracks = [];
    window.__mockAudioContexts = [];
    window.__mockAudioProcessors = [];
    window.__mockMediaRecorders = [];
    window.__mockLiveConnectDelayMs = 0;

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (window.__mockMissingMicrophone) {
            throw new DOMException('No microphone device found', 'NotFoundError');
          }
          const track = {
            kind: 'audio',
            enabled: true,
            readyState: 'live',
            stopped: false,
            listeners: new Map(),
            stop() {
              this.stopped = true;
              this.readyState = 'ended';
            },
            addEventListener(event, handler) {
              this.listeners.set(event, handler);
            },
            removeEventListener(event, handler) {
              if (this.listeners.get(event) === handler) this.listeners.delete(event);
            },
            emit(event) {
              this.listeners.get(event)?.();
            }
          };
          window.__mockMicTracks.push(track);
          return {
            active: true,
            getTracks: () => [track]
          };
        }
      }
    });

    class MockAudioContext {
      constructor() {
        this.sampleRate = 16000;
        this.currentTime = 0;
        this.destination = {};
        this.state = 'running';
        this.resumeCalls = 0;
        window.__mockAudioContexts.push(this);
      }

      async resume() {
        this.resumeCalls += 1;
        this.state = 'running';
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createScriptProcessor() {
        const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        window.__mockAudioProcessors.push(processor);
        return processor;
      }

      createBuffer() {
        return {
          duration: 0,
          copyToChannel() {}
        };
      }

      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          disconnect() {},
          start() {
            this.onended?.();
          },
          stop() {},
          onended: null
        };
      }

      async close() {
        this.state = 'closed';
      }
    }

    window.AudioContext = MockAudioContext;
    window.webkitAudioContext = MockAudioContext;

    class MockMediaRecorder {
      static isTypeSupported(mimeType) {
        return mimeType === 'audio/webm;codecs=opus' || mimeType === 'audio/webm';
      }

      constructor(stream, options = {}) {
        this.stream = stream;
        sessionStorage.setItem('__issue41RecorderConstructions', String(
          Number(sessionStorage.getItem('__issue41RecorderConstructions') || 0) + 1
        ));
        this.mimeType = options.mimeType || 'audio/webm';
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onerror = null;
        this.onstop = null;
        window.__mockMediaRecorders.push(this);
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        const tracks = typeof this.stream?.getTracks === 'function' ? this.stream.getTracks() : [];
        if (!tracks.every((track) => track.stopped)) {
          this.ondataavailable?.({
            data: new Blob([`audio-${window.__mockMediaRecorders.length}`], { type: this.mimeType })
          });
        }
        this.onstop?.({});
      }

      emitError(message = 'mock recorder error') {
        this.onerror?.({ error: new Error(message) });
      }
    }

    window.MediaRecorder = MockMediaRecorder;
  });

  await page.route('**/api/live-token', async (route) => {
    const body = route.request().postDataJSON() || {};
    const lifecycleVersion = Number(route.request().headers()['x-meeting-lifecycle-version']);
    const effectiveGlossaryRevision = createHash('sha256').update(serializeEffectiveGlossary({
      sourceLanguageCode: body.sourceLanguageCode,
      targetLanguageCode: body.targetLanguageCode,
      entries: []
    })).digest('hex');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      token: 'mock-local-e2e-token', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      liveConnectModel: 'gemini-live-e2e-model', liveConnectConfig: {},
      liveGlossaryEntries: [], effectiveGlossaryRevision, glossaryEntryCount: 0,
      authoritativeSegment: { meetingId: body.meetingId, sessionId: body.sessionId,
        segmentId: body.segmentId, lifecycleVersion }
    }) });
  });
  await installE2EAuth(page);
});

async function emitMicrophoneAudio(page, sampleValue = 0.25) {
  await page.evaluate((value) => {
    const processor = window.__mockAudioProcessors.at(-1);
    processor?.onaudioprocess?.({
      inputBuffer: {
        getChannelData() {
          return new Float32Array(1600).fill(value);
        }
      }
    });
  }, sampleValue);
}

async function verifyRealApiEndRetry(page, { responseLost }) {
  const auth = localE2EAuthSession();
  const supabaseUrl = process.env.ISSUE41_ISOLATED_SUPABASE_URL;
  expect(auth).toBeTruthy();
  expect(supabaseUrl).toBe(process.env.SUPABASE_URL);
  expect(new URL(supabaseUrl).hostname).toBe('127.0.0.1');
  const authHeaders = { Authorization: `Bearer ${auth.token}` };
  const dbHeaders = {
    apikey: process.env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`
  };
  const dbRows = async (table, query) => {
    const response = await page.request.get(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: dbHeaders });
    expect(response.ok(), `Supabase ${table}: ${response.status()}`).toBe(true);
    return response.json();
  };
  const meetingRow = async (id) => {
    const rows = await dbRows('meetings', `select=id,status,ended_at,lifecycle_version,purge_at&id=eq.${id}`);
    expect(rows).toHaveLength(1);
    return rows[0];
  };
  const created = await page.request.post('/api/meetings', {
    headers: authHeaders,
    data: { draft: true, name: `B2-L End ${responseLost ? 'lost' : '503'} ${Date.now()}`,
      sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', shouldRecordInputAudio: true }
  });
  expect(created.status(), await created.text()).toBe(201);
  const { meeting } = await created.json();
  expect(meeting.lifecycleContractVersion).toBe(2);
  const meetingId = meeting.id;
  try {
  const listResponse = await page.request.get('/api/meetings', { headers: authHeaders });
  expect(listResponse.status()).toBe(200);
  expect((await listResponse.json()).some((row) => row.id === meetingId)).toBe(true);
  const initial = await meetingRow(meetingId);
    const shareResponse = await page.request.post(`/api/meetings/${meetingId}/shares`, {
      headers: authHeaders, data: { role: 'viewer' }
    });
    expect(shareResponse.status(), await shareResponse.text()).toBe(201);
    const { share } = await shareResponse.json();
    const viewerMetadataUrl = `/api/shared-meetings/${encodeURIComponent(share.token)}/metadata`;
    const initialMetadataResponse = await page.request.get(viewerMetadataUrl);
    expect(initialMetadataResponse.status()).toBe(200);
    const initialMetadata = await initialMetadataResponse.json();
    expect(initialMetadata.meeting.lifecycleVersion).toBe(initial.lifecycle_version);
  let completeRequests = 0;
  let releaseRetry;
  const retryReleased = new Promise((resolve) => { releaseRetry = resolve; });
  await page.route(`**/api/meetings/${meetingId}/complete`, async (route) => {
    completeRequests += 1;
    if (completeRequests === 1) {
      if (responseLost) {
        const committed = await route.fetch();
        expect(committed.status()).toBe(200);
      }
      await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'injected_end_response_failure' } }) });
      return;
    }
    await retryReleased;
    await route.fallback();
  });

  await page.goto('/#settings');
  await page.getByRole('textbox', { name: 'Gemini API Key' }).fill('test-api-key');
  await page.getByRole('button', { name: '設定金鑰' }).click();
  await expect.poll(async () =>
    await page.getByText('已設定', { exact: true }).isVisible().catch(() => false)
    || !/#settings$/u.test(page.url())
  ).toBe(true);
  await page.goto('/#meetings');
  await expect(page.getByText(meeting.name)).toBeVisible();
  await page.evaluate((id) => {
    sessionStorage.setItem(`live-translate:meeting-audio:${id}`, JSON.stringify({
      inputDeviceId: '', outputDeviceId: '', inputDeviceLabel: '瀏覽器預設麥克風',
      outputDeviceLabel: '瀏覽器預設揚聲器', permissionStatus: 'confirmed',
      confirmedAt: new Date().toISOString()
    }));
    window.location.hash = `#live?meetingId=${id}`;
  }, meetingId);
  await expect(page.getByRole('button', { name: '開始錄製', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '開始錄製', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mockAudioProcessors.length)).toBe(1);
  await emitMicrophoneAudio(page);
  await expect(page.getByText('聆聽中')).toBeVisible();
  expect(await page.evaluate(() => window.__mockMediaRecorders.length)).toBe(1);
  const recorderConstructions = await page.evaluate(() =>
    Number(sessionStorage.getItem('__issue41RecorderConstructions')));

  const readLocal = () => page.evaluate(async (id) => {
    const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const restored = await createLocalMeetingPersistence().restore(id);
    const retention = await createIndexedDbLocalMeetingManifestStore().getRetention(id);
    const root = await navigator.storage.getDirectory();
    const journal = await (await (await root.getDirectoryHandle('pcm-journals')).getDirectoryHandle('v1'))
      .getDirectoryHandle(id);
    let pcmBytes = 0;
    for await (const [, recording] of journal.entries()) {
      for await (const [, file] of recording.entries()) {
        if (file.kind === 'file') pcmBytes += (await file.getFile()).size;
      }
    }
    return { state: restored.recording.state, segmentId: restored.recording.segmentId,
      chunks: restored.chunks.map(({ state, segmentId, byteSize }) => ({ state, segmentId, byteSize })),
      pending: retention?.pendingCompletion, expiresAt: retention?.expiresAt, pcmBytes };
  }, meetingId);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '結束會議' }).click();
  await expect.poll(() => completeRequests).toBe(1);
  await expect.poll(async () => (await readLocal()).pending).toBeTruthy();
  const sealed = await readLocal();
  expect(sealed.state).toBe('stopped_local');
  expect(sealed.pcmBytes).toBeGreaterThan(0);
  expect(sealed.chunks.some((chunk) => chunk.state === 'sealed' && chunk.byteSize > 0)).toBe(true);
  expect(Date.parse(sealed.expiresAt) - Date.parse(sealed.pending.sealedAt)).toBe(30 * 60 * 1000);
  const afterFirst = await meetingRow(meetingId);
  expect(afterFirst.status === 'completed').toBe(responseLost);
  console.log('B2_L_END_AFTER_FIRST', JSON.stringify({ responseLost, meetingId, initialVersion: initial.lifecycle_version, ...afterFirst }));

  await page.reload();
  await expect.poll(() => completeRequests).toBe(2);
  const pendingAfterReload = await readLocal();
  expect(pendingAfterReload.pending).toEqual(sealed.pending);
  expect(pendingAfterReload.expiresAt).toBe(sealed.expiresAt);
  releaseRetry();
  await expect.poll(async () => (await readLocal()).pending).toBeFalsy();
  const final = await meetingRow(meetingId);
  expect(final.status).toBe('completed');
  expect(final.ended_at).toBeTruthy();
    const completedMetadataResponse = await page.request.get(viewerMetadataUrl);
    expect(completedMetadataResponse.status()).toBe(200);
    const completedMetadata = await completedMetadataResponse.json();
    expect(completedMetadata.meeting.status).toBe('completed');
    expect(completedMetadata.meeting.lifecycleVersion).toBe(final.lifecycle_version);
    expect(completedMetadata.meeting.lifecycleVersion).toBe(initialMetadata.meeting.lifecycleVersion + 1);
  console.log('B2_L_END_FINAL', JSON.stringify({ responseLost, meetingId, ...final }));
  if (responseLost) expect(final.ended_at).toBe(afterFirst.ended_at);
  else expect(afterFirst.ended_at).toBeNull();
  expect(Date.parse(final.purge_at) - Date.parse(final.ended_at)).toBe(30 * 60_000);
  const completedLocal = await readLocal();
  expect(completedLocal.state).toBe('stopped_local');
  expect(completedLocal.segmentId).toBe(sealed.segmentId);
  expect(completedLocal.chunks).toEqual(sealed.chunks);
  expect(completedLocal.expiresAt).toBe(sealed.expiresAt);
  expect(await page.evaluate(() => window.__mockMediaRecorders.length)).toBe(0);
  expect(await page.evaluate(() => Number(sessionStorage.getItem('__issue41RecorderConstructions'))))
    .toBe(recorderConstructions);
  // A Cue requires a Session; both Session and Segment rows must stay absent for this Meeting.
  for (const table of ['sessions', 'meeting_segments', 'meeting_events',
    'audio_artifacts', 'export_artifacts']) {
    expect(await dbRows(table, `select=id&meeting_id=eq.${meetingId}`), table).toEqual([]);
  }
  const repeat = await page.request.post(`/api/meetings/${meetingId}/complete`, { headers: authHeaders });
  expect(repeat.status()).toBe(200);
  const idempotent = await meetingRow(meetingId);
  expect(idempotent.lifecycle_version).toBe(final.lifecycle_version);
  expect(idempotent.ended_at).toBe(final.ended_at);
  expect(idempotent.purge_at).toBe(final.purge_at);
  expect(completeRequests).toBe(2);
  expect(afterFirst.lifecycle_version).toBe(initial.lifecycle_version + (responseLost ? 1 : 0));
  expect(final.lifecycle_version).toBe(initial.lifecycle_version + 1);
  } finally {
    const cleanup = await page.request.delete(
      `${supabaseUrl}/rest/v1/meetings?id=eq.${meetingId}&owner_user_id=eq.${auth.profile.id}`,
      { headers: dbHeaders }
    );
    if (!cleanup.ok()) console.warn('B2_L_END_CLEANUP_FAILED', meetingId, cleanup.status());
  }
}

test('B2-L real API End retry after uncommitted 503', async ({ page }) => {
  test.skip(process.env.ISSUE41_FINAL_GATE !== 'true');
  await verifyRealApiEndRetry(page, { responseLost: false });
});

test('B2-L real API End retry after committed response loss', async ({ page }) => {
  test.skip(process.env.ISSUE41_FINAL_GATE !== 'true');
  await verifyRealApiEndRetry(page, { responseLost: true });
});
