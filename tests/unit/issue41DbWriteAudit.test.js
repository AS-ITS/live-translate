import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.ISSUE41_ISOLATED_DB_CONTAINER = 'supabase_db_issue41-audit-test';
const { auditNamespace, installWriteAudit } = await import('../e2e/issue41DbWriteAudit.js');

test('audit namespace accepts only a per-run lowercase hex identifier', () => {
  const previous = process.env.ISSUE41_AUDIT_NAMESPACE;
  try {
    const valid = `issue41_audit_${'a'.repeat(24)}`;
    process.env.ISSUE41_AUDIT_NAMESPACE = valid;
    assert.equal(auditNamespace(), valid);
    for (const invalid of [
      'issue41_audit',
      `issue41_audit_${'A'.repeat(24)}`,
      `issue41_audit_${'a'.repeat(23)}`,
      `issue41_audit_${'a'.repeat(24)};DROP SCHEMA public`
    ]) {
      process.env.ISSUE41_AUDIT_NAMESPACE = invalid;
      assert.throws(() => installWriteAudit(), /valid per-run namespace/u);
    }
  } finally {
    if (previous === undefined) delete process.env.ISSUE41_AUDIT_NAMESPACE;
    else process.env.ISSUE41_AUDIT_NAMESPACE = previous;
  }
});
