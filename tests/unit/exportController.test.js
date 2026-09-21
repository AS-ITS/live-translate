import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportController } from '../../server/exportController.js';

function response() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body = body; }
  };
}

function request(method, body = {}) {
  return {
    method,
    async *[Symbol.asyncIterator]() { if (method === 'POST') yield JSON.stringify(body); }
  };
}

test('export controller returns queued artifact and hides storage details', async () => {
  const controller = createExportController({
    exportArtifactService: {
      async create(input) { assert.deepEqual(input, { meetingId: 'meeting-1', format: 'txt', stream: 'translation' }); return { accepted: true, artifact: { id: 'export-1', status: 'queued', fileName: 'file.txt' } }; }
    }
  });
  const res = response();

  await controller.handle({ req: request('POST', { format: 'txt', stream: 'translation' }), res, path: '/api/meetings/meeting-1/exports', requestId: 'request-1' });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(JSON.parse(res.body), { export: { id: 'export-1', status: 'queued', fileName: 'file.txt' }, requestId: 'request-1' });
});

test('export controller maps invalid streams to a stable 400 error', async () => {
  const controller = createExportController({
    exportArtifactService: { async create() { throw Object.assign(new Error(), { code: 'export_invalid_stream', status: 400 }); } }
  });
  const res = response();

  await controller.handle({ req: request('POST', { format: 'srt', stream: 'both' }), res, path: '/api/meetings/meeting-1/exports', requestId: 'request-2' });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body).error, { code: 'export_invalid_stream', message: 'Export stream is invalid for this format.', requestId: 'request-2' });
});
