import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveToken } from '../../server/tokenService.js';

const languages = { sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en' };

test('Save then Continue revisions cover add, replace, delete, and Meeting override', async () => {
  const globalEntries = [{ source: '你好', target: 'Global', replacementAliases: ['Hello'] }];
  const states = [
    { name: 'empty', snapshot: { glossaryEntries: [], privateGlossaryEntries: [] }, expected: [] },
    {
      name: 'added',
      snapshot: { glossaryEntries: [], privateGlossaryEntries: [{ source: '你好', target: 'A', replacementAliases: ['Hi'] }] },
      expected: [{ source: '你好', target: 'A', replacementAliases: ['Hi'] }]
    },
    {
      name: 'replaced',
      snapshot: { glossaryEntries: [], privateGlossaryEntries: [{ source: '你好', target: 'B', replacementAliases: ['Hey'] }] },
      expected: [{ source: '你好', target: 'B', replacementAliases: ['Hey'] }]
    },
    { name: 'deleted', snapshot: { glossaryEntries: [], privateGlossaryEntries: [] }, expected: [] },
    {
      name: 'meeting-override',
      snapshot: { glossaryEntries: [], privateGlossaryEntries: [{ source: '你好', target: 'Meeting', replacementAliases: [] }] },
      expected: [{ source: '你好', target: 'Meeting', replacementAliases: ['Global', 'Hello'] }],
      includeGlobal: true
    }
  ];
  const revisions = new Map();

  for (const state of states) {
    let tokenConfig;
    const token = await createLiveToken(
      { ...languages, meetingId: 'meeting-1' },
      {
        client: { authTokens: { async create({ config }) { tokenConfig = config; return { name: `token-${state.name}` }; } } },
        glossary: { async entriesFor() { return state.includeGlobal ? globalEntries : []; } },
        meetingRepository: { async getMeeting() { return { id: 'meeting-1' }; } },
        authoritativeSegment: { id: `segment-${state.name}`, settingsSnapshot: state.snapshot },
        authoritativeBinding: {
          meetingId: 'meeting-1', sessionId: 'session-1', segmentId: `segment-${state.name}`, lifecycleVersion: 2
        }
      }
    );

    assert.deepEqual(token.liveGlossaryEntries, state.expected, state.name);
    assert.equal(token.glossaryEntryCount, state.expected.length, state.name);
    assert.deepEqual(token.authoritativeSegment, {
      meetingId: 'meeting-1', sessionId: 'session-1', segmentId: `segment-${state.name}`, lifecycleVersion: 2
    });
    const instruction = tokenConfig.liveConnectConstraints.config.systemInstruction.parts[0].text;
    for (const entry of state.expected) assert.match(instruction, new RegExp(`Required translation: ${entry.target}`));
    revisions.set(state.name, token.effectiveGlossaryRevision);
  }

  assert.notEqual(revisions.get('empty'), revisions.get('added'));
  assert.notEqual(revisions.get('added'), revisions.get('replaced'));
  assert.equal(revisions.get('empty'), revisions.get('deleted'));
  assert.notEqual(revisions.get('deleted'), revisions.get('meeting-override'));
});

test('provider reconnect and rollover retain revision for an unchanged Segment snapshot', async () => {
  const settingsSnapshot = {
    glossaryEntries: [],
    privateGlossaryEntries: [{ source: '你好', target: 'B', replacementAliases: ['Hello'] }]
  };
  const issue = (segmentId) => createLiveToken(
    { ...languages, meetingId: 'meeting-1' },
    {
      client: { authTokens: { async create() { return { name: `token-${segmentId}` }; } } },
      glossary: { async entriesFor() { return []; } },
      meetingRepository: { async getMeeting() { return { id: 'meeting-1' }; } },
      authoritativeSegment: { id: segmentId, settingsSnapshot },
      authoritativeBinding: { meetingId: 'meeting-1', sessionId: 'session-1', segmentId, lifecycleVersion: 3 }
    }
  );

  const initial = await issue('segment-resume');
  const reconnect = await issue('segment-resume');
  const rollover = await issue('segment-rollover');

  assert.equal(reconnect.effectiveGlossaryRevision, initial.effectiveGlossaryRevision);
  assert.equal(rollover.effectiveGlossaryRevision, initial.effectiveGlossaryRevision);
  assert.deepEqual(reconnect.liveGlossaryEntries, initial.liveGlossaryEntries);
  assert.deepEqual(rollover.liveGlossaryEntries, initial.liveGlossaryEntries);
});

test('edits during recording stay behind the next authoritative Segment boundary', async () => {
  const meeting = {
    id: 'meeting-1',
    glossaryEntries: [],
    privateGlossaryEntries: [{ source: '你好', target: 'B', replacementAliases: [] }]
  };
  const activeSnapshot = {
    glossaryEntries: [],
    privateGlossaryEntries: [{ source: '你好', target: 'A', replacementAliases: [] }]
  };
  const client = { authTokens: { async create() { return { name: 'token' }; } } };
  const common = {
    client,
    glossary: { async entriesFor() { return []; } },
    meetingRepository: { async getMeeting() { return meeting; } }
  };

  const currentSegment = await createLiveToken(
    { ...languages, meetingId: 'meeting-1' },
    { ...common, authoritativeSegment: { id: 'segment-a', settingsSnapshot: activeSnapshot } }
  );
  const nextSegment = await createLiveToken(
    { ...languages, meetingId: 'meeting-1' },
    { ...common, authoritativeSegment: { id: 'segment-b', settingsSnapshot: meeting } }
  );

  assert.equal(currentSegment.liveGlossaryEntries[0].target, 'A');
  assert.equal(nextSegment.liveGlossaryEntries[0].target, 'B');
  assert.notEqual(currentSegment.effectiveGlossaryRevision, nextSegment.effectiveGlossaryRevision);
});
