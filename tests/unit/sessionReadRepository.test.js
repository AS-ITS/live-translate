import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSessionReadRepository,
  SESSION_READ_REPOSITORY_METHODS
} from '../../src/repositories/sessionReadRepository.js';

const transcriptSummary = Object.freeze({
  totalItems: 2,
  sourceFinalCount: 1,
  translationFinalCount: 1,
  sourcePartialCount: 0,
  translationPartialCount: 0,
  hasTranscript: true
});

test('read repository exposes the session read repository interface', () => {
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({ records: [] })
  });

  for (const method of SESSION_READ_REPOSITORY_METHODS) {
    assert.equal(typeof repository[method], 'function');
  }
});

test('empty repository returns an empty history list', () => {
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({ records: [] })
  });

  assert.deepEqual(repository.listSessionHistory(), []);
});

test('history records are mapped through the history read model contract', () => {
  const record = sessionRecord({
    id: 'session-1',
    createdAt: 900,
    updatedAt: 5100,
    lastLifecycleState: 'completed'
  });
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({ records: [record] })
  });

  assert.deepEqual(repository.listSessionHistory(), [
    {
      id: 'session-1',
      status: 'completed',
      startedAt: 1000,
      endedAt: 5000,
      durationMs: 4000,
      targetLanguageCode: 'fr',
      targetLanguageLabel: 'French',
      failureReason: null,
      failureCategory: null,
      transcriptSummary,
      recordKind: 'session',
      retranslatedFrom: null,
      legacy: true
    }
  ]);
});

test('history ordering follows the underlying repository order', () => {
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({
      records: [
        sessionRecord({ id: 'session-2', startedAt: 2000 }),
        sessionRecord({ id: 'session-1', startedAt: 1000 })
      ]
    })
  });

  assert.deepEqual(
    repository.listSessionHistory().map((item) => item.id),
    ['session-2', 'session-1']
  );
});

test('raw legacy records are not returned from history', () => {
  const record = sessionRecord({
    id: 'session-1',
    createdAt: 900,
    updatedAt: 5100,
    lastLifecycleState: 'completed'
  });
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({ records: [record] })
  });

  const [historyItem] = repository.listSessionHistory();

  assert.notStrictEqual(historyItem, record);
  assert.equal(historyItem.createdAt, undefined);
  assert.equal(historyItem.updatedAt, undefined);
  assert.equal(historyItem.lastLifecycleState, undefined);
});

test('detail lookup returns a mapped detail DTO', () => {
  const detail = sessionDetail({
    transcriptItems: [
      transcriptItem({ id: 'source-1', stream: 'source', text: 'Hello.', sequence: 1 }),
      transcriptItem({ id: 'translation-1', stream: 'translation', text: 'Bonjour.', sequence: 2 })
    ]
  });
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({ details: { 'session-1': detail } })
  });

  const dto = repository.getSessionDetail('session-1');

  assert.equal(dto.session.id, 'session-1');
  assert.equal(dto.sourceTranscript.id, 'source:session-1');
  assert.deepEqual(dto.sourceTranscript.items.map((item) => item.id), ['source-1']);
  assert.deepEqual(dto.translationOutputs[0].items.map((item) => item.id), ['translation-1']);
  assert.equal(dto.selectedTranslationOutput, dto.translationOutputs[0]);
});

test('missing session detail returns null', () => {
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({ details: {} })
  });

  assert.equal(repository.getSessionDetail('missing'), null);
});

test('repository inputs and results are not mutated', () => {
  const record = sessionRecord({ id: 'session-1', transcriptSummary: { ...transcriptSummary } });
  const detail = sessionDetail({
    sessionRecord: record,
    transcriptItems: [
      transcriptItem({ id: 'translation-1', stream: 'translation', text: 'Bonjour.', sequence: 2 })
    ]
  });
  const beforeRecord = JSON.stringify(record);
  const beforeDetail = JSON.stringify(detail);
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({ records: [record], details: { 'session-1': detail } })
  });

  const [historyItem] = repository.listSessionHistory();
  const dto = repository.getSessionDetail('session-1');
  historyItem.transcriptSummary.totalItems = 99;
  dto.translationOutputs[0].items[0].text = 'mutated';

  assert.equal(JSON.stringify(record), beforeRecord);
  assert.equal(JSON.stringify(detail), beforeDetail);
});

test('underlying asynchronous repository behavior is supported', async () => {
  const repository = createSessionReadRepository({
    sessionRepository: {
      async listSessionRecords() {
        return [sessionRecord({ id: 'session-1' })];
      },
      async getSessionRecord(id) {
        return id === 'session-1' ? sessionDetail() : null;
      }
    }
  });

  const history = await repository.listSessionHistory();
  const detail = await repository.getSessionDetail('session-1');

  assert.deepEqual(history.map((item) => item.id), ['session-1']);
  assert.equal(detail.session.id, 'session-1');
});

test('storage errors are not converted into successful empty results', async () => {
  const syncRepository = createSessionReadRepository({
    sessionRepository: {
      listSessionRecords() {
        throw new Error('storage failed');
      },
      getSessionRecord() {
        throw new Error('detail failed');
      }
    }
  });
  const asyncRepository = createSessionReadRepository({
    sessionRepository: {
      async listSessionRecords() {
        throw new Error('async storage failed');
      },
      async getSessionRecord() {
        throw new Error('async detail failed');
      }
    }
  });

  assert.throws(() => syncRepository.listSessionHistory(), /storage failed/);
  assert.throws(() => syncRepository.getSessionDetail('session-1'), /detail failed/);
  await assert.rejects(asyncRepository.listSessionHistory(), /async storage failed/);
  await assert.rejects(asyncRepository.getSessionDetail('session-1'), /async detail failed/);
});

test('mapper-generated legacy metadata remains intact', () => {
  const repository = createSessionReadRepository({
    sessionRepository: legacyRepository({
      records: [sessionRecord({ id: 'session-1' })],
      details: {
        'session-1': sessionDetail({
          transcriptItems: [transcriptItem({ id: 'translation-1', stream: 'translation' })]
        })
      }
    })
  });

  const [historyItem] = repository.listSessionHistory();
  const detail = repository.getSessionDetail('session-1');

  assert.equal(historyItem.legacy, true);
  assert.equal(detail.legacy, true);
  assert.equal(detail.sourceTranscript.legacy, true);
  assert.equal(detail.translationOutputs[0].legacy, true);
});

function legacyRepository({ records = [], details = {} }) {
  return {
    listSessionRecords() {
      return records;
    },
    getSessionRecord(id) {
      return details[id] ?? null;
    }
  };
}

function sessionDetail(overrides = {}) {
  return {
    sessionRecord: overrides.sessionRecord || sessionRecord(),
    transcriptItems: overrides.transcriptItems || []
  };
}

function sessionRecord(overrides = {}) {
  return {
    id: overrides.id || 'session-1',
    status: overrides.status || 'completed',
    startedAt: overrides.startedAt ?? 1000,
    endedAt: overrides.endedAt ?? 5000,
    durationMs: overrides.durationMs ?? 4000,
    targetLanguageCode: overrides.targetLanguageCode || 'fr',
    targetLanguageLabel: overrides.targetLanguageLabel || 'French',
    failureReason: overrides.failureReason ?? null,
    failureCategory: overrides.failureCategory ?? null,
    selectedInputDeviceId: overrides.selectedInputDeviceId || 'device-1',
    inputDeviceLabelSnapshot: overrides.inputDeviceLabelSnapshot || 'Studio Mic',
    transcriptSummary: overrides.transcriptSummary || transcriptSummary,
    createdAt: overrides.createdAt ?? 900,
    updatedAt: overrides.updatedAt ?? 5100,
    lastLifecycleState: overrides.lastLifecycleState || 'completed'
  };
}

function transcriptItem(overrides = {}) {
  return {
    id: overrides.id || 'item-1',
    sessionId: overrides.sessionId || 'session-1',
    stream: overrides.stream || 'source',
    status: overrides.status || 'final',
    text: overrides.text || 'Text.',
    sequence: overrides.sequence ?? 1,
    startedAt: overrides.startedAt ?? 1100,
    finalizedAt: overrides.finalizedAt ?? 1200,
    ...(overrides.languageCode ? { languageCode: overrides.languageCode } : {})
  };
}
