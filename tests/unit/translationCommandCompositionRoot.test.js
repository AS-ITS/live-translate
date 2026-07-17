import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApplicationDependencies,
  createProductionApplicationDependencies,
  createTranslationCommandDependencies
} from '../../server/compositionRoot.js';
import { TranslationExecution } from '../../src/domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../../src/domain/translation/translationRepository.js';
import { createFakeTranslationExecutionProvider } from '../../src/infrastructure/fakeTranslationExecutionProvider.js';

test('application dependencies assemble translation command graph with injected repository', () => {
  const translationRepository = repository();
  const domainEventPublisher = publisher();
  const translationExecutionDispatcher = dispatcher();
  const translationCommandService = service();
  const translationCommandController = controller();
  const requestHandlerResult = function requestHandler() {};
  const calls = [];

  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
    translationCommandServiceFactory(options) {
      calls.push(['serviceFactory', options]);
      return translationCommandService;
    },
    translationCommandControllerFactory(options) {
      calls.push(['controllerFactory', options]);
      return translationCommandController;
    },
    requestHandlerFactory(options) {
      calls.push(['requestHandlerFactory', options]);
      return requestHandlerResult;
    }
  });

  assert.strictEqual(dependencies.translationRepository, translationRepository);
  assert.strictEqual(dependencies.domainEventPublisher, domainEventPublisher);
  assert.strictEqual(dependencies.translationExecutionDispatcher, translationExecutionDispatcher);
  assert.strictEqual(dependencies.translationCommandService, translationCommandService);
  assert.strictEqual(dependencies.translationCommandController, translationCommandController);
  assert.strictEqual(dependencies.requestHandler, requestHandlerResult);
  assert.strictEqual(calls[0][1].translationRepository, translationRepository);
  assert.strictEqual(calls[0][1].domainEventPublisher, domainEventPublisher);
  assert.strictEqual(calls[0][1].translationExecutionDispatcher, translationExecutionDispatcher);
  assert.deepEqual(Object.keys(calls[0][1]), [
    'translationRepository',
    'domainEventPublisher',
    'translationExecutionDispatcher'
  ]);
  assert.strictEqual(calls[1][1].translationCommandService, translationCommandService);
  assert.deepEqual(Object.keys(calls[1][1]), ['translationCommandService']);
  assert.strictEqual(calls[2][1].translationCommandController, translationCommandController);
  assert.strictEqual(calls[2][1].sessionReadController, dependencies.sessionReadController);
  assert.deepEqual(Object.keys(calls[2][1]).sort(), ['sessionReadController', 'translationCommandController']);
});

test('translation command dependencies use the service factory result to build the controller', () => {
  const translationRepository = repository();
  const domainEventPublisher = publisher();
  const translationExecutionDispatcher = dispatcher();
  const translationCommandService = service();
  const translationCommandController = controller();
  let injectedRepository;
  let injectedPublisher;
  let injectedDispatcher;
  let injectedService;

  const dependencies = createTranslationCommandDependencies({
    translationRepository,
    domainEventPublisher,
    translationExecutionDispatcher,
    translationCommandServiceFactory({
      translationRepository: nextRepository,
      domainEventPublisher: nextPublisher,
      translationExecutionDispatcher: nextDispatcher
    }) {
      injectedRepository = nextRepository;
      injectedPublisher = nextPublisher;
      injectedDispatcher = nextDispatcher;
      return translationCommandService;
    },
    translationCommandControllerFactory({ translationCommandService: nextService }) {
      injectedService = nextService;
      return translationCommandController;
    }
  });

  assert.strictEqual(injectedRepository, translationRepository);
  assert.strictEqual(injectedPublisher, domainEventPublisher);
  assert.strictEqual(injectedDispatcher, translationExecutionDispatcher);
  assert.strictEqual(injectedService, translationCommandService);
  assert.strictEqual(dependencies.domainEventPublisher, domainEventPublisher);
  assert.strictEqual(dependencies.translationExecutionDispatcher, translationExecutionDispatcher);
  assert.strictEqual(dependencies.translationCommandService, translationCommandService);
  assert.strictEqual(dependencies.translationCommandController, translationCommandController);
});

test('production composition injects an execution provider resolver for the production provider', () => {
  const geminiHttpClient = { post() {} };
  const geminiClient = {
    async execute() {
      return { translatedText: 'Bonjour' };
    }
  };
  const geminiProvider = {
    async execute() {
      return { translatedText: 'Bonjour' };
    }
  };
  const calls = [];
  const serviceResult = service();
  let observedServiceOptions;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'model-from-env'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    geminiEnvironmentFactory(options) {
      calls.push(['environment', options]);
      return { apiKey: 'api-key-from-env', model: 'model-from-env' };
    },
    geminiHttpClientFactory(options) {
      calls.push(['geminiHttpClient', options]);
      return geminiHttpClient;
    },
    geminiClientFactory(options) {
      calls.push(['geminiClient', options]);
      return geminiClient;
    },
    geminiTranslationExecutionProviderFactory(options) {
      calls.push(['geminiExecutionProvider', options]);
      return geminiProvider;
    },
    googleGenAIClientFactory(options) {
      calls.push(['googleClient', options]);
      return { models: { generateContent() {} } };
    },
    geminiClientAdapterFactory(options) {
      calls.push(['adapter', options]);
      return { generateContent() {} };
    },
    geminiSavedTranscriptTranslationCompositionFactory(options) {
      calls.push(['providerComposition', options]);
      return { savedTranscriptTranslationProvider: { translate() {} } };
    },
    translationProviderConfigurationFactory(options) {
      calls.push(['providerConfiguration', options]);
      return { defaultProviderKey: 'gemini' };
    },
    translationProviderResolutionCompositionFactory(options) {
      calls.push(['providerResolutionComposition', options]);
      return {
        resolver: {
          resolve() {
            throw new Error('saved transcript resolver should not run');
          }
        },
        resolve() {
          throw new Error('saved transcript resolver should not run');
        }
      };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    },
    translationCommandServiceFactory(options) {
      observedServiceOptions = options;
      return serviceResult;
    }
  });

  assert.equal(Object.hasOwn(dependencies, 'translationExecutionProvider'), false);
  assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve, 'function');
  assert.equal(dependencies.retryPolicy.maxRetries, 0);
  assert.strictEqual(dependencies.translationCommandService, serviceResult);
  assert.strictEqual(
    observedServiceOptions.translationExecutionProviderResolver,
    dependencies.translationExecutionProviderResolver
  );
  assert.strictEqual(observedServiceOptions.translationExecutionProviderResolver.resolve('gemini'), geminiProvider);
  assert.strictEqual(observedServiceOptions.translationExecutionProviderResolver.resolve(undefined), geminiProvider);
  assert.throws(
    () => observedServiceOptions.translationExecutionProviderResolver.resolve('fake'),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message, 'translation execution provider not found: fake');
      return true;
    }
  );
  assert.deepEqual(calls.map(([name]) => name), [
    'environment',
    'providerConfiguration',
    'geminiHttpClient',
    'geminiClient',
    'geminiExecutionProvider'
  ]);
  assert.strictEqual(calls[2][1].apiKey, 'api-key-from-env');
  assert.deepEqual(calls[3][1], {
    httpClient: geminiHttpClient,
    model: 'model-from-env'
  });
  assert.deepEqual(calls[4][1], { client: geminiClient });
  assert.equal(Object.hasOwn(observedServiceOptions, 'translationProviderResolver'), false);
  assert.equal(Object.hasOwn(observedServiceOptions, 'translationExecutionProvider'), false);
  assert.equal(observedServiceOptions.retryPolicy.maxRetries, 0);
});

test('production composition executes the Gemini provider for providerKey gemini', async () => {
  const httpCalls = [];
  let persistedExecution;
  let persistedOutput;
  let completedExecution;
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'gemini-composed-model'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      createTranslationOutput(output) {
        persistedOutput = output;
        return output;
      },
      updateTranslationExecution(execution) {
        completedExecution = execution;
        return execution;
      }
    }),
    geminiHttpClientFactory({ apiKey }) {
      assert.equal(apiKey, 'api-key-from-env');
      return {
        post(request) {
          httpCalls.push(request);
          return {
            ok: true,
            async json() {
              return {
                translatedText: 'Bonjour',
                detectedSourceLanguageCode: 'en'
              };
            }
          };
        }
      };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.equal(Object.hasOwn(dependencies, 'translationExecutionProvider'), false);
  assert.equal(typeof dependencies.translationExecutionProviderResolver.resolve('gemini').execute, 'function');

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      providerKey: 'gemini'
    })
  );

  assert.strictEqual(result, persistedExecution);
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].path, '/v1beta/models/gemini-composed-model:generateContent');
  assert.equal(httpCalls[0].body.contents[0].parts.at(-1).text, 'hello');
  assert.equal(persistedOutput.translatedText, 'Bonjour');
  assert.equal(persistedOutput.targetLanguageCode, 'fr');
  assert.equal(completedExecution.status, 'completed');
});

test('production composition executes the default Gemini provider when providerKey is omitted', async () => {
  const httpCalls = [];
  let persistedExecution;
  let persistedOutput;
  let completedExecution;
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'api-key-from-env',
      GEMINI_MODEL: 'gemini-default-model'
    },
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      createTranslationOutput(output) {
        persistedOutput = output;
        return output;
      },
      updateTranslationExecution(execution) {
        completedExecution = execution;
        return execution;
      }
    }),
    geminiHttpClientFactory({ apiKey }) {
      assert.equal(apiKey, 'api-key-from-env');
      return {
        post(request) {
          httpCalls.push(request);
          return {
            ok: true,
            async json() {
              return {
                translatedText: 'Bonjour',
                detectedSourceLanguageCode: 'en'
              };
            }
          };
        }
      };
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(
    dependencies.translationExecutionProviderResolver.resolve(undefined),
    dependencies.translationExecutionProviderResolver.resolve('gemini')
  );

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    })
  );

  assert.strictEqual(result, persistedExecution);
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].path, '/v1beta/models/gemini-default-model:generateContent');
  assert.equal(persistedOutput.translatedText, 'Bonjour');
  assert.equal(persistedOutput.targetLanguageCode, 'fr');
  assert.equal(completedExecution.status, 'completed');
});

test('production composition injects supplied execution provider and uses it', async () => {
  const providerCalls = [];
  let persistedExecution;
  let persistedOutput;
  let completedExecution;
  const suppliedProvider = {
    async execute(input) {
      providerCalls.push(input);
      return { translatedText: 'Bonjour' };
    }
  };
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      createTranslationOutput(output) {
        persistedOutput = output;
        return output;
      },
      updateTranslationExecution(execution) {
        completedExecution = execution;
        return execution;
      }
    }),
    translationExecutionProvider: suppliedProvider,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(dependencies.translationExecutionProvider, suppliedProvider);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve('fake'), suppliedProvider);
  assert.equal(dependencies.retryPolicy.maxRetries, 0);

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      providerKey: 'fake'
    })
  );

  assert.strictEqual(result, persistedExecution);
  assert.deepEqual(providerCalls, [
    {
      sourceText: 'hello',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr',
      providerKey: 'fake'
    }
  ]);
  assert.equal(persistedOutput.translatedText, 'Bonjour');
  assert.equal(persistedOutput.targetLanguageCode, 'fr');
  assert.equal(completedExecution.status, 'completed');
});

test('production composition default retry policy does not retry provider failures', async () => {
  const providerError = new Error('provider failed');
  let providerCalls = 0;
  let failedExecution;
  const suppliedProvider = {
    async execute() {
      providerCalls += 1;
      throw providerError;
    }
  };
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        return execution;
      },
      createTranslationOutput() {
        throw new Error('output should not be created on provider failure');
      },
      updateTranslationExecution(execution) {
        failedExecution = execution;
        return execution;
      }
    }),
    translationExecutionProvider: suppliedProvider,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(dependencies.translationExecutionProvider, suppliedProvider);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve(undefined), suppliedProvider);
  assert.equal(dependencies.retryPolicy.maxRetries, 0);

  await assert.rejects(
    dependencies.translationCommandService.createTranslationExecution(
      executionPayload({
        sourceText: 'hello',
        targetLanguageCode: 'fr'
      })
    ),
    (actualError) => actualError === providerError
  );

  assert.equal(providerCalls, 1);
  assert.equal(failedExecution.status, 'failed');
});

test('fake composition keeps supplied FakeTranslationExecutionProvider unchanged', async () => {
  let persistedExecution;
  let persistedOutput;
  let completedExecution;
  const fakeProvider = createFakeTranslationExecutionProvider();
  const dependencies = createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      },
      createTranslationOutput(output) {
        persistedOutput = output;
        return output;
      },
      updateTranslationExecution(execution) {
        completedExecution = execution;
        return execution;
      }
    }),
    translationExecutionProvider: fakeProvider,
    geminiEnvironmentFactory() {
      throw new Error('Gemini environment should not be created for supplied fake provider');
    },
    geminiHttpClientFactory() {
      throw new Error('Gemini HTTP client should not be created for supplied fake provider');
    },
    geminiClientFactory() {
      throw new Error('Gemini client should not be created for supplied fake provider');
    },
    geminiTranslationExecutionProviderFactory() {
      throw new Error('Gemini execution provider should not be created for supplied fake provider');
    },
    googleGenAIClientFactory() {
      throw new Error('Google GenAI client should not be created for supplied fake provider');
    },
    geminiClientAdapterFactory() {
      throw new Error('Gemini saved-transcript client adapter should not be created for supplied fake provider');
    },
    geminiSavedTranscriptTranslationCompositionFactory() {
      throw new Error('Gemini saved-transcript provider should not be created for supplied fake provider');
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider resolution should not run');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    }
  });

  assert.strictEqual(dependencies.translationExecutionProvider, fakeProvider);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve('fake'), fakeProvider);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve(undefined), fakeProvider);
  assert.throws(
    () => dependencies.translationExecutionProviderResolver.resolve('unknown-provider'),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message, 'translation execution provider not found: unknown-provider');
      return true;
    }
  );
  assert.equal(dependencies.retryPolicy.maxRetries, 0);

  const result = await dependencies.translationCommandService.createTranslationExecution(
    executionPayload({
      sourceText: 'hello',
      targetLanguageCode: 'fr'
    })
  );

  assert.equal(result instanceof TranslationExecution, true);
  assert.strictEqual(result, persistedExecution);
  assert.deepEqual(dependencies.translationExecutionDispatcher.dispatchedExecutions, []);
  assert.equal(persistedOutput.translatedText, '[fake] hello');
  assert.equal(persistedOutput.targetLanguageCode, 'fr');
  assert.equal(completedExecution.status, 'completed');
});

test('production runtime wiring preserves saved transcript resolver composition', () => {
  const savedTranscriptResolver = {
    resolve() {
      throw new Error('runtime resolver should not run');
    }
  };
  const geminiExecutionProvider = {
    async execute() {
      return { translatedText: 'Bonjour' };
    }
  };
  const savedTranscriptProvider = { translate() {} };
  const savedTranscriptService = { translateSavedTranscript() {} };
  const resolvedProvider = { translate() {} };
  let resolveSavedTranscriptTranslationProvider;

  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'unused-by-mock',
      GEMINI_MODEL: 'unused-by-mock'
    },
    sessionReadRepository: readRepository(),
    geminiEnvironmentFactory() {
      return { apiKey: 'api-key', model: 'model-name' };
    },
    geminiHttpClientFactory() {
      return { post() {} };
    },
    geminiClientFactory() {
      return { execute() {} };
    },
    geminiTranslationExecutionProviderFactory() {
      return geminiExecutionProvider;
    },
    googleGenAIClientFactory() {
      return { models: { generateContent() {} } };
    },
    geminiClientAdapterFactory() {
      return { generateContent() {} };
    },
    geminiSavedTranscriptTranslationCompositionFactory() {
      return { savedTranscriptTranslationProvider: savedTranscriptProvider };
    },
    translationProviderConfigurationFactory() {
      return { defaultProviderKey: 'gemini' };
    },
    translationProviderResolutionCompositionFactory() {
      return {
        resolver: savedTranscriptResolver,
        resolve(options) {
          assert.deepEqual(options, {
            providerKey: 'gemini',
            configuration: { defaultProviderKey: 'gemini' }
          });
          return resolvedProvider;
        }
      };
    },
    savedTranscriptRetranslationServiceFactory(options) {
      resolveSavedTranscriptTranslationProvider = options.resolveSavedTranscriptTranslationProvider;
      assert.ok(!Object.hasOwn(options, 'savedTranscriptTranslationProvider'));
      return savedTranscriptService;
    }
  });

  assert.strictEqual(dependencies.savedTranscriptRetranslationService, savedTranscriptService);
  assert.strictEqual(dependencies.translationExecutionProviderResolver.resolve('gemini'), geminiExecutionProvider);
  assert.strictEqual(resolveSavedTranscriptTranslationProvider({ providerKey: 'gemini' }), resolvedProvider);
});

test('application composition injects supplied dispatcher unchanged and awaits dispatch when provider is omitted', async () => {
  const deferredDispatch = createDeferred();
  const dispatchCalls = [];
  let persistedExecution;
  let resolved = false;
  const suppliedDispatcher = {
    dispatch(...args) {
      dispatchCalls.push(args);
      return deferredDispatch.promise;
    }
  };
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      }
    }),
    translationExecutionDispatcher: suppliedDispatcher
  });

  assert.strictEqual(dependencies.translationExecutionDispatcher, suppliedDispatcher);
  assert.equal(Object.hasOwn(dependencies.translationExecutionDispatcher, 'dispatchedExecutions'), false);

  const resultPromise = dependencies.translationCommandService.createTranslationExecution(executionPayload()).then((result) => {
    resolved = true;
    return result;
  });

  await Promise.resolve();

  assert.equal(resolved, false);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].length, 1);
  assert.strictEqual(dispatchCalls[0][0], persistedExecution);

  deferredDispatch.resolve();

  assert.strictEqual(await resultPromise, persistedExecution);
  assert.equal(resolved, true);
});

test('application-composed dispatcher failure propagates after persistence without retry when provider is omitted', async () => {
  const dispatcherError = new Error('dispatch failed');
  let persistedExecution;
  let dispatchCalls = 0;
  let publishCalls = 0;
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      }
    }),
    domainEventPublisher: publisher({
      publish() {
        publishCalls += 1;
      }
    }),
    translationExecutionDispatcher: {
      async dispatch(execution) {
        dispatchCalls += 1;
        assert.strictEqual(execution, persistedExecution);
        throw dispatcherError;
      }
    }
  });

  await assert.rejects(
    dependencies.translationCommandService.createTranslationExecution(executionPayload()),
    dispatcherError
  );

  assert.equal(persistedExecution instanceof TranslationExecution, true);
  assert.equal(dispatchCalls, 1);
  assert.equal(publishCalls, 0);
});

test('translation command service remains constructible when execution provider is undefined', async () => {
  let persistedExecution;
  const dependencies = createTranslationCommandDependencies({
    translationRepository: repository({
      createTranslationExecution(execution) {
        persistedExecution = execution;
        return execution;
      }
    }),
    translationExecutionProvider: undefined
  });

  assert.equal(Object.hasOwn(dependencies, 'translationExecutionProvider'), false);

  const result = await dependencies.translationCommandService.createTranslationExecution(executionPayload());

  assert.strictEqual(result, persistedExecution);
  assert.deepEqual(dependencies.translationExecutionDispatcher.dispatchedExecutions, [persistedExecution]);
});

test('production composition forwards create-execution providerKey from controller to service unchanged', () => {
  const serviceCalls = [];
  const input = {
    executionId: 'execution-1',
    requestId: 'request-1',
    providerKey: 'gemini'
  };
  const dependencies = createProductionTranslationCommandDependencies({
    createTranslationExecution(nextInput) {
      serviceCalls.push(nextInput);
      return { id: nextInput.executionId };
    }
  });

  const result = dependencies.translationCommandController.createTranslationExecution(input);

  assert.deepEqual(result, { id: 'execution-1' });
  assert.deepEqual(serviceCalls, [input]);
  assert.strictEqual(serviceCalls[0], input);
  assert.equal(serviceCalls[0].providerKey, 'gemini');
});

test('production composition preserves omitted create-execution providerKey as undefined', () => {
  const serviceCalls = [];
  const input = {
    executionId: 'execution-1',
    requestId: 'request-1'
  };
  const dependencies = createProductionTranslationCommandDependencies({
    createTranslationExecution(nextInput) {
      serviceCalls.push(nextInput);
      return { id: nextInput.executionId };
    }
  });

  const result = dependencies.translationCommandController.createTranslationExecution(input);

  assert.deepEqual(result, { id: 'execution-1' });
  assert.deepEqual(serviceCalls, [input]);
  assert.strictEqual(serviceCalls[0], input);
  assert.equal(serviceCalls[0].providerKey, undefined);
  assert.equal(Object.hasOwn(serviceCalls[0], 'providerKey'), false);
});

test('translation command dependencies create one usable publisher instance by default', () => {
  const translationRepository = repository();
  const translationCommandService = service();
  let injectedPublisher;
  let injectedDispatcher;

  const dependencies = createTranslationCommandDependencies({
    translationRepository,
    translationCommandServiceFactory({ domainEventPublisher: nextPublisher, translationExecutionDispatcher }) {
      injectedPublisher = nextPublisher;
      injectedDispatcher = translationExecutionDispatcher;
      return translationCommandService;
    },
    translationCommandControllerFactory() {
      return controller();
    }
  });

  assert.equal(typeof dependencies.domainEventPublisher.publish, 'function');
  assert.equal(typeof dependencies.translationExecutionDispatcher.dispatch, 'function');
  assert.strictEqual(injectedPublisher, dependencies.domainEventPublisher);
  assert.strictEqual(injectedDispatcher, dependencies.translationExecutionDispatcher);
});

test('application dependencies preserve existing session read controller wiring', () => {
  const history = [{ id: 'session-1' }];
  const detail = { session: { id: 'session-1' } };
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository({ history, detail }),
    translationRepository: repository()
  });

  assert.deepEqual(dependencies.sessionReadController.listSessions(), history);
  assert.deepEqual(dependencies.sessionReadController.getSession('session-1'), detail);
});

test('composition root returns the request handler factory result', () => {
  const requestHandlerResult = function requestHandler() {};
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    requestHandlerFactory() {
      return requestHandlerResult;
    }
  });

  assert.strictEqual(dependencies.requestHandler, requestHandlerResult);
});

test('translation command dependency validation follows existing TypeError style', () => {
  assert.throws(
    () =>
      createApplicationDependencies({
        sessionReadRepository: readRepository(),
        translationRepository: undefined
      }),
    TypeError
  );
  assert.throws(
    () =>
      createApplicationDependencies({
        sessionReadRepository: readRepository(),
        translationRepository: repository(),
        translationCommandServiceFactory: {}
      }),
    /translationCommandServiceFactory must be a function/
  );
  assert.throws(
    () =>
      createApplicationDependencies({
        sessionReadRepository: readRepository(),
        translationRepository: repository(),
        translationCommandControllerFactory: null
      }),
    /translationCommandControllerFactory must be a function/
  );
});

test('composition root does not execute repository commands while assembling dependencies', () => {
  const calls = [];
  const dependencies = createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository(
      Object.fromEntries(
        TRANSLATION_REPOSITORY_METHODS.map((methodName) => [
          methodName,
          function repositoryCommand() {
            calls.push(methodName);
            throw new Error(`${methodName} should not be called during composition`);
          }
        ])
      )
    )
  });

  assert.equal(typeof dependencies.translationCommandController.createTranslationRequest, 'function');
  assert.deepEqual(calls, []);
});

test('composition root does not create provider, database, queue, event bus, or frontend dependencies', () => {
  const unexpectedDependencyNames = ['provider', 'database', 'queue', 'eventBus', 'frontend'];
  const observedFactoryOptions = [];

  createApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    translationCommandServiceFactory(options) {
      observedFactoryOptions.push(options);
      return service();
    },
    translationCommandControllerFactory(options) {
      observedFactoryOptions.push(options);
      return controller();
    },
    requestHandlerFactory(options) {
      observedFactoryOptions.push(options);
      return function requestHandler() {};
    }
  });

  for (const options of observedFactoryOptions) {
    for (const dependencyName of unexpectedDependencyNames) {
      assert.equal(Object.prototype.hasOwnProperty.call(options, dependencyName), false);
    }
  }
});

function repository(overrides = {}) {
  return Object.fromEntries(
    TRANSLATION_REPOSITORY_METHODS.map((methodName) => [
      methodName,
      overrides[methodName] ||
        function repositoryMethod() {
          return null;
        }
    ])
  );
}

function service(overrides = {}) {
  return {
    createTranslationRequest:
      overrides.createTranslationRequest ||
      function createTranslationRequest(input) {
        return input;
      },
    createTranslationExecution:
      overrides.createTranslationExecution ||
      function createTranslationExecution(input) {
        return input;
      },
    updateTranslationExecution:
      overrides.updateTranslationExecution ||
      function updateTranslationExecution(input) {
        return input;
      },
    createTranslationOutput:
      overrides.createTranslationOutput ||
      function createTranslationOutput(input) {
        return input;
      }
  };
}

function publisher(overrides = {}) {
  return {
    publish:
      overrides.publish ||
      function publish() {
        return undefined;
      }
  };
}

function dispatcher(overrides = {}) {
  return {
    dispatch:
      overrides.dispatch ||
      async function dispatch() {
        return undefined;
      }
  };
}

function controller(overrides = {}) {
  return service(overrides);
}

function executionPayload(overrides = {}) {
  return {
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
    ...overrides
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

function createProductionTranslationCommandDependencies(serviceOverrides = {}) {
  return createProductionApplicationDependencies({
    sessionReadRepository: readRepository(),
    translationRepository: repository(),
    translationExecutionProvider: {
      async execute() {
        return { translatedText: 'translated' };
      }
    },
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('provider resolution should not run for translation command composition');
    },
    savedTranscriptRetranslationServiceFactory() {
      return { translateSavedTranscript() {} };
    },
    translationCommandServiceFactory() {
      return service(serviceOverrides);
    }
  });
}

function readRepository(overrides = {}) {
  return {
    listSessionHistory:
      overrides.listSessionHistory ||
      function listSessionHistory() {
        return overrides.history || [];
      },
    getSessionDetail:
      overrides.getSessionDetail ||
      function getSessionDetail() {
        return overrides.detail || null;
      }
  };
}
