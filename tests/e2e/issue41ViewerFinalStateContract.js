import { createHash } from 'node:crypto';

const fields = ['meetingId', 'segmentId', 'sourceText', 'translatedText', 'status',
 'sourceVersion', 'translationVersion'];
const hash = (value) => createHash('sha256').update(value).digest('hex');

// This function runs in the Viewer page. Read React's committed detail state,
// which is updated by the same merge that emits VIEWER_STORE_UPDATED.
export function readViewerCueStore() {
 const node = document.querySelector('[data-testid="meeting-viewer-cue-viewport"]');
 const key = node && Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
 let fiber = key ? node[key] : null;
 while (fiber && fiber.type?.name !== 'MeetingViewerPage') fiber = fiber.return;
 const detail = fiber?.memoizedState?.memoizedState;
 if (!detail || !Array.isArray(detail.cues)) return { available: false };
 return { available: true, hostCursor: detail.hostCursor || null, cues: detail.cues };
}

function canonical(cues) {
 const missingFields = new Set();
 const rows = (cues || []).map((cue) => {
  const row = { cueId: cue?.cueId ?? null };
  for (const field of fields) {
   if (!Object.hasOwn(cue || {}, field) || cue[field] == null) missingFields.add(field);
   row[field] = cue?.[field] ?? null;
  }
  return row;
 }).sort((left, right) => String(left.cueId).localeCompare(String(right.cueId), 'en'));
 if (rows.some((row) => !row.cueId)) missingFields.add('cueId');
 return { rows, serialized: JSON.stringify(rows), missingFields: [...missingFields].sort() };
}

export function compareViewerCueState(hostCues, viewerCues) {
 const host = canonical(hostCues);
 const viewer = canonical(viewerCues);
 const hostById = new Map(host.rows.map((cue) => [cue.cueId, cue]));
 const viewerById = new Map(viewer.rows.map((cue) => [cue.cueId, cue]));
 const missingCueCount = [...hostById.keys()].filter((id) => !viewerById.has(id)).length;
 const extraCueCount = [...viewerById.keys()].filter((id) => !hostById.has(id)).length;
 const differingFields = new Set();
 for (const [id, cue] of hostById) {
  const actual = viewerById.get(id);
  if (actual) for (const field of fields) {
   if (cue[field] !== actual[field]) differingFields.add(field);
  }
 }
 const unverifiableFields = [...new Set([...host.missingFields, ...viewer.missingFields])].sort();
 return {
  verdict: unverifiableFields.length ? 'UNVERIFIABLE'
   : host.serialized !== viewer.serialized ? 'FAIL' : 'PASS',
  hostCueCount: host.rows.length, viewerCueCount: viewer.rows.length,
  hostHash: hash(host.serialized), viewerHash: hash(viewer.serialized),
  missingCueCount, extraCueCount, differingFields: [...differingFields].sort(),
  unverifiableFields,
  hostVersions: host.rows.map((cue) => ({ cueIdHash: hash(String(cue.cueId)),
   sourceVersion: cue.sourceVersion, translationVersion: cue.translationVersion })),
  viewerVersions: viewer.rows.map((cue) => ({ cueIdHash: hash(String(cue.cueId)),
   sourceVersion: cue.sourceVersion, translationVersion: cue.translationVersion }))
 };
}

export async function observeViewerFinalState({ hostEvents, readHostEvents = async () => hostEvents,
 readHostCues, readViewerStore,
 readViewerEvents, timeoutMs = 5_000, intervalMs = 100, stableMs = 200, now = Date.now,
 wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
 const deadline = now() + timeoutMs;
 let result;
 let lastHost = null;
 let stableSince = now();
 do {
  const firstHost = await readHostCues();
  const firstHostEvents = await readHostEvents();
  let store;
  try {
   store = await readViewerStore();
  } catch {
   store = { available: false };
  }
  const viewerEvents = await readViewerEvents();
  const secondHost = await readHostCues();
  const secondHostEvents = await readHostEvents();
  const publishEvents = (events) => events.filter((event) => event.stage === 'WEBRTC_CUE_PUBLISH'
   && ['cue.append', 'cue.update'].includes(event.eventType)
   && Number.isSafeInteger(event.sequence));
  const firstPublish = publishEvents(firstHostEvents).at(-1);
  const secondPublish = publishEvents(secondHostEvents).at(-1);
  const hostPublishCursor = `${secondPublish?.sourceId || ''}:${secondPublish?.sequence || 0}`;
  const firstPublishCursor = `${firstPublish?.sourceId || ''}:${firstPublish?.sequence || 0}`;
  const appendSequences = publishEvents(secondHostEvents)
   .filter((event) => event.eventType === 'cue.append').map((event) => event.sequence);
  const firstSerialized = canonical(firstHost).serialized;
  const secondSerialized = canonical(secondHost).serialized;
  const baseline = `${secondSerialized}:${hostPublishCursor}`;
  if (lastHost !== baseline || firstSerialized !== secondSerialized
   || firstPublishCursor !== hostPublishCursor) stableSince = now();
  lastHost = baseline;
  const stableHost = firstSerialized === secondSerialized
   && firstPublishCursor === hostPublishCursor && now() - stableSince >= stableMs;
  const comparison = compareViewerCueState(secondHost, store.cues || []);
  const applied = viewerEvents.filter((event) => event.stage === 'VIEWER_STORE_UPDATED'
   && event.transportResult === 'updated');
  const receivedAppend = new Set(applied.filter((event) => event.messageType === 'cue.append')
   .map((event) => event.sequence));
  const missingAppend = appendSequences.filter((sequence) => !receivedAppend.has(sequence));
  const snapshot = applied.filter((event) => event.messageType === 'snapshot'
   && missingAppend.every((sequence) => event.sequence >= sequence))
   .sort((left, right) => right.sequence - left.sequence)[0];
  const requiredSequence = Math.max(0, ...applied.filter((event) =>
   ['snapshot', 'cue.append', 'cue.update'].includes(event.messageType)).map((event) => event.sequence || 0));
  const storeApplied = store.available === true && Boolean(secondPublish?.sourceId)
   && store.hostCursor?.sourceId === secondPublish.sourceId
   && Number.isSafeInteger(store.hostCursor.sequence)
   && requiredSequence > 0
   && store.hostCursor.sequence >= Math.max(requiredSequence, secondPublish.sequence);
  const snapshotCoversMissingAppend = missingAppend.length > 0 && Boolean(snapshot)
   && storeApplied && store.hostCursor.sequence >= snapshot.sequence
   && comparison.verdict === 'PASS';
  const appendCovered = appendSequences.length > 0 && comparison.hostCueCount > 0
   && (missingAppend.length === 0 || snapshotCoversMissingAppend);
  const verdict = !stableHost ? 'HOST_UNSTABLE'
   : !storeApplied || !appendCovered ? 'FAIL' : comparison.verdict;
  result = { ...comparison, verdict,
   failureCode: verdict !== 'FAIL' ? null : store.available !== true
    ? 'TEST_INSTRUMENTATION_FAILURE' : 'VIEWER_DATA_MISMATCH',
   stableHost, storeApplied, appendSequences, missingAppend,
   hostPublishSequence: secondPublish?.sequence ?? null,
   snapshotSequence: snapshot?.sequence ?? null,
   storeCursorSequence: store.hostCursor?.sequence ?? null,
   snapshotCoversMissingAppend };
  if (result.verdict === 'PASS' || now() >= deadline) break;
  await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
 } while (true);
 return result;
}
