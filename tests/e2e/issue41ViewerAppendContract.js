const hostAppend = (event) => event.stage === 'WEBRTC_CUE_PUBLISH'
 && event.eventType === 'cue.append' && Number.isSafeInteger(event.sequence);

export function classifyViewerAppend(hostEvents = [], viewerEvents = []) {
 const published = hostEvents.filter(hostAppend);
 const publishedSequences = [...new Set(published.map((event) => event.sequence))];
 const receivedSequences = new Set(viewerEvents.filter((event) =>
 event.stage === 'VIEWER_STORE_UPDATED' && event.messageType === 'cue.append'
 && event.transportResult === 'updated').map((event) => event.sequence));
 const missingSequences = publishedSequences.filter((sequence) => !receivedSequences.has(sequence));
 const firstMissing = published.find((event) => missingSequences.includes(event.sequence));
 return {
 hostAppendPublished: publishedSequences.length > 0,
 viewerAppendReceived: publishedSequences.length > 0 && missingSequences.length === 0,
 verdict: publishedSequences.length === 0 ? 'NOT_OBSERVED' : missingSequences.length ? 'FAIL' : 'PASS',
 publishedSequences,
 missingSequences,
 firstFailureStage: !published.length ? 'HOST_APPEND_NOT_PUBLISHED'
  : !firstMissing ? null
  : firstMissing.transportResult !== 'sent' ? 'HOST_TRANSPORT'
  : 'VIEWER_RECEIVE_OR_STORE'
 };
}

export async function observeViewerAppend({ hostEvents, readViewerEvents,
 timeoutMs = 5_000, intervalMs = 100, now = Date.now,
 wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
 const deadline = now() + timeoutMs;
 let viewerEvents;
 let result;
 do {
 viewerEvents = await readViewerEvents();
 result = classifyViewerAppend(hostEvents, viewerEvents);
 if (result.verdict !== 'FAIL' || now() >= deadline) break;
 await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
 } while (true);
 return { ...result, viewerEvents };
}

export function viewerAppendTimeline(hostEvents = [], viewerEvents = []) {
 const safeTime = (value) => typeof value === 'string'
 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ? value : null;
 return {
 hostPublish: hostEvents.filter(hostAppend).map((event, order) => ({
 order, timestamp: safeTime(event.timestamp), eventType: event.eventType,
 sequence: event.sequence, transportResult: event.transportResult
 })),
 viewerReceive: viewerEvents.filter((event) => event.stage === 'VIEWER_STORE_UPDATED'
 && ['snapshot', 'cue.append', 'cue.update'].includes(event.messageType))
 .map((event, order) => ({
 order, timestamp: safeTime(event.timestamp), messageType: event.messageType,
 sequence: event.sequence, transportResult: event.transportResult
 }))
 };
}
