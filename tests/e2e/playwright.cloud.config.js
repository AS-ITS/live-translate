import { defineConfig } from '@playwright/test';

const cloudBaseUrl = process.env.CLOUD_BASE_URL?.trim();
const cloudAccessToken = process.env.CLOUD_TEST_ACCESS_TOKEN?.trim();

if (!cloudBaseUrl) throw new Error('CLOUD_BASE_URL is required for cloud E2E tests.');
const parsedBaseUrl = new URL(cloudBaseUrl);
if (parsedBaseUrl.protocol !== 'https:') throw new Error('CLOUD_BASE_URL must use https.');
if (!cloudAccessToken) throw new Error('CLOUD_TEST_ACCESS_TOKEN is required for cloud E2E tests.');

parsedBaseUrl.pathname = parsedBaseUrl.pathname.replace(/\/+$/u, '');
parsedBaseUrl.search = '';
parsedBaseUrl.hash = '';

export default defineConfig({
  testDir: '../cloud',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: parsedBaseUrl.toString().replace(/\/$/u, ''),
    extraHTTPHeaders: { Authorization: `Bearer ${cloudAccessToken}` },
    trace: 'off'
  }
});
