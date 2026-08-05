const EMPTY_CONTENT = '尚無內容。';

export const MEETING_SUMMARY_EXPORT_FORMATS = Object.freeze(['pdf', 'md', 'docx', 'txt']);

export function normalizeMeetingSummary(summary = {}) {
  const content = summary?.summary || {};
  return {
    title: clean(content.title),
    overview: clean(content.overview) || EMPTY_CONTENT,
    topics: list(summary.topics, content.keyPoints),
    decisions: list(summary.decisions, content.decisions),
    actionItems: list(summary.actionItems, content.actionItems),
    ...(hasExtendedFields(summary, content) ? {
      timeline: timelineList(summary.timeline, content.timeline),
      keywords: list(summary.keywords, content.keywords),
      risks: list(summary.risks, content.risks),
      openQuestions: list(summary.openQuestions, content.openQuestions),
      followUpSuggestions: list(summary.followUpSuggestions, content.followUpSuggestions)
    } : {})
  };
}

export function formatMeetingSummaryText(summary, format = 'txt') {
  const normalized = normalizeMeetingSummary(summary);
  if (format === 'md') return markdown(normalized);
  if (format === 'txt') return plainText(normalized);
  throw new TypeError(`Unsupported meeting summary text format: ${format}`);
}

export function buildMeetingSummaryFileName(sessionId, { format = 'txt', timestamp = new Date() } = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new TypeError('sessionId must be a non-empty string.');
  if (!MEETING_SUMMARY_EXPORT_FORMATS.includes(format)) throw new TypeError(`Unsupported meeting summary format: ${format}`);
  const date = new Date(timestamp);
  const stamp = Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  const safeStamp = stamp.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'session';
  return `live-translate-summary-${safeSessionId}-${safeStamp}.${format}`;
}

export function createMeetingSummaryExport(summary, format = 'txt') {
  if (!MEETING_SUMMARY_EXPORT_FORMATS.includes(format)) throw new TypeError(`Unsupported meeting summary format: ${format}`);
  if (format === 'pdf') return { blob: createPdfBlob(normalizeMeetingSummary(summary)), type: 'application/pdf' };
  if (format === 'docx') return { blob: createDocxBlob(normalizeMeetingSummary(summary)), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const type = format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
  return { blob: new Blob([formatMeetingSummaryText(summary, format)], { type }), type };
}

function markdown(summary) {
  return `${summary.title ? `# ${summary.title}\n\n` : ''}## Executive Summary\n\n${summary.overview}\n\n${markdownList('Key Topics', summary.topics)}\n\n${markdownList('Decisions', summary.decisions)}\n\n${markdownList('Action Items', summary.actionItems)}${summary.timeline || summary.keywords || summary.risks || summary.openQuestions || summary.followUpSuggestions ? `\n\n${markdownTimeline(summary.timeline || [])}\n\n${markdownList('Keywords', summary.keywords || [])}\n\n${markdownList('Risks', summary.risks || [])}\n\n${markdownList('Open Questions', summary.openQuestions || [])}\n\n${markdownList('Follow-up Suggestions', summary.followUpSuggestions || [])}` : ''}\n`;
}

function plainText(summary) {
  return [
    ...(summary.title ? [summary.title, ''] : []),
    '',
    'Executive Summary',
    summary.overview,
    '',
    plainList('Key Topics', summary.topics),
    '',
    plainList('Decisions', summary.decisions),
    '',
    plainList('Action Items', summary.actionItems),
    ...(summary.timeline || summary.keywords || summary.risks || summary.openQuestions || summary.followUpSuggestions ? ['', plainTimeline(summary.timeline || []), '', plainList('Keywords', summary.keywords || []), '', plainList('Risks', summary.risks || []), '', plainList('Open Questions', summary.openQuestions || []), '', plainList('Follow-up Suggestions', summary.followUpSuggestions || [])] : []),
    ''
  ].join('\n');
}

function markdownList(title, items) { return `## ${title}\n\n${items.length ? items.map((item) => `- ${item}`).join('\n') : EMPTY_CONTENT}`; }
function plainList(title, items) { return [title, items.length ? items.map((item) => `- ${item}`).join('\n') : EMPTY_CONTENT].join('\n'); }
function list(primary, fallback) { const values = Array.isArray(primary) && primary.length ? primary : fallback; return Array.isArray(values) ? values.map(clean).filter(Boolean) : []; }
function hasExtendedFields(summary, content) { return ['timeline', 'keywords', 'risks', 'openQuestions', 'followUpSuggestions'].some((field) => Array.isArray(summary?.[field]) || Array.isArray(content?.[field])); }
function timelineList(primary, fallback) { const values = Array.isArray(primary) && primary.length ? primary : fallback; return Array.isArray(values) ? values.filter((item) => item && typeof item === 'object').sort(compareTimeline) : []; }
function timelineLabel(item) { return [item.title, item.description].map(clean).filter(Boolean).join(': ') || clean(item.text) || '尚無內容。'; }
function markdownTimeline(items) { return `## Timeline\n\n${items.length ? items.map((item) => `- ${timelineTimeLabel(item)} — ${timelineLabel(item)}`).join('\n') : EMPTY_CONTENT}`; }
function plainTimeline(items) { return ['Timeline', items.length ? items.map((item) => `- ${timelineTimeLabel(item)} - ${timelineLabel(item)}`).join('\n') : EMPTY_CONTENT].join('\n'); }
function timelineTimeLabel(item) { return clean(item.startTimeMs ?? item.timestampMs ?? item.time); }
function compareTimeline(left, right) { return timelineTime(left) - timelineTime(right); }
function timelineTime(value) { return Number.isFinite(value.startTimeMs) ? value.startTimeMs : Number.isFinite(value.timestampMs) ? value.timestampMs : Number.POSITIVE_INFINITY; }
function clean(value) { return typeof value === 'string' ? value.trim() : ''; }

function summaryParagraphs(summary) {
  const timeline = summary.timeline || [];
  const keywords = summary.keywords || [];
  const risks = summary.risks || [];
  const openQuestions = summary.openQuestions || [];
  const followUpSuggestions = summary.followUpSuggestions || [];
  return [
    ...(summary.title ? [[summary.title, 'title']] : []),
    ['Executive Summary', 'heading'], [summary.overview, 'body'],
    ['Key Topics', 'heading'], ...summary.topics.map((item) => [item, 'bullet']),
    ['Decisions', 'heading'], ...summary.decisions.map((item) => [item, 'bullet']),
    ['Action Items', 'heading'], ...summary.actionItems.map((item) => [item, 'bullet']),
    ...(timeline.length || keywords.length || risks.length || openQuestions.length || followUpSuggestions.length ? [['Timeline', 'heading'], ...timeline.map((item) => [timelineLabel(item), 'bullet']), ['Keywords', 'heading'], ...keywords.map((item) => [item, 'bullet']), ['Risks', 'heading'], ...risks.map((item) => [item, 'bullet']), ['Open Questions', 'heading'], ...openQuestions.map((item) => [item, 'bullet']), ['Follow-up Suggestions', 'heading'], ...followUpSuggestions.map((item) => [item, 'bullet'])] : [])
  ];
}

function createPdfBlob(summary) {
  const lines = summaryParagraphs(summary).flatMap(([text, kind]) => kind === 'body' ? wrapPdfText(text) : [[text, kind]]);
  const pageHeight = 792;
  const content = ['BT', '/F1 12 Tf', '54 738 Td'];
  lines.forEach(([text, kind], index) => {
    const size = kind === 'title' ? 18 : kind === 'heading' ? 14 : 11;
    const prefix = index === 0 ? '' : '0 -18 Td';
    content.push(`${prefix} /F1 ${size} Tf (${escapePdf(text)}) Tj`);
  });
  content.push('ET');
  const stream = content.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = pdf.length; pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}

function wrapPdfText(text) { return String(text).split(/\r?\n/).flatMap((line) => { const words = line.split(/\s+/); const result = []; let current = ''; for (const word of words) { if ((current + ' ' + word).trim().length > 88) { if (current) result.push([current, 'body']); current = word; } else current = `${current} ${word}`.trim(); } if (current || result.length === 0) result.push([current, 'body']); return result; }); }
function escapePdf(text) { return String(text).replace(/[\\()]/g, (value) => `\\${value}`).replace(/[^\x20-\x7E]/g, '?'); }

function createDocxBlob(summary) {
  const paragraphs = summaryParagraphs(summary).map(([text, kind]) => {
    const properties = kind === 'title' ? '<w:pStyle w:val="Title"/>' : kind === 'heading' ? '<w:pStyle w:val="Heading1"/>' : kind === 'bullet' ? '<w:pStyle w:val="ListBullet"/>' : '';
    return `<w:p><w:pPr>${properties}</w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  }).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': document
  };
  return new Blob([zipFiles(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function escapeXml(value) { return String(value).replace(/[<>&'"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character])); }

function zipFiles(files) {
  const encoder = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const nameBytes = encoder.encode(name); const data = encoder.encode(value); const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length); const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, 0, true); view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, nameBytes.length, true); local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length); chunks.push(local);
    const record = new Uint8Array(46 + nameBytes.length); const recordView = new DataView(record.buffer); recordView.setUint32(0, 0x02014b50, true); recordView.setUint16(4, 20, true); recordView.setUint16(6, 20, true); recordView.setUint32(16, crc, true); recordView.setUint32(20, data.length, true); recordView.setUint32(24, data.length, true); recordView.setUint16(28, nameBytes.length, true); recordView.setUint32(42, offset, true); record.set(nameBytes, 46); central.push(record); offset += local.length;
  }
  const centralSize = central.reduce((total, item) => total + item.length, 0); const end = new Uint8Array(22); const endView = new DataView(end.buffer); endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, central.length, true); endView.setUint16(10, central.length, true); endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true); return new Uint8Array([...chunks, ...central, end].reduce((all, item) => [...all, ...item], []));
}

function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
