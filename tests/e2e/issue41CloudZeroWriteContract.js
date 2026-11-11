import { OBSERVABILITY_METRIC_NAMES } from '../../src/application/observability/observabilityMetricRegistry.js';

export const ALLOWED_METRIC_NAMES = Object.freeze([...Object.values(OBSERVABILITY_METRIC_NAMES), 'readiness_probe']);

const METRIC_COLUMNS = new Set([
  'bucket_start', 'instance_id', 'metric_name', 'operation', 'provider', 'status_class',
  'count', 'sum_value', 'max_value', 'gauge_value'
]);
const METRIC_UPDATE_COLUMNS = new Set(['count', 'sum_value', 'max_value', 'gauge_value']);
// Only product metadata may cross the cloud boundary. Content tables have no entry here.
export const METADATA_COLUMNS = Object.freeze({
  'public.profiles': new Set(['status', 'updated_at']),
  'public.meetings': new Set(['id', 'owner_user_id', 'name', 'source_language_code',
    'target_language_code', 'status', 'created_at', 'updated_at', 'started_at', 'ended_at',
    'purge_at', 'lifecycle_version', 'lifecycle_contract_version', 'last_heartbeat_at',
    'retention_policy_version', 'purge_status', 'purge_attempt_count', 'settings']),
  'public.glossary_categories': new Set(['id', 'owner_user_id', 'label', 'sort_order', 'system']),
  'public.glossary_entries': new Set(['id', 'owner_user_id', 'category_id', 'source',
    'translation', 'translations', 'source_language_code', 'target_language_code',
    'scope', 'tags', 'enabled', 'notes', 'created_at', 'updated_at']),
  'public.meeting_glossary_entries': new Set(['owner_user_id', 'meeting_id', 'glossary_entry_id']),
  'public.viewer_shares': new Set(['id', 'owner_user_id', 'meeting_id', 'role', 'token_hash',
    'code_hash', 'status', 'expires_at', 'created_at', 'updated_at', 'revoked_at']),
  'public.meeting_members': new Set(['id', 'meeting_id', 'user_id', 'owner_user_id', 'role',
    'status', 'created_at', 'updated_at'])
});
const METADATA_JSON_PATHS = Object.freeze({
  'public.meetings': /^(?:settings|settings\.(?:echoTargetLanguage|shouldRecordInputAudio|glossaryEntries(?:\[\](?:\.(?:source|target|replacementAliases(?:\[\])?))?)?|privateGlossaryEntries(?:\[\](?:\.(?:source|translations(?:\.[a-zA-Z-]+)?|replacementAliases(?:\.[a-zA-Z-]+(?:\[\])?)?))?)?))$/u,
  'public.glossary_entries': /^(?:tags(?:\[\])?|translations(?:\.[a-zA-Z-]+)?)$/u
});
const CLOUD_COUNTS = ['cues', 'contentEvents', 'checkpoints', 'sessionContent', 'audioObjects', 'exportObjects'];
const SAFE_EVIDENCE_STRINGS = new Set([
  'mode', 'startedAt', 'finishedAt', 'captureStartedAt', 'barrierCompletedAt', 'at', 'sampledAt',
  'status', 'state', 'recordingState', 'result', 'phase', 'stage', 'event', 'role',
  'method', 'relation_name', 'action', 'route', 'code', 'inventory'
]);

export function redactCloudAuditEvidence(value, key = '') {
  if (typeof value === 'string') {
    if (key === 'changed_columns' || key === 'columns' || key === 'expectedTables' || key === 'monitoredTables') {
      return /^[a-z_][a-z_0-9.]{0,80}$/u.test(value) ? value : '[REDACTED]';
    }
    if (key === 'json_paths' || key === 'jsonPaths') return /^[a-z_][a-z_0-9.\[\]]{0,120}$/u.test(value) ? value : '[REDACTED]';
    if (key === 'evidenceChecks') return ['PASS', 'FAIL', 'NOT_VERIFIED', 'UNVERIFIED', 'NOT_RUN'].includes(value) ? value : '[REDACTED]';
    if (SAFE_EVIDENCE_STRINGS.has(key)) {
      return /^[A-Za-z0-9_:\-.+TZ]{1,100}$/u.test(value) ? value : '[REDACTED]';
    }
    return '[REDACTED]';
  }
  if (Array.isArray(value)) return value.map((item) => redactCloudAuditEvidence(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) =>
      [name, redactCloudAuditEvidence(item,
        key === 'json_paths' || key === 'jsonPaths' || key === 'evidenceChecks' ? key : name)]));
  }
  return value;
}

export function classifyCloudContentRequest({ method, path }) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (/^\/storage\/v1\/object\/list(?:\/|$)/u.test(path)) return null;
  if (/^\/storage\/v1\//u.test(path)) return 'storage';
  const rest = /^\/rest\/v1\/([a-z_]+)(?:\/|$)/u.exec(path);
  if (rest?.[1] === 'profiles') return 'profile-direct-write';
  if (rest) return METADATA_COLUMNS[`public.${rest[1]}`] ? null : 'rest';
  if (/^\/api\/(?:sessions|saved-transcripts|shared-sessions|translation-(?:requests|executions|outputs|dead-letter-queue))(?:\/|$)/u.test(path)) return 'legacy-content';
  const meeting = /^\/api\/meetings\/[^/]+(?:\/(.*))?$/u.exec(path);
  if (meeting) {
    if (method === 'POST' && meeting[1] === 'complete') return null;
    if (!meeting[1] || meeting[1] === 'shares' || meeting[1] === 'heartbeat'
      || meeting[1] === 'settings' || meeting[1] === 'members') return null;
    return `meeting-${meeting[1].split('/')[0]}`;
  }
  return null;
}

export const LEGAL_COORDINATION_RPC = new Set([
  'create_meeting_with_initial_segment', 'complete_local_only_meeting',
  'apply_meeting_checkpoint_operation_v2', 'execute_meeting_lifecycle_command',
  'lookup_meeting_lifecycle_operation', 'record_observability_metric'
]);

export function classifyServerSupabaseWrite({ method, route, authorizationPayloadValid,
  serviceRoleCredential } = {}) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  if (route === '/storage/v1/object/list') return null;
  const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/u.exec(route || '');
  if (rpc) {
    if (rpc[1] === 'activate_pending_profile') {
      return method === 'POST' && authorizationPayloadValid === true && serviceRoleCredential === true
        ? null : 'authorization-rpc';
    }
    return method === 'POST' && LEGAL_COORDINATION_RPC.has(rpc[1]) ? null : 'rpc';
  }
  const rest = /^\/rest\/v1\/([a-z_]+)$/u.exec(route || '');
  if (rest?.[1] === 'profiles') return 'profile-direct-write';
  if (rest) return METADATA_COLUMNS[`public.${rest[1]}`] || rest[1] === 'observability_metric_buckets'
    ? null : 'rest';
  return 'storage-or-unknown';
}

export function evaluateCloudZeroWrite({ events, coverage, before, after, storageBefore, storageAfter,
  cloudBefore, cloudAfter, requests, complete } = {}) {
  if (!complete || !Array.isArray(events) || !coverage?.expectedTables?.length
    || !Array.isArray(coverage.monitoredTables) || !before?.tables || !after?.tables
    || !storageBefore || !storageAfter || !cloudBefore || !cloudAfter || !Array.isArray(requests)) {
    return { status: 'NOT_VERIFIED', violations: [], checkedWrites: 0 };
  }
  const violations = [];
  const expected = [...coverage.expectedTables].sort();
  if (JSON.stringify(expected) !== JSON.stringify([...coverage.monitoredTables].sort())) {
    violations.push({ code: 'trigger_coverage_incomplete' });
  }
  if (JSON.stringify(Object.keys(before.tables).sort()) !== JSON.stringify(expected)
    || JSON.stringify(Object.keys(after.tables).sort()) !== JSON.stringify(expected)) {
    violations.push({ code: 'snapshot_coverage_incomplete' });
  }
  for (const event of events) {
    const columns = event.changed_columns;
    const relation = event.relation_name;
    const action = event.action;
    const allowed = relation === 'public.profiles' && action !== 'UPDATE' ? null
      : relation === 'public.observability_metric_buckets' && action === 'INSERT'
      ? METRIC_COLUMNS : relation === 'public.observability_metric_buckets' && action === 'UPDATE'
        ? METRIC_UPDATE_COLUMNS : METADATA_COLUMNS[relation] || null;
    const paths = event.json_paths || {};
    const jsonPathsAllowed = Object.entries(paths).every(([column, entries]) =>
      allowed?.has(column) && Array.isArray(entries) && entries.every((path) =>
        METADATA_JSON_PATHS[relation]?.test(path)));
    if (!allowed || !Array.isArray(columns)
      || (relation === 'public.profiles' && (columns.length !== 2
        || !['status', 'updated_at'].every((column) => columns.includes(column))))
      || (!columns.length && relation !== 'public.observability_metric_buckets')
      || event.metadata_valid !== true
      || columns.some((column) => !allowed.has(column))
      || !jsonPathsAllowed) {
      violations.push({ code: 'db_write_not_allowed', relation, action,
        transactionId: event.transaction_id, columns: Array.isArray(columns) ? columns : [],
        jsonPaths: paths });
    }
  }
  if (!events.some((event) => event.relation_name === 'public.meetings'
    && event.action === 'UPDATE' && event.metadata_valid === true
    && ['status', 'ended_at', 'purge_at'].every((column) => event.changed_columns?.includes(column)))) {
    violations.push({ code: 'end_update_missing' });
  }
  for (const relation of expected) {
    if (METADATA_COLUMNS[relation] || relation === 'public.observability_metric_buckets') continue;
    if (JSON.stringify(before.tables[relation]) !== JSON.stringify(after.tables[relation])) {
      violations.push({ code: 'snapshot_changed', relation });
    }
  }
  for (const relation of [...Object.keys(METADATA_COLUMNS), 'public.observability_metric_buckets']) {
    if (!expected.includes(relation)) continue;
    if (JSON.stringify(before.tables[relation]) !== JSON.stringify(after.tables[relation])
      && !events.some((event) => event.relation_name === relation)) {
      violations.push({ code: 'write_event_missing', relation });
    }
  }
  if (JSON.stringify(storageBefore) !== JSON.stringify(storageAfter)) violations.push({ code: 'storage_changed' });
  for (const key of CLOUD_COUNTS) {
    if (cloudBefore[key] !== cloudAfter[key]) violations.push({ code: 'cloud_content_changed', inventory: key });
  }
  for (const request of requests) {
    const route = classifyCloudContentRequest(request);
    if (route) violations.push({ code: 'cloud_content_request', method: request.method, route });
  }
  return { status: violations.length ? 'FAIL' : 'PASS', violations, checkedWrites: events.length,
    allowedMetadataWrites: events.length - violations.filter((item) => item.code === 'db_write_not_allowed').length };
}

export function evaluateNormalCloudContentWrite(input, serverRequests) {
  if (!Array.isArray(serverRequests)) return { status: 'NOT_VERIFIED', violations: [], checkedWrites: 0 };
  const verdict = evaluateCloudZeroWrite(input);
  if (verdict.status === 'NOT_VERIFIED') return verdict;
  const serverViolations = serverRequests.flatMap((request) => {
    const route = classifyServerSupabaseWrite(request);
    return route ? [{ code: 'server_cloud_content_request', method: request.method, route }] : [];
  });
  return {
    ...verdict,
    status: verdict.violations.length || serverViolations.length ? 'FAIL' : 'PASS',
    violations: [...verdict.violations, ...serverViolations]
  };
}
