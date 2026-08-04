import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createFileMeetingSummaryRepository } from '../../src/infrastructure/fileMeetingSummaryRepository.js';

test('file-backed repository reloads summaries by Session ID', async () => {
  const directory = await fileSystem.mkdtemp(join(tmpdir(), 'live-translate-summary-'));
  const filePath = join(directory, 'summaries.json');
  const input = { summaryId: 'summary-1', sessionId: 'session-1', status: 'completed', model: 'gemini-3.5-flash-lite', summary: { title: 'Meeting' }, topics: ['Topic'], decisions: [], actionItems: [], timeline: [], keywords: [], risks: [], openQuestions: [], followUpSuggestions: [], createdAt: 1, completedAt: 2 };
  try {
    const first = createFileMeetingSummaryRepository({ filePath, fileSystem });
    await first.createSummary(input);
    const second = createFileMeetingSummaryRepository({ filePath, fileSystem });
    const loaded = await second.getSummaryBySessionId('session-1');
    assert.deepEqual({ ...loaded }, input);
  } finally {
    await fileSystem.rm(directory, { recursive: true, force: true });
  }
});
