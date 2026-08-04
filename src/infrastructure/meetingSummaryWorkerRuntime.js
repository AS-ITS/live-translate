export function createMeetingSummaryWorkerRuntime({ worker, activeQueue, jobRepository, recovery, clock = () => new Date().toISOString(), pollIntervalMs = 1000, scheduler = defaultScheduler, logger } = {}) {
  if (!worker || typeof worker.processNext !== 'function') throw new TypeError('summary worker is required.');
  if (!activeQueue || typeof activeQueue.size !== 'function') throw new TypeError('summary activeQueue is required.');
  if (!jobRepository || typeof jobRepository.listAvailable !== 'function' || typeof jobRepository.nextAvailableAt !== 'function') throw new TypeError('summary jobRepository is required.');
  if (!recovery || typeof recovery.recover !== 'function') throw new TypeError('summary recovery is required.');
  let started = false;
  let processing = false;
  let timer;

  function start() { if (started) return; started = true; schedule(false); }
  function stop() { started = false; if (timer !== undefined) { if (timer !== PENDING) scheduler.clear(timer); timer = undefined; } }
  function wake() { if (!started || processing) return; if (timer !== undefined && timer !== PENDING) scheduler.clear(timer); timer = scheduler.set(process, 0); }
  function schedule(resolve) {
    if (!started || timer !== undefined) return;
    if (!resolve) { timer = scheduler.set(process, pollIntervalMs); return; }
    timer = PENDING;
    Promise.resolve(jobRepository.nextAvailableAt(clock())).then((at) => {
      if (!started || timer !== PENDING) return;
      const delay = at ? Math.min(pollIntervalMs, Math.max(0, new Date(at).getTime() - new Date(clock()).getTime())) : pollIntervalMs;
      timer = scheduler.set(process, delay);
    }).catch((error) => { logger?.(error); if (started && timer === PENDING) timer = scheduler.set(process, pollIntervalMs); });
  }
  async function process() {
    timer = undefined;
    if (!started || processing) return schedule(true);
    processing = true;
    try {
      if (activeQueue.size() === 0) {
        for (const job of await jobRepository.listAvailable(clock())) await activeQueue.enqueue({ jobId: job.jobId, sessionId: job.sessionId, meetingId: job.meetingId });
      }
      if (activeQueue.size() > 0) await worker.processNext();
    } catch (error) { logger?.(error); } finally { processing = false; schedule(true); }
  }
  return Object.freeze({ start, stop, wake, isRunning: () => started || processing, recover: () => recovery.recover() });
}

const PENDING = Symbol('pending_schedule');
const defaultScheduler = Object.freeze({ set: (callback, delay) => setTimeout(callback, delay), clear: (handle) => clearTimeout(handle) });
