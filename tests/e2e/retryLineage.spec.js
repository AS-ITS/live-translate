import { expect, test } from '@playwright/test';

test('history detail groups executions into a retry lineage and retries failed execution', async ({ page }) => {
  let retryCalls = 0;
  const record = {
    id: 'session-1',
    targetLanguageCode: 'en',
    targetLanguageLabel: '英文',
    status: 'stopped',
    startedAt: '2026-08-10T00:00:00.000Z',
    endedAt: '2026-08-10T00:01:00.000Z',
    durationMs: 60000,
    transcriptSummary: { totalItems: 2, sourceFinalCount: 1, translationFinalCount: 1 }
  };
  const detail = {
    session: record,
    sourceTranscript: { items: [] },
    selectedTranslationOutput: { items: [] },
    translationHistory: {
      outputs: [],
      executions: [
        { id: 'execution-original', requestId: 'request-1', targetLanguageCode: 'en', status: 'failed', createdAt: '2026-08-10T00:00:01.000Z', failureInfo: { reason: 'provider_execution_failed' } },
        { id: 'execution-retry', requestId: 'request-1', targetLanguageCode: 'en', status: 'queued', createdAt: '2026-08-10T00:00:02.000Z' },
        { id: 'execution-other', requestId: 'request-2', targetLanguageCode: 'ja', status: 'completed', createdAt: '2026-08-10T00:00:03.000Z' }
      ]
    },
    readingContent: {
      sourceTranscript: { kind: 'sourceTranscript', status: 'empty', text: '', paragraphs: [] },
      translationArticle: { kind: 'translationArticle', status: 'empty', text: '', paragraphs: [] }
    }
  };

  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [record] });
    else await route.continue();
  });
  await page.route('**/api/meetings', async (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/session-1/translations', async (route) => route.fulfill({ json: { translations: [], translationHistory: detail.translationHistory } }));
  await page.route('**/api/sessions/session-1', async (route) => route.fulfill({ json: detail }));
  await page.route('**/api/translation-executions/**', async (route) => {
    retryCalls += 1;
    await route.fulfill({ status: 202, json: { id: 'execution-new', requestId: 'request-1', status: 'queued' } });
  });

  await page.goto('/#history');
  await page.getByRole('button', { name: '查看詳細資料' }).click();

  await expect(page.getByRole('region', { name: '重新翻譯進度' })).toContainText('Request request-1');
  await expect(page.getByRole('region', { name: '重新翻譯進度' })).toContainText('2 次 execution');
  await expect(page.getByRole('region', { name: '重新翻譯進度' })).toContainText('execution-original');
  await expect(page.getByRole('region', { name: '重新翻譯進度' })).toContainText('execution-retry');
  await expect(page.getByRole('region', { name: '重新翻譯進度' })).toContainText('Request request-2');

  await page.getByRole('region', { name: '重新翻譯進度' }).getByRole('button', { name: '重試' }).click();
  await expect.poll(() => retryCalls).toBe(1);
});
