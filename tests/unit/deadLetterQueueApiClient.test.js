import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeadLetterQueueApiClient } from '../../src/lib/deadLetterQueueApiClient.js';

test('lists with the access token and returns the complete payload', async () => {
  const calls = [];
  const payload = { items: [{ executionId: 'execution-1' }], size: 1 };
  const client = createDeadLetterQueueApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(payload);
    }
  });

  assert.strictEqual(await client.list(), payload);
  assert.equal(calls[0].url, '/api/translation-dead-letter-queue');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(typeof calls[0].options.headers, 'object');
});

test('replay URL-encodes execution IDs and preserves error status/code', async () => {
  const calls = [];
  const client = createDeadLetterQueueApiClient({
    fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse({ error: { code: 'dead_letter_item_not_found' } }, { status: 404 });
    }
  });

  await assert.rejects(client.replay('execution 1/zh-Hant'), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, 'dead_letter_item_not_found');
    return true;
  });
  assert.equal(calls[0].url, '/api/translation-dead-letter-queue/execution%201%2Fzh-Hant/replay');
  assert.equal(calls[0].options.method, 'POST');
});

test('malformed execution IDs do not send a request', async () => {
  let calls = 0;
  const client = createDeadLetterQueueApiClient({ fetchImpl() { calls += 1; } });

  await assert.rejects(client.replay('   '), TypeError);
  assert.equal(calls, 0);
});

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
