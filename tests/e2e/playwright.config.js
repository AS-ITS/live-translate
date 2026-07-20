import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.js'],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'NODE_ENV=test GEMINI_API_KEY=test ALLOWED_ORIGIN=http://127.0.0.1:5174 npm run server',
      url: 'http://127.0.0.1:3001/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    },
    {
      command: 'npm run dev -- --config tests/e2e/vite.e2e.config.js --port 5174',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    }
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
