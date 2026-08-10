import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationApplicationService } from '../../src/application/translationApplicationService.js';

test('translation application service delegates commands and query without changing arguments', async () => {
  const calls = [];
  const result = { id: 'result' };
  const service = createTranslationApplicationService({
    translationCommandService: commandService(calls, result),
    translationHistoryQueryService: {
      listSessionTranslations(input) { calls.push(['history', input]); return result; }
    },
    translationRepository: repository(calls, result)
  });
  const input = { id: 'input', nested: { keep: true } };

  assert.strictEqual(service.requestTranslation(input), result);
  assert.strictEqual(service.executeTranslation(input), result);
  assert.strictEqual(service.updateExecution(input), result);
  assert.strictEqual(service.recordTranslationOutput(input), result);
  assert.strictEqual(service.getTranslationRequest('request-1'), result);
  assert.strictEqual(service.listTranslationOutputs({ executionId: 'execution-1' }), result);
  assert.strictEqual(service.listTranslationOutputs({ requestId: 'request-1' }), result);
  assert.strictEqual(service.listTranslationOutputs({ sessionId: 'session-1' }), result);
  assert.strictEqual(service.listSessionTranslations(input), result);
  assert.deepEqual(calls, [
    ['createTranslationRequest', input], ['createTranslationExecution', input],
    ['updateTranslationExecution', input], ['createTranslationOutput', input],
    ['request', 'request-1'], ['executionOutputs', 'execution-1'],
    ['requestOutputs', 'request-1'], ['sessionOutputs', 'session-1'], ['history', input]
  ]);
});

test('translation application service validates missing dependencies and methods deterministically', () => {
  assert.throws(() => createTranslationApplicationService(), /translationCommandService is required/);
  assert.throws(() => createTranslationApplicationService({ translationCommandService: {}, translationHistoryQueryService: {}, translationRepository: {} }), /translationCommandService\.createTranslationRequest/);
  assert.throws(() => createTranslationApplicationService({ translationCommandService: commandService(), translationHistoryQueryService: {}, translationRepository: repository() }), /translationHistoryQueryService\.listSessionTranslations/);
  assert.throws(() => createTranslationApplicationService({ translationCommandService: commandService(), translationHistoryQueryService: { listSessionTranslations() {} }, translationRepository: {} }), /translationRepository\.getTranslationRequest/);
});

test('translation application service preserves asynchronous results and errors', async () => {
  const error = new Error('delegated failure');
  const pending = Promise.reject(error);
  const service = createTranslationApplicationService({
    translationCommandService: commandService([], pending),
    translationHistoryQueryService: { listSessionTranslations() {} },
    translationRepository: repository([], pending)
  });
  assert.strictEqual(service.requestTranslation({}), pending);
  await assert.rejects(service.requestTranslation({}), error);
});

function commandService(calls, result = undefined) {
  return Object.fromEntries([
    ['createTranslationRequest', 'createTranslationRequest'],
    ['createTranslationExecution', 'createTranslationExecution'],
    ['updateTranslationExecution', 'updateTranslationExecution'],
    ['createTranslationOutput', 'createTranslationOutput']
  ].map(([method, label]) => [method, (input) => { calls.push([label, input]); return result; }]));
}

function repository(calls, result = undefined) {
  return {
    getTranslationRequest(id) { calls.push(['request', id]); return result; },
    listTranslationOutputsByExecution(id) { calls.push(['executionOutputs', id]); return result; },
    listTranslationOutputsByRequest(id) { calls.push(['requestOutputs', id]); return result; },
    listTranslationOutputsBySession(id) { calls.push(['sessionOutputs', id]); return result; }
  };
}
