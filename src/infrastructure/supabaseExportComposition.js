import { createExportArtifactService } from '../application/exportArtifactService.js';
import { createExportWorker } from '../application/exportWorker.js';
import { BACKGROUND_JOB_QUEUES } from '../application/backgroundJobs.js';
import { createSupabaseBackgroundJobQueue } from './supabaseBackgroundJobQueue.js';
import { createSupabaseServiceRoleClient } from './supabaseRestClient.js';
import { createSupabaseExportArtifactRepository } from './supabaseExportArtifactRepository.js';
import { createSupabaseMeetingExportSource } from './supabaseMeetingExportSource.js';
import { createSupabaseExportStorage } from './supabaseExportStorage.js';

export function createSupabaseExportComposition({ env = process.env, fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
  const client = createSupabaseServiceRoleClient({ env, fetchImpl });
  const artifactRepository = createSupabaseExportArtifactRepository({ env, fetchImpl });
  const sourceReader = createSupabaseMeetingExportSource({ env, fetchImpl });
  const storage = createSupabaseExportStorage({ env, fetchImpl, clock });
  if (!client || !artifactRepository || !sourceReader || !storage) return null;
  const queue = createSupabaseBackgroundJobQueue({
    client,
    queueName: BACKGROUND_JOB_QUEUES.EXPORT,
    clock
  });
  const exportArtifactService = createExportArtifactService({
    artifactRepository,
    sourceReader,
    queue,
    storage,
    clock
  });
  return Object.freeze({
    artifactRepository,
    sourceReader,
    storage,
    queue,
    exportArtifactService,
    exportWorker: createExportWorker({ exportArtifactService, queue })
  });
}
