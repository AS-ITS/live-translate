import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.liveTokenRequests = [];
  page.failLiveTokenRequestAt = null;

  await page.addInitScript(() => {
    window.__mockMicTracks = [];

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const track = {
            kind: 'audio',
            stopped: false,
            stop() {
              this.stopped = true;
            }
          };
          window.__mockMicTracks.push(track);
          return {
            getTracks: () => [track]
          };
        }
      }
    });

    class MockAudioContext {
      constructor() {
        this.sampleRate = 16000;
        this.currentTime = 0;
        this.destination = {};
        this.state = 'running';
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createScriptProcessor() {
        return { connect() {}, disconnect() {}, onaudioprocess: null };
      }

      createBuffer() {
        return {
          duration: 0,
          copyToChannel() {}
        };
      }

      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          disconnect() {},
          start() {
            this.onended?.();
          },
          stop() {},
          onended: null
        };
      }

      async close() {
        this.state = 'closed';
      }
    }

    window.AudioContext = MockAudioContext;
    window.webkitAudioContext = MockAudioContext;
  });

  await page.route('**/api/live-token', async (route) => {
    const request = route.request();
    const body = JSON.parse(request.postData() || '{}');
    page.liveTokenRequests.push(body);

    if (page.failLiveTokenRequestAt === page.liveTokenRequests.length) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'provider_unavailable' } })
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: `mock-token-for-${body.targetLanguageCode}`,
        expiresAt: '2026-07-07T00:30:00.000Z'
      })
    });
  });
});

function historyPanel(page) {
  return page.locator('.history-panel');
}

function historyItems(page) {
  return historyPanel(page).locator('.history-item');
}

function sessionDetail(page) {
  return page.locator('.session-detail');
}

async function emitFinalTranscript(page, sourceText = 'history source', translationText = 'history translation') {
  await page.evaluate(
    ({ sourceText, translationText }) => {
      window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
        serverContent: {
          inputTranscription: { text: sourceText },
          outputTranscription: { text: translationText },
          turnComplete: true
        }
      });
    },
    { sourceText, translationText }
  );
}

async function emitPartialTranscript(page, sourceText = 'partial source', translationText = 'partial translation') {
  await page.evaluate(
    ({ sourceText, translationText }) => {
      window.__mockGoogleGenAI.liveSessions.at(-1).emitMessage({
        serverContent: {
          inputTranscription: { text: sourceText },
          outputTranscription: { text: translationText }
        }
      });
    },
    { sourceText, translationText }
  );
}

test('initial history shows empty state', async ({ page }) => {
  await page.goto('/');

  await expect(historyPanel(page).getByRole('heading', { name: 'Session history' })).toBeVisible();
  await expect(historyPanel(page).getByText('No session history yet.')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
});

test('active session is not shown while listening', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await expect(historyPanel(page).getByText('No session history yet.')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);
  await expect(historyPanel(page).getByRole('button', { name: 'View details' })).toHaveCount(0);
});

test('starts and stops a mocked Gemini Live translation session', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Live Translate' })).toBeVisible();
  await expect(page.getByText('Ready')).toBeVisible();

  const targetLanguage = page.getByRole('combobox', { name: 'Target language' });

  await targetLanguage.selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page.getByText('Listening')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__mockGoogleGenAI?.liveConnects.length || 0))
    .toBe(1);
  await expect(targetLanguage).toBeDisabled();

  const liveConnect = await page.evaluate(() => {
    const request = window.__mockGoogleGenAI.liveConnects[0];
    return {
      model: request.model,
      targetLanguageCode: request.config.generationConfig.translationConfig.targetLanguageCode,
      responseModalities: request.config.responseModalities
    };
  });
  expect(liveConnect).toEqual({
    model: 'gemini-3.5-live-translate-preview',
    targetLanguageCode: 'ja',
    responseModalities: ['AUDIO']
  });

  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.locator('.status-pill').getByText('Stopped', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockMicTracks.every((track) => track.stopped))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveSessions[0].closed)).toBe(true);
});

test('stopped session appears in history with language, status, and transcript summary', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: 'Target language' }).selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'hello history', '履歴');

  await page.getByRole('button', { name: 'Stop' }).click();

  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByRole('heading', { name: 'Japanese' })).toBeVisible();
  await expect(item.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(item.getByText('Source final: 1 · Translation final: 1')).toBeVisible();
});

test('stopped session can open and close inline detail with metadata and final transcripts', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: 'Target language' }).selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitPartialTranscript(page, 'partial should not save', 'partial translation should not save');
  await emitFinalTranscript(page, 'saved source detail', 'saved translation detail');

  await page.getByRole('button', { name: 'Stop' }).click();
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByRole('heading', { name: 'Japanese details' })).toBeVisible();
  await expect(detail.getByText('Target language')).toBeVisible();
  await expect(detail.getByText('Japanese', { exact: true })).toBeVisible();
  await expect(detail.getByText('Status')).toBeVisible();
  await expect(detail.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(detail.getByText('Started')).toBeVisible();
  await expect(detail.getByText('Ended')).toBeVisible();
  await expect(detail.getByText('Duration')).toBeVisible();
  await expect(detail.getByText('Source final: 1 · Translation final: 1')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Source transcript' })).toBeVisible();
  await expect(detail.getByText('saved source detail')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Translation transcript' })).toBeVisible();
  await expect(detail.getByText('saved translation detail')).toBeVisible();
  await expect(detail.getByText('partial should not save')).toBeHidden();
  await expect(detail.getByText('partial translation should not save')).toBeHidden();

  await detail.getByRole('button', { name: 'Close details' }).click();
  await expect(sessionDetail(page)).toBeHidden();
  await expect(historyItems(page)).toHaveCount(1);
});

test('no transcript detail shows empty state', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();

  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  await expect(sessionDetail(page).getByText('No saved transcript.')).toBeVisible();
});

test('failed session appears in history with normalized failure reason', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Unable to reconnect live translation. You can start a new session when ready.')).toBeVisible();

  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByText('Failed', { exact: true })).toBeVisible();
  await expect(item.getByText('Reason: unexpected_close')).toBeVisible();
});

test('failed session detail shows normalized failure reason', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Unable to reconnect live translation. You can start a new session when ready.')).toBeVisible();
  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByText('Failure reason')).toBeVisible();
  await expect(detail.getByText('unexpected_close')).toBeVisible();
  await expect(detail.getByText('Failure category')).toBeVisible();
  await expect(detail.getByText('provider')).toBeVisible();
});

test('expired session appears in history with expired status', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  const item = historyItems(page).first();
  await expect(historyItems(page)).toHaveCount(1);
  await expect(item.getByText('Expired', { exact: true })).toBeVisible();
  await expect(item.getByText('Reason: token_expired')).toBeVisible();
});

test('expired session detail shows normalized failure reason', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await historyItems(page).first().getByRole('button', { name: 'View details' }).click();

  const detail = sessionDetail(page);
  await expect(detail.getByText('Failure reason')).toBeVisible();
  await expect(detail.getByText('token_expired')).toBeVisible();
  await expect(detail.getByText('Failure category')).toBeVisible();
  await expect(detail.getByText('token', { exact: true })).toBeVisible();
});

test('manual Start after a finalized session does not clear previous history', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(historyItems(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('Stopped', { exact: true })).toBeVisible();
});

test('reconnect does not create duplicate history record', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await emitFinalTranscript(page, 'before reconnect', 'after reconnect');

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await expect(page.getByText('Listening')).toBeVisible();
  await expect(historyItems(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(historyItems(page)).toHaveCount(1);
  await expect(historyItems(page).first().getByText('Stopped', { exact: true })).toBeVisible();
});

test('reconnects once after mocked unexpected close and preserves transcript', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('combobox', { name: 'Target language' }).selectOption('ja');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'hello' },
        outputTranscription: { text: 'こんにちは' },
        turnComplete: true
      }
    });
  });
  await expect(page.getByText('hello')).toBeVisible();
  await expect(page.getByText('こんにちは')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
  await expect(page.getByText('Listening')).toBeVisible();
  await expect(page.getByText('hello')).toBeVisible();
  await expect(page.getByText('こんにちは')).toBeVisible();
});

test('token expired shows friendly message without reconnect and preserves transcript', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'before token expiration' },
        outputTranscription: { text: 'still visible after expiration' },
        turnComplete: true
      }
    });
  });
  await expect(page.getByText('before token expiration')).toBeVisible();
  await expect(page.getByText('still visible after expiration')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'token expired', code: 1008 });
  });

  await expect(page.getByText('Session expired', { exact: true })).toBeVisible();
  await expect(page.getByText('Session expired. Please start a new session.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  await expect(page.getByText('before token expiration')).toBeVisible();
  await expect(page.getByText('still visible after expiration')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await expect(page.getByText('before token expiration')).toBeHidden();
  await expect(page.getByText('still visible after expiration')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
});

test('auth failed shows friendly message without reconnect', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'before auth failure' },
        outputTranscription: { text: 'auth failure transcript' },
        turnComplete: true
      }
    });
  });

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitError({
      code: 'auth_failed',
      message: 'raw auth failure token abc123 at Provider.stack'
    });
  });

  await expect(page.getByText('Access failed', { exact: true })).toBeVisible();
  await expect(page.getByText('Access failed. Please check your access token or configuration.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  await expect(page.getByText('before auth failure')).toBeVisible();
  await expect(page.getByText('auth failure transcript')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('rate limited shows friendly message without reconnect', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'before rate limit' },
        outputTranscription: { text: 'rate limit transcript' },
        turnComplete: true
      }
    });
  });

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitError({
      code: 'rate_limited',
      message: 'raw rate limit failure token abc123 at Provider.stack'
    });
  });

  await expect(page.getByText('Rate limited', { exact: true })).toBeVisible();
  await expect(page.getByText('Too many requests. Please wait and try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  await expect(page.getByText('before rate limit')).toBeVisible();
  await expect(page.getByText('rate limit transcript')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('stop during reconnect cancels pending replacement session', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });
  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.status-pill').getByText('Stopped', { exact: true })).toBeVisible();
  await page.waitForTimeout(900);

  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(1);
  await expect.poll(() => page.liveTokenRequests.length).toBe(1);
});

test('duplicate unexpected close does not create duplicate replacement sessions', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    const session = window.__mockGoogleGenAI.liveSessions[0];
    session.emitClose({ reason: 'unexpected provider close', code: 1011 });
    session.emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await page.waitForTimeout(900);
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(2);
  await expect.poll(() => page.liveTokenRequests.length).toBe(2);
});

test('reconnect failure preserves transcript and allows manual restart', async ({ page }) => {
  page.failLiveTokenRequestAt = 2;
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'hello before failure' },
        outputTranscription: { text: 'translated before failure' },
        turnComplete: true
      }
    });
  });
  await expect(page.getByText('hello before failure')).toBeVisible();
  await expect(page.getByText('translated before failure')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await expect(page.getByText('Unable to reconnect live translation. You can start a new session when ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(page.getByText('hello before failure')).toBeVisible();
  await expect(page.getByText('translated before failure')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();

  page.failLiveTokenRequestAt = null;
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await expect.poll(() => page.liveTokenRequests.length).toBe(3);
});

test('retry exhaustion shows explicit error and preserves transcript', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Listening')).toBeVisible();

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[0].emitMessage({
      serverContent: {
        inputTranscription: { text: 'still exportable' },
        outputTranscription: { text: 'after exhaustion' },
        turnComplete: true
      }
    });
  });

  for (let index = 0; index < 3; index += 1) {
    await page.evaluate((sessionIndex) => {
      window.__mockGoogleGenAI.liveSessions[sessionIndex].emitClose({ reason: 'unexpected provider close', code: 1011 });
    }, index);
    await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(index + 2);
    await expect(page.getByText('Listening')).toBeVisible();
  }

  await page.evaluate(() => {
    window.__mockGoogleGenAI.liveSessions[3].emitClose({ reason: 'unexpected provider close', code: 1011 });
  });

  await expect(page.getByText('Live translation could not reconnect after repeated attempts. You can start a new session when ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(page.getByText('still exportable')).toBeVisible();
  await expect(page.getByText('after exhaustion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__mockGoogleGenAI.liveConnects.length)).toBe(4);
});
