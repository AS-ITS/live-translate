import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createSessionSnapshotSyncService } from '../../src/application/sessionSnapshotSyncService.js';
import { createFakeTranslationExecutionProviderResolver } from '../../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import { createFileSessionRepository } from '../../src/infrastructure/fileSessionRepository.js';

test('application server composition reads existing file-backed sessions into history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-file-history-'));
  const filePath = join(directory, 'data', 'session-records.json');
  await mkdir(join(directory, 'data'), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    schemaVersion: 1,
    records: [{
      id: 'session-persisted',
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
      targetLanguageCode: 'ja',
      targetLanguageLabel: 'Japanese',
      status: 'stopped',
      failureReason: null,
      failureCategory: null,
      transcriptSummary: {
        totalItems: 1,
        sourceFinalCount: 1,
        translationFinalCount: 0,
        sourcePartialCount: 0,
        translationPartialCount: 0,
        hasTranscript: true
      }
    }],
    transcriptItems: {
      'session-persisted': [{
        id: 'source-1',
        sessionId: 'session-persisted',
        stream: 'source',
        status: 'final',
        text: 'Hello persisted history',
        sequence: 1,
        startedAt: 1000,
        finalizedAt: 2000
      }]
    }
  }), 'utf8');

  const dependencies = createApplicationDependencies({
    env: { SESSION_RECORDS_FILE: filePath },
    requestHandlerFactory() {
      return function requestHandler() {};
    }
  });

  const history = await dependencies.sessionReadController.listSessions();
  assert.deepEqual(history.map((record) => record.id), ['session-persisted']);
  assert.equal(history[0].status, 'stopped');
  assert.equal(history[0].transcriptSummary.hasTranscript, true);
});

test('file-backed session snapshot survives dependency restart and supports canonical retranslation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-file-retranslation-'));
  const filePath = join(directory, 'sessions.json');
  const fs = await import('node:fs/promises');

  const writerRepository = createFileSessionRepository({ filePath, fileSystem: fs, now: () => 1000 });
  await createSessionSnapshotSyncService({ sessionRepository: writerRepository }).sync({
    session: {
      id: 'session-1',
      startedAt: 900,
      endedAt: 1200,
      status: 'stopped',
      targetLanguageCode: 'en',
      failureReason: 'user_stop',
      failureCategory: null,
      transcriptSummary: {
        totalItems: 1,
        sourceFinalCount: 1,
        translationFinalCount: 0,
        sourcePartialCount: 0,
        translationPartialCount: 0,
        hasTranscript: true
      }
    },
    transcriptItems: [
      {
        id: 'source-1',
        stream: 'source',
        status: 'final',
        text: 'Hello persisted transcript',
        sequence: 0,
        startedAt: 900,
        finalizedAt: 1000,
        languageCode: 'en'
      }
    ]
  });

  const reloadedRepository = createFileSessionRepository({ filePath, fileSystem: fs, now: () => 2000 });
  const dependencies = createApplicationDependencies({
    sessionRepository: reloadedRepository,
    translationExecutionProviderResolver: createFakeTranslationExecutionProviderResolver({
      translationExecutionProvider: { async execute() { throw new Error('provider must not execute during submission'); } }
    }),
    idGenerator: ((value = 0) => (prefix) => `${prefix}-${++value}`)(),
    clock: () => 2000
  });

  const result = await dependencies.sessionRetranslationCommandService.submitRetranslation({
    sessionId: 'session-1',
    targetLanguageCode: 'ja'
  });
  const request = await dependencies.translationRepository.getTranslationRequest(result.request.id);

  assert.equal(result.execution.status, 'queued');
  assert.equal(request.sourceTranscriptSnapshot.sourceText, 'Hello persisted transcript');
  assert.deepEqual(request.sourceTranscriptSnapshot.items.map((item) => item.id), ['source-1']);
});
