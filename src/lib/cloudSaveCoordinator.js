const VALID_KINDS = new Set(['cue', 'checkpoint', 'terminal']);

export function createCloudSaveCoordinator({ onChange } = {}) {
  if (onChange !== undefined && typeof onChange !== 'function') {
    throw new TypeError('onChange must be a function.');
  }

  const operations = new Map();

  return Object.freeze({
    begin(input = {}) {
      const id = required(input.id, 'id');
      const kind = VALID_KINDS.has(input.kind) ? input.kind : 'checkpoint';
      const previous = operations.get(id);
      operations.set(id, { id, kind, state: previous?.state === 'failed' ? 'retrying' : 'pending', error: null });
      return emit();
    },

    retry(id) {
      const key = required(id, 'id');
      const previous = operations.get(key);
      operations.set(key, { id: key, kind: previous?.kind || 'checkpoint', state: 'retrying', error: null });
      return emit();
    },

    succeed(id) {
      operations.delete(required(id, 'id'));
      return emit();
    },

    fail(id, error) {
      const key = required(id, 'id');
      const previous = operations.get(key);
      operations.set(key, { id: key, kind: previous?.kind || 'checkpoint', state: 'failed', error: safeError(error) });
      return emit();
    },

    snapshot() {
      return snapshotFor(operations);
    }
  });

  function emit() {
    const snapshot = snapshotFor(operations);
    onChange?.(snapshot);
    return snapshot;
  }
}

function snapshotFor(operations) {
  const values = [...operations.values()];
  const failed = values.filter((operation) => operation.state === 'failed');
  const retrying = values.filter((operation) => operation.state === 'retrying');
  const pending = values.filter((operation) => operation.state === 'pending');
  const state = failed.length > 0
    ? 'cloud_failed'
    : retrying.length > 0
      ? 'cloud_retrying'
      : pending.length > 0
        ? 'cloud_pending'
        : 'cloud_synced';

  return Object.freeze({
    state,
    pendingCount: pending.length,
    retryingCount: retrying.length,
    failedCount: failed.length,
    error: failed.at(-1)?.error || null
  });
}

function safeError(error) {
  return Object.freeze({
    status: Number.isInteger(error?.status) ? error.status : null,
    code: typeof error?.code === 'string' ? error.code : null,
    requestId: typeof error?.requestId === 'string' ? error.requestId : null,
    message: typeof error?.message === 'string' ? error.message : null
  });
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name} is required.`);
  return normalized;
}
