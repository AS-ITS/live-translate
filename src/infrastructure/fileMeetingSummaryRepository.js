import { dirname } from 'node:path';
import { MeetingSummary } from '../domain/meetingSummary/index.js';
import { MEETING_SUMMARY_REPOSITORY_METHODS } from '../domain/meetingSummary/meetingSummaryRepository.js';

const INITIAL_STORAGE = Object.freeze({ schemaVersion: 1, summaries: Object.freeze([]) });

export function createFileMeetingSummaryRepository({ filePath, fileSystem } = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('filePath must be a non-empty string.');
  for (const method of ['readFile', 'mkdir', 'writeFile', 'rename']) if (!fileSystem || typeof fileSystem[method] !== 'function') throw new TypeError(`fileSystem.${method} must be a function.`);
  let mutationQueue = Promise.resolve();
  const repository = {
    createSummary(input) { return mutate(async (storage) => { const summary = new MeetingSummary(input); if (storage.summaries.some((item) => item.summaryId === summary.summaryId)) throw new Error(`Meeting summary already exists: ${summary.summaryId}`); assertNoActiveSummary(storage.summaries, summary); storage.summaries.push(plain(summary)); return new MeetingSummary(summary); }); },
    async getSummary(summaryId) { const storage = await readStorage(); const item = storage.summaries.find((entry) => entry.summaryId === summaryId); return item ? new MeetingSummary(item) : null; },
    async getSummaryBySessionId(sessionId) { const items = await repository.listSummariesBySessionId(sessionId); const finals = items.filter((item) => (item.kind ?? 'final') === 'final'); return finals.find((item) => item.status !== 'failed') || finals[0] || null; },
    async getSummaryByRange(sessionId, rangeKey) { const items = await repository.listPartialSummariesBySessionId(sessionId); return items.filter((item) => item.range.rangeKey === rangeKey).sort((left, right) => (left.status === 'failed') - (right.status === 'failed') || compareSummaries(left, right))[0] || null; },
    async listPartialSummariesBySessionId(sessionId) { const storage = await readStorage(); return storage.summaries.filter((item) => item.sessionId === sessionId && item.kind === 'partial').sort(compareRanges).map((item) => new MeetingSummary(item)); },
    async listSummariesBySessionId(sessionId) { const storage = await readStorage(); return storage.summaries.filter((item) => item.sessionId === sessionId).sort(compareSummaries).map((item) => new MeetingSummary(item)); },
    updateSummary(input) { return mutate(async (storage) => { const summary = new MeetingSummary(input); const index = storage.summaries.findIndex((item) => item.summaryId === summary.summaryId); if (index === -1) return null; const existing = storage.summaries[index]; if (existing.status !== 'pending') throw new Error(`${existing.status} meeting summary is immutable: ${summary.summaryId}`); if (existing.sessionId !== summary.sessionId || existing.model !== summary.model || existing.createdAt !== summary.createdAt) throw new Error(`meeting summary identity is immutable: ${summary.summaryId}`); storage.summaries[index] = plain(summary); return new MeetingSummary(summary); }); }
  };
  return Object.freeze(Object.fromEntries(MEETING_SUMMARY_REPOSITORY_METHODS.map((method) => [method, repository[method]])));

  function mutate(operation) {
    const next = mutationQueue.then(async () => { const storage = await readStorage(); const result = await operation(storage); await writeStorage(storage); return result; });
    mutationQueue = next.catch(() => {});
    return next;
  }
  async function readStorage() {
    let content;
    try { content = await fileSystem.readFile(filePath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return { schemaVersion: 1, summaries: [] }; throw error; }
    let parsed; try { parsed = JSON.parse(content); } catch { throw new TypeError('Meeting summary repository JSON is invalid.'); }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.summaries)) throw new TypeError('Meeting summary repository storage shape is invalid.');
    parsed.summaries.forEach((item) => new MeetingSummary(item));
    return { schemaVersion: 1, summaries: parsed.summaries.map(plain) };
  }
  async function writeStorage(storage) { await fileSystem.mkdir(dirname(filePath), { recursive: true }); const temporaryPath = `${filePath}.tmp`; await fileSystem.writeFile(temporaryPath, `${JSON.stringify(storage, null, 2)}\n`, 'utf8'); await fileSystem.rename(temporaryPath, filePath); }
}

function assertNoActiveSummary(summaries, summary) {
  if (summary.status === 'failed') return;
  if (summary.kind === 'partial' && summaries.some((item) => item.sessionId === summary.sessionId && item.kind === 'partial' && item.range?.rangeKey === summary.range?.rangeKey && item.status !== 'failed')) throw new Error(`an active partial meeting summary already exists for range: ${summary.range.rangeKey}`);
  if ((summary.kind ?? 'final') === 'final' && summaries.some((item) => item.sessionId === summary.sessionId && (item.kind ?? 'final') === 'final' && item.status !== 'failed')) throw new Error(`an active meeting summary already exists for session: ${summary.sessionId}`);
}
function compareSummaries(left, right) { return String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.summaryId).localeCompare(String(left.summaryId)); }
function compareRanges(left, right) { return left.range.segmentSequence - right.range.segmentSequence || left.range.startCueId.localeCompare(right.range.startCueId) || left.range.endCueId.localeCompare(right.range.endCueId); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
