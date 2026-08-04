import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createSessionSummaryController } from '../../server/sessionSummaryController.js';

const summary = (status) => ({
  summaryId: `summary-${status}`, sessionId: 'session-1', status,
  model: 'gemini-3.5-flash-lite', summary: status === 'completed' ? { title: 'Meeting' } : null,
  topics: status === 'completed' ? ['Topic'] : [], decisions: [], actionItems: [], createdAt: 1,
  completedAt: status === 'completed' ? 2 : null
});

test('GET /api/sessions/:sessionId/summary returns persisted summary states', async () => {
  for (const status of ['completed', 'pending', 'failed']) {
    const handler = createHandler(summary(status));
    const response = await request(handler, { url: `/api/sessions/session-1/summary` });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), summary(status));
  }
});

test('GET /api/sessions/:sessionId/summary returns deterministic 404 for missing summaries', async () => {
  const handler = createHandler(null);
  const response = await request(handler, { url: '/api/sessions/missing/summary' });
  assert.equal(response.status, 404);
  assert.equal(response.json().error.code, 'meeting_summary_not_found');
});

test('summary API decodes the Session ID and delegates through the query controller', async () => {
  const calls = [];
  const controller = createSessionSummaryController({
    sessionSummaryQueryService: {
      getSessionSummary(sessionId) { calls.push(sessionId); return summary('completed'); }
    }
  });
  const handler = createRequestHandler({ sessionSummaryController: controller });
  const response = await request(handler, { url: '/api/sessions/session%201/summary' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['session 1']);
});

test('POST /api/sessions/:sessionId/summary/retry enqueues a new summary job', async () => {
  const calls = [];
  const handler = createRequestHandler({
    sessionRepository: { async getSessionRecord() { return { sessionRecord: { id: 'session 1', meetingId: 'meeting-1' } }; } },
    summaryRepository: { async getSummaryBySessionId() { return { status: 'failed' }; } },
    summaryJobEnqueuer: { async retryForSession(input) { calls.push(input); return { jobId: 'job-1' }; } }
  });
  const response = await request(handler, { method: 'POST', url: '/api/sessions/session%201/summary/retry' });
  assert.equal(response.status, 202);
  assert.deepEqual(response.json(), { accepted: true, jobId: 'job-1', sessionId: 'session 1' });
  assert.deepEqual(calls, [{ sessionId: 'session 1', meetingId: 'meeting-1' }]);
});

function createHandler(value) {
  return createRequestHandler({
    sessionSummaryController: createSessionSummaryController({
      sessionSummaryQueryService: { getSessionSummary() { return value; } }
    })
  });
}
async function request(handler, { method = 'GET', url } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = {
    status: null,
    body: Buffer.alloc(0),
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = Buffer.from(String(body)); }
  };
  await handler(req, response);
  return { status: response.status, json: () => JSON.parse(response.body.toString('utf8')) };
}
