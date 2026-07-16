import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createSavedTranscriptRetranslationService } from '../../src/application/translation/index.js';
import { TRANSLATION_EVENT_TYPES } from '../../src/domain/translation/index.js';
import { createFakeSavedTranscriptTranslationProvider } from '../../src/infrastructure/fakeSavedTranscriptTranslationProvider.js';
import { createTranslationRepositoryAdapter } from '../../src/infrastructure/translationRepositoryAdapter.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

const SERVICE_METHODS = Object.freeze(['translateSavedTranscript']);

test('factory returns frozen service shape and validates dependencies clearly', () => {
  const valid = serviceDependencies();
  const service = createSavedTranscriptRetranslationService(valid);

  assert.equal(Object.isFrozen(service), true);
  assert.deepEqual(Object.keys(service), SERVICE_METHODS);
  assert.equal(typeof service.translateSavedTranscript, 'function');
  assert.throws(() => {
    service.extra = true;
  }, TypeError);

  for (const missingMethod of ['createTranslationRequest', 'createTranslationExecution', 'updateTranslationExecution', 'createTranslationOutput']) {
    const dependencies = serviceDependencies();
    delete dependencies.translationCommandService[missingMethod];
    assert.throws(
      () => createSavedTranscriptRetranslationService(dependencies),
      new RegExp(`translationCommandService\\.${missingMethod}`)
    );
  }

  assert.throws(
    () => createSavedTranscriptRetranslationService({ ...valid, savedTranscriptTranslationProvider: {} }),
    /savedTranscriptTranslationProvider\.translate/
  );
  assert.throws(
    () => createSavedTranscriptRetranslationService({ ...valid, resolveSavedTranscriptTranslationProvider: {} }),
    /resolveSavedTranscriptTranslationProvider/
  );
  assert.throws(
    () => createSavedTranscriptRetranslationService({ ...valid, sessionRepository: {} }),
    /sessionRepository\.getSessionRecord/
  );
  assert.throws(() => createSavedTranscriptRetranslationService({ ...valid, idGenerator: null }), /idGenerator/);
  assert.throws(() => createSavedTranscriptRetranslationService({ ...valid, clock: null }), /clock/);
});

test('separate service instances retain isolated dependencies', async () => {
  const first = serviceDependencies({ translatedText: 'Bonjour' });
  const second = serviceDependencies({ translatedText: 'Hola' });

  const firstResult = await createSavedTranscriptRetranslationService(first).translateSavedTranscript(operationInput());
  const secondResult = await createSavedTranscriptRetranslationService(second).translateSavedTranscript(
    operationInput({ sessionId: 'session-2', targetLanguageCode: 'es' })
  );

  assert.equal(firstResult.output.translatedText, 'Bonjour');
  assert.equal(secondResult.output.translatedText, 'Hola');
  assert.deepEqual(first.provider.getCalls().map((call) => call.sessionId), ['session-1']);
  assert.deepEqual(second.provider.getCalls().map((call) => call.sessionId), ['session-2']);
});

test('missing session and missing source transcript fail before native records are created', async () => {
  const missing = serviceDependencies({ seedSession: false });
  await assert.rejects(
    createSavedTranscriptRetranslationService(missing).translateSavedTranscript(operationInput()),
    /Session record not found/
  );
  assert.deepEqual(missing.calls.names(), []);

  const noTranscript = serviceDependencies({ sourceItems: [] });
  await assert.rejects(
    createSavedTranscriptRetranslationService(noTranscript).translateSavedTranscript(operationInput()),
    /Saved source transcript is not available/
  );
  assert.deepEqual(noTranscript.calls.names(), []);
});

test('canonical source transcript is resolved without mutating session detail or caller input', async () => {
  const dependencies = serviceDependencies({
    sourceItems: [
      sourceItem({ id: 'source-2', sequence: 2, text: 'Second line' }),
      sourceItem({ id: 'source-1', sequence: 1, text: ' First line ' }),
      sourceItem({ id: 'partial-1', sequence: 3, status: 'partial', text: 'ignored' })
    ]
  });
  const service = createSavedTranscriptRetranslationService(dependencies);
  const input = operationInput();
  const inputBefore = structuredClone(input);
  const detailBefore = dependencies.sessionRepository.getSessionRecord('session-1');

  await service.translateSavedTranscript(input);

  assert.deepEqual(input, inputBefore);
  assert.deepEqual(dependencies.sessionRepository.getSessionRecord('session-1').transcriptItems, detailBefore.transcriptItems);
  assert.equal(dependencies.provider.getCalls()[0].sourceText, ' First line \nSecond line');
});

test('explicit providerKey is forwarded to resolver and the returned provider translates', async () => {
  const provider = createFakeSavedTranscriptTranslationProvider({ result: { translatedText: 'Konnichiwa' } });
  const resolverCalls = [];
  const dependencies = serviceDependencies({
    provider,
    resolveSavedTranscriptTranslationProvider(options) {
      resolverCalls.push(options);
      return provider;
    }
  });

  const result = await createSavedTranscriptRetranslationService(dependencies).translateSavedTranscript(
    operationInput({ targetLanguageCode: 'ja', providerKey: 'fake' })
  );

  assert.deepEqual(resolverCalls, [{ providerKey: 'fake' }]);
  assert.equal(provider.getCalls().length, 1);
  assert.equal(provider.getCalls()[0].targetLanguageCode, 'ja');
  assert.equal(result.output.translatedText, 'Konnichiwa');
});

test('omitted providerKey is forwarded to resolver as undefined without service default selection', async () => {
  const provider = createFakeSavedTranscriptTranslationProvider({ result: { translatedText: 'Bonjour' } });
  const resolverCalls = [];
  const dependencies = serviceDependencies({
    provider,
    resolveSavedTranscriptTranslationProvider(options) {
      resolverCalls.push(options);
      return provider;
    }
  });

  await createSavedTranscriptRetranslationService(dependencies).translateSavedTranscript(operationInput());

  assert.deepEqual(resolverCalls, [{ providerKey: undefined }]);
  assert.equal(provider.getCalls().length, 1);
});

test('resolved provider object is used unchanged for translation', async () => {
  const fixedProvider = createFakeSavedTranscriptTranslationProvider({ result: { translatedText: 'Default' } });
  const resolvedProvider = createFakeSavedTranscriptTranslationProvider({ result: { translatedText: 'Resolved' } });
  const dependencies = serviceDependencies({
    provider: fixedProvider,
    resolveSavedTranscriptTranslationProvider() {
      return resolvedProvider;
    }
  });

  const result = await createSavedTranscriptRetranslationService(dependencies).translateSavedTranscript(operationInput());

  assert.equal(result.output.translatedText, 'Resolved');
  assert.deepEqual(fixedProvider.getCalls(), []);
  assert.equal(resolvedProvider.getCalls().length, 1);
});

test('provider resolution error propagates unchanged and prevents translation command persistence', async () => {
  const resolutionError = new Error('translation provider not found: does-not-exist');
  const provider = createFakeSavedTranscriptTranslationProvider({ result: { translatedText: 'Bonjour' } });
  const dependencies = serviceDependencies({
    provider,
    resolveSavedTranscriptTranslationProvider() {
      throw resolutionError;
    }
  });

  await assert.rejects(
    createSavedTranscriptRetranslationService(dependencies).translateSavedTranscript(
      operationInput({ providerKey: 'does-not-exist' })
    ),
    (actualError) => actualError === resolutionError
  );

  assert.deepEqual(provider.getCalls(), []);
  assert.deepEqual(dependencies.calls.names(), []);
});

test('success flow creates request, running execution before provider, final execution, output, return value, and events', async () => {
  const events = [];
  const dependencies = graphDependencies({
    providerResult: { translatedText: 'Bonjour', detectedSourceLanguageCode: 'en' },
    handlers: recordEvents(events)
  });
  const service = dependencies.savedTranscriptRetranslationService;

  const result = await service.translateSavedTranscript(operationInput());

  assert.equal(result.request.id, 'request-1');
  assert.equal(result.request.sessionId, 'session-1');
  assert.equal(result.request.sourceTranscriptRevisionId, 'source-revision:session-1:final');
  assert.equal(result.request.sourceTranscriptSnapshot.items[0].text, 'Hello');
  assert.equal(result.execution.id, 'execution-1');
  assert.equal(result.execution.status, 'completed');
  assert.equal(result.output.id, 'output-1');
  assert.equal(result.output.translatedText, 'Bonjour');
  assert.equal(result.output.targetLanguageCode, 'fr');
  assert.deepEqual(result.output.providerMetadata, { detectedSourceLanguageCode: 'en' });
  assert.equal(Object.isFrozen(result), true);

  assert.deepEqual(dependencies.provider.getCalls(), [
    {
      sourceText: 'Hello\nworld',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      requestId: 'request-1',
      sessionId: 'session-1',
      executionId: 'execution-1'
    }
  ]);

  assert.deepEqual(
    events.map((event) => [event.type, event.payload.request?.id || event.payload.execution?.status || event.payload.output?.id]),
    [
      [TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED, 'request-1'],
      [TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED, 'pending'],
      [TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED, 'running'],
      [TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED, 'output-1'],
      [TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED, 'completed']
    ]
  );

  const repository = dependencies.translationRepository;
  assert.deepEqual(
    repository.listTranslationRequestsBySession('session-1').map((request) => request.id),
    ['request-1']
  );
  assert.deepEqual(
    repository.listTranslationExecutionsByRequest('request-1').map((execution) => execution.status),
    ['completed']
  );
  assert.deepEqual(
    repository.listTranslationOutputsBySession('session-1').map((output) => output.id),
    ['output-1']
  );
  assert.deepEqual(
    repository.listTranslationOutputsByRequest('request-1').map((output) => output.id),
    ['output-1']
  );
});

test('provider input object is not mutated and deferred completion is awaited before success update and output', async () => {
  const deferred = createDeferred();
  const observed = { providerInput: null, events: [] };
  const provider = {
    translate(input) {
      observed.providerInput = input;
      return deferred.promise;
    }
  };
  const dependencies = graphDependencies({
    provider,
    handlers: recordEvents(observed.events)
  });

  const translationPromise = dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput());
  await waitFor(() => observed.providerInput !== null);
  const providerInputBefore = structuredClone(observed.providerInput);

  assert.deepEqual(
    observed.events.map((event) => event.payload.execution?.status || event.type),
    [TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED, 'pending', 'running']
  );
  assert.deepEqual(dependencies.translationRepository.listTranslationOutputsBySession('session-1'), []);

  deferred.resolve({ translatedText: 'Bonjour' });
  const result = await translationPromise;

  assert.deepEqual(observed.providerInput, providerInputBefore);
  assert.equal(result.execution.status, 'completed');
  assert.deepEqual(
    observed.events.map((event) => event.payload.execution?.status || event.type),
    [TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED, 'pending', 'running', TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED, 'completed']
  );
});

test('success flow persists output before completing execution and returns final references', async () => {
  const order = [];
  const dependencies = serviceDependencies({
    commandOverrides: {
      createTranslationRequest(input) {
        order.push('createTranslationRequest');
        return { ...input, marker: 'request-reference' };
      },
      createTranslationExecution(input) {
        order.push('createTranslationExecution');
        return { ...input, marker: 'created-execution-reference' };
      },
      updateTranslationExecution(input) {
        order.push(`updateTranslationExecution:${input.transition}`);
        return {
          id: input.executionId,
          status: input.transition === 'start' ? 'running' : 'completed',
          marker: `${input.transition}-execution-reference`
        };
      },
      createTranslationOutput(input) {
        order.push('createTranslationOutput');
        return { ...input, marker: 'output-reference' };
      }
    }
  });

  const result = await createSavedTranscriptRetranslationService(dependencies).translateSavedTranscript(operationInput());

  assert.deepEqual(order, [
    'createTranslationRequest',
    'createTranslationExecution',
    'updateTranslationExecution:start',
    'createTranslationOutput',
    'updateTranslationExecution:complete'
  ]);
  assert.equal(result.request.marker, 'request-reference');
  assert.equal(result.execution.marker, 'complete-execution-reference');
  assert.equal(result.output.marker, 'output-reference');
});

test('multiple invocations for the same session and target preserve separate requests and outputs', async () => {
  const dependencies = graphDependencies({ providerResult: { translatedText: 'Bonjour' } });

  await dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput());
  await dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput());

  assert.deepEqual(
    dependencies.translationRepository.listTranslationRequestsBySession('session-1').map((request) => request.id),
    ['request-1', 'request-2']
  );
  assert.deepEqual(
    dependencies.translationRepository.listTranslationOutputsBySession('session-1').sort(compareById).map((output) => [
      output.id,
      output.targetLanguageCode
    ]),
    [
      ['output-1', 'fr'],
      ['output-2', 'fr']
    ]
  );
});

test('synchronous and asynchronous provider failure persist failed execution, create no output, and rethrow exact error', async () => {
  for (const mode of ['throw', 'reject']) {
    const expectedError = new Error(`${mode} provider failed`);
    const dependencies = graphDependencies({
      provider: createFakeSavedTranscriptTranslationProvider({ mode, error: expectedError })
    });

    await assert.rejects(
      dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput()),
      (actualError) => actualError === expectedError
    );

    const [request] = dependencies.translationRepository.listTranslationRequestsBySession('session-1');
    const [execution] = dependencies.translationRepository.listTranslationExecutionsByRequest(request.id);
    assert.equal(execution.status, 'failed');
    assert.equal(execution.completedAt, 't4');
    assert.deepEqual(execution.failureInfo, {
      reason: 'provider_error',
      message: expectedError.message
    });
    assert.deepEqual(dependencies.translationRepository.listTranslationOutputsBySession('session-1'), []);
    assert.equal(dependencies.provider.getCalls().length, 1);
  }
});

test('provider failure is not retried or wrapped', async () => {
  const expectedError = new Error('provider failed once');
  const dependencies = graphDependencies({
    provider: createFakeSavedTranscriptTranslationProvider({ error: expectedError })
  });

  await assert.rejects(
    dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput()),
    (actualError) => actualError === expectedError
  );
  await Promise.resolve();

  assert.equal(dependencies.provider.getCalls().length, 1);
  assert.deepEqual(
    dependencies.translationRepository.listTranslationExecutionsByRequest('request-1').map((execution) => execution.status),
    ['failed']
  );
});

test('provider failure creates no output and does not complete execution', async () => {
  const expectedError = new Error('provider failed before output');
  const dependencies = serviceDependencies({
    provider: createFakeSavedTranscriptTranslationProvider({ mode: 'throw', error: expectedError })
  });

  await assert.rejects(
    createSavedTranscriptRetranslationService(dependencies).translateSavedTranscript(operationInput()),
    (actualError) => actualError === expectedError
  );

  assert.deepEqual(dependencies.calls.names(), [
    'createTranslationRequest',
    'createTranslationExecution',
    'updateTranslationExecution',
    'updateTranslationExecution'
  ]);
  assert.equal(dependencies.calls.entries()[2][1].transition, 'start');
  assert.equal(dependencies.calls.entries()[3][1].transition, 'fail');
  assert.equal(dependencies.provider.getCalls().length, 1);
});

test('output creation synchronous throw propagates exactly without completing execution or retrying', async () => {
  const expectedError = new Error('output repository sync failed');
  const dependencies = serviceDependencies({
    commandOverrides: {
      createTranslationOutput() {
        dependencies.calls.push('createTranslationOutput', { attempt: 1 });
        throw expectedError;
      }
    }
  });
  const input = operationInput();
  const before = structuredClone(input);

  await assert.rejects(
    createSavedTranscriptRetranslationService(dependencies).translateSavedTranscript(input),
    (actualError) => actualError === expectedError
  );

  assert.deepEqual(input, before);
  assert.equal(dependencies.provider.getCalls().length, 1);
  assert.deepEqual(dependencies.calls.names(), [
    'createTranslationRequest',
    'createTranslationExecution',
    'updateTranslationExecution',
    'createTranslationOutput'
  ]);
  assert.equal(dependencies.calls.entries()[2][1].transition, 'start');
});

test('output creation asynchronous rejection propagates exactly without completing execution or retrying', async () => {
  const expectedError = new Error('output repository async failed');
  const dependencies = serviceDependencies({
    commandOverrides: {
      createTranslationOutput(input) {
        dependencies.calls.push('createTranslationOutput', input);
        return Promise.reject(expectedError);
      }
    }
  });

  await assert.rejects(
    createSavedTranscriptRetranslationService(dependencies).translateSavedTranscript(operationInput()),
    (actualError) => actualError === expectedError
  );

  assert.equal(dependencies.provider.getCalls().length, 1);
  assert.deepEqual(dependencies.calls.names(), [
    'createTranslationRequest',
    'createTranslationExecution',
    'updateTranslationExecution',
    'createTranslationOutput'
  ]);
  assert.equal(dependencies.calls.entries()[2][1].transition, 'start');
});

test('output event publication failure preserves output but does not complete execution', async () => {
  const expectedError = new Error('output handler failed before completion');
  const dependencies = graphDependencies({
    handlers: {
      outputCreated() {
        throw expectedError;
      }
    }
  });

  await assert.rejects(
    dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput()),
    (actualError) => actualError === expectedError
  );

  assert.deepEqual(
    dependencies.translationRepository.listTranslationRequestsBySession('session-1').map((request) => request.id),
    ['request-1']
  );
  assert.deepEqual(
    dependencies.translationRepository.listTranslationExecutionsByRequest('request-1').map((execution) => execution.status),
    ['running']
  );
  assert.deepEqual(
    dependencies.translationRepository.listTranslationOutputsBySession('session-1').map((output) => output.id),
    ['output-1']
  );
  assert.equal(dependencies.provider.getCalls().length, 1);
});

test('execution completion repository failure preserves output and propagates exactly without retry', async () => {
  const expectedError = new Error('complete repository failed');
  const calls = [];
  const dependencies = graphDependencies({
    translationRepositoryFactory(baseRepository) {
      return {
        ...baseRepository,
        updateTranslationExecution(execution) {
          calls.push(['updateTranslationExecution', execution.status]);
          if (execution.status === 'completed') {
            throw expectedError;
          }
          return baseRepository.updateTranslationExecution(execution);
        }
      };
    }
  });

  await assert.rejects(
    dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput()),
    (actualError) => actualError === expectedError
  );

  assert.deepEqual(calls, [
    ['updateTranslationExecution', 'running'],
    ['updateTranslationExecution', 'completed']
  ]);
  assert.deepEqual(
    dependencies.translationRepository.listTranslationExecutionsByRequest('request-1').map((execution) => execution.status),
    ['running']
  );
  assert.deepEqual(
    dependencies.translationRepository.listTranslationOutputsBySession('session-1').map((output) => output.id),
    ['output-1']
  );
  assert.equal(dependencies.provider.getCalls().length, 1);
});

test('execution completion event publication failure preserves completed execution and output without retry', async () => {
  const expectedError = new Error('completion handler failed');
  const updatedStatuses = [];
  const dependencies = graphDependencies({
    handlers: {
      executionUpdated(event) {
        updatedStatuses.push(event.payload.execution.status);
        if (event.payload.execution.status === 'completed') {
          throw expectedError;
        }
      }
    }
  });

  await assert.rejects(
    dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput()),
    (actualError) => actualError === expectedError
  );

  assert.deepEqual(updatedStatuses, ['running', 'completed']);
  assert.deepEqual(
    dependencies.translationRepository.listTranslationExecutionsByRequest('request-1').map((execution) => execution.status),
    ['completed']
  );
  assert.deepEqual(
    dependencies.translationRepository.listTranslationOutputsBySession('session-1').map((output) => output.id),
    ['output-1']
  );
  assert.equal(dependencies.provider.getCalls().length, 1);
});

test('command failures propagate and prevent later work without retry, rollback, or compensation', async () => {
  const requestError = new Error('request failed');
  const requestFailure = serviceDependencies({
    commandOverrides: {
      createTranslationRequest() {
        throw requestError;
      }
    }
  });
  await assert.rejects(
    createSavedTranscriptRetranslationService(requestFailure).translateSavedTranscript(operationInput()),
    (error) => error === requestError
  );
  assert.deepEqual(requestFailure.provider.getCalls(), []);

  const executionError = new Error('execution failed');
  const executionFailure = serviceDependencies({
    commandOverrides: {
      createTranslationExecution() {
        throw executionError;
      }
    }
  });
  await assert.rejects(
    createSavedTranscriptRetranslationService(executionFailure).translateSavedTranscript(operationInput()),
    (error) => error === executionError
  );
  assert.deepEqual(executionFailure.provider.getCalls(), []);

  const successUpdateError = new Error('success update failed');
  const successUpdateFailure = serviceDependencies({
    commandOverrides: {
      updateTranslationExecution(input) {
        if (input.transition === 'complete') {
          throw successUpdateError;
        }
        return { id: input.executionId, status: input.transition === 'start' ? 'running' : input.transition };
      }
    }
  });
  await assert.rejects(
    createSavedTranscriptRetranslationService(successUpdateFailure).translateSavedTranscript(operationInput()),
    (error) => error === successUpdateError
  );
  assert.equal(successUpdateFailure.calls.names().includes('createTranslationOutput'), true);

  const outputError = new Error('output failed');
  const outputFailure = serviceDependencies({
    commandOverrides: {
      createTranslationOutput() {
        throw outputError;
      }
    }
  });
  await assert.rejects(
    createSavedTranscriptRetranslationService(outputFailure).translateSavedTranscript(operationInput()),
    (error) => error === outputError
  );
  assert.equal(outputFailure.calls.names().filter((name) => name === 'updateTranslationExecution').length, 1);
});

test('event handler rejection propagates after committed state remains queryable', async () => {
  const expectedError = new Error('output handler failed');
  const dependencies = graphDependencies({
    handlers: {
      outputCreated() {
        throw expectedError;
      }
    }
  });

  await assert.rejects(
    dependencies.savedTranscriptRetranslationService.translateSavedTranscript(operationInput()),
    (error) => error === expectedError
  );

  assert.deepEqual(
    dependencies.translationRepository.listTranslationRequestsBySession('session-1').map((request) => request.id),
    ['request-1']
  );
  assert.deepEqual(
    dependencies.translationRepository.listTranslationExecutionsByRequest('request-1').map((execution) => execution.status),
    ['running']
  );
  assert.deepEqual(
    dependencies.translationRepository.listTranslationOutputsBySession('session-1').map((output) => output.id),
    ['output-1']
  );
});

test('composition uses injected provider, never creates a fake implicitly, preserves isolation and unsubscribe', async () => {
  const providerA = createFakeSavedTranscriptTranslationProvider({ result: { translatedText: 'Bonjour' } });
  const providerB = createFakeSavedTranscriptTranslationProvider({ result: { translatedText: 'Hola' } });
  const appWithoutProvider = createApplicationDependencies();

  assert.equal(Object.hasOwn(appWithoutProvider, 'savedTranscriptRetranslationService'), false);
  assert.equal(typeof appWithoutProvider.unsubscribeTranslationDomainEvents, 'function');

  const appA = graphDependencies({ provider: providerA });
  const appB = graphDependencies({ provider: providerB, sessionId: 'session-b', targetLanguageCode: 'es' });

  await appA.savedTranscriptRetranslationService.translateSavedTranscript(operationInput());
  await appB.savedTranscriptRetranslationService.translateSavedTranscript(operationInput({ sessionId: 'session-b', targetLanguageCode: 'es' }));

  assert.deepEqual(providerA.getCalls().map((call) => call.sessionId), ['session-1']);
  assert.deepEqual(providerB.getCalls().map((call) => call.sessionId), ['session-b']);
  assert.deepEqual(appA.translationRepository.listTranslationRequestsBySession('session-b'), []);
  assert.deepEqual(appB.translationRepository.listTranslationRequestsBySession('session-1'), []);

  appA.unsubscribeTranslationDomainEvents();
  appA.unsubscribeTranslationDomainEvents();
});

function serviceDependencies(options = {}) {
  const calls = callRecorder();
  const provider =
    options.provider ||
    createFakeSavedTranscriptTranslationProvider({
      result: {
        translatedText: options.translatedText || 'Bonjour',
        detectedSourceLanguageCode: 'en'
      }
    });
  const sessionRepository = {
    getSessionRecord(sessionId) {
      if (options.seedSession === false) {
        return null;
      }
      return sessionDetail({
        sessionId,
        sourceItems: options.sourceItems
      });
    }
  };
  const commandService = {
    createTranslationRequest(input) {
      calls.push('createTranslationRequest', input);
      return { ...input };
    },
    createTranslationExecution(input) {
      calls.push('createTranslationExecution', input);
      return { ...input };
    },
    updateTranslationExecution(input) {
      calls.push('updateTranslationExecution', input);
      return { id: input.executionId, status: input.transition === 'start' ? 'running' : input.transition };
    },
    createTranslationOutput(input) {
      calls.push('createTranslationOutput', input);
      return { ...input };
    },
    ...options.commandOverrides
  };

  return {
    translationCommandService: commandService,
    savedTranscriptTranslationProvider: provider,
    ...(options.resolveSavedTranscriptTranslationProvider
      ? { resolveSavedTranscriptTranslationProvider: options.resolveSavedTranscriptTranslationProvider }
      : {}),
    provider,
    sessionRepository,
    idGenerator: sequentialIdGenerator(),
    clock: sequentialClock(),
    calls
  };
}

function graphDependencies(options = {}) {
  const sessionRepository = createMemorySessionRepository({ now: () => 'session-now' });
  const sessionId = options.sessionId || 'session-1';
  sessionRepository.createSessionRecord({
    id: sessionId,
    startedAt: '2026-07-14T01:00:00.000Z',
    targetLanguageCode: options.targetLanguageCode || 'fr'
  });
  sessionRepository.appendTranscriptItem(sessionId, sourceItem({ id: `${sessionId}-source-1`, sequence: 1, text: 'Hello' }));
  sessionRepository.appendTranscriptItem(sessionId, sourceItem({ id: `${sessionId}-source-2`, sequence: 2, text: 'world' }));

  const provider =
    options.provider ||
    createFakeSavedTranscriptTranslationProvider({
      result: options.providerResult || { translatedText: 'Bonjour' }
    });
  const translationRepository = options.translationRepositoryFactory
    ? options.translationRepositoryFactory(createTranslationRepositoryAdapter({ sessionRepository }))
    : undefined;

  return {
    ...createApplicationDependencies({
      sessionRepository,
      ...(translationRepository ? { translationRepository } : {}),
      savedTranscriptTranslationProvider: provider,
      idGenerator: sequentialIdGenerator(),
      clock: sequentialClock(),
      translationDomainEventHandlers: options.handlers || {}
    }),
    provider
  };
}

function recordEvents(events) {
  return {
    requestCreated(event) {
      events.push(event);
    },
    executionCreated(event) {
      events.push(event);
    },
    executionUpdated(event) {
      events.push(event);
    },
    outputCreated(event) {
      events.push(event);
    }
  };
}

function sessionDetail({ sessionId = 'session-1', sourceItems } = {}) {
  return {
    sessionRecord: {
      id: sessionId,
      status: 'completed',
      startedAt: '2026-07-14T01:00:00.000Z',
      endedAt: '2026-07-14T01:05:00.000Z',
      targetLanguageCode: 'fr'
    },
    transcriptItems: sourceItems ?? [sourceItem({ text: 'Hello' })]
  };
}

function sourceItem(overrides = {}) {
  return {
    id: 'source-1',
    sessionId: 'session-1',
    stream: 'source',
    status: 'final',
    text: 'Hello',
    sequence: 1,
    startedAt: '2026-07-14T01:00:01.000Z',
    finalizedAt: '2026-07-14T01:00:02.000Z',
    ...overrides
  };
}

function operationInput(overrides = {}) {
  return {
    sessionId: 'session-1',
    sourceLanguageCode: 'en',
    targetLanguageCode: 'fr',
    ...overrides
  };
}

function sequentialIdGenerator() {
  const counts = new Map();
  const names = new Map([
    ['translation-request', 'request'],
    ['translation-execution', 'execution'],
    ['translation-output', 'output']
  ]);

  return (prefix) => {
    const nextCount = (counts.get(prefix) || 0) + 1;
    counts.set(prefix, nextCount);
    return `${names.get(prefix) || prefix}-${nextCount}`;
  };
}

function sequentialClock() {
  let count = 0;
  return () => {
    count += 1;
    return `t${count}`;
  };
}

function callRecorder() {
  const calls = [];
  return {
    push(name, input) {
      calls.push([name, input]);
    },
    names() {
      return calls.map(([name]) => name);
    },
    entries() {
      return calls.slice();
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for condition.');
}

function compareById(first, second) {
  return first.id.localeCompare(second.id);
}
