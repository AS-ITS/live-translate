import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('legacy persisted credential repository and API client are removed', () => {
  const repositoryPath = fileURLToPath(new URL('../../server/geminiCredentialRepository.js', import.meta.url));
  const clientPath = fileURLToPath(new URL('../../src/lib/geminiCredentialApiClient.js', import.meta.url));
  assert.equal(existsSync(repositoryPath), false);
  assert.equal(existsSync(clientPath), false);
});
