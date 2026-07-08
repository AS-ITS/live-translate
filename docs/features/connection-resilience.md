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
- No production code is changed by this specification.
