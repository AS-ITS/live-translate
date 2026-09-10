import {
  BACKGROUND_JOB_MAX_ATTEMPTS,
  BACKGROUND_JOB_VISIBILITY_TIMEOUT_SECONDS,
  assertBackgroundJobMessage,
  createBackgroundJobMessage
} from '../application/backgroundJobs.js';

const RPC = Object.freeze({
  send: 'background_job_enqueue',
  read: 'background_job_claim',
  renew: 'background_job_renew',
  acknowledge: 'background_job_acknowledge',
  retry: 'background_job_retry',
  archive: 'background_job_archive',
  depth: 'background_job_depth'
});

export function createSupabaseBackgroundJobQueue({ client, queueName, clock = () => Date.now(), leaseSeconds = BACKGROUND_JOB_VISIBILITY_TIMEOUT_SECONDS } = {}) {
  if (!client || typeof client.request !== 'function') throw new TypeError('Supabase client is required.');
  if (typeof queueName !== 'string' || queueName.trim() === '') throw new TypeError('queueName is required.');

  const call = (name, body) => client.request(`rpc/${name}`, { method: 'POST', body });
  return Object.freeze({
    async enqueue(message) {
      const safeMessage = assertBackgroundJobMessage(message);
      const rows = await call(RPC.send, { queue_name: queueName, message: safeMessage });
      return rows?.[0] ?? rows ?? null;
    },
    async claim({ limit = 1, leaseSeconds: requestedLeaseSeconds = leaseSeconds } = {}) {
      const rows = await call(RPC.read, { queue_name: queueName, visibility_timeout: requestedLeaseSeconds, quantity: limit });
      return (Array.isArray(rows) ? rows : []).map(normalizeClaim);
    },
    async renew({ messageId, readCt, leaseSeconds: requestedLeaseSeconds = leaseSeconds }) {
      return call(RPC.renew, { queue_name: queueName, message_id: messageId, read_ct: readCt, visibility_timeout: requestedLeaseSeconds });
    },
    async acknowledge({ messageId, readCt }) {
      return call(RPC.acknowledge, { queue_name: queueName, message_id: messageId, read_ct: readCt });
    },
    async retry({ messageId, readCt, attempt, errorCode, message }) {
      if (attempt >= BACKGROUND_JOB_MAX_ATTEMPTS) {
        return call(RPC.archive, { queue_name: queueName, message_id: messageId, read_ct: readCt, attempt, error_code: errorCode || 'background_job_retry_exhausted', message: message || null });
      }
      return call(RPC.retry, { queue_name: queueName, message_id: messageId, read_ct: readCt, attempt, error_code: errorCode || null });
    },
    async depth() {
      const rows = await call(RPC.depth, { queue_name: queueName });
      return Number(rows?.[0]?.depth ?? rows?.depth ?? 0);
    },
    now: () => clock()
  });
}

function normalizeClaim(row) {
  const message = typeof row?.message === 'string' ? JSON.parse(row.message) : row?.message;
  return Object.freeze({
    messageId: String(row?.msg_id ?? row?.message_id ?? ''),
    readCt: Number(row?.read_ct ?? 0),
    visibilityTimeoutAt: row?.vt ?? null,
    message: createBackgroundJobMessage(message)
  });
}
