export async function waitForDurabilityPromises(promises, {
  timeoutMs = 5_000,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout
} = {}) {
  const pending = Array.from(promises || []);
  if (pending.length === 0) return { settlements: [], timedOut: false, pendingCount: 0 };

  const settlements = new Array(pending.length);
  let settledCount = 0;
  let timer = null;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });

  pending.forEach((promise, index) => {
    Promise.resolve(promise).then(
      (value) => { settlements[index] = { status: 'fulfilled', value }; },
      (reason) => { settlements[index] = { status: 'rejected', reason }; }
    ).finally(() => {
      settledCount += 1;
      if (settledCount === pending.length) finish('settled');
    });
  });

  const timeout = new Promise((resolve) => {
    timer = setTimeoutFn(() => resolve('timeout'), Math.max(1, Math.floor(timeoutMs)));
  });
  const outcome = await Promise.race([completed, timeout]);
  clearTimeoutFn(timer);
  return {
    settlements: settlements.filter(Boolean),
    timedOut: outcome === 'timeout',
    pendingCount: pending.length - settledCount
  };
}
