import { defineConfig, devices } from '@playwright/test';
import { E2E_SUPABASE_URL, E2E_SUPABASE_PUBLISHABLE_KEY } from './authBootstrap.js';

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
      command: 'env NODE_ENV=test E2E_TEST_MODE=true SUPABASE_URL= SUPABASE_SECRET_KEY= SUPABASE_JWKS_URL= AUTH_ALLOWED_EMAIL_DOMAINS= LIVE_PIPELINE_TRACE_ENABLED=true dev_frontend_origin=http://127.0.0.1:5174 GEMINI_API_KEY=test SESSION_RECORDS_FILE=/private/tmp/live-translate-e2e-session-records.json npm run server',
      url: 'http://127.0.0.1:3000/healthz',
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `env VITE_SUPABASE_URL=${E2E_SUPABASE_URL} VITE_SUPABASE_PUBLISHABLE_KEY=${E2E_SUPABASE_PUBLISHABLE_KEY} npm run dev -- --config tests/e2e/vite.e2e.config.js --port 5174`,
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
