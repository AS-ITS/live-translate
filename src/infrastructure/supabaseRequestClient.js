import { currentRequestScope } from '../../server/requestIdentity.js';
import { createSupabaseServiceRoleClient, createSupabaseUserClient } from './supabaseRestClient.js';

export function createSupabaseRequestClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const serviceClient = createSupabaseServiceRoleClient({ env, fetchImpl });
  return function requestClient() {
    const scope = currentRequestScope();
    const ownerIsActor = !scope?.resourceOwnerUserId || scope.resourceOwnerUserId === scope.actorUserId;
    if (scope?.accessToken && ownerIsActor) {
      return createSupabaseUserClient({ env, fetchImpl, accessToken: scope.accessToken }) || serviceClient;
    }
    return serviceClient;
  };
}
