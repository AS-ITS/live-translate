import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';

test('POST viewer telemetry records a public share metric', async () => {
  const recorded = [];
  const handler = createRequestHandler({
    sessionShareService: {
      async resolveCode(code) {
        assert.equal(code, 'SDR96VY9');
        return {
          id: 'share-1',
          meetingId: 'meeting-1',
          resourceType: 'meeting',
          role: 'viewer'
        };
      }
    },
    observabilityMetrics: {
      recordCounter(...args) {
        recorded.push(args);
      }
    }
  });

  const response = await post(handler, '/api/shared-meetings/code/SDR96VY9/events/telemetry', {
    eventType: 'reconnect',
    count: 1
  });

  assert.equal(response.status, 202);
  assert.equal(response.json().accepted, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0][0], 'viewer_reconnect_total');
  assert.equal(recorded[0][1], 1);
});

async function post(handler, url, body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = url;
  req.headers = { host: '127.0.0.1:3000', 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = createResponse();
  await handler(req, response);
  return {
    status: response.statusCode,
    json: () => JSON.parse(response.body)
  };
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
    },
    end(chunk = '') {
      this.body += chunk;
    }
  };
}
