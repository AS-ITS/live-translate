const DEMO_ACCESS_TOKEN = import.meta.env?.VITE_DEMO_ACCESS_TOKEN;

export function accessTokenHeaders(headers = {}) {
  const nextHeaders = { ...headers };
  if (typeof DEMO_ACCESS_TOKEN === 'string' && DEMO_ACCESS_TOKEN.length > 0) {
    nextHeaders.Authorization = `Bearer ${DEMO_ACCESS_TOKEN}`;
  }
  return nextHeaders;
}

export function authenticatedFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('authenticated fetch requires fetchImpl to be a function.');
  return (url, init = {}) => fetchImpl(url, {
    ...init,
    headers: accessTokenHeaders(init.headers || {})
  });
}
