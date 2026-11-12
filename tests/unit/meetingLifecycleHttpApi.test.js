import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

test('legacy recording mutations and operation endpoints have no HTTP writer', async () => {
  let lifecycleCalls = 0;
  const handler = createRequestHandler({
    meetingLifecycleService: { execute() { lifecycleCalls += 1; } },
    legacyResumeService: { execute() { lifecycleCalls += 1; } }
  });
  const paths = [
    ['/api/meetings/meeting-1/recording/start', 'POST'],
    ['/api/meetings/meeting-1/recording/pause', 'POST'],
    ['/api/meetings/meeting-1/recording/resume', 'POST'],
    ['/api/meetings/meeting-1/recording/rollover', 'POST'],
    ['/api/meetings/meeting-1/recording/recover', 'POST'],
    ['/api/meetings/meeting-1/recording/stop', 'POST'],
    ['/api/meetings/meeting-1/recording/takeover', 'POST'],
    ['/api/meetings/meeting-1/recording/lease/heartbeat', 'POST'],
    ['/api/meetings/meeting-1/recording/lease/recover', 'POST'],
    ['/api/meetings/meeting-1/recording/legacy-resume', 'POST'],
    ['/api/meetings/meeting-1/recording/operations/op-1', 'GET'],
    ['/api/meetings/meeting-1/heartbeat', 'POST']
  ];
  for (const [url, method] of paths) {
    const response = await request(handler, { url, method });
    assert.equal(response.status, 410, `${method} ${url}`);
    assert.equal(response.json().error.code, 'meeting_content_local_only');
  }
  assert.equal(lifecycleCalls, 0);
});

async function request(handler, { url, method }) {
  const req = new Readable({ read() {} });
  req.url = url;
  req.method = method;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  req.push(null);
  const chunks = [];
  const res = {
    writeHead(status) { this.statusCode = status; },
    setHeader() {},
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); }
  };
  await handler(req, res);
  return { status: res.statusCode, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
