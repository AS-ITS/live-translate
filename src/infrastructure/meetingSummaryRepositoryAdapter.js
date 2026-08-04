import { MeetingSummary } from '../domain/meetingSummary/index.js';
import { MEETING_SUMMARY_REPOSITORY_METHODS } from '../domain/meetingSummary/meetingSummaryRepository.js';

export function createMemoryMeetingSummaryRepository() {
  const records = new Map();
  const repository = {
    createSummary(input) {
      const summary = new MeetingSummary(input);
      if (records.has(summary.summaryId)) throw new Error(`Meeting summary already exists: ${summary.summaryId}`);
      assertNoActiveSummary(records, summary);
      records.set(summary.summaryId, plain(summary));
      return new MeetingSummary(summary);
    },
    getSummary(summaryId) { const value = records.get(summaryId); return value ? new MeetingSummary(value) : null; },
    getSummaryBySessionId(sessionId) { return latestForSession(records, sessionId); },
    listSummariesBySessionId(sessionId) { return Array.from(records.values()).filter((item) => item.sessionId === sessionId).sort(compareSummaries).map((item) => new MeetingSummary(item)); },
    updateSummary(input) {
      const summary = new MeetingSummary(input);
      const existing = records.get(summary.summaryId);
      if (!existing) return null;
      if (existing.status !== 'pending') throw new Error(`${existing.status} meeting summary is immutable: ${summary.summaryId}`);
      if (existing.sessionId !== summary.sessionId || existing.model !== summary.model || existing.createdAt !== summary.createdAt) throw new Error(`meeting summary identity is immutable: ${summary.summaryId}`);
      records.set(summary.summaryId, plain(summary));
      return new MeetingSummary(summary);
    }
  };
  return Object.freeze(Object.fromEntries(MEETING_SUMMARY_REPOSITORY_METHODS.map((method) => [method, repository[method]])));
}

function assertNoActiveSummary(records, summary) {
  if (summary.status === 'failed') return;
  if (Array.from(records.values()).some((item) => item.sessionId === summary.sessionId && item.status !== 'failed')) {
    throw new Error(`an active meeting summary already exists for session: ${summary.sessionId}`);
  }
}
function latestForSession(records, sessionId) {
  const items = Array.from(records.values()).filter((item) => item.sessionId === sessionId).sort(compareSummaries);
  const active = items.find((item) => item.status !== 'failed');
  return active ? new MeetingSummary(active) : items.length ? new MeetingSummary(items[0]) : null;
}
function compareSummaries(left, right) { return String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.summaryId).localeCompare(String(left.summaryId)); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
