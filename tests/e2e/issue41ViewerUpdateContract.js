const hostUpdate = (event) => event.stage === 'WEBRTC_CUE_PUBLISH'
  && event.eventType === 'cue.update'
  && event.transportResult === 'sent'
  && Number.isSafeInteger(event.sequence);

export function classifyViewerUpdate(hostEvents = [], viewerEvents = []) {
  const publishedSequences = [...new Set(hostEvents.filter(hostUpdate).map((event) => event.sequence))];
  const receivedSequences = new Set(viewerEvents
    .filter((event) => event.stage === 'VIEWER_STORE_UPDATED'
      && event.messageType === 'cue.update' && event.transportResult === 'updated')
    .map((event) => event.sequence));
  const missingSequences = publishedSequences.filter((sequence) => !receivedSequences.has(sequence));
  return {
    hostUpdatePublished: publishedSequences.length > 0,
    viewerUpdateReceived: publishedSequences.length > 0 && missingSequences.length === 0,
    verdict: publishedSequences.length === 0 ? 'NOT_OBSERVED'
      : missingSequences.length === 0 ? 'PASS' : 'FAIL',
    publishedSequences,
    missingSequences
  };
}

export async function observeViewerUpdate({ hostEvents, readViewerEvents,
  timeoutMs = 5_000, intervalMs = 100, now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs;
  let viewerEvents;
  let result;
  do {
    viewerEvents = await readViewerEvents();
    result = classifyViewerUpdate(hostEvents, viewerEvents);
    if (result.verdict !== 'FAIL' || now() >= deadline) break;
    await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
  } while (true);
  return { ...result, viewerEvents };
}

export function viewerUpdateTimeline(hostEvents = [], viewerEvents = []) {
  const safeTime = (value) => typeof value === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ? value : null;
  return {
    hostPublish: hostEvents.filter((event) => event.stage === 'WEBRTC_CUE_PUBLISH'
      && ['cue.append', 'cue.update'].includes(event.eventType)).map((event, order) => ({
      order, timestamp: safeTime(event.timestamp), eventType: event.eventType,
      sequence: event.sequence, revision: event.revision, transportResult: event.transportResult
    })),
    viewerReceive: viewerEvents.filter((event) => event.stage === 'VIEWER_STORE_UPDATED'
      && ['snapshot', 'cue.append', 'cue.update'].includes(event.messageType)).map((event, order) => ({
      order, timestamp: safeTime(event.timestamp), messageType: event.messageType,
      sequence: event.sequence, transportResult: event.transportResult
    }))
  };
}
