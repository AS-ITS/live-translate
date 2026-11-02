import { createLocalPcmGapLedger } from './localPcmGapLedger.js';

const DEFAULT_PENDING_BYTES = 512 * 1024;
let nextDiagnosticClientId = 0;
const BATCH_BYTES = 32_000; // one second of 16 kHz mono PCM16

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function createDurablePcmJournalClient({ meetingId, recordingId, workerFactory = () => new Worker(
  new URL('./durablePcmJournal.worker.js', import.meta.url), { type: 'module' }
), onStatus = () => {}, gapStore = createLocalPcmGapLedger(),
maxPendingBytes = DEFAULT_PENDING_BYTES, commitIntervalMs = 1000 } = {}) {
  if (typeof meetingId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(meetingId)) {
    throw new TypeError('valid meetingId required');
  }
  if (typeof recordingId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(recordingId)) {
    throw new TypeError('valid recordingId required');
  }
  const worker = workerFactory();
  const requests = new Map();
  const tasks = [];
  let requestId = 0;
  const diagnosticClientId = ++nextDiagnosticClientId;
  const endDiagnostic = (stage, details = {}) => console.info('ISSUE41_PCM_END', JSON.stringify({ stage, recordingId, clientId: diagnosticClientId, ...details }));
  let opening;
  let ready = false;
  let baseEpoch = 0;
  let startedEpoch = 0;
  let localEpoch = 1;
  let connectionKey;
  let cursor = 0;
  let batch = [];
  let batchBytes = 0;
  let batchStart = 0;
  let pendingBytes = 0;
  let timer;
  let pumping = false;
  let failure = null;
  let recoveryTailState = null;
  let state = 'OPENING';
  let persisted = null;
  let estimatedRemainingBytes = null;
  const gaps = [];
  const gapWrites = new Set();
  const gapSessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

  function recordGap(range, code) {
    const captureEpoch = ready ? baseEpoch + range.localEpoch : null;
    const id = `${recordingId}:${captureEpoch ?? gapSessionId}:${range.startSample}:${range.endSample}:${code}`;
    if (gaps.some((gap) => gap.id === id)) return;
    const gap = { id, meetingId, recordingId,
      captureEpoch,
      localEpoch: range.localEpoch, startSample: range.startSample,
      endSample: range.endSample, code, createdAt: new Date().toISOString(),
      persistenceState: 'pending' };
    gaps.push(gap);
    onStatus({ state: 'GAP_RECORDED', meetingId, recordingId, pendingBytes, gap: { ...gap } });
    const write = Promise.resolve().then(() => gapStore.append({ ...gap, persistenceState: 'durable' }))
      .then(() => { gap.persistenceState = 'durable'; })
      .catch((error) => {
        gap.persistenceState = 'failed';
        onStatus({ state: 'GAP_LEDGER_ERROR', meetingId, recordingId, gap: { ...gap },
          code: error?.code || 'GAP_LEDGER_WRITE_FAILED' });
      }).finally(() => gapWrites.delete(write));
    gapWrites.add(write);
  }

  function emit(next, detail = {}) {
    state = next;
    onStatus({ state, meetingId, recordingId, pendingBytes, ...detail });
  }

  function fail(error) {
    failure = error instanceof Error ? error : new Error(String(error));
    for (const task of tasks) {
      if (task.kind === 'pcm') recordGap(task, failure.code || failure.name || 'JOURNAL_ERROR');
    }
    if (batch.length) recordGap({ localEpoch, startSample: batchStart,
      endSample: batchStart + batchBytes / 2 }, failure.code || failure.name || 'JOURNAL_ERROR');
    emit('DEGRADED', { code: failure.code || failure.name || 'JOURNAL_ERROR', message: failure.message });
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(failure); }
    requests.clear();
    for (const task of tasks.splice(0)) task.result.reject(failure);
    pendingBytes = 0;
    batch = [];
    batchBytes = 0;
    clearTimeout(timer);
  }

  worker.onmessage = ({ data }) => {
    const request = requests.get(data.id);
    if (!request) return;
    if (request.command === 'END' || request.command === 'CLOSE') endDiagnostic('WORKER_REPLY', { command: request.command, requestId: data.id, captureEpoch: request.captureEpoch ?? null, ok: data.ok, code: data.error?.code ?? null });
    clearTimeout(request.timer);
    requests.delete(data.id);
    if (data.ok) request.resolve(data.result);
    else {
      const error = new Error(data.error?.message || 'Journal worker failed');
      error.code = data.error?.code || 'JOURNAL_WORKER_ERROR';
      request.reject(error);
    }
  };
  worker.onerror = (event) => fail(new Error(event?.message || 'Journal worker crashed'));

  function rpc(command, args = {}, transfer = []) {
    if (failure) return Promise.reject(failure);
    const id = ++requestId;
    if (command === 'END' || command === 'CLOSE' || command === 'OPEN') endDiagnostic('WORKER_REQUEST', { command, requestId: id, captureEpoch: args.captureEpoch ?? null });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        requests.delete(id);
        const error = new Error('JOURNAL_WORKER_TIMEOUT');
        error.code = 'JOURNAL_WORKER_TIMEOUT';
        reject(error);
      }, 10_000);
      timeout.unref?.();
      requests.set(id, { resolve, reject, timer: timeout, command, captureEpoch: args.captureEpoch });
      try { worker.postMessage({ id, command, args, diagnosticClientId }, transfer); }
      catch (error) { clearTimeout(timeout); requests.delete(id); reject(error); }
    });
  }

  async function pump() {
    if (!ready || pumping || failure) return;
    pumping = true;
    try {
      while (tasks.length) {
        const task = tasks[0];
        const captureEpoch = baseEpoch + task.localEpoch;
        if (task.kind === 'pcm' && startedEpoch !== captureEpoch) {
          await rpc('BEGIN', { captureEpoch });
          startedEpoch = captureEpoch;
        }
        const args = task.kind === 'pcm'
          ? { operationId: `r${captureEpoch}_${task.startSample}_${task.endSample}`,
            captureEpoch, startSample: task.startSample, bytes: task.bytes }
          : { captureEpoch, endSample: task.endSample };
        if (task.kind === 'pcm') emit('WRITTEN_UNCOMMITTED', { captureEpoch,
          startSample: task.startSample, endSample: task.endSample });
        const result = await rpc(task.kind === 'pcm' ? 'APPEND' : 'END', args,
          task.kind === 'pcm' ? [task.bytes.buffer] : []);
        tasks.shift();
        if (task.kind === 'pcm') pendingBytes -= task.byteLength;
        task.result.resolve(result);
        emit('COMMITTED', { captureEpoch, endSample: task.endSample });
      }
    } catch (error) { fail(error); }
    finally { pumping = false; }
  }

  function schedule(task) {
    task.result = deferred();
    task.result.promise.catch(() => {}); // callers may use fire-and-forget capture
    tasks.push(task);
    void pump();
    return task.result.promise;
  }

  function flushBatch() {
    clearTimeout(timer);
    timer = null;
    if (!batch.length) return null;
    const bytes = new Uint8Array(batchBytes);
    let at = 0;
    for (const part of batch) { bytes.set(part, at); at += part.length; }
    const task = { kind: 'pcm', localEpoch, startSample: batchStart,
      endSample: batchStart + bytes.length / 2, byteLength: bytes.length, bytes };
    batch = [];
    batchBytes = 0;
    return schedule(task);
  }

  function rotate() {
    flushBatch();
    const endScheduled = startedEpoch === baseEpoch + localEpoch
      || tasks.some((task) => task.localEpoch === localEpoch && task.kind === 'pcm');
    endDiagnostic('ROTATE', { captureEpoch: baseEpoch + localEpoch, localEpoch, startedEpoch, endScheduled, pendingTasks: tasks.length, endSample: cursor });
    if (endScheduled) {
      schedule({ kind: 'end', localEpoch, endSample: cursor });
    }
    localEpoch += 1;
    cursor = 0;
  }

  return Object.freeze({
    open() {
      if (opening) return opening;
      opening = rpc('OPEN', { meetingId, recordingId }).then(async (result) => {
        baseEpoch = result.highestEpoch;
        ready = true;
        if (result.tailState !== 'CLEAN') {
          recoveryTailState = result.tailState;
          emit('DEGRADED', { code: recoveryTailState, ...result });
          const error = new Error(recoveryTailState);
          error.code = recoveryTailState;
          for (const task of tasks.splice(0)) task.result.reject(error);
          pendingBytes = 0;
          batch = [];
          batchBytes = 0;
        } else {
          await rpc('BEGIN', { captureEpoch: baseEpoch + 1 });
          startedEpoch = baseEpoch + 1;
          emit('READY', result);
          void pump();
        }
        const storage = globalThis.navigator?.storage;
        if (!recoveryTailState) void storage?.persisted?.().then((value) => {
          persisted = value;
          if (value === false) emit('EVICTION_RISK');
        }).catch(() => {});
        if (!recoveryTailState) void storage?.estimate?.().then(({ quota, usage }) => {
          if (Number.isFinite(quota) && Number.isFinite(usage)) {
            estimatedRemainingBytes = Math.max(0, quota - usage);
            if (estimatedRemainingBytes < 64 * 1024 * 1024) emit('LOW_STORAGE', { estimatedRemainingBytes });
          }
        }).catch(() => {});
        return result;
      }).catch((error) => { fail(error); throw error; });
      return opening;
    },
    offer(bytes, { connectionEpoch } = {}) {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length % 2 !== 0) {
        return { state: 'REJECTED', code: 'INVALID_PCM' };
      }
      const nextKey = connectionEpoch ?? 'default';
      if (connectionKey === undefined) connectionKey = nextKey;
      else if (connectionKey !== nextKey) { rotate(); connectionKey = nextKey; }
      const range = { startSample: cursor, endSample: cursor + bytes.length / 2, localEpoch };
      cursor = range.endSample;
      if (failure || recoveryTailState || pendingBytes + bytes.length > maxPendingBytes) {
        flushBatch();
        recordGap(range, failure?.code || recoveryTailState || 'BACKPRESSURE_GAP');
        emit(failure || recoveryTailState ? 'DEGRADED' : 'BACKPRESSURE_GAP', { range });
        return { state: 'REJECTED', code: failure?.code || recoveryTailState || 'BACKPRESSURE_GAP', range };
      }
      if (batchBytes && batchBytes + bytes.length > BATCH_BYTES) flushBatch();
      if (!batch.length) {
        batchStart = range.startSample;
        timer = setTimeout(() => flushBatch(), commitIntervalMs);
        timer.unref?.();
      }
      batch.push(new Uint8Array(bytes));
      batchBytes += bytes.length;
      pendingBytes += bytes.length;
      if (batchBytes >= BATCH_BYTES) flushBatch();
      return { state: 'QUEUED', range };
    },
    async flush({ endEpoch = false } = {}) {
      if (endEpoch) endDiagnostic('FLUSH_ENTER', { captureEpoch: baseEpoch + localEpoch, localEpoch, startedEpoch, pendingTasks: tasks.length });
      if (recoveryTailState) return this.status();
      flushBatch();
      if (endEpoch) { rotate(); connectionKey = undefined; }
      await this.open();
      while (tasks.length && !failure) {
        const task = tasks.at(-1);
        await task.result.promise;
      }
      if (failure) throw failure;
      if (endEpoch) endDiagnostic('FLUSH_AWAITED', { captureEpoch: baseEpoch + localEpoch - 1, pendingTasks: tasks.length, code: this.status().code ?? null });
      return this.status();
    },
    async coverage(captureEpoch, startSample, endSample) {
      await this.flush();
      return rpc('COVERAGE', { captureEpoch, startSample, endSample });
    },
    async whenCommitted(captureEpoch, startSample, endSample) {
      const coverage = await this.coverage(captureEpoch, startSample, endSample);
      if (!coverage.complete) {
        const error = new Error('SAMPLE_RANGE_NOT_COMMITTED');
        error.code = 'SAMPLE_RANGE_NOT_COMMITTED';
        throw error;
      }
      return { state: 'COMMITTED', captureEpoch, startSample, endSample };
    },
    async readRange(captureEpoch, startSample, endSample) {
      await this.flush();
      return rpc('READ', { captureEpoch, startSample, endSample });
    },
    async recover() { await this.open(); return rpc('STATUS'); },
    gapLedger() { return gaps.map((gap) => ({ ...gap })); },
    async whenGapsPersisted() { await Promise.all([...gapWrites]); return this.gapLedger(); },
    async readPersistedGaps() { return gapStore.list(recordingId); },
    async reconcileGaps() { return gapStore.reconcile(recordingId); },
    status() { return { state, recordingId, pendingBytes, captureEpoch: baseEpoch + localEpoch,
      nextSample: cursor, code: failure?.code || recoveryTailState, persisted, estimatedRemainingBytes,
      gaps: this.gapLedger() }; },
    async close() {
      endDiagnostic('CLIENT_CLOSE_ENTER', { captureEpoch: baseEpoch + localEpoch, localEpoch, startedEpoch, recoveryTailState, pendingTasks: tasks.length });
      try {
        if (!recoveryTailState) await this.flush({ endEpoch: true });
        await rpc('CLOSE');
        endDiagnostic('CLIENT_CLOSE_AWAITED', { captureEpoch: baseEpoch + localEpoch - 1, pendingTasks: tasks.length, code: this.status().code ?? null });
      } finally {
        worker.terminate();
        await this.whenGapsPersisted();
      }
    }
  });
}
