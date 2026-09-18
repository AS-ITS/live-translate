import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function setRequestUser(user) {
  storage.enterWith(user || null);
}

export function setRequestScope(scope) {
  const current = storage.getStore() || {};
  storage.enterWith({ ...current, requestScope: scope || null });
}

export function currentRequestScope() {
  return storage.getStore()?.requestScope || null;
}

export function runWithRequestUser(user, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function.');
  return storage.run(user || null, callback);
}

export function isWorkerRequestContext() {
  return storage.getStore()?.kind === 'worker';
}

export function currentRequestUserId() {
  return storage.getStore()?.id || null;
}

export function currentRequestOwnerId() {
  const context = storage.getStore();
  return context?.ownerUserId || context?.id || null;
}

export function currentRequestActorId() {
  const context = storage.getStore();
  return context?.actorUserId || context?.id || null;
}
