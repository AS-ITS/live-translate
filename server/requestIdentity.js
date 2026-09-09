import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function setRequestUser(user) {
  storage.enterWith(user || null);
}

export function currentRequestUserId() {
  return storage.getStore()?.id || null;
}
