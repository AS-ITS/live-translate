import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationApplicationService } from '../../src/application/translationApplicationService.js';

test('translation application service delegates commands and query without changing arguments', async () => {
  const calls = [];
  const result = { id: 'result' };
  const request = { id: 'request-1', sourceTranscriptSnapshot: { sourceText: 'hello' }, targetLanguageCode: 'ja', createdAt: 1 };
  const output = { id: 'output-1', executionId: 'execution-1', requestId: 'request-1', translatedText: 'こんにちは', targetLanguageCode: 'ja', createdAt: 2 };
  const service = createTranslationApplicationService({
    translationCommandService: commandService(calls, result),
    translationHistoryQueryService: {
      listSessionTranslations(input) { calls.push(['history', input]); return result; }
    },
    translationRepository: repository(calls, { request, outputs: [output] })
  });
  const input = { id: 'input', nested: { keep: true } };

  assert.strictEqual(service.requestTranslation(input), result);
  assert.strictEqual(service.executeTranslation(input), result);
  assert.strictEqual(service.updateExecution(input), result);
  assert.strictEqual(service.recordTranslationOutput(input), result);
  assert.deepEqual(service.getTranslationRequest('request-1'), {
    id: 'request-1', sourceText: 'hello', targetLanguageCode: 'ja', createdAt: 1
  });
  assert.deepEqual(service.listTranslationOutputs({ executionId: 'execution-1' }), [detailDTO(output)]);
  assert.deepEqual(service.listTranslationOutputs({ requestId: 'request-1' }), [detailDTO(output)]);
  assert.deepEqual(service.listTranslationOutputs({ sessionId: 'session-1' }), [detailDTO(output)]);
  assert.strictEqual(service.listSessionTranslations(input), result);
  assert.deepEqual(calls, [
    ['createTranslationRequest', input], ['createTranslationExecution', input],
    ['updateTranslationExecution', input], ['createTranslationOutput', input],
    ['request', 'request-1'], ['executionOutputs', 'execution-1'],
    ['requestOutputs', 'request-1'], ['sessionOutputs', 'session-1'], ['history', input]
  ]);
});

test('translation application service maps sync and async read results without mutating domain objects', async () => {
  const request = { id: 'request-1', sourceTranscriptSnapshot: { items: [{ text: 'Hello' }] }, targetLanguageCode: 'en' };
  const output = { id: 'output-1', executionId: 'execution-1', translatedText: '你好', targetLanguageCode: 'zh-Hant', createdAt: 4 };
  const service = createTranslationApplicationService({
    translationCommandService: commandService(),
    translationHistoryQueryService: { listSessionTranslations() {} },
    translationRepository: {
      ...repository([], { request, outputs: [output] }),
      getTranslationRequest() { return Promise.resolve(request); },
      listTranslationOutputsByExecution() { return Promise.resolve([output]); },
      listTranslationOutputsByRequest() { return Promise.resolve([]); },
      listTranslationOutputsBySession() { return Promise.resolve(null); }
    }
  });
  const requestSnapshot = structuredClone(request);
  const outputSnapshot = structuredClone(output);

  assert.deepEqual(await service.getTranslationRequest({ requestId: 'request-1' }), {
    id: 'request-1', sourceText: 'Hello', targetLanguageCode: 'en', createdAt: undefined
  });
  assert.deepEqual(await service.listTranslationOutputs({ executionId: 'execution-1' }), [detailDTO(output)]);
  assert.deepEqual(await service.listTranslationOutputs({ requestId: 'request-1' }), []);
  assert.strictEqual(await service.listTranslationOutputs({ sessionId: 'session-1' }), null);
  assert.deepEqual(request, requestSnapshot);
  assert.deepEqual(output, outputSnapshot);
});

test('translation application service preserves null, empty lists, and repository errors', async () => {
  const error = new Error('repository failure');
  const emptyOutputs = [];
  const service = createTranslationApplicationService({
    translationCommandService: commandService(),
    translationHistoryQueryService: { listSessionTranslations() {} },
    translationRepository: {
      ...repository(),
      getTranslationRequest() { return null; },
      listTranslationOutputsByExecution() { return emptyOutputs; },
      listTranslationOutputsByRequest() { return Promise.reject(error); },
      listTranslationOutputsBySession() { throw error; }
    }
  });

  assert.strictEqual(service.getTranslationRequest('missing'), null);
  assert.strictEqual(service.listTranslationOutputs({ executionId: 'execution-1' }), emptyOutputs);
  await assert.rejects(service.listTranslationOutputs({ requestId: 'request-1' }), error);
  assert.throws(() => service.listTranslationOutputs({ sessionId: 'session-1' }), error);
});

test('translation application service keeps selector precedence and missing selector error', () => {
  const calls = [];
  const service = createTranslationApplicationService({
    translationCommandService: commandService(),
    translationHistoryQueryService: { listSessionTranslations() {} },
    translationRepository: repository(calls, { outputs: [] })
  });

  service.listTranslationOutputs({ executionId: 'execution-1', requestId: 'request-1', sessionId: 'session-1' });
  service.listTranslationOutputs({ requestId: 'request-2', sessionId: 'session-2' });
  service.listTranslationOutputs({ sessionId: 'session-3' });
  assert.deepEqual(calls, [['executionOutputs', 'execution-1'], ['requestOutputs', 'request-2'], ['sessionOutputs', 'session-3']]);
  assert.throws(() => service.listTranslationOutputs(), /listTranslationOutputs requires sessionId, requestId, or executionId/);
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
    getTranslationRequest(id) { calls.push(['request', id]); return result?.request ?? result; },
    listTranslationOutputsByExecution(id) { calls.push(['executionOutputs', id]); return result?.outputs ?? result; },
    listTranslationOutputsByRequest(id) { calls.push(['requestOutputs', id]); return result?.outputs ?? result; },
    listTranslationOutputsBySession(id) { calls.push(['sessionOutputs', id]); return result?.outputs ?? result; }
  };
}

function detailDTO(output) {
  return {
    id: output.id,
    executionId: output.executionId,
    translatedText: output.translatedText,
    targetLanguageCode: output.targetLanguageCode,
    createdAt: output.createdAt,
    requestId: output.requestId,
    version: null,
    source: 'legacy',
    sourceLanguageCode: null,
    completedAt: output.createdAt
  };
}
