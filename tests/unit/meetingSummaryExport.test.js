import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMeetingSummaryFileName,
  createMeetingSummaryExport,
  formatMeetingSummaryText,
  normalizeMeetingSummary
} from '../../src/lib/meetingSummaryExport.js';

const summary = {
  sessionId: 'session-42',
  status: 'completed',
  summaryId: 'summary-1',
  summary: { title: 'Planning', overview: 'Executive overview', keyPoints: ['Topic A'], decisions: ['Decision A'], actionItems: ['Action A'] },
  topics: [], decisions: [], actionItems: []
};

test('normalizes the displayed structured summary with fallback fields', () => {
  assert.deepEqual(normalizeMeetingSummary(summary), {
    title: 'Planning', overview: 'Executive overview', topics: ['Topic A'], decisions: ['Decision A'], actionItems: ['Action A']
  });
  assert.match(formatMeetingSummaryText(summary, 'md'), /## Executive Summary/);
  assert.match(formatMeetingSummaryText(summary, 'txt'), /Action Items\n- Action A/);
});

test('builds deterministic Session ID and export timestamp filenames', () => {
  assert.equal(buildMeetingSummaryFileName('session/42', { format: 'docx', timestamp: '2026-08-04T12:34:56.000Z' }), 'live-translate-summary-session-42-20260804-123456.docx');
});

test('creates PDF and DOCX blobs with the correct document signatures and types', async () => {
  const pdf = createMeetingSummaryExport(summary, 'pdf');
  const docx = createMeetingSummaryExport(summary, 'docx');
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(docx.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(new TextDecoder().decode(new Uint8Array(await pdf.blob.arrayBuffer())).slice(0, 8), '%PDF-1.4');
  assert.deepEqual(Array.from(new Uint8Array(await docx.blob.arrayBuffer())).slice(0, 4), [0x50, 0x4b, 0x03, 0x04]);
});

test('rejects unsupported formats', () => {
  assert.throws(() => createMeetingSummaryExport(summary, 'html'), /Unsupported meeting summary format/);
});
