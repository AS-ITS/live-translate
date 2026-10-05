import { createMeetingPurgeWorker } from '../application/meetingPurgeWorker.js';
import { randomUUID } from 'node:crypto';
import { createSupabaseMeetingPurgeRepository } from './supabaseMeetingPurgeRepository.js';
import { createSupabaseMeetingPurgeStorage } from './supabaseMeetingPurgeStorage.js';

export function createSupabaseMeetingPurgeComposition({ env = process.env, fetchImpl = globalThis.fetch, workerId = randomUUID(), observabilityMetrics } = {}) {
  const repository = createSupabaseMeetingPurgeRepository({ env, fetchImpl });
  const storage = createSupabaseMeetingPurgeStorage({ env, fetchImpl });
  if (!repository || !storage) return null;
  return Object.freeze({
    meetingPurgeWorker: createMeetingPurgeWorker({ repository, storage, workerId, observabilityMetrics })
  });
}
