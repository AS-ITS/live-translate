import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTranslationRepository,
  TRANSLATION_REPOSITORY_METHODS
} from '../../src/domain/translation/translationRepository.js';

const EXPECTED_METHODS = [
  'createTranslationRequest',
  'getTranslationRequest',
  'updateTranslationRequest',
  'listTranslationRequestsBySession',
  'createTranslationExecution',
  'getTranslationExecution',
  'updateTranslationExecution',
  'listTranslationExecutionsByRequest',
  'createTranslationOutput',
  'listTranslationOutputsByExecution',
  'listTranslationOutputsBySession',
  'listTranslationOutputsByRequest',
  'getTranslationOutput'
];

test('exports translation repository factory', () => {
  assert.equal(typeof createTranslationRepository, 'function');
});

test('repository exposes exactly the required translation repository methods', () => {
  const repository = createTranslationRepository();

  assert.deepEqual(TRANSLATION_REPOSITORY_METHODS, EXPECTED_METHODS);
  assert.deepEqual(Object.keys(repository), EXPECTED_METHODS);

  for (const method of EXPECTED_METHODS) {
    assert.equal(typeof repository[method], 'function');
  }
});

test('every repository method throws not implemented error', () => {
  const repository = createTranslationRepository();

  for (const method of EXPECTED_METHODS) {
    assert.throws(() => repository[method](), new RegExp(`TranslationRepository\\.${method} is not implemented\\.`));
  }
});

test('repository method list and object shape are immutable', () => {
  const repository = createTranslationRepository();

  assert.equal(Object.isFrozen(TRANSLATION_REPOSITORY_METHODS), true);
  assert.equal(Object.isFrozen(repository), true);

  assert.throws(() => {
    TRANSLATION_REPOSITORY_METHODS.push('extraMethod');
  }, TypeError);
  assert.throws(() => {
    repository.extraMethod = () => null;
  }, TypeError);
  assert.throws(() => {
    delete repository.createTranslationRequest;
  }, TypeError);

  assert.deepEqual(Object.keys(repository), EXPECTED_METHODS);
});
