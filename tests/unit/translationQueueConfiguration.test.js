import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DURABLE_TRANSLATION_QUEUE_FILE,
  createTranslationQueueConfiguration
} from '../../src/infrastructure/translationQueueConfiguration.js';

test('defaults durable queue to disabled', () => {
  const configuration = createTranslationQueueConfiguration({
    environment: {}
  });

  assert.equal(configuration.durableQueueEnabled, false);
});

test('enabled=true enables durable queue', () => {
  const configuration = createTranslationQueueConfiguration({
    environment: {
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true'
    }
  });

  assert.equal(configuration.durableQueueEnabled, true);
});

test('enabled=false disables durable queue', () => {
  const configuration = createTranslationQueueConfiguration({
    environment: {
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'false'
    }
  });

  assert.equal(configuration.durableQueueEnabled, false);
});

test('custom file path is used when provided', () => {
  const configuration = createTranslationQueueConfiguration({
    environment: {
      TRANSLATION_DURABLE_QUEUE_FILE: '/tmp/custom-translation-queue.json'
    }
  });

  assert.equal(configuration.durableQueueFilePath, '/tmp/custom-translation-queue.json');
});

test('default file path uses translation execution queue filename', () => {
  const configuration = createTranslationQueueConfiguration({
    environment: {}
  });

  assert.equal(configuration.durableQueueFilePath, DEFAULT_DURABLE_TRANSLATION_QUEUE_FILE);
  assert.equal(configuration.durableQueueFilePath, 'translation-execution-queue.json');
});

test('returned configuration is frozen and exposes only durable queue fields', () => {
  const configuration = createTranslationQueueConfiguration({
    environment: {
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true',
      TRANSLATION_DURABLE_QUEUE_FILE: '/tmp/custom-translation-queue.json'
    }
  });

  assert.equal(Object.isFrozen(configuration), true);
  assert.deepEqual(Object.keys(configuration), ['durableQueueEnabled', 'durableQueueFilePath']);
  assert.throws(() => {
    configuration.durableQueueEnabled = false;
  }, TypeError);
});

test('does not mutate supplied environment', () => {
  const environment = {
    TRANSLATION_DURABLE_QUEUE_ENABLED: 'true',
    TRANSLATION_DURABLE_QUEUE_FILE: '/tmp/custom-translation-queue.json'
  };
  const before = structuredClone(environment);

  createTranslationQueueConfiguration({ environment });

  assert.deepEqual(environment, before);
});
