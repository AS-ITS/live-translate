import { currentRequestCapability, currentRequestScope, currentRequestUserId, isWorkerRequestContext } from '../../server/requestIdentity.js';
import { createSupabaseServiceRoleClient, createSupabaseUserClient } from './supabaseRestClient.js';

export const CLOUD_CAPABILITY_UNAVAILABLE = 'cloud_capability_unavailable';

export function createSupabaseRequestClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const serviceClient = createSupabaseServiceRoleClient({ env, fetchImpl });
  return function requestClient() {
    const scope = currentRequestScope();
    if (scope) {
      if (scope.capability !== 'user' || !scope.accessToken) return null;
      return createSupabaseUserClient({ env, fetchImpl, accessToken: scope.accessToken });
    }
    // Direct repository tests and the legacy local worker path predate the
    // request scope. They remain service-role only until they are migrated to
    // an explicit worker/admin context. A scoped request never reaches here.
    if (isWorkerRequestContext() || currentRequestUserId()) return serviceClient;
    return null;
  };
}

export function requireSupabaseRequestClient(clientForRequest) {
  const client = clientForRequest?.();
  if (client) return client;
  const error = new Error('Authenticated Supabase user client is unavailable.');
  error.code = CLOUD_CAPABILITY_UNAVAILABLE;
  error.status = 503;
  throw error;
}

// Repositories used by both HTTP requests and background workers must choose
// the credential from an explicit capability. This keeps worker secret access
// available without making it a fallback for an authenticated user request.
export function createSupabaseContextClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const requestClient = createSupabaseRequestClient({ env, fetchImpl });
  const serviceClient = createSupabaseServiceRoleClient({ env, fetchImpl });
  return function contextClient() {
    const capability = currentRequestCapability();
    if (capability === 'user') return requestClient();
    if (capability === 'worker' || capability === 'admin' || capability === 'readiness') return serviceClient;
    // No request scope means an explicit non-HTTP caller, such as a worker
    // composition or a direct repository adapter. HTTP requests always set a
    // scope before reaching a repository, so this cannot hide a user fallback.
    if (!currentRequestScope() && (isWorkerRequestContext() || currentRequestUserId() || serviceClient)) return serviceClient;
    return null;
  };
}

export function requireSupabaseContextClient(clientForContext) {
  return requireSupabaseRequestClient(clientForContext);
}
