import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCloudContentRequest, classifyServerSupabaseWrite, evaluateCloudZeroWrite, redactCloudAuditEvidence } from '../e2e/issue41CloudZeroWriteContract.js';

const tables = ['public.meetings', 'public.profiles', 'public.observability_metric_buckets', 'public.meeting_recordings',
  'public.subtitle_cues', 'public.glossary_entries', 'public.meeting_glossary_entries',
  'public.viewer_shares', 'storage.objects'];
const base = () => ({
  complete: true,
  coverage: { expectedTables: tables, monitoredTables: tables },
  before: { tables: Object.fromEntries(tables.map((name) => [name, { count: 0, digest: 'before' }])) },
  after: { tables: Object.fromEntries(tables.map((name) => [name, { count: 0, digest: 'before' }])) },
  storageBefore: { audio: [], exports: [] }, storageAfter: { audio: [], exports: [] },
  cloudBefore: { cues: 0, contentEvents: 0, checkpoints: 0, sessionContent: 0, audioObjects: 0, exportObjects: 0 },
  cloudAfter: { cues: 0, contentEvents: 0, checkpoints: 0, sessionContent: 0, audioObjects: 0, exportObjects: 0 },
  requests: [], events: []
});
const endWrite = (overrides = {}) => ({ relation_name: 'public.meetings', action: 'UPDATE',
  transaction_id: 41, changed_columns: ['status', 'ended_at', 'purge_at', 'lifecycle_version', 'updated_at'],
  json_paths: {}, metadata_valid: true, ...overrides });

test('End lifecycle metadata update passes the shared contract', () => {
  const input = base();
  input.events.push(endWrite());
  input.after.tables['public.meetings'] = { count: 0, digest: 'after' };
  assert.equal(evaluateCloudZeroWrite(input).status, 'PASS');
});

test('valid metric no-op UPDATE is recorded but does not fail', () => {
  const input = base();
  input.events.push(endWrite(), { relation_name: 'public.observability_metric_buckets',
    action: 'UPDATE', transaction_id: 42, changed_columns: [], json_paths: {}, metadata_valid: true });
  assert.equal(evaluateCloudZeroWrite(input).status, 'PASS');
});

test('meeting, dictionary, and share metadata writes remain legal', () => {
  const input = base();
  input.events.push(endWrite(),
    endWrite({ changed_columns: ['name', 'settings'], json_paths: {
      settings: ['settings.echoTargetLanguage', 'settings.glossaryEntries',
        'settings.glossaryEntries[].source', 'settings.glossaryEntries[].target']
    } }),
    { relation_name: 'public.glossary_entries', action: 'INSERT', transaction_id: 42,
      changed_columns: ['id', 'owner_user_id', 'source', 'translation', 'translations', 'tags'],
      json_paths: { translations: ['translations.en'], tags: ['tags'] }, metadata_valid: true },
    { relation_name: 'public.meeting_glossary_entries', action: 'INSERT', transaction_id: 43,
      changed_columns: ['owner_user_id', 'meeting_id', 'glossary_entry_id'],
      json_paths: {}, metadata_valid: true },
    { relation_name: 'public.viewer_shares', action: 'INSERT', transaction_id: 44,
      changed_columns: ['id', 'owner_user_id', 'meeting_id', 'role', 'token_hash'],
      json_paths: {}, metadata_valid: true });
  for (const relation of ['public.meetings', 'public.glossary_entries',
    'public.meeting_glossary_entries', 'public.viewer_shares']) {
    input.after.tables[relation] = { count: 1, digest: 'after' };
  }
  assert.equal(evaluateCloudZeroWrite(input).status, 'PASS');
});

test('meeting JSON content and unknown JSON keys fail without persisting values', () => {
  const input = base();
  input.events.push(endWrite({ changed_columns: ['status', 'settings'],
    json_paths: { settings: ['settings.transcript'] } }));
  const verdict = evaluateCloudZeroWrite(input);
  assert.equal(verdict.status, 'FAIL');
  assert.deepEqual(verdict.violations[0].columns, ['status', 'settings']);
  const artifact = JSON.stringify(redactCloudAuditEvidence({ ...verdict, raw: 'private transcript',
    cue: { text: 'private transcript' }, token: 'secret-token' }));
  assert.doesNotMatch(artifact, /private transcript|secret-token/u);
});

test('evidence check states survive redaction without exposing arbitrary strings', () => {
  const checkNames = ['pcmCallbacksFramesBytes', 'journalClaimCoverageAndHashes', 'pcmRecordingOwnership',
    'segmentPcmOwnership', 'segmentCueOwnership', 'endDurability', 'reloadReadback',
    'rolloverDurableOperations', 'oldSegmentEnded', 'providerStartTrace', 'cloudZeroWrite'];
  const checks = Object.fromEntries(checkNames.map((name) => [name, 'PASS']));
  const redacted = redactCloudAuditEvidence({
    evidenceChecks: { ...checks, failed: 'FAIL', missing: 'NOT_VERIFIED', unknown: 'private transcript' },
    token: 'secret-token'
  });
  assert.deepEqual(redacted.evidenceChecks, {
    ...checks, failed: 'FAIL', missing: 'NOT_VERIFIED', unknown: '[REDACTED]'
  });
  assert.equal(redacted.token, '[REDACTED]');
});

test('RPC or trigger writes are judged by their actual relation and columns', () => {
  const input = base();
  input.events.push(endWrite(), { relation_name: 'public.meeting_recordings', action: 'UPDATE',
    transaction_id: 41, changed_columns: ['ended_at'], json_paths: {}, metadata_valid: false });
  const verdict = evaluateCloudZeroWrite(input);
  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.violations[0].relation, 'public.meeting_recordings');
});

test('unknown relation, field, and metric JSON payload fail closed', () => {
  for (const event of [endWrite({ relation_name: 'public.future_table' }),
    endWrite({ changed_columns: ['status', 'transcript'] }),
    { relation_name: 'public.observability_metric_buckets', action: 'UPDATE', transaction_id: 42,
      changed_columns: ['payload'], json_paths: { payload: ['payload.transcript'] }, metadata_valid: true }]) {
    assert.equal(evaluateCloudZeroWrite({ ...base(), events: [event] }).status, 'FAIL');
  }
});

test('incomplete audit is NOT_VERIFIED', () => {
  assert.equal(evaluateCloudZeroWrite({ ...base(), complete: false }).status, 'NOT_VERIFIED');
  assert.equal(evaluateCloudZeroWrite({ ...base(), coverage: null }).status, 'NOT_VERIFIED');
});

test('HTTP audit covers legacy meeting content, REST, and Storage writes', () => {
  for (const path of ['/api/meetings/id/audio/input', '/api/meetings/id/audio-artifacts/id/complete',
    '/api/meetings/id/exports', '/api/meetings/id/recording/start',
    '/api/meetings/id/segments/id/cues', '/api/sessions/id/audio/input',
    '/rest/v1/rpc/unknown_writer', '/storage/v1/object/meeting-audio/path']) {
    assert.ok(classifyCloudContentRequest({ method: 'POST', path }), path);
  }
  assert.equal(classifyCloudContentRequest({ method: 'POST', path: '/api/meetings/id/complete' }), null);
  assert.equal(classifyCloudContentRequest({ method: 'PATCH', path: '/rest/v1/meetings' }), null);
  assert.equal(classifyCloudContentRequest({ method: 'POST', path: '/rest/v1/glossary_entries' }), null);
  assert.equal(classifyCloudContentRequest({ method: 'POST', path: '/api/meetings/id/shares' }), null);
  assert.equal(classifyCloudContentRequest({ method: 'POST', path: '/storage/v1/object/list/meeting-audio' }), null);
});

test('pending-profile activation metadata is allowed, arbitrary profile changes are rejected', () => {
  const input = base();
  input.events.push(endWrite(), {
    relation_name: 'public.profiles', action: 'UPDATE', transaction_id: 42,
    changed_columns: ['status', 'updated_at'], json_paths: {}, metadata_valid: true
  });
  input.after.tables['public.meetings'] = { count: 0, digest: 'after' };
  input.after.tables['public.profiles'] = { count: 0, digest: 'after' };
  assert.equal(evaluateCloudZeroWrite(input).status, 'PASS');
  for (const change of [
    { action: 'INSERT', changed_columns: ['status', 'updated_at'], metadata_valid: true },
    { action: 'UPDATE', changed_columns: ['role', 'updated_at'], metadata_valid: true },
    { action: 'UPDATE', changed_columns: ['status', 'updated_at'], metadata_valid: false }
  ]) {
    input.events[1] = { ...input.events[1], ...change };
    assert.equal(evaluateCloudZeroWrite(input).status, 'FAIL');
  }
  assert.equal(classifyCloudContentRequest({ method: 'PATCH', path: '/rest/v1/profiles' }),
    'profile-direct-write');
});

test('only scoped POST activation RPC payload and service credential are allowed', () => {
  const valid = { method: 'POST', route: '/rest/v1/rpc/activate_pending_profile',
    authorizationPayloadValid: true, serviceRoleCredential: true };
  assert.equal(classifyServerSupabaseWrite(valid), null);
  for (const request of [
    { ...valid, method: 'PUT' }, { ...valid, authorizationPayloadValid: false },
    { ...valid, serviceRoleCredential: false },
    { ...valid, route: '/rest/v1/rpc/arbitrary_writer' },
    { method: 'PATCH', route: '/rest/v1/profiles' },
    { method: 'POST', route: '/storage/v1/object/meeting-audio' }
  ]) assert.notEqual(classifyServerSupabaseWrite(request), null);
});
