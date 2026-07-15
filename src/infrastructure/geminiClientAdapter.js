export function createGeminiClientAdapter({ client } = {}) {
  assertClient(client);

  return Object.freeze({
    generateContent(request) {
      return client.models.generateContent(request);
    }
  });
}

function assertClient(client) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    throw new TypeError('client is required.');
  }

  if (!client.models || typeof client.models !== 'object' || Array.isArray(client.models)) {
    throw new TypeError('client.models is required.');
  }

  if (typeof client.models.generateContent !== 'function') {
    throw new TypeError('client.models.generateContent must be a function.');
  }
}
