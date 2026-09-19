import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const REQUEST_CAPABILITIES = new Set(['user', 'worker', 'admin', 'readiness']);

export function setRequestUser(user) {
  storage.enterWith(user || null);
  if (user?.kind === 'worker') {
    setRequestScope({
      actorUserId: null,
      resourceOwnerUserId: user.ownerUserId || user.id || null,
      accessToken: null,
      capability: 'worker'
    });
  }
}

export function setRequestScope(scope) {
  const current = storage.getStore() || {};
  if (!scope) {
    storage.enterWith({ ...current, requestScope: null });
    return;
  }
  const capability = scope.capability || 'user';
  if (!REQUEST_CAPABILITIES.has(capability)) {
    throw new TypeError(`Unsupported request capability: ${capability}`);
  }
  storage.enterWith({
    ...current,
    requestScope: Object.freeze({
      actorUserId: scope.actorUserId || null,
      resourceOwnerUserId: scope.resourceOwnerUserId || null,
      accessToken: scope.accessToken || null,
      capability
    })
  });
}

export function currentRequestScope() {
  return storage.getStore()?.requestScope || null;
}

export function runWithRequestUser(user, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function.');
  return storage.run(user || null, () => {
    if (user?.kind === 'worker') {
      setRequestScope({
        actorUserId: null,
        resourceOwnerUserId: user.ownerUserId || user.id || null,
        accessToken: null,
        capability: 'worker'
      });
    }
    return callback();
  });
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

export function currentRequestCapability() {
  return currentRequestScope()?.capability || null;
}
