# Session Lifecycle Management

## Feature Overview

Session Lifecycle Management is a Phase 2 foundation feature that organizes the
current Start / Stop / Error flow into an explicit session lifecycle model. The
goal is to make session state, transitions, cleanup, and error reasons clear
before adding Auto Reconnect, Token Refresh, Session History, or Usage Logging.

This feature does not directly implement reconnect behavior, change the Gemini
Live token flow, add backend APIs, add a database, or add persistence.

## Related Capabilities

### Connection Resilience

Session Lifecycle Management provides the state model, lifecycle transition
rules, cleanup policy, close reasons, UI mapping, and lifecycle rules that
Connection Resilience builds on.

Connection Resilience is a separate capability specification for retry policy,
auto reconnect, token refresh, timeout strategy, health monitoring, recovery
matrix, and recovery UX. See
[Connection Resilience](connection-resilience.md).

## Goals

- Define session state model.
- Define legal state transitions.
- Distinguish user stop, unexpected close, token/auth failure, and network
  failure.
- Define cleanup policy.
- Define UI state mapping.
- Keep the existing Gemini Live session/token flow unchanged.
- Do not add persistence.
- Do not add backend API.

## Non-Goals

- Implement Auto Reconnect.
- Implement Token Refresh.
- Implement Session History.
- Implement Usage Logging.
- Add a database.
- Add login.
- Change Gemini Live API integration.

## Session State Model

- `idle`: No active session or setup operation is in progress.
- `requesting-permission`: The browser microphone permission step is active.
- `connecting`: Token request or Gemini Live session setup is active.
- `listening`: Microphone input is being sent and translated output may be
  received.
- `stopping`: User stop or shutdown cleanup is in progress.
- `stopped`: The session ended through an expected user stop or controlled
  shutdown.
- `error`: The session failed or closed unexpectedly and can be reset or
  restarted.
- `reconnecting`: Automatic recovery setup is active.
- `expired`: Future-ready state for token or session expiration that cannot
  continue without refresh or restart.

`expired` is a reserved future-ready state for token refresh. It can still be
used as a visible manual-recovery state before token refresh is implemented.

## State Transition Rules

| From | Event | To | Cleanup Required | Notes |
| --- | --- | --- | --- | --- |
| `idle` | User starts session | `requesting-permission` | No | Start flow begins. |
| `requesting-permission` | Microphone permission granted | `connecting` | No | Continue to token request and Gemini setup. |
| `requesting-permission` | Permission denied | `error` | Yes | Reason: `permission_denied`. Stop any temporary tracks. |
| `connecting` | Gemini session setup succeeds | `listening` | No | Active session begins. |
| `connecting` | Token request fails | `error` | Yes | Reason: `token_request_failed`. |
| `connecting` | Gemini connect fails | `error` | Yes | Reason: `live_connect_failed`. |
| `listening` | User stops session | `stopping` | Yes | Reason: `user_stop`. |
| `stopping` | Cleanup succeeds | `stopped` | No | Session ended cleanly. |
| `stopping` | Cleanup fails | `error` | Yes | Reason: `cleanup_failed`; retry best-effort cleanup. |
| `listening` | Unexpected close | `error` | Yes | Reason: `unexpected_close`. |
| `listening` | Network failure | `error` | Yes | Reason: `network_error`. |
| `listening` | Auth or rate-limit failure | `error` | Yes | Reason: `auth_failed` or `rate_limited`. |
| `error` | User resets or retries | `idle` | No | Error display can clear after reset. |
| `stopped` | User starts another session | `requesting-permission` | No | New session flow begins. |
| `listening` | Recoverable disconnect detected | `reconnecting` | Yes | Recovery is active outside this lifecycle spec. |
| `reconnecting` | Reconnect succeeds | `listening` | No | Return after replacement setup succeeds. |
| `reconnecting` | Recovery fails or is unavailable | `error` | Yes | Failure remains a normal error lifecycle outcome. |
| `listening` | Token/session expiration detected | `expired` | Yes | Reason: `token_expired`; token refresh is not active in this feature. |

Invalid transitions should be rejected or ignored in a controlled way. For
example, `idle` should not transition directly to `listening`, and `stopped`
should not transition to `listening` without a new setup flow.

## Close / Error Reason Model

- `user_stop`: The user intentionally stopped the session.
- `permission_denied`: Browser microphone permission was denied or blocked.
- `token_request_failed`: The backend token request failed before a Live session
  could be opened.
- `live_connect_failed`: Gemini Live session setup failed after token issuance.
- `unexpected_close`: The Live session closed without an expected user stop.
- `network_error`: Browser or network connectivity interrupted the session.
- `token_expired`: The ephemeral token or Live session expired.
- `auth_failed`: Authentication or authorization failed.
- `rate_limited`: Token issuance or live translation startup was rate-limited.
- `provider_error`: Gemini or provider-side behavior returned an unrecoverable
  error.
- `cleanup_failed`: Resource cleanup failed or only partially completed.

## Cleanup Policy

Cleanup is required for:

- User stop.
- Connection error.
- Unexpected close.
- Page unload.
- React unmount.
- Token/auth failure.

Cleanup should:

- Stop microphone tracks.
- Disconnect audio nodes.
- Close Gemini session.
- Close `AudioContext`.
- Clear playback queue.
- Reset active session reference.

Cleanup should be idempotent. Calling cleanup more than once must not create a
new session, request a token, throw uncaught errors, or clear unrelated
transcript/export state unless the selected session reset policy requires it.

## UI State Mapping

| State | Start Button | Stop Button | Device Selector | Export Controls | Status Message | Error Display |
| --- | --- | --- | --- | --- | --- | --- |
| `idle` | Enabled | Disabled | Enabled | Enabled if transcript exists | Ready | Hidden |
| `requesting-permission` | Disabled | Disabled | Disabled | Disabled | Requesting microphone permission | Hidden |
| `connecting` | Disabled / Starting | Hidden | Disabled | Disabled | Starting | Hidden |
| `listening` | Disabled | Enabled | Disabled | Enabled if transcript exists | Listening | Hidden |
| `stopping` | Disabled | Disabled | Disabled | Disabled | Stopping | Hidden |
| `stopped` | Enabled | Disabled | Enabled | Enabled if transcript exists | Stopped | Hidden |
| `error` | Enabled | Disabled | Enabled | Enabled if transcript exists | Error | Visible |
| `reconnecting` | Disabled | Enabled | Disabled | Enabled if transcript exists | Reconnecting | Hidden unless reconnect fails |
| `expired` | Enabled | Disabled | Enabled | Enabled if transcript exists | Session expired | Visible |

Export controls should never require an active Gemini Live session. They should
depend only on available transcript data and the selected export format. During
`reconnecting`, export controls can remain available; Download availability is
still determined by transcript and export-format availability.

`auth_failed` and `rate_limited` currently use the internal `error` state. The
visible status label may be overridden to a more specific user-facing label
without adding separate lifecycle states.

## Testing Requirements

- Valid state transitions.
- Invalid transitions rejected.
- User stop cleanup path.
- Unexpected close cleanup path.
- Error reason mapping.
- UI mapping.

Tests should be deterministic and should not call the real Gemini API.

## Acceptance Criteria

- Session lifecycle states documented.
- State transition table completed.
- Close/error reason model documented.
- Cleanup policy documented.
- Connection Resilience dependency documented.
- No production code changed.
