import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingReadApiClient } from '../../src/lib/meetingReadApiClient.js';

test('GET /api/meetings uses the correct URL and method', async () => {
  const calls = [];
  const client = createMeetingReadApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse([]);
    }
  });

  await client.listMeetingHistory();

  assert.deepEqual(calls, [{ url: '/api/meetings', options: { method: 'GET', headers: {} } }]);
});

test('GET /api/meetings/:meetingId URL-encodes the ID', async () => {
  const calls = [];
  const client = createMeetingReadApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(meetingDetail({ id: 'meeting 1/long' }));
    }
  });

  await client.getMeetingDetail('meeting 1/long');

  assert.deepEqual(calls, [
    { url: '/api/meetings/meeting%201%2Flong', options: { method: 'GET', headers: {} } }
  ]);
});

test('meeting history and detail DTOs are returned unchanged', async () => {
  const history = [meetingSummary({ id: 'meeting-1' })];
  const detail = meetingDetail({ id: 'meeting-1' });
  const client = createMeetingReadApiClient({
    fetchImpl(url) {
      return jsonResponse(url === '/api/meetings' ? history : detail);
    }
  });

  assert.strictEqual(await client.listMeetingHistory(), history);
  assert.strictEqual(await client.getMeetingDetail('meeting-1'), detail);
});

test('missing meeting detail returns null for meeting_not_found response', async () => {
  const client = createMeetingReadApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'meeting_not_found' } }, { status: 404 });
    }
  });

  assert.equal(await client.getMeetingDetail('missing-meeting'), null);
});

test('unexpected HTTP errors and malformed responses reject', async () => {
  const serverErrorClient = createMeetingReadApiClient({
    fetchImpl() {
      return jsonResponse({ error: { code: 'internal_error' } }, { status: 500 });
    }
  });
  const malformedHistoryClient = createMeetingReadApiClient({
    fetchImpl() {
      return jsonResponse({ id: 'not-array' });
    }
  });
  const malformedDetailClient = createMeetingReadApiClient({
    fetchImpl() {
      return jsonResponse([]);
    }
  });

  await assert.rejects(serverErrorClient.listMeetingHistory(), /HTTP 500/);
  await assert.rejects(malformedHistoryClient.listMeetingHistory(), /must be an array/);
  await assert.rejects(malformedDetailClient.getMeetingDetail('meeting-1'), /must be an object/);
});

test('meeting history HTTP errors expose API code and request ID', async () => {
  const client = createMeetingReadApiClient({
    fetchImpl: async () => jsonResponse({
      error: {
        code: 'auth_invalid',
        message: 'Access token is invalid.',
        requestId: 'request-list-123'
      }
    }, { status: 401 })
  });

  await assert.rejects(
    client.listMeetingHistory(),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'auth_invalid');
      assert.equal(error.requestId, 'request-list-123');
      return true;
    }
  );
});

test('invalid inputs do not issue requests', async () => {
  let calls = 0;
  const client = createMeetingReadApiClient({
    fetchImpl() {
      calls += 1;
      return jsonResponse(meetingDetail({ id: 'meeting-1' }));
    }
  });

  assert.throws(() => createMeetingReadApiClient({ fetchImpl: null }), TypeError);
  await assert.rejects(client.getMeetingDetail(''), TypeError);
  await assert.rejects(client.getMeetingDetail('   '), TypeError);
  await assert.rejects(client.getMeetingDetail(null), TypeError);
  assert.equal(calls, 0);
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

function meetingSummary(overrides = {}) {
  return {
    id: overrides.id || 'meeting-1',
    status: 'active',
    startedAt: 1000,
    endedAt: null,
    durationMs: null,
    segmentSummary: { totalSegments: 1, countsByStatus: { active: 1 }, hasInterruptedSegments: false, hasFailedSegments: false },
    transcriptSummary: { totalItems: 0, sourceFinalCount: 0, translationFinalCount: 0, hasTranscript: false },
    failureInfo: null,
    recordKind: 'meeting'
  };
}

function meetingDetail(overrides = {}) {
  const meeting = meetingSummary(overrides);
  return {
    meeting,
    segments: [],
    timeline: [],
    transcriptItems: [],
    readingContent: {
      sourceTranscript: { kind: 'sourceTranscript', status: 'empty', text: '', paragraphs: [] },
      translationArticle: { kind: 'translationArticle', status: 'empty', text: '', paragraphs: [] }
    },
    recordKind: 'meeting'
  };
}
