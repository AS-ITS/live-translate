const SOURCE_FIELDS = ['sourceText', 'rawSource', 'sourceStatus', 'sourceProvenance'];
const TRANSLATION_FIELDS = ['translatedText', 'rawTranslation', 'translationStatus', 'initialTranslation', 'translationProvenance'];
const REFINEMENT_FIELDS = ['refinement', 'refinedSource', 'refinedTranslation'];

function changed(before, after, fields) {
  return fields.some((field) => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null));
}

export function cueMutationsForChange(before, cue) {
  if (!before || before.status !== 'final') return [{ side: 'initial', cue }];
  const mutations = [];
  if (changed(before, cue, SOURCE_FIELDS)) mutations.push({ side: 'source', cue });
  if (changed(before, cue, TRANSLATION_FIELDS)) mutations.push({ side: 'translation', cue });
  if (changed(before, cue, REFINEMENT_FIELDS)) mutations.push({ side: 'refinement', cue });
  return mutations;
}

export function createCueMutationCoordinator({ commit, onAck, onReject, onError,
  onPending,
  createEventKey = () => globalThis.crypto.randomUUID() } = {}) {
  if (typeof commit !== 'function') throw new TypeError('Cue commit function required.');
  let queue = Promise.resolve();
  const failures = new Map();
  return Object.freeze({
    enqueue({ meetingId, segmentId, changes = [] }) {
      const jobs = changes.flatMap(({ before, cue, side }) => (side === 'pending'
        ? [{ side, cue }] : cueMutationsForChange(before, cue))
        .map((mutation) => ({ meetingId, segmentId, eventKey: createEventKey(), ...mutation })));
      const work = queue.catch(() => {}).then(async () => {
        const results = [];
      for (const [mutationIndex, job] of jobs.entries()) {
          const failureKey = JSON.stringify([job.meetingId, job.segmentId, job.cue.cueId]);
          try {
            const result = await commit(job);
            results.push({ job, result });
            if (result?.status === 'committed' || result?.status === 'duplicate') {
              failures.delete(failureKey);
              onAck?.(result, job);
            } else if (result?.status === 'pending') {
              failures.delete(failureKey);
              onPending?.(result, job);
            } else {
            failures.set(failureKey, { job, result, mutationCount: jobs.length, mutationIndex });
              onReject?.(result, job);
            }
          } catch (error) {
            results.push({ job, error });
          failures.set(failureKey, { job, error, mutationCount: jobs.length, mutationIndex });
            onError?.(error, job);
          }
        }
        return results;
      });
      queue = work;
      return work;
    },
    flush() { return queue.then(() => [...failures.values()]); }
  });
}
