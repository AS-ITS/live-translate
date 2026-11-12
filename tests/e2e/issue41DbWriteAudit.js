import { execFileSync } from 'node:child_process';
import { ALLOWED_METRIC_NAMES } from './issue41CloudZeroWriteContract.js';

const container = process.env.ISSUE41_ISOLATED_DB_CONTAINER;
if (!/^supabase_db_issue41-[a-z0-9-]+$/u.test(container || '')) {
  throw new Error('Issue 41 audit requires a newly created isolated Supabase DB container');
}

export function auditNamespace() {
  const namespace = process.env.ISSUE41_AUDIT_NAMESPACE;
  if (!/^issue41_audit_[0-9a-f]{24}$/u.test(namespace || '')) {
    throw new Error('Issue 41 audit requires a valid per-run namespace');
  }
  return namespace;
}

function sql(statement) {
  return execFileSync('docker', [
    'exec', container, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'postgres', '-c', statement
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

export function installWriteAudit() {
  const namespace = auditNamespace();
  if (sql(`SELECT to_regnamespace('${namespace}') IS NULL`) !== 't') {
    throw new Error('This run\'s audit namespace already exists');
  }
  const triggerName = `${namespace}_write`;
  const metricNames = ALLOWED_METRIC_NAMES.map((name) => `'${name}'`).join(', ');
  sql(`
    BEGIN;
    CREATE SCHEMA ${namespace};
    CREATE TABLE ${namespace}.writes (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      happened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      relation_name text NOT NULL,
      action text NOT NULL,
    transaction_id bigint NOT NULL,
    changed_columns text[] NOT NULL,
    json_paths jsonb NOT NULL,
    metadata_valid boolean NOT NULL
    );
  CREATE FUNCTION ${namespace}.key_paths(value jsonb, prefix text DEFAULT '') RETURNS text[]
  LANGUAGE plpgsql SET search_path = pg_catalog, ${namespace} AS $paths$
  DECLARE item record; result text[] := ARRAY[]::text[]; path text;
  BEGIN
    IF jsonb_typeof(value) = 'object' THEN
      FOR item IN SELECT entry.key, entry.child FROM jsonb_each(value) AS entry(key, child) LOOP
        path := prefix || '.' || CASE WHEN item.key ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'
          THEN item.key ELSE '<unsafe-key>' END;
        result := result || path || ${namespace}.key_paths(item.child, path);
      END LOOP;
    ELSIF jsonb_typeof(value) = 'array' THEN
      FOR item IN SELECT entry.child FROM jsonb_array_elements(value) AS entry(child) LOOP
        result := result || ${namespace}.key_paths(item.child, prefix || '[]');
      END LOOP;
    END IF;
    RETURN result;
  END $paths$;
    CREATE FUNCTION ${namespace}.track_write() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ${namespace} AS $fn$
  DECLARE
    old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
    new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
    columns text[];
    paths jsonb;
    valid boolean := false;
    BEGIN
    SELECT coalesce(array_agg(key ORDER BY key), ARRAY[]::text[]) INTO columns
    FROM jsonb_each(CASE WHEN TG_OP = 'DELETE' THEN old_row ELSE new_row END) AS field(key, value)
    WHERE (TG_OP = 'UPDATE' AND old_row -> key IS DISTINCT FROM value)
      OR (TG_OP <> 'UPDATE' AND value <> 'null'::jsonb);
    SELECT coalesce(jsonb_object_agg(key, to_jsonb(${namespace}.key_paths(value, key))), '{}'::jsonb)
      INTO paths
    FROM jsonb_each(CASE WHEN TG_OP = 'DELETE' THEN old_row ELSE new_row END) AS field(key, value)
    WHERE key = ANY(columns) AND jsonb_typeof(value) IN ('object', 'array');
    IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME IN
      ('meetings', 'glossary_categories', 'glossary_entries', 'meeting_glossary_entries',
       'viewer_shares', 'meeting_members') THEN
      valid := true;
    ELSIF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' THEN
      valid := OLD.status = 'pending' AND NEW.status = 'active'
        AND OLD.id = NEW.id AND columns <@ ARRAY['status', 'updated_at']::text[]
        AND array_length(columns, 1) = 2;
    ELSIF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'observability_metric_buckets'
      AND TG_OP IN ('INSERT', 'UPDATE') THEN
      valid := NEW.metric_name = ANY(ARRAY[${metricNames}]::text[])
        AND NEW.instance_id ~ '^instance-[0-9]+$'
        AND NEW.operation IN ('none', 'translation', 'polishing', 'token', 'viewer')
        AND NEW.provider IN ('none', 'gemini')
        AND NEW.status_class IN ('none', '200', '401', '403', '429', '5xx', 'other');
    END IF;
    INSERT INTO ${namespace}.writes (relation_name, action, transaction_id,
      changed_columns, json_paths, metadata_valid)
    VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP, txid_current(), columns, paths, valid);
      RETURN COALESCE(NEW, OLD);
    END
    $fn$;
    DO $block$
    DECLARE target record;
    BEGIN
      FOR target IN
        SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND (table_schema = 'public' OR (table_schema = 'storage' AND table_name = 'objects'))
      LOOP
        EXECUTE format(
          'CREATE TRIGGER ${triggerName} AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION ${namespace}.track_write()',
          target.table_schema, target.table_name
        );
      END LOOP;
    END
    $block$;
    COMMIT;
  `);
  return auditTriggerCoverage();
}

export function auditTriggerCoverage() {
  const namespace = auditNamespace();
  const expectedTables = sql(`SELECT table_schema || '.' || table_name
    FROM information_schema.tables WHERE table_type = 'BASE TABLE'
    AND (table_schema = 'public' OR (table_schema = 'storage' AND table_name = 'objects'))
    ORDER BY 1`).split('\n').filter(Boolean);
  const monitoredTables = sql(`SELECT n.nspname || '.' || c.relname
    FROM pg_trigger AS t
    JOIN pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE t.tgname = '${namespace}_write'
      AND t.tgfoid = '${namespace}.track_write()'::regprocedure
      AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 29
    ORDER BY 1`).split('\n').filter(Boolean);
  if (!expectedTables.length || expectedTables.join(',') !== monitoredTables.join(',')) {
    throw new Error('Issue 41 audit trigger coverage is incomplete');
  }
  return { namespace, expectedTables, monitoredTables };
}

export function databaseSnapshot() {
  const names = sql(`SELECT table_schema || '.' || table_name
    FROM information_schema.tables WHERE table_type = 'BASE TABLE'
    AND (table_schema = 'public' OR (table_schema = 'storage' AND table_name = 'objects'))
    ORDER BY 1`).split('\n').filter(Boolean);
  const tables = {};
  for (const name of names) {
    if (!/^(public|storage)\.[a-z_]+$/u.test(name)) throw new Error(`Unexpected relation ${name}`);
    tables[name] = JSON.parse(sql(`SELECT json_build_object(
      'count', count(*),
      'digest', md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text), ''))
    ) FROM ${name} AS t`));
  }
  return {
    tables,
    migrations: sql("SELECT version FROM supabase_migrations.schema_migrations ORDER BY version").split('\n').filter(Boolean)
  };
}

export function recordedWrites() {
  const namespace = auditNamespace();
  return JSON.parse(sql(`SELECT coalesce(json_agg(row_to_json(w) ORDER BY id), '[]'::json)
    FROM ${namespace}.writes AS w`));
}

export function rolledBackRecordingWriteControl(meetingId) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(meetingId)) {
    throw new Error('Negative control requires an isolated Meeting UUID');
  }
  const namespace = auditNamespace();
  const before = sql(`SELECT count(*) FROM public.meeting_recordings WHERE meeting_id = '${meetingId}'`);
  if (before !== '0') throw new Error('Negative control Meeting has an existing cloud recording');
  const observed = sql(`BEGIN;
    INSERT INTO public.meeting_recordings (owner_user_id, meeting_id)
      SELECT owner_user_id, id FROM public.meetings WHERE id = '${meetingId}';
    SELECT count(*) FROM ${namespace}.writes
      WHERE relation_name = 'public.meeting_recordings' AND action = 'INSERT'
        AND metadata_valid = false AND transaction_id = txid_current();
    ROLLBACK;`);
  const after = sql(`SELECT count(*) FROM public.meeting_recordings WHERE meeting_id = '${meetingId}'`);
  const persistedAuditRows = sql(`SELECT count(*) FROM ${namespace}.writes
    WHERE relation_name = 'public.meeting_recordings'`);
  let contentGuardRejected = false;
  try {
    sql('INSERT INTO public.subtitle_cues DEFAULT VALUES');
  } catch (error) {
    contentGuardRejected = String(error.stderr || '').includes('meeting_content_local_only');
  }
  return { observedIllegalWrite: observed === '1', before: Number(before), after: Number(after),
    persistedAuditRows: Number(persistedAuditRows), rolledBack: after === '0' && persistedAuditRows === '0',
    contentGuardRejected };
}
