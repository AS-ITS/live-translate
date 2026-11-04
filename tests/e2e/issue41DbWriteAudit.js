import { execFileSync } from 'node:child_process';

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
  sql(`
    BEGIN;
    CREATE SCHEMA ${namespace};
    CREATE TABLE ${namespace}.writes (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      happened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      relation_name text NOT NULL,
      action text NOT NULL,
      transaction_id bigint NOT NULL
    );
    CREATE FUNCTION ${namespace}.track_write() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ${namespace} AS $fn$
    BEGIN
      INSERT INTO ${namespace}.writes (relation_name, action, transaction_id)
      VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP, txid_current());
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
