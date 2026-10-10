import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveGlossaryRevision } from '../../src/lib/glossaryRevision.js';
import { clearLiveCredential, setLiveCredential } from '../../src/lib/liveCredentialHolder.js';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';
import {
  clearMeetingLifecycleWriteFence,
  setMeetingLifecycleWriteFence
} from '../../src/lib/meetingLifecycleWriteFence.js';

test.afterEach(() => {
  clearMeetingLifecycleWriteFence();
  clearLiveCredential();
});

test.beforeEach(() => setLiveCredential('test-api-key'));

test('lifecycle v2 atomically applies the token glossary and authoritative Segment binding', async () => {
  const originalFetch = globalThis.fetch;
  const entries = [{ source: '你好', target: 'B', replacementAliases: ['Hello'] }];
  const revision = await effectiveGlossaryRevision({
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', entries
  });
  let request;
  setMeetingLifecycleWriteFence({
    meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-b',
    lifecycleVersion: 8, leaseId: 'lease-1', fenceToken: 3
  });
  globalThis.fetch = async (_url, options) => {
    request = options;
    return tokenResponse({ entries, revision, segmentId: 'segment-b' });
  };
  const session = new LiveTranslateSession({
    meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-b',
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en'
  });

  try {
    await session.getTokenResponse({ forceRefresh: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.headers['x-meeting-lifecycle-version'], '8');
  assert.equal(request.headers['x-meeting-segment-id'], 'segment-b');
  assert.equal(JSON.parse(request.body).segmentId, 'segment-b');
  assert.equal(session.effectiveGlossaryRevision, revision);
  assert.deepEqual(session.liveGlossaryEntries, entries);
});

test('Segment or revision mismatch leaves prior correction configuration untouched', async () => {
  const originalFetch = globalThis.fetch;
  const oldEntries = [{ source: '你好', target: 'A', replacementAliases: [] }];
  const nextEntries = [{ source: '你好', target: 'B', replacementAliases: [] }];
  const nextRevision = await effectiveGlossaryRevision({
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', entries: nextEntries
  });
  setMeetingLifecycleWriteFence({
    meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-b',
    lifecycleVersion: 8, leaseId: 'lease-1', fenceToken: 3
  });
  const session = new LiveTranslateSession({
    meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-b',
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', liveGlossaryEntries: oldEntries
  });
  globalThis.fetch = async () => tokenResponse({ entries: nextEntries, revision: nextRevision, segmentId: 'segment-stale' });

  try {
    await assert.rejects(session.getTokenResponse({ forceRefresh: true }), { code: 'token_segment_mismatch' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(session.liveGlossaryEntries, oldEntries);
  assert.equal(session.effectiveGlossaryRevision, null);
  assert.equal(session.tokenState, null);
});

test('pending token configuration cannot expose the previous Segment glossary', async () => {
  const originalFetch = globalThis.fetch;
  const entries = [{ source: '你好', target: 'B', replacementAliases: [] }];
  const revision = await effectiveGlossaryRevision({
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', entries
  });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  setMeetingLifecycleWriteFence({
    meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-b',
    lifecycleVersion: 8, leaseId: 'lease-1', fenceToken: 3
  });
  globalThis.fetch = async () => pending;
  const session = new LiveTranslateSession({
    meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-b',
    sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en'
  });

  const configuration = session.getTokenResponse({ forceRefresh: true });
  await Promise.resolve();
  assert.deepEqual(session.liveGlossaryEntries, []);
  assert.equal(session.tokenState, null);
  release(tokenResponse({ entries, revision, segmentId: 'segment-b' }));

  try {
    await configuration;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(session.liveGlossaryEntries, entries);
});

function tokenResponse({ entries, revision, segmentId }) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        token: 'ephemeral-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        liveGlossaryEntries: entries,
        effectiveGlossaryRevision: revision,
        glossaryEntryCount: entries.length,
        authoritativeSegment: {
          meetingId: 'meeting-1', sessionId: 'session-1', segmentId, lifecycleVersion: 8
        }
      };
    }
  };
}
