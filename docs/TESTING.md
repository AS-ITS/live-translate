# Testing

This project separates deterministic tests from real Gemini API validation. Unit,
integration, and E2E tests must not call the real Gemini API. The live smoke test
is opt-in only.

Issue #29 Milestone 1 coverage includes Meeting home route behavior, status
mapping, search/filter rules, and Meeting Management E2E flows. Later coverage
will add Meeting Workspace, Viewer snapshot/SSE, Cue deduplication, ordering,
and reconnect merge. The Viewer latency SLA will use a local deterministic
synthetic broadcaster test; it must not call Gemini or overwrite full benchmark
reports. See [Meeting Center and Live Viewer](features/meeting-center-live-viewer.md).

## Test Responsibility Boundaries

- Unit tests own pure rules, state transitions, input matrices, and failure
  classification.
- Integration tests own HTTP, composition, persistence, and provider adapter
  boundaries.
- E2E tests keep representative browser journeys and browser-only wiring; pure
  Cue merge and display matrices belong in unit tests.
- The live smoke test only checks an explicitly enabled real Gemini connection.

`npm test` is the canonical unit-test entry point and is equivalent to
`npm run test:unit`. Legacy top-level audio and token tests were consolidated
into the unit suite; provider-specific token behavior remains in
`tests/unit/tokenService.test.js`.

## Unit Tests

Run the file-backed queue concurrency and persistence tests:

```bash
node --test tests/unit/fileDurableTranslationExecutionQueueRepository.test.js tests/unit/fileDeadLetterQueueRepository.test.js
```

These tests include two independent Node.js processes writing the same queue
file, concurrent claim ownership, stale sidecar-lock recovery, deterministic
JSON persistence, and the existing queue/DLQ repository contracts.

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

Run transcript polishing unit tests:

```bash
node --test tests/unit/transcriptPolishing.test.js tests/unit/geminiTranscriptPolishingProvider.test.js
```

Run media device utility unit tests:

```bash
node --test tests/unit/mediaDevices.test.js
```

Run connection failure classification unit tests:

```bash
node --test tests/unit/connectionFailures.test.js
```

Run retry policy unit tests:

```bash
node --test tests/unit/retryPolicy.test.js
```

Run reconnect controller unit tests:

```bash
node --test tests/unit/reconnectController.test.js
```

Run LiveSession failure signal unit tests:

```bash
node --test tests/unit/liveSessionFailureSignal.test.js
```

Run frontend failure UI state mapping unit tests:

```bash
node --test tests/unit/failureUiState.test.js
```

Run session records domain model unit tests:

```bash
node --test tests/unit/sessionRecords.test.js
```

Run session repository unit tests:

```bash
node --test tests/unit/sessionRepository.test.js
```

Run session record lifecycle mapping unit tests:

```bash
node --test tests/unit/sessionRecordLifecycle.test.js
```

Run saved session export unit tests:

```bash
node --test tests/unit/sessionRecordExport.test.js
```

Run Long Meeting checkpoint and reliability unit tests:

```bash
node --test tests/unit/meetingCheckpointService.test.js
node --test tests/unit/segmentSwitchOrchestrator.test.js
```

Current unit coverage:

- Cue UI timecode formatting, sequence sorting, cueId upsert, single partial
  preview rendering, history final-only filtering, and follow-latest threshold

- PCM16 audio conversion and base64 byte conversion
- Linear resampling and PCM chunking
- Transcript update behavior
- Transcript export formatting
- Media device normalization, input constraints, and output-selection capability
  detection
- Connection failure classification, including token expiration readiness
- Retry policy decisions
- Reconnect controller lifecycle, cancellation, generation guard, and execution hook
- LiveSession post-cleanup failure signal integration
- Frontend failure-to-UI-state mapping for manual recovery and controlled
  reconnect, including token expiration recovery
- Session records domain model creation, finalization, transcript item mapping,
  and transcript summary behavior
- Session repository interface and in-memory adapter behavior
- Session record lifecycle mapping helpers for active record creation, final
  transcript append, and finalization
- Saved session export helpers for TXT/SRT/VTT formatting, session-relative
  timing, file naming, and unavailable export states
- Long Meeting accelerated 2+ hour checkpoint scenario coverage, including
  ordered Segment reconstruction, rollover, interrupted recovery, failed Segment
  checkpoint readability, duplicate protection, and ordering checks
- Frontend/backend language allowlist alignment
- Token request validation and token config shape

## Integration Tests

Run integration tests with the test-only Gemini mock loader:

```bash
npm run test:integration
```

Run Long Meeting file-backed vertical integration tests:

```bash
node --loader ./tests/fixtures/mockGoogleGenAiLoader.mjs --test tests/integration/meetingCheckpointVerticalIntegration.test.js
```

The loader intercepts `@google/genai`, so `POST /api/live-token` uses the real
local route handler while Gemini token creation is mocked.

Run the Gemini Live normalized Cue flow integration test:

```bash
node --test tests/integration/liveSubtitleCue.integration.test.js
```

Run Cue persistence and checkpoint identity tests:

```bash
node --test tests/unit/subtitleCuePersistence.test.js
```

This test uses `LiveTranslateSession` with deterministic clock and provider
message mocks to cover partial pairing, boundary events, Stop flush, segment
sequence continuity, and replay de-duplication. Cue persistence uses the
existing Segment checkpoint file and is covered by the Cue persistence tests.

Run Session sharing unit and integration tests:

```bash
node --test tests/unit/sessionShareService.test.js tests/unit/fileSessionShareService.test.js tests/integration/sessionSharing.integration.test.js
```

These tests cover opaque token expiry and revocation, file-backed token
persistence, Viewer-safe payloads, per-Session SSE isolation, monotonic event
IDs, terminal snapshots, and reconnecting to the latest snapshot.

Current integration coverage:

- The live Cue integration path continues to validate normalized partial/final
  Cue state; UI-level Cue rendering uses deterministic test-mode events.

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
- Meeting checkpoint API persistence, Segment recovery, Meeting detail read
  reconstruction, and accelerated 2+ hour Long Meeting reload validation

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

Run the Live Translate E2E flow only:

```bash
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/liveTranslate.spec.js
```

Run the Session sharing Viewer E2E flow only:

```bash
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/sessionSharing.spec.js
```

This flow verifies read-only Viewer rendering, cross-Session content isolation,
and recoverable invalid or expired share-link errors.

The Playwright flow:

- Live Cue rows keep source and translation paired, show session-relative
  timecodes, keep one partial row at the list tail, protect manual scroll
  position, and restore persisted final Cues on session detail reload.
- Stable Cue UI contract selectors include `live-cue-panel`, `cue-list`,
  `cue-final-row`, `cue-partial-row`, `cue-source-text`,
  `cue-translated-text`, `cue-timecode`, and `follow-latest-button`.
- Legacy transcript assertions are retained only for the no-Cue fallback
  fixture; Sessions with Cues are verified through the final Cue list and do
  not require the removed article tabs.
- The Playwright suite includes the manual-scroll follow-latest regression case;
  run the targeted spec after changing live Cue behavior.

- Opens the home page
- Selects a target language
- Clicks `Start`
- Mocks microphone permission and media tracks
- Verifies the UI reaches `Listening`
- Clicks `Stop`
- Verifies the mocked session closes and microphone tracks stop
- Mocks an unexpected close and verifies controlled reconnect for that reason
- Verifies token expiration triggers controlled reconnect with a fresh token and
  Segment recovery checkpoint
- Verifies browser-suspended wake recovery triggers controlled reconnect with a
  fresh token and Segment recovery checkpoint
- Verifies `#live?meetingId=...` reload restores checkpointed transcript content
  and manual resume continues in the next recovered Segment
- Verifies authorization failure and rate-limit UX messages do not trigger
  reconnect
- Verifies manual recovery states keep Start available, hide Stop, preserve
  transcript/export state, and reset transcript on manual Start
- Verifies reconnect failure, retry exhaustion, Stop cancellation, and
  transcript preservation during recovery errors
- Verifies long-meeting Stop resource diagnostics for mocked mic tracks,
  AudioContexts, Live sessions, and cancelled rollover scheduling
- Verifies read-only finalized session history list behavior for empty state,
  stopped sessions, failed sessions, manual restart, token-expiration reconnect,
  and reconnect without duplicate history records
- Verifies read-only inline session detail behavior for saved metadata,
  final-only source and translation transcripts, close behavior, failure
  reasons, and no-transcript empty state
- Verifies saved session detail export controls for TXT/SRT/VTT availability,
  unsupported stream combinations, session switching, and active export state
  separation

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

- `LIVE_SMOKE_TARGET_LANGUAGE`: target language code, defaults to `en`
- `LIVE_SMOKE_TIMEOUT_MS`: connection timeout in milliseconds, defaults to `15000`

CI must not set `ENABLE_REAL_GEMINI_TEST=true` unless the job is explicitly
intended to spend real Gemini API quota.

### Subtitle Cue export (WP5A)

Session detail export tests should use persisted final Cues as the primary
fixture. Verify TXT, SRT, and VTT content from the same sequence-sorted Cue
list, including session-relative timestamps, partial filtering, duplicate and
timeline validation, and export-time wrapping. A Session with no Cues keeps
the legacy transcript export fallback. Do not use DOM layout or Cue UI line
wrapping as export input.
# Recorder sharing validation

Use mocked request contexts to verify Recorder share role migration, lease
claim/heartbeat/release, duplicate claim (`409 recorder_already_active`),
expiry, hash-only grant expiry/revocation, Recorder live-token authorization,
snapshot/audio write authorization, and fence-token rejection. Do not call
Gemini or run a full benchmark.
