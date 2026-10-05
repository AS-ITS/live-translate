let liveCredential = '';
const clearListeners = new Set();

export function setLiveCredential(value) {
  liveCredential = typeof value === 'string' ? value.trim() : '';
  return hasLiveCredential();
}

export function getLiveCredential() {
  return liveCredential || null;
}

export function hasLiveCredential() {
  return liveCredential.length > 0;
}

export function clearLiveCredential() {
  liveCredential = '';
  for (const listener of clearListeners) listener();
}

export function subscribeToLiveCredentialClear(listener) {
  clearListeners.add(listener);
  return () => clearListeners.delete(listener);
}

export function resetLiveCredentialForTest() {
  clearLiveCredential();
}
