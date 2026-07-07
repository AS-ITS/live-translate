# Testing

This project separates deterministic tests from real Gemini API validation. Unit,
integration, and E2E tests must not call the real Gemini API. The live smoke test
is opt-in only.

## Unit Tests

Run all unit tests:

```bash
npm run test:unit
```

Run transcript unit tests:

```bash
node --test tests/unit/transcript.test.js
```

Run transcript export unit tests:

```bash
node --test tests/unit/transcriptExport.test.js
```

Current unit coverage:

- PCM16 audio conversion and base64 byte conversion
- Linear resampling and PCM chunking
- Transcript update behavior
- Transcript export formatting
- Frontend/backend language allowlist alignment
- Token request validation and token config shape

## Integration Tests

Run integration tests with the test-only Gemini mock loader:

```bash
npm run test:integration
```

The loader intercepts `@google/genai`, so `POST /api/live-token` uses the real
local route handler while Gemini token creation is mocked.

Current integration coverage:

- Successful `POST /api/live-token`
- Invalid language
- Missing `GEMINI_API_KEY`
- Provider expired-token style failure
- Structured error response for invalid JSON
- Demo access-token gate
- Origin allowlist enforcement
- IP-based rate limiting
- Security headers and request id response headers
- `/healthz` and `/readyz`

## E2E Tests

E2E tests use Playwright and a Vite test config that aliases `@google/genai` to a
browser mock.

Install Playwright if it is not already installed:

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

Run E2E tests:

```bash
npm run test:e2e
```

The Playwright flow:

- Opens the home page
- Selects a target language
- Clicks `Start`
- Mocks microphone permission and media tracks
- Verifies the UI reaches `Listening`
- Clicks `Stop`
- Verifies the mocked session closes and microphone tracks stop

## Live Smoke Test

The live smoke test is the only test path allowed to call the real Gemini API.
It is disabled unless `ENABLE_REAL_GEMINI_TEST=true`.

Default safe run, no real API call:

```bash
npm run test:live-smoke
```

Real Gemini smoke test:

```bash
ENABLE_REAL_GEMINI_TEST=true \
GEMINI_API_KEY=your_real_key \
npm run test:live-smoke
```

Optional environment variables:

- `LIVE_SMOKE_TARGET_LANGUAGE`: target language code, defaults to `zh-Hant`
- `LIVE_SMOKE_TIMEOUT_MS`: connection timeout in milliseconds, defaults to `15000`

CI must not set `ENABLE_REAL_GEMINI_TEST=true` unless the job is explicitly
intended to spend real Gemini API quota.
