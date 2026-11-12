import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCloudZeroWrite, evaluateNormalCloudContentWrite } from '../e2e/issue41CloudZeroWriteContract.js';

const tables = ['public.meetings', 'public.profiles', 'public.glossary_entries', 'public.meeting_glossary_entries',
  'public.viewer_shares', 'public.observability_metric_buckets', 'public.subtitle_cues', 'storage.objects'];
const fixture = () => ({
  complete: true,
  coverage: { expectedTables: tables, monitoredTables: tables },
  before: { tables: Object.fromEntries(tables.map((name) => [name, { count: 0 }])) },
  after: { tables: Object.fromEntries(tables.map((name) => [name, { count: 0 }])) },
  storageBefore: { audio: [], exports: [] }, storageAfter: { audio: [], exports: [] },
  cloudBefore: { cues: 0, contentEvents: 0, checkpoints: 0, sessionContent: 0, audioObjects: 0, exportObjects: 0 },
  cloudAfter: { cues: 0, contentEvents: 0, checkpoints: 0, sessionContent: 0, audioObjects: 0, exportObjects: 0 },
  requests: [],
  events: [{ relation_name: 'public.meetings', action: 'UPDATE', transaction_id: 1,
    changed_columns: ['status', 'ended_at', 'purge_at', 'lifecycle_version', 'updated_at'],
    json_paths: {}, metadata_valid: true }]
});

test('RAM mode requires a server audit and rejects content writes in the normal flow', () => {
  const input = fixture();
  assert.equal(evaluateNormalCloudContentWrite(input).status, 'NOT_VERIFIED');
  assert.equal(evaluateNormalCloudContentWrite(input, []).status, 'PASS', JSON.stringify(evaluateNormalCloudContentWrite(input, [])));
  input.requests.push({ method: 'POST', path: '/api/meetings/id/segments/id/cues' });
  assert.equal(evaluateNormalCloudContentWrite(input, []).status, 'FAIL');
  input.requests = [];
  assert.equal(evaluateNormalCloudContentWrite(input,
    [{ method: 'POST', route: '/storage/v1/object/meeting-audio' }]).status, 'FAIL');
});

test('meeting, dictionary and authorization metadata remain legal in both modes', () => {
  const input = fixture();
  input.events.push(
    { relation_name: 'public.glossary_entries', action: 'INSERT', transaction_id: 2,
      changed_columns: ['source', 'translations'], json_paths: { translations: ['translations.en'] }, metadata_valid: true },
    { relation_name: 'public.profiles', action: 'UPDATE', transaction_id: 3,
      changed_columns: ['status', 'updated_at'], json_paths: {}, metadata_valid: true }
  );
  input.after.tables['public.glossary_entries'] = { count: 1 };
  input.after.tables['public.profiles'] = { count: 1 };
  const serverRequests = [
    { method: 'POST', route: '/rest/v1/rpc/create_meeting_with_initial_segment' },
    { method: 'POST', route: '/rest/v1/rpc/activate_pending_profile',
      authorizationPayloadValid: true, serviceRoleCredential: true }
  ];
  assert.equal(evaluateNormalCloudContentWrite(input, serverRequests).status, 'PASS', JSON.stringify(evaluateNormalCloudContentWrite(input, serverRequests)));
  assert.equal(evaluateCloudZeroWrite(input).status, 'PASS');
});
