import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequestHandler } from '../../server/index.js';
import { createLiveToken } from '../../server/tokenService.js';

const cases = [
  {
    name: 'T1 empty to added',
    initial: [],
    saved: [{ source: '你好', target: 'B', replacementAliases: ['Hello'] }],
    expectedTarget: 'B'
  },
  {
    name: 'T2 A to B',
    initial: [{ source: '你好', target: 'A', replacementAliases: [] }],
    saved: [{ source: '你好', target: 'B', replacementAliases: [] }],
    expectedTarget: 'B'
  },
  {
    name: 'T3 existing to deleted',
    initial: [{ source: '你好', target: 'A', replacementAliases: [] }],
    saved: [],
    expectedTarget: null
  }
];

for (const scenario of cases) {
  test(`Save -> authoritative Resume -> bound token: ${scenario.name}`, async () => {
    const state = createState(scenario.initial);
    const handler = createHandler(state);

    const save = await request(handler, {
      method: 'PATCH',
      url: '/api/meetings/meeting-1',
      body: { privateGlossaryEntries: scenario.saved }
    });
    assert.equal(save.status, 200);

    const resume = await request(handler, {
      method: 'POST',
      url: '/api/meetings/meeting-1/recording/resume',
      body: {
        operationId: `resume-${scenario.name}`,
        expectedLifecycleVersion: 1,
        leaseId: 'lease-1',
        fenceToken: 1
      }
    });
    assert.equal(resume.status, 201);
    assert.equal(resume.json.segment.id, 'segment-2');
    assert.deepEqual(resume.json.segment.settingsSnapshot.privateGlossaryEntries, scenario.saved);

    const token = await request(handler, {
      method: 'POST',
      url: '/api/live-token',
      headers: {
        'x-meeting-session-id': 'session-1',
        'x-meeting-segment-id': 'segment-2',
        'x-meeting-lease-id': 'lease-1',
        'x-meeting-fence-token': '1',
        'x-meeting-lifecycle-version': '2'
      },
      body: {
        meetingId: 'meeting-1',
        sessionId: 'session-1',
        segmentId: 'segment-2',
        geminiApiKey: 'request-only-secret',
        sourceLanguageCode: 'zh-Hant',
        targetLanguageCode: 'en'
      }
    });

    assert.equal(token.status, 200);
    assert.equal(token.json.authoritativeSegment.segmentId, 'segment-2');
    assert.equal(token.json.glossaryEntryCount, scenario.saved.length);
    assert.equal(token.json.liveGlossaryEntries[0]?.target || null, scenario.expectedTarget);
    assert.match(token.json.effectiveGlossaryRevision, /^[a-f0-9]{64}$/);
    const glossaryEvents = state.logs.filter((entry) => [
      'GLOSSARY_SAVE_ACCEPTED', 'GLOSSARY_REVISION_UPDATED', 'TOKEN_SEGMENT_BOUND'
    ].includes(entry.event));
    assert.deepEqual(
      glossaryEvents.map((entry) => entry.event),
      ['GLOSSARY_SAVE_ACCEPTED', 'GLOSSARY_REVISION_UPDATED', 'TOKEN_SEGMENT_BOUND']
    );
    assert.equal(glossaryEvents[2].segmentId, 'segment-2');
    assert.equal(glossaryEvents[2].revision, token.json.effectiveGlossaryRevision);
    assert.equal(glossaryEvents[2].glossaryEntryCount, scenario.saved.length);
    assert.doesNotMatch(JSON.stringify(state.logs), /request-only-secret|ephemeral-token|Required translation:/);
    assert.equal(state.providerConfigs.length, 1);
    const instruction = state.providerConfigs[0].liveConnectConstraints.config.systemInstruction.parts[0].text;
    if (scenario.expectedTarget) assert.match(instruction, new RegExp(`Required translation: ${scenario.expectedTarget}`));
    else assert.doesNotMatch(instruction, /Required translation:/);
  });
}

function createState(initialEntries) {
  const meeting = {
    id: 'meeting-1',
    ownerUserId: 'owner-1',
    status: 'active',
    lifecycleContractVersion: 2,
    lifecycleVersion: 1,
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    glossaryEntries: [],
    privateGlossaryEntries: initialEntries
  };
  const segments = [{
    id: 'segment-1', sessionId: 'session-1', sequence: 0, status: 'completed',
    settingsSnapshot: { ...meeting }
  }];
  return { meeting, segments, providerConfigs: [], logs: [] };
}

function createHandler(state) {
  const meetingRepository = {
    async getMeeting() { return { ...state.meeting }; },
    async listMeetingSegments() { return state.segments.map((segment) => ({ ...segment })); }
  };
  const meetingLifecycleService = {
    async execute(input) {
      assert.equal(input.command, 'resume');
      state.meeting.lifecycleVersion += 1;
      const segment = {
        id: 'segment-2',
        sessionId: 'session-1',
        sequence: 1,
        status: 'active',
        settingsSnapshot: {
          sourceLanguageCode: state.meeting.sourceLanguageCode,
          targetLanguageCode: state.meeting.targetLanguageCode,
          glossaryEntries: state.meeting.glossaryEntries,
          privateGlossaryEntries: state.meeting.privateGlossaryEntries
        }
      };
      state.segments.push(segment);
      return {
        meeting: { id: 'meeting-1', lifecycleVersion: state.meeting.lifecycleVersion },
        session: { id: 'session-1' },
        segment,
        lease: { leaseId: 'lease-1', fenceToken: 1 }
      };
    },
    async validateWrite(input) {
      assert.deepEqual(input, {
        meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'segment-2',
        leaseId: 'lease-1', fenceToken: 1
      });
      return { valid: true };
    }
  };
  return createRequestHandler({
    accessControl: { validateRequest: async () => ({ id: 'owner-1', role: 'member', status: 'active' }) },
    profileService: { async getProfile() { return { role: 'member', status: 'active' }; } },
    meetingMembershipService: {
      async canRecord() { return true; },
      async canManage() { return true; },
      async canAccessMeeting() { return true; },
      async getMeetingOwner() { return 'owner-1'; }
    },
    meetingRepository,
    meetingLifecycleService,
    meetingCheckpointService: {
      async updateMeeting({ settings }) {
        Object.assign(state.meeting, settings);
        return { meeting: { ...state.meeting } };
      }
    },
    glossaryController: { async listEntries() { return []; } },
    sessionRepository: {
      async getSessionRecord() {
        return {
          sessionRecord: {
            id: 'session-1', meetingId: 'meeting-1', segmentId: 'segment-1',
            sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en'
          },
          transcriptItems: []
        };
      }
    },
    liveTokenCreator: (body, options) => createLiveToken(body, {
      ...options,
      client: {
        authTokens: {
          async create({ config }) {
            state.providerConfigs.push(config);
            return { name: 'ephemeral-token' };
          }
        }
      },
      glossary: { async entriesFor() { return []; } },
      meetingRepository
    }),
    requestLogger(entry) { state.logs.push(entry); }
  });
}

async function request(handler, { method, url, body, headers = {} }) {
  const req = Readable.from([JSON.stringify(body || {})]);
  req.method = method;
  req.url = url;
  req.headers = { authorization: 'Bearer signed-token', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = {
    statusCode: 0,
    body: '',
    setHeader() {},
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(value = '') { this.body = value; }
  };
  await handler(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}
