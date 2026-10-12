import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTranslateSession } from '../../src/lib/liveSession.js';

test('startup timing milestones remain staging-safe and preserve startup stage', () => {
  const diagnostics = [];
  const session = new LiveTranslateSession({
    targetLanguageCode: 'en',
    startupStartedAt: 1000,
    onStartupMilestone: (milestone) => diagnostics.push(milestone)
  });

  session.markStartupMilestone('provider_setup_complete');
  session.startupError('first_pcm_timeout', 'audio pipeline failed');
  session.markStartupMilestone('first_pcm_generated');

  const snapshot = session.getDebugSnapshot({ includeText: false });
  assert.equal(snapshot.startupStage, 'first_pcm_timeout');
  assert.equal(snapshot.startupTimings.start_click.at, 1000);
  assert.equal(snapshot.startupTimings.provider_setup_complete.durationMs >= 0, true);
  assert.equal(snapshot.startupTimings.first_pcm_generated.durationMs >= 0, true);
  assert.deepEqual(diagnostics.map((item) => item.name), [
    'provider_setup_complete',
    'first_pcm_generated'
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /audio pipeline failed/);
});

test('Continue timing starts before token and provider startup', () => {
  const continueStartedAt = Date.now() - 25;
  const resumedSession = new LiveTranslateSession({
    targetLanguageCode: 'en',
    startupStartedAt: continueStartedAt,
    continueStartedAt
  });
  const newSession = new LiveTranslateSession({ targetLanguageCode: 'en' });

  assert.equal(resumedSession.startupTimings.start_click.at, continueStartedAt);
  assert.equal(resumedSession.continueElapsedMs() >= 25, true);
  assert.equal(newSession.continueElapsedMs(), null);
});

