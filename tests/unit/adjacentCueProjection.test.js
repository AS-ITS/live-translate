import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAdjacentFinalCues } from '../../src/lib/adjacentCueProjection.js';
import { applyMeetingCueEvent, mergeMeetingViewerSnapshot } from '../../src/lib/meetingViewerState.js';
import { exportCuesToSrt, exportCuesToTxt, exportCuesToVtt } from '../../src/lib/subtitleCueExport.js';

const cue = (cueId, sequence, sourceText, translatedText, startTimeMs, endTimeMs) => ({
  cueId, sequence, sourceText, rawSource: sourceText, translatedText,
  rawTranslation: translatedText, status: 'final', finalizedReason: 'turnComplete',
  sessionId: 'session-1', segmentId: 'segment-1', audioTurnId: 'turn-1',
  sourceLanguageCode: 'en', targetLanguageCode: 'zh-Hant',
  sourceVersion: 1, translationVersion: 1, revision: 1,
  startTimeMs, endTimeMs
});

test('adjacent projection keeps authority independent and export uses the same sentence and timeline', () => {
  const authority = [
    cue('cue-1', 1, 'Hello,', '你好，', 1000, 1800),
    cue('cue-2', 2, 'world.', '世界。', 1801, 2600)
  ];
  const original = structuredClone(authority);
  const projected = projectAdjacentFinalCues(authority);
  assert.equal(projected.length, 1);
  assert.deepEqual(projected[0].projectionCueIds, ['cue-1', 'cue-2']);
  assert.equal(projected[0].sourceText, 'Hello, world.');
  assert.equal(projected[0].translatedText, '你好，世界。');
  assert.deepEqual([projected[0].startTimeMs, projected[0].endTimeMs], [1000, 2600]);
  assert.equal(projected[0].translationVersion, undefined);
  assert.equal(exportCuesToTxt(authority, { stream: 'translation' }), '你好，世界。\n');
  assert.match(exportCuesToSrt(authority, { stream: 'source' }), /00:00:01,000 --> 00:00:02,600\nHello, world\./u);
  assert.match(exportCuesToVtt(authority, { stream: 'translation' }), /00:00:01\.000 --> 00:00:02\.600\n你好，世界。/u);
  assert.deepEqual(authority, original);
  assert.deepEqual(projectAdjacentFinalCues(structuredClone(authority)), projected);
});

test('viewer snapshot append update and replay rebuild the projection from Cue IDs', () => {
  const first = cue('cue-1', 1, 'Hello,', '你好，', 1000, 1800);
  const second = cue('cue-2', 2, 'world.', '世界。', 1801, 2600);
  let viewer = mergeMeetingViewerSnapshot(null, { cues: [first], cursor: { eventId: 1 } });
  viewer = applyMeetingCueEvent(viewer, { type: 'cue.append', eventId: 2, cue: second });
  assert.deepEqual(viewer.cues.map((item) => item.cueId), ['cue-1', 'cue-2']);
  assert.equal(projectAdjacentFinalCues(viewer.cues)[0].translatedText, '你好，世界。');

  const updated = { ...second, translatedText: '世界！', rawTranslation: '世界！', translationVersion: 2, revision: 2 };
  viewer = applyMeetingCueEvent(viewer, { type: 'cue.update', eventId: 3, cue: updated });
  viewer = applyMeetingCueEvent(viewer, { type: 'cue.update', eventId: 3, cue: updated });
  assert.equal(viewer.cues.length, 2);
  const reloaded = mergeMeetingViewerSnapshot(null, { cues: structuredClone(viewer.cues), cursor: viewer.cursor });
  assert.deepEqual(projectAdjacentFinalCues(reloaded.cues), projectAdjacentFinalCues(viewer.cues));
  assert.equal(exportCuesToTxt(reloaded.cues, { stream: 'translation' }), '你好，世界！\n');
});

test('source-only adjacent Cues project for source export without inventing translation', () => {
  const first = cue('cue-1', 1, 'Hello,', '', 1000, 1800);
  const second = cue('cue-2', 2, 'world.', '', 1801, 2600);
  assert.equal(projectAdjacentFinalCues([first, second]).length, 2);
  const source = projectAdjacentFinalCues([first, second], { stream: 'source' });
  assert.equal(source.length, 1);
  assert.equal(source[0].sourceText, 'Hello, world.');
  assert.equal(source[0].translatedText, '');
  assert.equal(exportCuesToTxt([first, second], { stream: 'source' }), 'Hello, world.\n');
});

test('late translation changes only the matching authority Cue and rebuilds one display row', () => {
  const first = cue('cue-1', 1, 'Hello,', '', 1000, 1800);
  const second = cue('cue-2', 2, 'world.', '世界。', 1801, 2600);
  let viewer = mergeMeetingViewerSnapshot(null, { cues: [first, second] });
  assert.equal(projectAdjacentFinalCues(viewer.cues).length, 2);
  const translated = { ...first, translatedText: '你好，', rawTranslation: '你好，',
    translationVersion: 2, revision: 2 };
  viewer = applyMeetingCueEvent(viewer, { type: 'cue.update', eventId: 1, cue: translated });
  const rows = projectAdjacentFinalCues(viewer.cues);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].projectionCueIds, ['cue-1', 'cue-2']);
  assert.equal(rows[0].sourceText, 'Hello, world.');
  assert.equal(rows[0].translatedText, '你好，世界。');
  assert.equal(viewer.cues[1].rawTranslation, '世界。');
});
