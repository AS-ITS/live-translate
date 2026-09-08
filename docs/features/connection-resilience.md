# Connection Resilience

## Capability Overview

Connection Resilience is a Phase 2 capability that improves session reliability
when a live translation session is interrupted by recoverable connection,
token, provider, browser, or audio-device failures.

This capability builds on
[Session Lifecycle Management](session-lifecycle.md). Session Lifecycle owns the
session state model, allowed transitions, close reasons, cleanup policy, UI
mapping, and lifecycle rules. Connection Resilience owns retry, reconnect,
refresh, timeout, health monitoring, recovery UX, and failure-handling policy on
top of that lifecycle model.

This capability does not change the browser-to-Gemini Live API architecture.
The browser continues to connect directly to Gemini Live API using ephemeral
tokens issued by the backend. The backend continues to own `GEMINI_API_KEY` and
must not proxy live audio.

## Failure Classification

Connection failures should be classified into stable internal categories before
recovery decisions are made.

Status: Slice 1 implemented.

Implementation files:

- `src/lib/connectionFailures.js`
- `tests/unit/connectionFailures.test.js`

This slice only classifies failures. It does not implement Auto Reconnect,
Token Refresh, retry orchestration, or recovery UI behavior.

| Category | Reasons | Recovery Direction |
| --- | --- | --- |
| Permission | `permission_denied`, `permission_revoked` | Stop and ask for user action. |
| Token | `token_request_failed`, `token_expired`, `auth_failed`, `rate_limited` | Retry only when transient; never bypass auth or rate limits. |
| Network | `network_offline`, `network_timeout`, `network_interrupted` | Pause while offline; reconnect when connectivity returns. |
| Provider | `provider_unavailable`, `provider_error`, `live_connect_failed`, `unexpected_close` | Retry only when the error appears transient. |
| Browser Runtime | `browser_suspended`, `audio_context_lost`, `page_hidden_timeout` | Attempt recovery after resume when resources can be rebuilt. |
| Audio Device | `microphone_disconnected`, `selected_device_missing`, `audio_capture_failed` | Fall back to default device when safe; otherwise ask for user action. |
| User Intent | `user_stop`, `page_unload` | Do not recover automatically. |
| Cleanup | `cleanup_failed` | Stop automatic recovery to avoid duplicate resources. |
| Unknown | `unknown_error` | Use limited retry, then stop with a user-visible error. |

### Token Expiration Classification / UX Readiness

Status: Implemented.

Implementation files:

- `src/lib/connectionFailures.js`
- `src/lib/liveSession.js`
- `tests/unit/connectionFailures.test.js`

This slice classifies explicit `token_expired` reasons or codes and Live
error/close payloads that clearly indicate token or session expiration. The
classification is recoverable, requires a fresh token, does not require user
action, and exposes only a safe user-facing message.

This slice prepares UX messaging and recovery metadata. Long Meeting WP4 now
uses `token_expired` as a controlled reconnect signal with a fresh token and
Segment recovery checkpoint. Replacement Live sessions always obtain a fresh
single-use token.

Current token status:

- `token_expired` classification is complete.
- `token_expired` reconnect is enabled through the controlled reconnect path.
- Provider reconnects reuse the latest session-resumption handle and request a
  fresh single-use token for every replacement Live session.

GoAway is an expected provider lifecycle event, not an abnormal failure. The
client uses its `timeLeft` value to schedule one reconnect, passes the latest
session-resumption handle, and requests a fresh single-use token for the
replacement Live session. Only reconnect failure is reported as abnormal.

## Recovery Matrix

| Failure | Can Recover? | Requires User Action? | Retry? | Reconnect? | Reset Session? |
| --- | --- | --- | --- | --- | --- |
| `permission_denied` | No | Yes | No | No | Yes |
| `permission_revoked` | No | Yes | No | No | Yes |
| `token_request_failed` | Yes, if transient | No | Yes | Yes, with fresh token | No |
| `token_expired` | Yes | No | Yes | Yes, with fresh token | No |
| `auth_failed` | No | Yes or operator action | No | No | Yes |
| `rate_limited` | Later only | Maybe | Delayed only | No immediate reconnect | No |
| `live_connect_failed` | Yes | No | Yes | Yes | No |
| `unexpected_close` | Yes | No | Yes | Yes | No |
| `provider_error` | Maybe | Maybe | Limited | Maybe | If unrecoverable |
| `network_offline` | Yes after online | No | Wait for online | Yes | No |
| `network_timeout` | Yes | No | Yes | Yes | No |
| `browser_suspended` | Maybe | Maybe | Yes after resume | Yes | No |
| `audio_context_lost` | Maybe | Maybe | Yes | Yes | No |
| `microphone_disconnected` | Maybe | Maybe | If fallback is available | Yes | No |
| `selected_device_missing` | Yes | No | Yes with default device | Yes | No |
| `audio_capture_failed` | Maybe | Maybe | Limited | Maybe | If repeated |
| `cleanup_failed` | No | Maybe | No | No | Yes |
| `user_stop` | No | No | No | No | No |
| `page_unload` | No | No | No | No | No |
| `unknown_error` | Maybe | Maybe | Limited | Maybe | If repeated |

## Retry Strategy

Retry must be bounded, observable, and cancelable.

Status: Slice 2 implemented.

Implementation files:

- `src/lib/retryPolicy.js`
- `tests/unit/retryPolicy.test.js`

This slice only decides retry timing and limits from an existing failure
classification. It does not implement Auto Reconnect, Token Refresh, or
recovery UI behavior.

- Use exponential backoff with jitter.
- Start around `500ms` to `1000ms`.
- Cap per-attempt delay around `8s` to `10s`.
- Allow up to `3` automatic reconnect attempts per active session.
- Stop automatic recovery after about `30s` total recovery time.
- Stop retry immediately for user stop, permission denial, auth failure,
  cleanup failure, and repeated audio capture failure.
- Pause retry while the browser is offline.
- Resume retry only after connectivity returns and the session is still
  recoverable.

Retry must never loop indefinitely or silently create multiple active sessions.

Navigation away from an active Live workspace is not a recoverable connection
failure. The frontend must classify it as intentional shutdown, cancel pending
reconnect work, perform the normal stop/checkpoint cleanup once, and only then
complete the requested route change. Paused Sessions may remain paused while
the user visits Settings or Management; switching to another Meeting remains
blocked until the paused Session is ended.

## Reconnect Controller Skeleton

Status: Slice 3A implemented.

Implementation files:

- `src/lib/reconnectController.js`
- `tests/unit/reconnectController.test.js`

This slice adds a testable orchestration skeleton for reconnect lifecycle state,
retry state, cancellation, generation protection, and cleanup ordering. It does
not open a Gemini Live session, request a token, change UI state, or enable Auto
Reconnect.

Auto Reconnect, Token Refresh, and Recovery UI remain not implemented.

## LiveSession Failure Signal Integration

Status: Slice 3B implemented.

Implementation files:

- `src/lib/liveSession.js`
- `src/main.jsx`
- `tests/unit/liveSessionFailureSignal.test.js`

This slice emits classifiable failure signals after Live session error or
unexpected-close cleanup completes. The UI entrypoint classifies the signal and
asks the Reconnect Controller skeleton for a retry scheduling decision.

This slice does not rebuild Live sessions, request fresh tokens, add a
SessionFactory, change the Gemini Live session flow, or enable Auto Reconnect.

Auto Reconnect, Token Refresh, SessionFactory, and Recovery UI remain not
implemented.

## Reconnect Execution Hook Skeleton

Status: Slice 3C-A implemented.

Implementation files:

- `src/lib/reconnectController.js`
- `tests/unit/reconnectController.test.js`

This slice lets the Reconnect Controller call an injected `executeReconnect`
hook after a scheduled retry delay when the generation is still current and the
controller has not been cancelled. The hook receives the failure classification,
retry decision, and generation id.

This hook is execution infrastructure only. It does not create a
`LiveTranslateSession`, request tokens, add a SessionFactory, modify UI state, or
enable real Auto Reconnect.

Real Auto Reconnect, LiveSession creation, Token Refresh, SessionFactory, and
Recovery UI remain not implemented.

## Controlled Reconnect for Unexpected Close

Status: Slice 3C-B implemented.

Implementation files:

- `src/main.jsx`
- `tests/e2e/liveTranslate.spec.js`

This slice wires the Reconnect Controller execution hook to a controlled
frontend adapter path. After Live session cleanup and retry delay, the adapter
flushes the current Meeting Segment checkpoint, recovers the Segment through the
backend recovery API, and creates a replacement `LiveTranslateSession`; the
session start path naturally requests a fresh ephemeral token through the
existing `/api/live-token` flow.

This slice preserves current transcript state, export controls, selected input
device, target language, and echo-target-language settings during reconnect.
Stop remains available during reconnect and cancels pending or in-progress
replacement startup.

Controlled reconnect is enabled for `unexpected_close`, `token_expired`, and
selected transient provider/network/browser failure classifications. Offline
pause/resume and microphone-disconnect recovery are also enabled. Proactive
token refresh and a separate SessionFactory remain not implemented.

When the browser goes offline, the active Live session is cleaned up once and
the current reconnect decision is held without starting a replacement. The
decision resumes after the browser reports `online`. User Stop cancels the
held recovery. When an input track ends, the next replacement session retries
with the browser default microphone if a selected device is no longer present;
if capture still fails, recovery ends with a user-visible microphone error.

## Retry Exhaustion and Failure UX Hardening

Status: Implemented.

Implementation files:

- `src/main.jsx`
- `tests/e2e/liveTranslate.spec.js`

This slice hardens the user-visible reconnect failure path for the controlled
reconnect scope. Reconnecting state now has a
clear user-visible message, reconnect startup failure shows a safe manual-retry
error, retry exhaustion shows a distinct exhausted-retry message, stale
callbacks are guarded by reconnect generation checks, and transcript/export
state remains available after reconnect failure.

Token refresh is replacement-session aware: every provider reconnect requests a
fresh ephemeral token because the token is single-use for starting a Live
session. The latest session-resumption handle is reused to preserve context.

## Reload Resume for Long Meetings

Status: Implemented.

Implementation files:

- `src/main.jsx`
- `src/lib/meetingCheckpointApiClient.js`
- `tests/e2e/liveTranslate.spec.js`

Opening the live page with `#live?meetingId=...` loads the Meeting's ordered
Segments, reads Segment checkpoints, restores confirmed source and translation
content into the live transcript panels, and shows a manual resume action. The
manual resume path recovers the latest active Segment as interrupted, creates the
next active Segment with a fresh Live session association, starts a replacement
Live session through the existing `/api/live-token` flow, and keeps restored
content in the final Session snapshot.

This path does not auto-start the microphone on page load. Offline pause/resume
and device-disconnect recovery are handled only during an active recovery
lifecycle.

## Terminal Disconnect Meeting Recovery

Status: Implemented.

When automatic reconnect is exhausted or a non-recoverable live failure ends an
active Meeting, the frontend flushes the current checkpoint and uses the
recovery API to mark the current Segment and Meeting as `interrupted`. A new
`created` Segment is prepared without a placeholder Live Session. The Meeting
Management and live routes accept interrupted Meetings, and explicit resume
starts that Segment with a fresh Live Session and ephemeral token.

This path does not automatically request microphone access after failure. It is
idempotent and preserves confirmed transcript content for later resume.

## Token Expiration UX Display Path

Status: Implemented.

Implementation files:

- `src/main.jsx`
- `tests/e2e/liveTranslate.spec.js`

This slice displays stable, user-facing behavior when the frontend receives
classified `token_expired`, `auth_failed`, or `rate_limited` connection
failures. `token_expired` enters the controlled reconnect path and keeps
transcript/export state available. `auth_failed` and `rate_limited` move to the
manual error display path.

This slice does not bypass auth or rate limits and does not add proactive token
refresh. Replacement Live sessions still request fresh ephemeral tokens through
the existing `/api/live-token` flow.

## Frontend Failure-State Mapping Unit Coverage

Status: Implemented.

Implementation files:

- `src/lib/failureUiState.js`
- `tests/unit/failureUiState.test.js`

This slice covers the frontend mapping from classified connection failures to
UI state metadata. It keeps manual-recovery failures distinct from the
controlled reconnect path:

- `token_expired` maps to the controlled reconnect path.
- `auth_failed` maps to the manual error path and does not reconnect.
- `rate_limited` maps to the manual error path and does not reconnect.
- `unexpected_close` and transient provider/network/browser failures map to the
  controlled reconnect path.

This unit coverage documents and protects the current frontend boundary. It
does not request fresh tokens for manual-recovery failures outside the normal
provider-session expiry flow.

## Manual Recovery UX Polish

Status: Implemented.

Implementation files:

- `src/main.jsx`
- `tests/e2e/liveTranslate.spec.js`

This slice clarifies that `auth_failed` and `rate_limited` states require
manual recovery. The UI shows direct next-step messages asking the user to check
access or wait and try again. In these states, the Start button is available,
the Stop button is hidden, and existing transcript/export state is kept
available until the user manually starts a new session.

Manual Start continues through the existing start flow and resets transcript
state. Token refresh remains limited to the existing provider reconnect flow.

## Timeout Strategy

Timeouts should reuse current boundaries unless implementation evidence shows a
need to change them.

- Token request timeout: keep the existing `10s` behavior.
- Live connect timeout: keep the existing `15s` behavior.
- Recovery window: target about `30s` total automatic recovery time.
- Offline waiting: pause the retry window while offline, but do not hide the
  offline state from the user.
- Cleanup timeout: reconnect must not start until cleanup has completed or
  failed in a controlled way.

Timeout failures should be classified before deciding whether to retry,
reconnect, or stop.

## Token Refresh Strategy

Status: Not implemented.

Use reactive token refresh first.

- Do not reuse old ephemeral tokens for reconnect.
- Request a fresh token through the existing `POST /api/live-token` endpoint
  before each reconnect attempt that opens a new Gemini Live session.
- Keep the backend-owned `GEMINI_API_KEY` and existing token validation flow
  unchanged.
- Do not introduce frontend access to long-lived credentials.
- Do not add proactive refresh until Gemini Live SDK behavior and token/session
  semantics are confirmed.

Reactive refresh should be triggered by recoverable token/session expiration,
unexpected close that requires a new Live session, or a failed session that must
be rebuilt from a clean state.

## Auto Reconnect Strategy

Status: Not implemented.

Auto reconnect should rebuild the live session from a clean lifecycle boundary.

- Classify the failure.
- Confirm the failure is recoverable.
- Run lifecycle cleanup first.
- Preserve existing transcript state unless the user explicitly resets.
- Request a fresh ephemeral token.
- Open a new Gemini Live session.
- Rebuild microphone capture and audio playback resources.
- Return to `listening` only after the new Live session is ready.
- Move to `error` or `expired` when retry limits are reached or recovery is not
  safe.

User stop must cancel any pending reconnect.

## Connection Health Monitoring

Connection health monitoring should provide recovery signals without becoming a
production observability system.

Candidate frontend signals:

- Browser `online` and `offline` events.
- Live session close and error callbacks.
- Token request timeout.
- Live connect timeout.
- Last successful Live message time.
- AudioContext state.
- Microphone track ended or muted events.
- Page visibility or browser resume signals.

Health signals should be converted into the failure classification model before
recovery action is selected.

## Recovery UX

Recovery UX should keep the existing Start / Stop flow recognizable.

- Show `reconnecting` while automatic recovery is active.
- Show retry attempt information only when useful.
- Show `offline` as a recovery pause, not as a separate permanent failure.
- Show `expired` when the session cannot continue without refresh or restart.
- Keep Stop available during reconnect so users can cancel recovery.
- Keep Start disabled while reconnect is active.
- Preserve visible transcript content during recovery attempts.
- Show the final error only after retry is exhausted or recovery is unsafe.

Avoid adding many independent top-level UI states when lifecycle state plus
recovery metadata can represent the condition.

## Testing Strategy

Automated tests must use mocks or deterministic helpers and must not call the
real Gemini API.

Unit tests:

- Failure classification mapping.
- Recoverable versus non-recoverable decisions.
- Backoff calculation with fake timers.
- Retry limit and recovery window enforcement.
- Token refresh decision rules.
- Stop-cancels-reconnect behavior.

Integration tests:

- Repeated `POST /api/live-token` requests under normal reconnect count.
- Rate limit still blocks excessive token requests.
- Auth, origin, and structured error responses remain unchanged.
- Provider token creation failures remain safe and stable.

E2E tests:

- Mock unexpected Live close and verify reconnect UI.
- Mock reconnect success and verify return to `listening`.
- Mock retry exhaustion and verify error UI.
- Mock offline/online and verify retry pauses and resumes.
- Mock selected microphone disappearance and verify fallback or user-visible
  failure.
- Verify transcript content remains visible across reconnect attempts.

Manual checks:

- Microphone permission denied or revoked.
- Network offline and online.
- Browser tab sleep and wake.
- Microphone unplug and replug.
- Stop during reconnect.
- Repeated start and stop after failed reconnect.

## Risks

High:

- Duplicate audio streams if cleanup does not complete before reconnect.
- Reusing expired or single-use tokens incorrectly.
- Retry loops causing rate limit failures or unexpected API usage.
- Accidentally changing the Gemini Live session flow.

Medium:

- UI state complexity around reconnecting, offline, expired, and failed states.
- Browser differences for suspend/resume and device disconnect behavior.
- Provider close and error payloads may not be stable enough for precise
  classification.
- Rate limit tuning may be needed for legitimate reconnect attempts.

Low:

- Additional unit test surface.
- Additional status labels and recovery messages.
- Documentation updates across capability references.

## Acceptance Criteria

- Connection Resilience remains a separate capability specification.
- Session Lifecycle remains responsible for state, transitions, cleanup, close
  reasons, UI mapping, and lifecycle rules.
- Failure classification is documented.
- Recovery matrix is documented.
- Retry, timeout, token refresh, auto reconnect, health monitoring, and recovery
  UX strategies are documented.
- Testing strategy is documented without requiring real Gemini API calls.
- Offline retry pause/resume and microphone-disconnect fallback are covered by
  deterministic unit and browser-mock E2E tests.
