import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportArtifactService } from '../../src/application/exportArtifactService.js';

function makeSetup() {
  const rows = new Map();
  const queued = [];
  const stored = [];
  let source = {
    sourceHash: 'hash-1',
    items: [{ id: 'item-1', stream: 'translation', text: 'hello', sequence: 1, startedAt: 0 }],
    cues: [],
    timeOrigin: 0
  };
  const repository = {
    async findByKey(input) { return [...rows.values()].find((row) => row.ownerUserId === input.ownerUserId && row.meetingId === input.meetingId && row.sourceHash === input.sourceHash && row.format === input.format && row.stream === input.stream) || null; },
    async create(input) { rows.set(input.id, { ...input }); return { ...input }; },
    async getById(id) { return rows.get(id) ? { ...rows.get(id) } : null; },
    async listByMeeting() { return [...rows.values()].map((row) => ({ ...row })); },
    async update(id, _owner, patch) { const next = { ...rows.get(id), ...patch }; rows.set(id, next); return { ...next }; },
    async remove(id) { rows.delete(id); },
    async removeByMeeting() { rows.clear(); }
  };
  const service = createExportArtifactService({
    artifactRepository: repository,
    sourceReader: { async read() { return source; } },
    queue: { async enqueue(message) { queued.push(message); } },
    storage: {
      async put(input) { stored.push(input); },
      async remove(input) { stored.push({ remove: input }); },
      async createSignedUrl() { return { url: 'https://signed.example/export', expiresAt: 60 }; }
    },
    exportApplicationService: { exportTranscript() { return 'hello\n'; } },
    idFactory: () => `export-${rows.size + 1}`,
    ownerResolver: () => 'owner-1'
  });
  return { service, rows, queued, stored, setSource(next) { source = next; } };
}

test('export source hash and create are idempotent for the same source', async () => {
  const setup = makeSetup();
  const first = await setup.service.create({ meetingId: 'meeting-1', format: 'txt', stream: 'translation' });
  const second = await setup.service.create({ meetingId: 'meeting-1', format: 'txt', stream: 'translation' });

  assert.equal(first.artifact.id, second.artifact.id);
  assert.equal(first.artifact.status, 'queued');
  assert.equal(setup.queued.length, 1);
  assert.match(first.artifact.fileName, /\.txt$/u);
});

test('worker processing transitions queued artifact to ready with MIME and byte size', async () => {
  const setup = makeSetup();
  const created = await setup.service.create({ meetingId: 'meeting-1', format: 'srt', stream: 'translation' });
  const result = await setup.service.process(setup.queued[0]);
  const artifact = setup.rows.get(created.artifact.id);

  assert.deepEqual(result, { status: 'ready', artifactId: created.artifact.id });
  assert.equal(artifact.status, 'ready');
  assert.equal(artifact.mimeType, 'application/x-subrip');
  assert.equal(artifact.byteSize, Buffer.byteLength('hello\n'));
  assert.equal(setup.stored[0].contentType, 'application/x-subrip');
});

test('source changes mark the queued artifact stale without overwriting storage', async () => {
  const setup = makeSetup();
  const created = await setup.service.create({ meetingId: 'meeting-1', format: 'vtt', stream: 'source' });
  setup.setSource({ sourceHash: 'hash-2', items: [], cues: [], timeOrigin: 0 });

  const result = await setup.service.process(setup.queued[0]);
  assert.deepEqual(result, { status: 'stale', artifactId: created.artifact.id });
  assert.equal(setup.rows.get(created.artifact.id).status, 'stale');
  assert.equal(setup.stored.length, 0);
});

test('a changed source creates a new idempotent artifact key', async () => {
  const setup = makeSetup();
  const first = await setup.service.create({ meetingId: 'meeting-1', format: 'txt', stream: 'translation' });
  setup.setSource({ sourceHash: 'hash-2', items: [{ id: 'item-2', stream: 'translation', text: 'changed' }], cues: [], timeOrigin: 0 });
  const second = await setup.service.create({ meetingId: 'meeting-1', format: 'txt', stream: 'translation' });

  assert.notEqual(first.artifact.id, second.artifact.id);
  assert.equal(setup.rows.size, 2);
  assert.equal(setup.queued.length, 2);
});

test('signed URL is only available for ready artifacts and deletion removes object before metadata', async () => {
  const setup = makeSetup();
  const created = await setup.service.create({ meetingId: 'meeting-1', format: 'txt', stream: 'both' });
  await assert.rejects(setup.service.createDownloadUrl({ meetingId: 'meeting-1', exportId: created.artifact.id }), (error) => error.code === 'export_not_ready');
  await setup.service.process(setup.queued[0]);
  const download = await setup.service.createDownloadUrl({ meetingId: 'meeting-1', exportId: created.artifact.id });
  assert.equal(download.fileName, created.artifact.fileName);
  await setup.service.delete({ meetingId: 'meeting-1', exportId: created.artifact.id });
  assert.equal(setup.rows.size, 0);
  assert.equal(setup.stored.at(-1).remove.path, 'owner-1/meeting-1/export-1/live-translate-meeting-meeting-1-txt-both.txt');
});
