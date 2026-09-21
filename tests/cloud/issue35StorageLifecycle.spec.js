import { test, expect, request as playwrightRequest } from '@playwright/test';
import { Upload } from 'tus-js-client';

function uniqueName() {
  return `codex-issue35-storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function uploadTus(upload, bytes) {
  await new Promise((resolve, reject) => {
    const tusUpload = new Upload(bytes, {
      endpoint: upload.uploadEndpoint,
      uploadSize: bytes.length,
      chunkSize: bytes.length,
      retryDelays: [0, 1000, 3000],
      headers: {
        Authorization: `Bearer ${process.env.CLOUD_TEST_ACCESS_TOKEN}`,
        'x-upsert': 'true'
      },
      metadata: {
        bucketName: upload.bucket,
        objectName: upload.objectPath,
        contentType: 'audio/webm',
        cacheControl: '3600'
      },
      onError: reject,
      onSuccess: resolve
    });
    tusUpload.start();
  });
}

test('owner-only audio and export lifecycle cleans up with Meeting deletion', async ({ request }) => {
  test.setTimeout(90_000);
  const created = await request.post('/api/meetings', {
    data: { draft: true, name: uniqueName(), sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' }
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json();
  const meetingId = createdBody.meeting?.id;
  const segmentId = createdBody.segment?.id;
  expect(meetingId).toBeTruthy();
  expect(segmentId).toBeTruthy();

  try {
    const cue = await request.post(`/api/meetings/${meetingId}/segments/${segmentId}/cues`, {
      data: {
        sessionId: `issue35-storage-session-${meetingId}`,
        producedAt: 0,
        cue: {
          cueId: `cue:issue35:${segmentId}:1`,
          sessionId: `issue35-storage-session-${meetingId}`,
          segmentId,
          sequence: 1,
          startTimeMs: 0,
          endTimeMs: 1000,
          sourceLanguageCode: 'zh-Hant',
          targetLanguageCode: 'en',
          sourceText: 'Issue 35 lifecycle source',
          translatedText: 'Issue 35 lifecycle translation',
          status: 'final'
        }
      }
    });
    expect(cue.status()).toBe(201);
    await cue.text();

    const audioStart = await request.post(`/api/meetings/${meetingId}/segments/${segmentId}/audio-uploads`, {
      data: { mimeType: 'audio/webm', byteSize: 4 }
    });
    expect(audioStart.status()).toBe(201);
    const upload = await audioStart.json();
    const bytes = Buffer.from([0, 1, 2, 3]);
    await uploadTus(upload, bytes);

    const complete = await request.post(`/api/meetings/${meetingId}/audio-artifacts/${upload.id}/complete`);
    expect(complete.status()).toBe(200);
    const artifact = await complete.json();
    expect(artifact.status).toBe('ready');

    const ownerDownload = await request.post(`/api/meetings/${meetingId}/audio-artifacts/${upload.id}/download-url`);
    expect(ownerDownload.status()).toBe(200);
    expect((await ownerDownload.json()).downloadUrl).toMatch(/^https:\/\//u);

    const exportStart = await request.post(`/api/meetings/${meetingId}/exports`, {
      data: { format: 'txt', stream: 'translation' }
    });
    expect(exportStart.status()).toBe(202);
    const exportBody = await exportStart.json();
    const exportId = exportBody.export?.id || exportBody.artifact?.id;
    expect(exportId).toBeTruthy();

    let exportArtifact;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const exportRead = await request.get(`/api/meetings/${meetingId}/exports/${exportId}`);
      expect(exportRead.status()).toBe(200);
      exportArtifact = await exportRead.json();
      const status = exportArtifact.export?.status || exportArtifact.artifact?.status || exportArtifact.status;
      if (status === 'ready' || status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    expect(exportArtifact.export?.status || exportArtifact.artifact?.status || exportArtifact.status).toBe('ready');

    const exportDownload = await request.post(`/api/meetings/${meetingId}/exports/${exportId}/download-url`);
    expect(exportDownload.status()).toBe(200);
    expect((await exportDownload.json()).downloadUrl).toMatch(/^https:\/\//u);

    const nonOwnerToken = process.env.CLOUD_TEST_NON_OWNER_ACCESS_TOKEN?.trim();
    if (nonOwnerToken) {
      const nonOwner = await playwrightRequest.newContext({
        baseURL: process.env.CLOUD_BASE_URL,
        extraHTTPHeaders: { Authorization: `Bearer ${nonOwnerToken}` }
      });
      try {
        const denied = await nonOwner.post(`/api/meetings/${meetingId}/audio-artifacts/${upload.id}/download-url`);
        expect(denied.status()).toBe(403);
      } finally {
        await nonOwner.dispose();
      }
    }
  } finally {
    const deleted = await request.delete(`/api/meetings/${meetingId}`);
    expect(deleted.status()).toBe(204);
    const missing = await request.get(`/api/meetings/${meetingId}`);
    expect(missing.status()).toBe(404);
  }
});
