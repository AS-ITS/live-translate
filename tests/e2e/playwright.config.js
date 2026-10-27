import { defineConfig, devices } from '@playwright/test';
import { E2E_SUPABASE_URL, E2E_SUPABASE_PUBLISHABLE_KEY, localE2EAuthSession } from './authBootstrap.js';

const localSession = localE2EAuthSession();
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
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: localSession
        ? 'env NODE_ENV=test E2E_TEST_MODE=true LIVE_PIPELINE_TRACE_ENABLED=true dev_frontend_origin=http://127.0.0.1:5174 GEMINI_API_KEY=test npm run server'
        : 'env NODE_ENV=test E2E_TEST_MODE=true SUPABASE_URL= SUPABASE_SECRET_KEY= SUPABASE_JWKS_URL= AUTH_ALLOWED_EMAIL_DOMAINS= LIVE_PIPELINE_TRACE_ENABLED=true dev_frontend_origin=http://127.0.0.1:5174 GEMINI_API_KEY=test SESSION_RECORDS_FILE=/private/tmp/live-translate-e2e-session-records.json npm run server',
      url: 'http://127.0.0.1:3000/healthz',
      reuseExistingServer: false,
      stdout: localSession ? 'pipe' : 'ignore',
      timeout: 30_000
    },
    {
      command: localSession
        ? 'npm run dev -- --config tests/e2e/vite.e2e.config.js --port 5174'
        : `env VITE_SUPABASE_URL=${E2E_SUPABASE_URL} VITE_SUPABASE_PUBLISHABLE_KEY=${E2E_SUPABASE_PUBLISHABLE_KEY} npm run dev -- --config tests/e2e/vite.e2e.config.js --port 5174`,
      url: 'http://127.0.0.1:5174',
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
