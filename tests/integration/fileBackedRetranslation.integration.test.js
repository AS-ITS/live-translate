import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createSessionSnapshotSyncService } from '../../src/application/sessionSnapshotSyncService.js';
import { createFakeTranslationExecutionProviderResolver } from '../../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import { createFileSessionRepository } from '../../src/infrastructure/fileSessionRepository.js';

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
