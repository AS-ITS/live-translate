# Testing

Live pipeline trace vocabulary: use `TRANSCRIPT_NORMALIZED`, `TURN_ASSIGNED`, `CUE_CREATED`, `CUE_UPDATED`, `CUE_FINALIZED`, `CUE_PUBLISHED`, `SPEECH_ACTIVITY_STARTED`, `SPEECH_ACTIVITY_CONTINUED`, `LOCAL_SILENCE_DETECTED`, and lifecycle reconnect/rollover stages. Legacy `NORMALIZED`, `CUE_STATE`, and `LOCAL_SILENCE_FINALIZE` names are not canonical. `audioTurnId` is authoritative at the audio boundary; `turnKey` belongs to normalized logical turns; `cueId` belongs to Cue state. Diagnostics never use one identity as another's fallback.

## WebRTC 正式流程

最小自動化驗證：

```bash
node --test tests/unit/webrtcSignalingRoute.test.js tests/unit/webrtcSubtitleDataChannel.test.js tests/unit/webrtcSubtitleTransport.test.js tests/unit/viewerLongSessionRecovery.test.js tests/unit/meetingViewerSnapshot.test.js tests/unit/meetingViewerState.test.js tests/unit/meetingViewerRealtime.test.js tests/unit/webrtcPocPage.test.js
npm run build
```

`webrtcSubtitleTransport.test.js` 另覆蓋 persistence 故障域隔離：已開啟的
DataChannel 在 signaling heartbeat 回 `503` 時不得 teardown、不得切換為
`reconnecting`，Cue 2／Cue 3 必須沿用同一 transport generation 繼續發布；雲端
control-plane 恢復後只恢復 heartbeat，不得重複發布已送達的 Cue。

這些測試涵蓋 Viewer code/token 分流、Device `canRecord` 授權邊界、拒絕 expired/revoked/mismatch/stopped、Viewer 禁止 offer/stop、participant heartbeat、8 秒 signaling timeout、暫時 poll 失敗、5 秒 disconnected grace、ICE restart、DataChannel close/error、舊 epoch、6 次重試耗盡、Realtime token refresh 與故障 reconnect timer 隔離、reconnect snapshot/replay、Segment sequence domain、snapshot 503 retry、same-source replay、sidecar 清理與 Cue 去重。跨網路實機仍依 [WebRTC Preview runbook](verification/webrtc-browser-deployment.md) 執行，不得以單元測試替代。

## Vercel Relay PoC verification boundary

The Relay PoC is documentation and operator validation only in this round; it
does not modify production code or enable a paid Vercel/Upstash plan. Keep the
following evidence classes separate:

- **Automated local proof:** run the existing local-device unit/E2E commands
  and `git diff --check`. This proves browser-to-local-device packet
  persistence, ACK/idempotency, reconnect backfill, and stop behavior only.
- **Preview/account proof:** requires a real Vercel Preview deployment, an
  Upstash Redis account/database, configured Preview environment variables,
  and an approved HTTPS/network path. It must exercise the two-hour relay
  matrix in [local-device-poc.md](verification/local-device-poc.md): Function
  expiry, redeploy, Viewer reconnect, and independent relay versus recording
  lifecycle heartbeats.
- **Not proven by this round:** production deployment, paid-plan activation,
  cross-network device reachability, exactly-once Pub/Sub delivery, durable
  subtitle history in Redis, or cloud audio storage/download. Audio download
  remains a future host-authorized range endpoint against the local permanent
  source.

The relay test report must state that Redis Pub/Sub is routing only (not
Streams), the registry has metadata only and no socket references, Redis has
no subtitle history, and a publisher ACK means `PUBLISH` completed—not Viewer
render or durable receipt. Include `requestId`, timeout/retry outcome,
deployment ID, account/region, Viewer count, and the exact source snapshot
used for recovery. Do not put REST tokens, ephemeral tokens, raw audio, or
transcript payloads in the report.

For cost/quotas and the formula for a two-hour meeting at different Viewer
counts, use the operator section in [local-device-poc.md](verification/local-device-poc.md)
and verify live limits at the linked official Vercel and Upstash pricing pages.

## Phase 0 contract evidence

Test the browser as the only OPFS reader, immutable chunk checksums, four
durable pending queues (`cue`, `checkpoint`, `operation`, `audio`), ACK loss
and resend, duplicate idempotency, stale fence/version/hash conflicts, and
the recovery order: operations, dependent checkpoints/Cues, then audio.
Queues must ACK independently so audio failure does not block Cue/checkpoint
delivery and vice versa.

Evidence must separately prove that stopping a Meeting immediately invalidates
Viewer/Recorder shares, while the authenticated host alone can export
TXT/SRT/VTT and download completed audio for 30 minutes. Origin/CORS tests
cover only approved Preview and Production origins.

Existing failures, skipped checks, and environment blockers are non-passing
baseline evidence. Reports must retain the command, result, and blocker; they
must never label a failed or blocked run as `baseline passed`. Phase 1 physical
acceptance is still pending for Mac/Windows microphones, reload/crash queue
recovery, OPFS quota/offline resend, audio loss/recovery, and deployed
Origin/CORS checks.

## Google Workspace accounts

Google OAuth is not automated in the regular E2E suite. Deterministic identity tests cover exact email-domain matching, pending profile auto-activation, missing/update failure rejection, disabled-account rejection, and super-admin role preservation using signed JWT fixtures and mocked Supabase responses.

## Domain auto-activation coverage

Deterministic tests cover transient pending provisioning, trusted `pending -> active`, concurrent disable behavior, `/api/profile` fail-closed responses, removed approval UI/API, Meeting authorization, anonymous Viewer access, and existing active/disabled management. Tests do not call Google OAuth, Gemini, or production APIs.

## CI and cloud validation

Pull requests and pushes to `main` run `.github/workflows/ci.yml` for syntax, build, security/cloud boundary, Issue #33 account permissions, durable worker, and Viewer checks. `.github/workflows/supabase-migrations.yml` starts a local Supabase stack, resets the database, and lints all migrations. It does not connect to a Supabase cloud project.

Vercel's Git integration creates the Preview deployment. `.github/workflows/vercel-preview-check.yml` listens for a successful Vercel Preview deployment and runs the read-only deployment preflight against its URL. It does not deploy a second copy or call Gemini.

## Local staging-equivalent validation

Run staging-equivalent checks against the local Supabase stack and local backend:

```bash
npm run db:start
npm run db:reset
npm run db:lint
npm run test:integration
npm run test:e2e
```

These local tests do not call the Gemini production API. Local Supabase validates migrations, RLS, and the local data flow only; it does not replace confirmation that the production Supabase deployment and connections are configured correctly.

For an additional deployment preflight after starting the local server, run:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 npm run test:deployment-preflight
```

## Issue #35 local RLS matrix

After local Supabase is running, execute the real PostgREST/Auth allow/deny matrix:

```bash
eval "$(supabase status -o env)"
RUN_SUPABASE_RLS_TESTS=true \
SUPABASE_TEST_URL="$API_URL" \
SUPABASE_TEST_PUBLISHABLE_KEY="$ANON_KEY" \
SUPABASE_TEST_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
npm run test:integration:supabase-rls
```

The test creates disposable local users and removes them with the service-role admin endpoint. It rejects non-local URLs unless `ALLOW_REMOTE_RLS_TESTS=true`; it never prints credentials or transcript data.

## Manual cloud validation

Cloud checks are split by deployment risk:

- Local E2E keeps its existing local backend and Vite web servers.
- Staging cloud smoke is not enabled in GitHub Actions; use the local staging-equivalent validation above. The retained `tests/cloud/stagingSmoke.spec.js` is an optional asset for a future cloud check.
- Production preflight is unauthenticated and read-only. It verifies health, readiness, private API auth, metrics auth, and worker auth. It does not create data or process the queue.

## Issue #37 Phase 2 Viewer pagination

The deterministic Viewer pagination checks cover cursor validation, latest-100
windowing, older-page merging, and the bounded Supabase joined Cue query:

```bash
node --test tests/unit/meetingViewerPagination.test.js \
  tests/unit/supabaseMeetingViewerPage.test.js
```

## Issue #37 Phase 1 lifecycle v2

The deterministic unit checks cover HTTP forwarding/conflict mapping, API
client payloads, domain mapping, and migration invariants:

```bash
node --test tests/unit/meetingLifecycleHttpApi.test.js \
  tests/unit/meetingLifecycleMigration.test.js \
  tests/unit/meetingLifecycleWriteFence.test.js \
  tests/unit/meetingLifecycleV2TranscriptBoundary.test.js \
  tests/unit/meetingAudioStorage.test.js \
  tests/unit/supabaseMeetingAudioService.test.js \
  tests/unit/workerEndpoint.test.js \
  tests/unit/meetingCheckpointApiClient.test.js \
  tests/unit/meetingDomain.test.js
```

This focused suite covers the 15-minute CRON expiration RPC, 30-minute
retention-claim contract, terminal-write rejection, v2 transcript boundary,
upload-start fencing, and pre-purge audio completion/failure. It does not run a
purge deletion job, call Gemini, or contact a remote Supabase project.

With local Supabase running and its environment loaded, the focused integration
test verifies concurrent start idempotency and competing rollover/stop behavior:

```bash
RUN_SUPABASE_LIFECYCLE_TESTS=true \
node --test tests/integration/meetingLifecycleV2.integration.test.js
```

Neither command calls Gemini or a remote Supabase project.

## Issue #37 Phase 0 recording diagnostics

Staging performance runs may opt in to the redacted browser diagnostics API by
building the frontend with the private Vercel variable
`LIVE_TRANSLATE_DIAGNOSTICS=true`. Vite injects only a boolean build constant;
the environment variable itself is never read by browser code. This flag
exposes numeric recorder/upload metrics and the sanitized LiveSession snapshot;
it does not enable verbose Live event logging or expose transcript text, tokens,
signed URLs, or audio payloads. Production must leave the flag unset.

Run three paired five-minute recordings in both Chrome on macOS and Safari on
macOS. Each pair uses the same staging Meeting, microphone, network condition,
and short speech script: one recording-off control, followed by one
recording-on treatment. Include one pause/resume treatment pair and wait for
the final audio artifact to reach a terminal status before collecting the
snapshot.

At the end of each run, collect:

- `window.__liveTranslateRecordingDebug.getSnapshot()`
- `window.__liveTranslateDebug.getSnapshot()`
- browser, OS, browser version, commit/build identifier, and run mode

Compare treatment runs with their control. Treat two or more treatment runs
with a callback-gap p95 increase above 20%, a new 500ms-or-longer gap, or any
audio loss/recovery failure as evidence for the OPFS gate. The default
15-minute segment rollover is not exercised by a five-minute run; rollover
upload contention therefore remains explicitly unverified.

```bash
SMOKE_BASE_URL=https://production.example.com npm run test:cloud:preflight
```

For staging authenticated reload coverage, provide a non-production staging URL, matching Supabase URL, and disposable owner token. The browser test injects the Supabase session directly and never automates Google OAuth:

```bash
CLOUD_BASE_URL=https://staging.example.com \
CLOUD_SUPABASE_URL=https://staging-project.supabase.co \
CLOUD_TEST_ACCESS_TOKEN="$STAGING_TEST_ACCESS_TOKEN" \
npm run test:e2e:cloud -- tests/cloud/issue35Reload.spec.js tests/cloud/stagingSmoke.spec.js tests/cloud/issue35BrowserReload.spec.js
```

Run the no-Gemini Storage/export lifecycle separately when staging worker and private Storage evidence are available:

```bash
npm run test:e2e:cloud -- tests/cloud/issue35StorageLifecycle.spec.js
```

The manual workflow `.github/workflows/cloud-validation.yml` is production-only and requires `PRODUCTION_BASE_URL`. It does not require staging secrets. Real Gemini smoke remains a separate explicit opt-in.

## Account permissions

Account role management uses the following deterministic service, HTTP, migration, domain-activation, and browser checks:

```bash
node --test tests/unit/adminService.test.js tests/unit/auditLogService.test.js tests/unit/accountRoleHttpApi.test.js tests/unit/accountRoleManagementMigration.test.js tests/unit/domainAutoActivationMigration.test.js tests/unit/profileService.test.js
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/accountRoleManagement.spec.js
```

After local Supabase migrations are applied, run the real concurrent cross-demotion regression:

```bash
RUN_SUPABASE_ROLE_TESTS=true node --test tests/integration/accountRoleConcurrency.integration.test.js
```

It starts two active `super_admin` profiles, concurrently attempts A→B and B→A demotions, and verifies exactly one succeeds, at least one administrator remains, the loser receives `auth_forbidden`, and only the successful audit event exists.

Coverage includes actor/resource-owner separation, disabled-profile refresh, member recording scope, owner-only private resources, atomic transfer rollback, credential exclusion, and safe audit failures. Local DB validation uses `supabase migration up --local` followed by `supabase db lint --local`.

Run the deterministic Issue #33 coverage without production Supabase or Gemini:

```bash
node --test tests/unit/meetingMembership.test.js tests/unit/adminService.test.js tests/unit/auditLogService.test.js tests/unit/profileService.test.js tests/unit/profileHttpApi.test.js tests/unit/dualWriteTranslationExecutionQueue.test.js tests/integration/accountPermissions.integration.test.js
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/accountPermissions.spec.js
```

The account E2E seeds a deterministic Supabase session in browser storage and mocks every account API response.

P1 identity tests use signed deterministic JWT fixtures and never call Google,
Gemini, or Supabase production services. Validate the identity slice with:

```bash
node --test tests/unit/accessControlSupabase.test.js tests/unit/accessControl.test.js tests/unit/accessToken.test.js
npm run build
npm run db:lint
```

## Realtime subtitle pipeline strategy (P0 and P1 implemented)

The four-stage pipeline is documented as a deterministic, mockable boundary.
P0 currently implements the voice transcription and finalized Cue stages;
initial Flash translation and refinement run asynchronously after finalized Cue persistence:

```text
finalized source Cue → initial Flash translation → Flash refinement
```

Interim events are UI-only. They must never appear in persistence, downstream
execution input, refinement context, export, history, or summary fixtures.
Real Gemini smoke tests are opt-in only (`ENABLE_REAL_GEMINI_TEST=true`); unit,
integration, and E2E coverage must use fixtures or provider mocks by default.

Focused coverage:

- Voice: PCM conversion, AudioContext recovery, AudioWorklet-compatible capture,
  playback failure isolation, output sink selection, and active microphone replacement.

- Unit: interim/finalized separation, immutable Cue fields, same-Cue updates,
  effective-translation fallback, duplicate handling, and stale-event rejection.
- Integration: `final_cue.persisted` through initial translation and refinement,
  including structured-output validation, failure isolation, idempotency, and
  version fencing.
- E2E: show the initial translation first, then update the same visible Cue row
  in place when refinement completes.
- Lifecycle: start/pre-roll, first sentence, pause/resume, reconnect, rollover,
  terminal flush, and no loss or late overwrite of finalized Cues.

This project separates deterministic tests from real Gemini API validation. Unit,
integration, and E2E tests must not call the real Gemini API. The live smoke test
is opt-in only.

Issue #29 Milestone 1 coverage includes Meeting home route behavior, status
mapping, search/filter rules, and Meeting Management E2E flows. Later coverage
will add independent Viewer snapshot/SSE, Cue deduplication, ordering,
and reconnect merge. The Viewer latency SLA will use a local deterministic
synthetic broadcaster test; it must not call Gemini or overwrite full benchmark
reports. See [Meeting Center and Live Viewer](features/meeting-center-live-viewer.md).

Milestone 5 realtime coverage includes Meeting broadcaster sequencing and
bounded replay, Cue publish HTTP authorization, Meeting Viewer SSE delivery,
snapshot gap recovery, duplicate/refinement merge, and deterministic latency
measurements.

Issue #29 UI consolidation coverage includes canonical independent Setting,
Live, History Detail, and Viewer routes, plus global/private glossary
boundaries.

Global glossary UI coverage includes card-grid filtering, category counts,
multi-language editing, enabled-state and delete batch actions, and the side drawer. The
global page manages only entries shared by all Meetings; private entries remain
covered by the Meeting glossary drawer tests.

Global glossary import coverage includes CSV/JSON parsing, row validation,
preview conflict detection, selected-row imports that skip invalid rows,
revision conflicts, and atomic all-or-nothing commits.

Meeting glossary import coverage includes private CSV/JSON/XLSX preview,
duplicate and conflict handling, staged form merging, and persistence through
the existing Meeting settings save request.

Run the focused realtime tests:

```bash
node --test tests/unit/meetingEventBroadcaster.test.js tests/unit/meetingViewerState.test.js tests/unit/meetingCheckpointHttpApi.test.js
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/sessionSharing.spec.js
```

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

Run the focused Gemini credential boundary tests:

```bash
node --test tests/integration/liveTokenRoute.test.js tests/unit/liveTokenSecurity.test.js tests/unit/geminiCredentialHttpApi.test.js
```

These tests verify request-scoped key handling, Viewer rejection, expired JWT
rejection, logout cleanup, `no-store` responses, and that keys do not enter
persistent storage or logs. The legacy profile credential test is retained
only while its removal is being completed and must not be used as Live flow
evidence.

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
- Missing request-scoped `geminiApiKey`
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
and recoverable invalid or expired share-link errors through the independent
`#viewer?code=<shortCode>` route.

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
The direct shell entrypoint requires `GEMINI_API_KEY` and enables the real API
call automatically.

The backend uses `v1beta` when provisioning an ephemeral token. The browser and
smoke-test Live clients use `v1alpha` because the current `@google/genai` SDK
requires `v1alpha` for ephemeral-token connections. The SDK may still print its
experimental ephemeral-token warning; that warning is expected.

Direct two-hour run:

```bash
./scripts/live-meeting-smoke.sh
```

Equivalent npm command:

```bash
npm run test:live-smoke
```

For a safe no-op check that never calls Gemini, run the Node implementation
directly without `ENABLE_REAL_GEMINI_TEST=true`:

```bash
node scripts/live-smoke-test.js
```

Optional environment variables:

- `LIVE_SMOKE_TARGET_LANGUAGE`: target language code, defaults to `en`
- `LIVE_SMOKE_TIMEOUT_MS`: connection timeout in milliseconds, defaults to `15000`
- `LIVE_SMOKE_DURATION_MS`: run duration, defaults to 2 hours (`7200000`)
- `LIVE_SMOKE_MAX_TOKEN_REQUESTS`: maximum token requests, defaults to `20`
- `LIVE_SMOKE_SPEECH_TEXT`: macOS `say` input text
- `LIVE_SMOKE_SPEECH_INTERVAL_MS`: interval between generated speech samples,
  defaults to `10000`
- `LIVE_SMOKE_REQUIRE_RECONNECT`: require at least one provider reconnect;
  defaults to true for runs of 10 minutes or longer and false for shorter runs

The long-meeting smoke test requires macOS `/usr/bin/say` and
`/usr/bin/afconvert`. It generates a short source-language speech sample,
converts it to mono 16-bit PCM at 16kHz, and loops it through Gemini Live for
the configured duration. Each generated speech sample ends with an explicit
`audioStreamEnd` signal so final input transcription does not depend only on
provider voice-activity detection. Provider reconnects reuse the
session-resumption handle; token refresh is counted and must stay within the
configured limit. Short diagnostic runs do not require a provider reconnect;
the default two-hour run does.
GoAway is an expected provider WebSocket lifecycle event; the test reports its
count separately from reconnect failures. The test prints only non-sensitive counters and is not intended for CI.
During execution it prints startup stages, provider connection/reconnect events,
speech sample sends, and a non-sensitive heartbeat every 60 seconds. The
default run lasts two hours; use `LIVE_SMOKE_DURATION_MS` for a shorter manual
check. At the end of every run it prints a Chinese summary with the start time,
end time, actual duration, provider connection/reconnect counts, token requests,
GoAway count, final transcript count, and sanitized abnormal events. The JSON
summary that follows keeps English field names for machine processing.

Two-hour validation:

```bash
./scripts/live-meeting-smoke.sh
```

CI must not set `ENABLE_REAL_GEMINI_TEST=true` unless the job is explicitly
intended to spend real Gemini API quota.

### Subtitle Cue export (WP5A)

Server export tests should use persisted Final Cues as the primary fixture.
Verify TXT, SRT, and VTT content from the same sequence-sorted Cue list,
including partial filtering, duplicate timeline validation, source-hash
idempotency, artifact retry, and signed URL readiness. P8 UI tests must also
verify that Supabase cloud mode uses the asynchronous export panel while local
mode shows the unavailable message and never creates a browser transcript
download. Do not use DOM layout or Cue UI line wrapping as export input.
# Recorder sharing validation

Use mocked request contexts to verify Recorder share role migration, lease
claim/heartbeat/release, duplicate claim (`409 recorder_already_active`),
expiry, hash-only grant expiry/revocation, Recorder live-token authorization,
snapshot/audio write authorization, and fence-token rejection. Do not call
Gemini or run a full benchmark.
## Issue #35 Phase 1–2 checks

Run the focused boundary checks before broader API tests:

```bash
node --test \
  tests/unit/cloudEnvironment.test.js \
  tests/unit/supabaseRestClient.test.js \
  tests/unit/accessToken.test.js \
  tests/unit/supabaseRepositoryOwnership.test.js \
  tests/unit/deploymentPreflight.test.js
```

These tests assert safe environment diagnostics, user JWT versus service-role headers, expiring-session refresh, and owner-scope repository behavior. Cloud smoke still requires a fresh Supabase access token and must not print it.

Readiness coverage also verifies the core persistence tables, translation metric/queue RPCs, and private `meeting-audio` Storage bucket through the service-role client. Run the local migration checks before relying on readiness results:

```bash
supabase db lint
supabase migration up --include-all
```

The production API must fail closed with `503 cloud_capability_unavailable` when the server-side Supabase contract is invalid; this guard is separate from browser-safe client configuration and must not be bypassed by file-backed fallback repositories.
P7 cloud export lifecycle coverage, without Gemini or production Storage:

```bash
node --test tests/unit/exportArtifactService.test.js tests/unit/exportWorker.test.js tests/unit/meetingExportSource.test.js tests/unit/workerEndpoint.test.js
```

Migration validation must include the private `meeting-exports` bucket,
owner-only Storage policies, `export_artifacts` constraints, and `export_jobs`:

```bash
npm run db:lint
```

Issue #37 Phase 4 retention, compatibility, and observability checks:

```bash
node --test \
  tests/unit/meetingRetention.test.js \
  tests/unit/meetingContentExpiry.test.js \
  tests/unit/supabaseLegacyWriteCompatibility.test.js \
  tests/unit/meetingPurgeWorker.test.js \
  tests/unit/supabaseMeetingAudioService.test.js \
  tests/unit/meetingReadQueryService.test.js \
  tests/unit/observability.test.js
```

These tests verify the 30-minute deadline read model, stable `410` expiry
contract, v1 read compatibility with v2 legacy-column write suppression, and
best-effort purge metrics. They do not call Gemini or remote Supabase.

## Spoken turn trace and real-microphone acceptance

Automated coverage must use the mock Gemini adapter. For a local or Vercel
Preview runtime, set server-only `LIVE_PIPELINE_TRACE_ENABLED=true`, redeploy or
restart, then inspect a turn with:

```js
const trace = window.__liveTranslateDebug.getPipelineTrace()
window.__liveTranslateDebug.getTurnTrace(trace.at(-1)?.audioTurnId)
const exportedTrace = window.__liveTranslateDebug.exportPipelineTrace()
copy(exportedTrace)
```

Local terminal replay entries include bounded `originEventId`,
`terminalStatus`, `terminalReason`, `localFinalize`, and
`isTerminalReplay` fields. Use these fields to distinguish a local-silence
flush from a new provider transcript; they never contain API keys, tokens, or
audio.

The endpoint exposes only `{ livePipelineTraceEnabled: true }`; the trace stays
in browser memory and resets on reload. Every entry has a bounded
`traceSequence`; normalized and Cue transitions keep their provider
`eventSequence`; Cue updates include bounded before/after source and translation
text. `exportPipelineTrace()` returns the same bounded, secret-free entries as
formatted JSON for saving from Preview DevTools. For each spoken turn, verify the trace
reaches `PCM_CAPTURED`, `PCM_SENT`,
`PROVIDER_EVENT`, `TRANSCRIPT_NORMALIZED`, `TURN_ASSIGNED`, one of `CUE_CREATED`
or `CUE_UPDATED`, and `REACT_RENDER`. Speech activity emits
`SPEECH_ACTIVITY_STARTED` and `SPEECH_ACTIVITY_CONTINUED`; local silence emits
`LOCAL_SILENCE_DETECTED` with non-empty `audioTurnId`; correlate later
`TURN_ASSIGNED` and Cue stages by that same `audioTurnId`; reconnect and segment replacement emit lifecycle stages.
A `drop` entry must include `dropReason`. Also inspect the subtitle DOM for missing or duplicate
Cue rows and the browser console for runtime errors.

Real browser and real microphone acceptance remains manual and must cover:

1. One sentence and two consecutive sentences (two separate Cues).
2. Five rapid sentences and sentences separated by 2–3 seconds.
3. One continuous 20–30 second sentence with partial updates and one final Cue.
4. Pause/resume followed immediately by speech.
5. Provider reconnect/rollover followed immediately by speech.

Mocks, unit tests, Playwright, and DOM inspection cannot mark these real-device
cases as passing. Each case passes only after the spoken text is confirmed
through PCM, provider, normalized transcript, Cue state, React render, and the
visible subtitle.
# Recording retention and completed Meeting deletion

Current policy (2026-10-07): expiry is an authorization boundary only. Targeted
tests must verify ordinary-user hiding, Viewer `410 meeting_content_expired`,
active `super_admin` pending-delete visibility, and explicit canonical deletion.
Legacy cleanup-worker tests cover dormant compatibility code; no GET or timer
may invoke that worker.

Run focused tests with `node --test tests/unit/localMeetingRetention.test.js tests/unit/supabaseMeetingCleanupWorker.test.js tests/unit/meetingDeletionService.test.js tests/unit/meetingDeletionHttpApi.test.js tests/unit/meetingReadQueryService.test.js`.
With local Supabase running and migrations applied, execute
`psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f tests/integration/recording_retention_local.sql`
and the equivalent `meeting_deletion_local.sql`. Both fixtures roll back;
they do not call Production, wait 30 minutes, or invoke Gemini. The SQL test
checks direct RLS/Storage visibility, immutable deadlines, late writes,
authorization, persisted cleanup throttling, and bounded continuation.
Browser UI regression: `playwright test tests/e2e/meetingManagementDelete.spec.js --config tests/e2e/playwright.config.js`.
