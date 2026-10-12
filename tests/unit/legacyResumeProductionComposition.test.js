import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { createRequestHandler } from '../../server/index.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';

const SUPABASE_SECRET_MARKER = 'service-role-secret-must-not-leak';

test('production composition passes legacy resume service to the returned request handler', async () => {
  const calls = [];
  const { handler, payload, payloadHash } = productionHandler({
    legacyResumeService: {
      async execute(input) {
        calls.push(input);
        return legacyResumeResult({ payloadHash, globalGlossaryEntries: input.globalGlossaryEntries });
      }
    }
  });

  const response = await request(handler, {
    body: { ...payload, operationId: 'continue-1', payloadHash }
  });

  assert.equal(response.status, 201);
  assert.equal(response.json().segment.id, 'segment-2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownerUserId, 'owner-1');
  assert.doesNotMatch(response.raw, new RegExp(SUPABASE_SECRET_MARKER, 'u'));
});

test('production composition safely rejects legacy resume when service is absent', async () => {
  const logs = [];
  const { handler, payload, payloadHash } = productionHandler({
    legacyResumeService: null,
    requestLogger(event) {
      logs.push(event);
    }
  });

  const response = await request(handler, {
    body: { ...payload, operationId: 'continue-1', payloadHash }
  });

  assert.equal(response.status, 503);
  assert.equal(response.json().error.code, 'cloud_capability_unavailable');
  assert.equal(logs.find((entry) => entry.event === 'legacy_resume_command')?.rpcAttempted, false);
  assert.doesNotMatch(`${response.raw}${JSON.stringify(logs)}`, new RegExp(SUPABASE_SECRET_MARKER, 'u'));
});

test('production composition preserves authorization before legacy resume execution', async () => {
  let executeCalls = 0;
  const { handler, payload, payloadHash } = productionHandler({
    authorize: false,
    legacyResumeService: {
      async execute() {
        executeCalls += 1;
        return legacyResumeResult({ payloadHash, globalGlossaryEntries: [] });
      }
    }
  });

  const response = await request(handler, {
    body: { ...payload, operationId: 'continue-1', payloadHash }
  });

  assert.equal(response.status, 403);
  assert.equal(response.json().error.code, 'auth_forbidden');
  assert.equal(executeCalls, 0);
});

function productionHandler({ legacyResumeService, authorize = true, requestLogger = () => {} } = {}) {
  const payload = {
    meetingId: 'meeting-1',
    sourceSegmentId: 'segment-1',
    nextLiveSessionId: 'live-2',
    expectedSessionId: 'session-1',
    checkpoint: { lastFinalCueSequence: 0, finalCues: [], durableChunks: [], cueCheckpoint: null }
  };
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const meetingRepository = {
    ...createMemoryMeetingRepository(),
    async getMeeting() {
      return { id: 'meeting-1', ownerUserId: 'owner-1', targetLanguageCode: 'en', lifecycleVersion: 1 };
    },
    async listMeetingSegments() {
      return [{ id: 'segment-1', status: 'active', sequence: 1 }];
    }
  };
  const dependencies = createProductionApplicationDependencies({
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SECRET_KEY: SUPABASE_SECRET_MARKER
    },
    legacyResumeService,
    meetingRepository,
    glossaryController: {
      async listEntries() {
        return [];
      }
    },
    translationExecutionProvider: { async execute() {} },
    resolveSavedTranscriptTranslationProvider() {
      return { async translate() {} };
    },
    requestHandlerFactory(options) {
      return createRequestHandler({
        ...options,
        requestLogger,
        accessControl: {
          async validateRequest() {
            if (!authorize) {
              const error = new Error('forbidden');
              error.code = 'auth_forbidden';
              error.status = 403;
              throw error;
            }
            return { id: 'member-1', role: 'member', status: 'active' };
          }
        },
        profileService: {
          async getProfile() {
            return { id: 'member-1', role: 'member', status: 'active' };
          },
          async findMeetingMembership() {
            return { meetingId: 'meeting-1', userId: 'member-1', ownerUserId: 'owner-1', canRecord: true };
          }
        },
        meetingMembershipService: {
          async canRecord() {
            return true;
          },
          async canManage() {
            return false;
          },
          async getMeetingOwner() {
            return 'owner-1';
          }
        }
      });
    }
  });

  return { handler: dependencies.requestHandler, payload, payloadHash };
}

function legacyResumeResult({ payloadHash, globalGlossaryEntries }) {
  return {
    meeting: { id: 'meeting-1' },
    interruptedSegment: { id: 'segment-1' },
    segment: {
      id: 'segment-2',
      sequence: 2,
      session_id: 'session-1',
      settings_snapshot: {
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en',
        globalGlossaryEntries,
        glossaryEntries: [],
        privateGlossaryEntries: []
      }
    },
    operation: {
      operationId: 'continue-1',
      payloadHash,
      sourceSegmentId: 'segment-1'
    }
  };
}

async function request(handler, { body } = {}) {
  const req = new Readable({ read() {} });
  req.method = 'POST';
  req.url = '/api/meetings/meeting-1/recording/legacy-resume';
  req.headers = { 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.push(JSON.stringify(body));
  req.push(null);

  const chunks = [];
  const res = {
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await handler(req, res);
  const raw = Buffer.concat(chunks).toString('utf8');
  return { status: res.statusCode, raw, json: () => JSON.parse(raw) };
}
