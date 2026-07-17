export function createGeminiTranslationExecutionProvider({ client } = {}) {
  assertClient(client);

  return Object.freeze({
    async execute(input) {
      return await client.execute(input);
    }
  });
}

function assertClient(client) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    throw new TypeError('client is required.');
  }

  if (typeof client.execute !== 'function') {
    throw new TypeError('client.execute must be a function.');
  }
}
