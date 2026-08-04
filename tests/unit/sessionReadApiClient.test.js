import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionReadApiClient } from '../../src/lib/sessionReadApiClient.js';

test('GET /api/sessions uses the correct URL and method', async () => {
  const calls = [];
  const client = createSessionReadApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse([]);
    }
  });

  await client.listSessionHistory();

  assert.deepEqual(calls, [
    {
      url: '/api/sessions',
      options: { method: 'GET' }
    }
  ]);
});

test('history DTO response is returned unchanged', async () => {
  const history = [historyItem({ id: 'session-1' })];
  const client = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse(history);
    }
  });

  const result = await client.listSessionHistory();

  assert.strictEqual(result, history);
});

test('GET /api/sessions/:sessionId URL-encodes the ID', async () => {
  const calls = [];
  const client = createSessionReadApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(detailDTO({ id: 'session 1/zh-Hant' }));
    }
  });

  await client.getSessionDetail('session 1/zh-Hant');

  assert.deepEqual(calls, [
    {
      url: '/api/sessions/session%201%2Fzh-Hant',
      options: { method: 'GET' }
    }
  ]);
});

test('DELETE /api/sessions/:sessionId URL-encodes the ID and returns confirmation', async () => {
  const calls = [];
  const client = createSessionReadApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse({ deleted: true, sessionId: 'session 1/zh-Hant' });
    }
  });

  const result = await client.deleteSessionRecord('session 1/zh-Hant');

  assert.deepEqual(calls, [
    {
      url: '/api/sessions/session%201%2Fzh-Hant',
      options: { method: 'DELETE' }
    }
  ]);
  assert.deepEqual(result, { deleted: true, sessionId: 'session 1/zh-Hant' });
});

test('missing delete returns null for session_not_found response', async () => {
  const client = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'session_not_found', message: 'Session not found.' } }, { status: 404 });
    }
  });

  assert.equal(await client.deleteSessionRecord('missing-session'), null);
});

test('DELETE /api/sessions/:sessionId/translations/:outputId URL-encodes IDs and returns confirmation', async () => {
  const calls = [];
  const client = createSessionReadApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse({ deleted: true, sessionId: 'session 1/zh-Hant', outputId: 'output 1/fr' });
    }
  });

  const result = await client.deleteSessionTranslationOutput('session 1/zh-Hant', 'output 1/fr');

  assert.deepEqual(calls, [
    {
      url: '/api/sessions/session%201%2Fzh-Hant/translations/output%201%2Ffr',
      options: { method: 'DELETE' }
    }
  ]);
  assert.deepEqual(result, { deleted: true, sessionId: 'session 1/zh-Hant', outputId: 'output 1/fr' });
});

test('missing translation output delete returns null for 404 response', async () => {
  const client = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'translation_output_not_found' } }, { status: 404 });
    }
  });

  assert.equal(await client.deleteSessionTranslationOutput('session-1', 'missing-output'), null);
});

test('detail DTO response is returned unchanged', async () => {
  const detail = detailDTO({ id: 'session-1' });
  const client = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse(detail);
    }
  });

  const result = await client.getSessionDetail('session-1');

  assert.strictEqual(result, detail);
});

test('GET /api/sessions/:sessionId/summary URL-encodes the ID and returns the summary unchanged', async () => {
  const calls = [];
  const summary = { summaryId: 'summary-1', sessionId: 'session 1', status: 'pending' };
  const client = createSessionReadApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(summary);
    }
  });

  const result = await client.getSessionSummary('session 1');

  assert.deepEqual(calls, [{ url: '/api/sessions/session%201/summary', options: { method: 'GET' } }]);
  assert.strictEqual(result, summary);
});

test('missing summary returns null for meeting_summary_not_found response', async () => {
  const client = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'meeting_summary_not_found' } }, { status: 404 });
    }
  });

  assert.equal(await client.getSessionSummary('missing-session'), null);
});

test('POST /api/sessions/:sessionId/summary/retry URL-encodes the ID', async () => {
  const calls = [];
  const client = createSessionReadApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse({ accepted: true, jobId: 'job-1' }, { status: 202 });
    }
  });
  assert.deepEqual(await client.retrySessionSummary('session 1'), { accepted: true, jobId: 'job-1' });
  assert.deepEqual(calls, [{ url: '/api/sessions/session%201/summary/retry', options: { method: 'POST' } }]);
});

test('missing detail returns null for session_not_found response', async () => {
  const client = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'session_not_found', message: 'Session not found.' } }, { status: 404 });
    }
  });

  assert.equal(await client.getSessionDetail('missing-session'), null);
});

test('unexpected HTTP errors reject', async () => {
  const serverErrorClient = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'internal_error' } }, { status: 500 });
    }
  });
  const unexpectedNotFoundClient = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'not_found' } }, { status: 404 });
    }
  });

  await assert.rejects(serverErrorClient.listSessionHistory(), /HTTP 500/);
  await assert.rejects(unexpectedNotFoundClient.getSessionDetail('session-1'), /HTTP 404/);
});

test('invalid JSON or malformed responses reject safely', async () => {
  const invalidJsonClient = createSessionReadApiClient({
    fetchImpl() {
      return {
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError('invalid json');
        }
      };
    }
  });
  const malformedHistoryClient = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse({ id: 'not-an-array' });
    }
  });
  const malformedDetailClient = createSessionReadApiClient({
    fetchImpl() {
      return jsonResponse([]);
    }
  });

  await assert.rejects(invalidJsonClient.listSessionHistory(), /valid JSON/);
  await assert.rejects(malformedHistoryClient.listSessionHistory(), /must be an array/);
  await assert.rejects(malformedDetailClient.getSessionDetail('session-1'), /must be an object/);
});

test('invalid fetchImpl throws TypeError', () => {
  assert.throws(() => createSessionReadApiClient({ fetchImpl: null }), TypeError);
});

test('invalid session ID does not issue a request', async () => {
  let calls = 0;
  const client = createSessionReadApiClient({
    fetchImpl() {
      calls += 1;
      return jsonResponse(detailDTO({ id: 'session-1' }));
    }
  });

  await assert.rejects(client.getSessionDetail(''), TypeError);
  await assert.rejects(client.getSessionDetail('   '), TypeError);
  await assert.rejects(client.getSessionDetail(null), TypeError);
  await assert.rejects(client.deleteSessionRecord(''), TypeError);
  await assert.rejects(client.deleteSessionTranslationOutput('', 'output-1'), TypeError);
  await assert.rejects(client.deleteSessionTranslationOutput('session-1', ''), TypeError);
  assert.equal(calls, 0);
});

test('input and response DTOs are not mutated by the client', async () => {
  const history = Object.freeze([Object.freeze(historyItem({ id: 'session-1' }))]);
  const detail = Object.freeze(detailDTO({ id: 'session-1' }));
  const beforeHistory = JSON.stringify(history);
  const beforeDetail = JSON.stringify(detail);
  const seenSessionIds = [];
  const client = createSessionReadApiClient({
    fetchImpl(url) {
      if (url === '/api/sessions') {
        return jsonResponse(history);
      }

      seenSessionIds.push('session-1');
      return jsonResponse(detail);
    }
  });

  const historyResult = await client.listSessionHistory();
  const detailResult = await client.getSessionDetail('session-1');

  assert.strictEqual(historyResult, history);
  assert.strictEqual(detailResult, detail);
  assert.deepEqual(seenSessionIds, ['session-1']);
  assert.equal(JSON.stringify(history), beforeHistory);
  assert.equal(JSON.stringify(detail), beforeDetail);
});

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

function historyItem(overrides = {}) {
  return {
    id: overrides.id || 'session-1',
    status: overrides.status || 'completed',
    startedAt: overrides.startedAt ?? 1000,
    endedAt: overrides.endedAt ?? 2000,
    durationMs: overrides.durationMs ?? 1000,
    targetLanguageCode: overrides.targetLanguageCode || 'fr',
    targetLanguageLabel: overrides.targetLanguageLabel || 'French',
    failureReason: overrides.failureReason ?? null,
    failureCategory: overrides.failureCategory ?? null,
    transcriptSummary: overrides.transcriptSummary || {
      totalItems: 1,
      sourceFinalCount: 0,
      translationFinalCount: 1,
      sourcePartialCount: 0,
      translationPartialCount: 0,
      hasTranscript: true
    },
    legacy: true
  };
}

function detailDTO(overrides = {}) {
  const sessionId = overrides.id || 'session-1';

  return {
    session: {
      id: sessionId,
      status: 'completed',
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
      failureReason: null,
      failureCategory: null,
      selectedInputDeviceId: null,
      inputDeviceLabelSnapshot: null,
      transcriptSummary: {
        totalItems: 1,
        sourceFinalCount: 0,
        translationFinalCount: 1,
        sourcePartialCount: 0,
        translationPartialCount: 0,
        hasTranscript: true
      }
    },
    sourceTranscript: {
      id: `source:${sessionId}`,
      sessionId,
      revisionId: `source-revision:${sessionId}:final`,
      status: 'finalized',
      items: [],
      createdAt: 1000,
      finalizedAt: 2000,
      legacy: true
    },
    translationOutputs: [],
    selectedTranslationOutput: null,
    legacy: true
  };
}
