import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapSessionRecordDetailToDTO,
  mapSessionRecordToHistoryListItem
} from '../../src/readModels/sessionReadModels.js';

const transcriptSummary = Object.freeze({
  totalItems: 4,
  sourceFinalCount: 1,
  translationFinalCount: 1,
  sourcePartialCount: 1,
  translationPartialCount: 1,
  hasTranscript: true
});

const baseSessionRecord = Object.freeze({
  id: 'session-1',
  status: 'completed',
  startedAt: 1000,
  endedAt: 5000,
  durationMs: 4000,
  targetLanguageCode: 'fr',
  targetLanguageLabel: 'French',
  failureReason: null,
  failureCategory: null,
  selectedInputDeviceId: 'device-1',
  inputDeviceLabelSnapshot: 'Studio Mic',
  transcriptSummary
});

test('maps a complete SessionRecord to a history list item', () => {
  assert.deepEqual(mapSessionRecordToHistoryListItem(baseSessionRecord), {
    id: 'session-1',
    status: 'completed',
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    targetLanguageCode: 'fr',
    targetLanguageLabel: 'French',
    sourceLanguageCode: null,
    failureReason: null,
    failureCategory: null,
    transcriptSummary,
    recordKind: 'session',
    retranslatedFrom: null,
    legacy: true
  });
});

test('maps retranslation provenance to history and detail DTOs', () => {
  const sessionRecord = {
    ...baseSessionRecord,
    recordKind: 'retranslation',
    retranslatedFrom: {
      sessionId: 'session-source',
      startedAt: 900,
      requestId: 'request-1',
      executionId: 'execution-1',
      outputId: 'output-1'
    }
  };

  const historyItem = mapSessionRecordToHistoryListItem(sessionRecord);
  const dto = mapSessionRecordDetailToDTO({ sessionRecord, transcriptItems: [] });

  assert.equal(historyItem.recordKind, 'retranslation');
  assert.deepEqual(historyItem.retranslatedFrom, sessionRecord.retranslatedFrom);
  assert.equal(dto.session.recordKind, 'retranslation');
  assert.deepEqual(dto.session.retranslatedFrom, sessionRecord.retranslatedFrom);
});

test('maps missing nullable history metadata to null', () => {
  const item = mapSessionRecordToHistoryListItem({
    id: 'session-2',
    status: 'active',
    startedAt: 2000
  });

  assert.equal(item.endedAt, null);
  assert.equal(item.durationMs, null);
  assert.equal(item.targetLanguageCode, null);
  assert.equal(item.targetLanguageLabel, null);
  assert.equal(item.failureReason, null);
  assert.equal(item.failureCategory, null);
});

test('detail DTO exposes audio artifact download metadata without storage paths', () => {
  const dto = mapSessionRecordDetailToDTO(detail({
    sessionRecord: {
      ...baseSessionRecord,
      audioArtifacts: {
        translation: {
          kind: 'translation',
          mimeType: 'audio/wav',
          byteLength: 12,
          fileName: 'translation.wav',
          storagePath: 'session-1/translation.wav',
          createdAt: 1234
        }
      }
    }
  }));

  assert.deepEqual(dto.session.audioArtifacts.translation, {
    kind: 'translation',
    mimeType: 'audio/wav',
    byteLength: 12,
    fileName: 'translation.wav',
    createdAt: 1234,
    downloadUrl: '/api/sessions/session-1/audio/translation'
  });
});

test('defaults missing transcriptSummary to an empty summary', () => {
  assert.deepEqual(mapSessionRecordToHistoryListItem({ id: 'session-1' }).transcriptSummary, emptySummary());
  assert.deepEqual(mapSessionRecordDetailToDTO({ sessionRecord: { id: 'session-1' }, transcriptItems: [] }).session.transcriptSummary, emptySummary());
});

test('source transcript includes only final source items', () => {
  const dto = mapSessionRecordDetailToDTO(
    detail({
      transcriptItems: [
        item({ id: 'source-partial', stream: 'source', status: 'partial', text: 'draft', sequence: 1 }),
        item({ id: 'source-final', stream: 'source', status: 'final', text: 'Hello.', sequence: 2 }),
        item({ id: 'translation-final', stream: 'translation', status: 'final', text: 'Bonjour.', sequence: 3 })
      ]
    })
  );

  assert.deepEqual(dto.sourceTranscript.items.map((sourceItem) => sourceItem.id), ['source-final']);
});

test('translation output includes only final translation items', () => {
  const dto = mapSessionRecordDetailToDTO(
    detail({
      transcriptItems: [
        item({ id: 'translation-partial', stream: 'translation', status: 'partial', text: 'Bon', sequence: 1 }),
        item({ id: 'translation-final', stream: 'translation', status: 'final', text: 'Bonjour.', sequence: 2 }),
        item({ id: 'source-final', stream: 'source', status: 'final', text: 'Hello.', sequence: 3 })
      ]
    })
  );

  assert.deepEqual(dto.translationOutputs[0].items.map((translationItem) => translationItem.id), ['translation-final']);
});

test('detail DTO exposes formal reading content for translation article and raw source transcript', () => {
  const dto = mapSessionRecordDetailToDTO(
    detail({
      transcriptItems: [
        item({ id: 'source-1', stream: 'source', status: 'final', text: '原始內容。', sequence: 1, startedAt: 1000, finalizedAt: 1200 }),
        item({ id: 'translation-2', stream: 'translation', status: 'final', text: 'Translated paragraph.', sequence: 2, startedAt: 1300, finalizedAt: 1500 }),
        item({ id: 'translation-partial', stream: 'translation', status: 'partial', text: 'draft', sequence: 3 })
      ]
    })
  );

  assert.deepEqual(dto.readingContent.translationArticle, {
    kind: 'translationArticle',
    status: 'available',
    targetLanguageCode: 'fr',
    targetLanguageLabel: 'French',
    version: null,
    text: 'Translated paragraph.',
    paragraphs: ['Translated paragraph.'],
    createdAt: 1000,
    completedAt: 5000,
    emptyReason: null
  });
  assert.deepEqual(dto.readingContent.sourceTranscript, {
    kind: 'sourceTranscript',
    status: 'available',
    text: '原始內容。',
    paragraphs: ['原始內容。'],
    createdAt: 1000,
    finalizedAt: 5000,
    emptyReason: null
  });
});

test('detail DTO reading content has stable empty states for active and failed legacy sessions', () => {
  const active = mapSessionRecordDetailToDTO(detail({
    sessionRecord: { ...baseSessionRecord, status: 'active', endedAt: null },
    transcriptItems: []
  }));
  const failed = mapSessionRecordDetailToDTO(detail({
    sessionRecord: { ...baseSessionRecord, status: 'failed', failureReason: 'unexpected_close' },
    transcriptItems: []
  }));

  assert.equal(active.readingContent.translationArticle.status, 'processing');
  assert.equal(active.readingContent.translationArticle.emptyReason, 'processing');
  assert.equal(active.readingContent.sourceTranscript.status, 'processing');
  assert.equal(failed.readingContent.translationArticle.status, 'failed');
  assert.equal(failed.readingContent.translationArticle.emptyReason, 'finalize_failed');
});

test('legacy translation output uses stable deterministic IDs', () => {
  const dto = mapSessionRecordDetailToDTO(detail({ transcriptItems: [item({ stream: 'translation', status: 'final' })] }));
  const missingLanguageDto = mapSessionRecordDetailToDTO(
    detail({
      sessionRecord: { ...baseSessionRecord, targetLanguageCode: undefined, targetLanguageLabel: undefined },
      transcriptItems: [item({ stream: 'translation', status: 'final' })]
    })
  );

  assert.equal(dto.translationOutputs[0].id, 'legacy-output:session-1:fr');
  assert.equal(dto.translationOutputs[0].translationRequestId, 'legacy-request:session-1:fr');
  assert.equal(missingLanguageDto.translationOutputs[0].id, 'legacy-output:session-1:unknown-language');
  assert.equal(missingLanguageDto.translationOutputs[0].translationRequestId, 'legacy-request:session-1:unknown-language');
});

test('does not create a translation output when there are no final translation items', () => {
  const dto = mapSessionRecordDetailToDTO(detail({ transcriptItems: [item({ stream: 'source', status: 'final' })] }));

  assert.deepEqual(dto.translationOutputs, []);
  assert.equal(dto.selectedTranslationOutput, null);
});

test('maps failed and stopped terminal sessions with existing final items', () => {
  for (const status of ['failed', 'stopped']) {
    const dto = mapSessionRecordDetailToDTO(
      detail({
        sessionRecord: {
          ...baseSessionRecord,
          status,
          failureReason: status === 'failed' ? 'unexpected_close' : 'user_stop',
          failureCategory: status === 'failed' ? 'provider' : 'user_intent'
        },
        transcriptItems: [
          item({ id: `${status}-source`, stream: 'source', status: 'final', sequence: 1 }),
          item({ id: `${status}-translation`, stream: 'translation', status: 'final', sequence: 2 })
        ]
      })
    );

    assert.equal(dto.session.status, status);
    assert.equal(dto.sourceTranscript.status, 'finalized');
    assert.equal(dto.sourceTranscript.items.length, 1);
    assert.equal(dto.translationOutputs[0].items.length, 1);
  }
});

test('does not mutate input objects', () => {
  const input = detail({
    sessionRecord: {
      ...baseSessionRecord,
      transcriptSummary: { ...transcriptSummary }
    },
    transcriptItems: [
      item({ id: 'translation-2', stream: 'translation', status: 'final', sequence: 2 }),
      item({ id: 'translation-1', stream: 'translation', status: 'final', sequence: 1 })
    ]
  });
  const before = JSON.stringify(input);
  const dto = mapSessionRecordDetailToDTO(input);
  dto.session.transcriptSummary.totalItems = 99;
  dto.translationOutputs[0].items[0].text = 'mutated';

  assert.equal(JSON.stringify(input), before);
});

test('items are sorted by sequence', () => {
  const dto = mapSessionRecordDetailToDTO(
    detail({
      transcriptItems: [
        item({ id: 'translation-3', stream: 'translation', status: 'final', sequence: 3 }),
        item({ id: 'source-4', stream: 'source', status: 'final', sequence: 4 }),
        item({ id: 'source-1', stream: 'source', status: 'final', sequence: 1 }),
        item({ id: 'translation-2', stream: 'translation', status: 'final', sequence: 2 })
      ]
    })
  );

  assert.deepEqual(dto.sourceTranscript.items.map((sourceItem) => sourceItem.id), ['source-1', 'source-4']);
  assert.deepEqual(dto.translationOutputs[0].items.map((translationItem) => translationItem.id), ['translation-2', 'translation-3']);
});

test('partial items are excluded from read model transcript items', () => {
  const dto = mapSessionRecordDetailToDTO(
    detail({
      transcriptItems: [
        item({ id: 'source-partial', stream: 'source', status: 'partial', sequence: 1 }),
        item({ id: 'translation-partial', stream: 'translation', status: 'partial', sequence: 2 })
      ]
    })
  );

  assert.deepEqual(dto.sourceTranscript.items, []);
  assert.deepEqual(dto.translationOutputs, []);
});

test('unknown or missing optional legacy fields do not crash mapper', () => {
  const dto = mapSessionRecordDetailToDTO({
    sessionRecord: {
      id: 'session-minimal',
      status: 'active',
      unknownLegacyField: 'ignored'
    },
    transcriptItems: [
      {
        id: 'translation-minimal',
        stream: 'translation',
        status: 'final',
        text: 'Bonjour.',
        sequence: 1,
        extraLegacyItemField: 'preserved'
      }
    ]
  });

  assert.equal(dto.session.id, 'session-minimal');
  assert.equal(dto.session.startedAt, null);
  assert.equal(dto.session.selectedInputDeviceId, null);
  assert.equal(dto.sourceTranscript.status, 'active');
  assert.equal(dto.translationOutputs[0].targetLanguageCode, 'unknown-language');
  assert.equal(dto.translationOutputs[0].items[0].extraLegacyItemField, 'preserved');
});

test('detail DTO exposes expected legacy shapes', () => {
  const dto = mapSessionRecordDetailToDTO(
    detail({
      transcriptItems: [
        item({ id: 'source-1', stream: 'source', status: 'final', sequence: 1 }),
        item({ id: 'translation-2', stream: 'translation', status: 'final', sequence: 2 })
      ]
    })
  );

  assert.deepEqual(dto.session, {
    id: 'session-1',
    status: 'completed',
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    failureReason: null,
    failureCategory: null,
    sourceLanguageCode: null,
    selectedInputDeviceId: 'device-1',
    inputDeviceLabelSnapshot: 'Studio Mic',
    audioArtifacts: {},
    transcriptSummary,
    recordKind: 'session',
    retranslatedFrom: null
  });
  assert.equal(dto.sourceTranscript.id, 'source:session-1');
  assert.equal(dto.sourceTranscript.revisionId, 'source-revision:session-1:final');
  assert.equal(dto.translationOutputs[0].legacy, true);
  assert.equal(dto.translationOutputs[0].provider, null);
  assert.equal(dto.translationOutputs[0].model, null);
  assert.equal(dto.translationOutputs[0].providerMetadataAvailable, false);
  assert.equal(dto.selectedTranslationOutput, dto.translationOutputs[0]);
  assert.equal(dto.legacy, true);
});

function detail(overrides = {}) {
  return {
    sessionRecord: overrides.sessionRecord || { ...baseSessionRecord, transcriptSummary: { ...transcriptSummary } },
    transcriptItems: overrides.transcriptItems || []
  };
}

function item(overrides = {}) {
  return {
    id: overrides.id || 'item-1',
    sessionId: 'session-1',
    stream: overrides.stream || 'source',
    status: overrides.status || 'final',
    text: overrides.text || 'Text.',
    sequence: overrides.sequence ?? 1,
    startedAt: overrides.startedAt ?? 1100,
    finalizedAt: overrides.finalizedAt ?? 1200,
    ...(overrides.languageCode ? { languageCode: overrides.languageCode } : {})
  };
}

function emptySummary() {
  return {
    totalItems: 0,
    sourceFinalCount: 0,
    translationFinalCount: 0,
    sourcePartialCount: 0,
    translationPartialCount: 0,
    hasTranscript: false
  };
}
