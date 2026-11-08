import { defineConfig, devices } from '@playwright/test';
import { E2E_SUPABASE_URL, E2E_SUPABASE_PUBLISHABLE_KEY, localE2EAuthSession } from './authBootstrap.js';

const localSession = localE2EAuthSession();
const apiPort = process.env.ISSUE41_E2E_API_PORT || '3000';
const frontendPort = process.env.ISSUE41_E2E_FRONTEND_PORT || '5174';
if (localSession && (
  !process.env.SUPABASE_SECRET_KEY || !process.env.SUPABASE_JWKS_URL ||
  !process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_URL !== process.env.SUPABASE_URL
)) {
  throw new Error('Local E2E requires matching Supabase server and browser configuration.');
}

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.js'],
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: process.env.ISSUE41_REAL_GEMINI_AUDIO === 'true' ? 'off' : 'retain-on-failure',
    ...(process.env.ISSUE41_LOCAL_AUDIO_WAV ? { launchOptions: { args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${process.env.ISSUE41_LOCAL_AUDIO_WAV}`
    ] } } : {})
  },
  webServer: [
    {
      command: localSession
        ? `env NODE_ENV=test E2E_TEST_MODE=true LIVE_PIPELINE_TRACE_ENABLED=true dev_frontend_origin=http://127.0.0.1:${frontendPort} GEMINI_API_KEY=${process.env.ISSUE41_REAL_GEMINI_AUDIO === 'true' ? '' : 'test'} npm run server`
        : `env NODE_ENV=test E2E_TEST_MODE=true SUPABASE_URL= SUPABASE_SECRET_KEY= SUPABASE_JWKS_URL= AUTH_ALLOWED_EMAIL_DOMAINS= LIVE_PIPELINE_TRACE_ENABLED=true dev_frontend_origin=http://127.0.0.1:${frontendPort} GEMINI_API_KEY=test SESSION_RECORDS_FILE=/private/tmp/live-translate-e2e-session-records-${apiPort}.json npm run server`,
      url: `http://127.0.0.1:${apiPort}/healthz`,
      reuseExistingServer: false,
      stdout: localSession ? 'pipe' : 'ignore',
      timeout: 30_000
    },
    ...(process.env.ISSUE41_SIGNALING_URL ? [{
      command: 'node ../../scripts/issue41-webrtc-signaling-harness.mjs',
      url: `${process.env.ISSUE41_SIGNALING_URL}/healthz`,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 30_000
    }] : []),
    {
      command: localSession
        ? `npm run dev -- --config tests/e2e/vite.e2e.config.js --port ${frontendPort}`
        : `env VITE_SUPABASE_URL=${E2E_SUPABASE_URL} VITE_SUPABASE_PUBLISHABLE_KEY=${E2E_SUPABASE_PUBLISHABLE_KEY} npm run dev -- --config tests/e2e/vite.e2e.config.js --port ${frontendPort}`,
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 30_000
    }
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'mobile-webkit',
      use: { ...devices['iPhone 13'] }
    }
  ]
});
