import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function setRequestUser(user) {
  storage.enterWith(user || null);
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
