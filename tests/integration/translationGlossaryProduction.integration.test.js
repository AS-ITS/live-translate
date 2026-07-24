import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('production saved-transcript translation applies target glossary instructions without changing source text', async () => {
  const sourceText = 'Codex powers Live Translate';
  const requests = [];
  const sessionRepository = createMemorySessionRepository({ now: () => '2026-07-21T00:00:00.000Z' });
  sessionRepository.createSessionRecord({ id: 'session-1', startedAt: 0, targetLanguageCode: 'ja' });
  sessionRepository.appendTranscriptItem('session-1', {
    id: 'source-1', stream: 'source', status: 'final', text: sourceText, sequence: 1, startedAt: 0, finalizedAt: 0
  });
  const dependencies = createProductionApplicationDependencies({
    env: {
      GEMINI_API_KEY: 'test-api-key',
      SAVED_RETRANSLATION_GEMINI_MODEL: 'gemini-test',
      TRANSLATION_GLOSSARY_FILE: 'translation-glossary.json'
    },
    sessionRepository,
    translationGlossaryFileSystem: {
      async readFile() {
        return JSON.stringify({
          entries: [
            { source: 'Codex', translations: { ja: 'コーデックス', 'zh-Hant': 'Codex' } },
            { source: 'Live Translate', translations: { 'zh-Hant': '即時翻譯系統' } }
          ]
        });
      }
    },
    googleGenAIClientFactory() {
      return {
        models: {
          async generateContent(request) {
            requests.push(request);
            return { translatedText: 'コーデックスは Live Translate を動かします', detectedSourceLanguageCode: 'en' };
          }
        }
      };
    },
    idGenerator: (() => { let id = 0; return () => `id-${++id}`; })(),
    clock: () => '2026-07-21T00:00:00.000Z'
  });

  await dependencies.savedTranscriptRetranslationService.translateSavedTranscript({
    sessionId: 'session-1', sourceLanguageCode: 'en', targetLanguageCode: 'ja'
  });

  assert.equal(requests.length, 1);
  const parts = requests[0].contents[0].parts.map((part) => part.text);
  assert.equal(parts.at(-1), sourceText);
  assert.equal(parts.some((part) => part.includes('Required translation: コーデックス')), true);
  assert.equal(parts.some((part) => part.includes('即時翻譯系統')), false);
  assert.equal(sessionRepository.getSessionRecord('session-1').transcriptItems[0].text, sourceText);
});
