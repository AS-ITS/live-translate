// Keep setup failures visible until the Cue job has actually reached the writer.
export function createPreCoordinatorCueRetry() {
  const failed = [];

  async function drain() {
    while (failed.length) {
      await failed[0]();
      failed.shift();
    }
  }

  return Object.freeze({
    async run(task, wasRegistered) {
      try {
        await drain();
        return await task();
      } catch (error) {
        if (!wasRegistered()) failed.push(task);
        throw error;
      }
    },
    drain,
    get pendingCount() { return failed.length; }
  });
}
