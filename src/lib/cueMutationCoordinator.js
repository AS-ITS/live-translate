import { cueRefinementInputHash } from './cueContent.js';
import { recordFirstInitialProvenance } from './firstInitialProvenanceTrace.js';

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
      let jobs;
      try {
        jobs = changes.flatMap(({ before, cue, side }) => (side === 'pending'
          ? [{ side, cue }] : cueMutationsForChange(before, cue))
          .map((mutation) => ({ meetingId, segmentId, eventKey: createEventKey(), ...mutation })));
      } catch (error) {
        onError?.(error, { meetingId, segmentId, side: changes[0]?.side,
          cue: { cueId: changes[0]?.cue?.cueId } }, 'enqueue');
        throw error;
      }
      const work = queue.catch(() => {}).then(async () => {
        const results = [];
      const failedThisBatch = new Set();
      const acceptedAuthority = new Map();
      for (const [mutationIndex, job] of jobs.entries()) {
          const failureKey = JSON.stringify([job.meetingId, job.segmentId, job.cue.cueId]);
          try {
          const before = changes.find((change) => change.cue?.cueId === job.cue.cueId)?.before;
          const accepted = acceptedAuthority.get(failureKey);
          const staleRefinement = job.side === 'refinement' && before && accepted
            && job.cue.refinement?.inputHash === cueRefinementInputHash(before)
            && job.cue.refinement.inputHash !== cueRefinementInputHash(accepted)
            && (accepted.sourceVersion > before.sourceVersion
              || accepted.translationVersion > before.translationVersion);
          const redundantPending = job.side === 'refinement' && accepted
            && job.cue.refinement?.status === 'pending'
            && job.cue.refinedSource == null && job.cue.refinedTranslation == null
            && job.cue.refinement.inputHash === cueRefinementInputHash(job.cue)
            && accepted.refinement?.inputHash === cueRefinementInputHash(accepted)
            && Number.isSafeInteger(accepted.translationProvenance?.eventSequence)
            && Number.isSafeInteger(accepted.translationProvenance?.connectionEpoch)
            && Number.isSafeInteger(accepted.translationProvenance?.providerEpoch)
            && ['rawSource', 'rawTranslation', 'initialTranslation', 'sourceVersion', 'translationVersion']
              .every((field) => job.cue[field] === accepted[field]);
          if (job.side === 'initial' && job.cue.translatedText) {
            const provenance = job.cue.translationProvenance;
            recordFirstInitialProvenance('before_initial_commit', {
              cueId: job.cue.cueId, turnId: provenance?.audioTurnId ?? job.cue.audioTurnId,
              connectionEpoch: provenance?.connectionEpoch,
              providerEpoch: provenance?.providerEpoch,
              eventSequence: provenance?.eventSequence,
              providerEventId: provenance?.providerEventId,
              providerTurnIndex: job.cue.turnIndex,
              previousTranslationVersion: 0, translationVersion: job.cue.translationVersion
            });
          }
          const result = staleRefinement || redundantPending
            ? { status: 'duplicate', reason: 'stale_refinement_invalidated', cue: accepted }
            : await commit(job);
            results.push({ job, result });
          if ((job.side === 'source' || job.side === 'translation')
            && (result?.status === 'committed' || result?.status === 'duplicate')) {
            acceptedAuthority.set(failureKey, result.cue);
          }
            if (result?.status === 'committed' || result?.status === 'duplicate') {
          if (!failedThisBatch.has(failureKey)) failures.delete(failureKey);
              onAck?.(result, job);
            } else if (result?.status === 'pending') {
          if (!failedThisBatch.has(failureKey)) failures.delete(failureKey);
              onPending?.(result, job);
            } else {
          if (!failedThisBatch.has(failureKey)) {
            failures.set(failureKey, { job, result, mutationCount: jobs.length, mutationIndex });
            failedThisBatch.add(failureKey);
          }
              onReject?.(result, job, 'commit');
            }
          } catch (error) {
            results.push({ job, error });
        if (!failedThisBatch.has(failureKey)) {
          failures.set(failureKey, { job, error, mutationCount: jobs.length, mutationIndex });
          failedThisBatch.add(failureKey);
        }
            onError?.(error, job, 'commit');
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
