# Audio Device Selection

Status: v1 implemented for input device selection / output device selection is
future browser-limited work

## 1. Feature Overview

Audio Device Selection is a Phase 2 internal-tool feature that lets the user
choose which microphone is used for live translation input and, in a future
browser-limited phase, which speaker or audio output device is used for
translated audio playback.

The v1 implementation supports input microphone selection only. It does not
implement output device routing.

This feature is browser-local. Device enumeration, selection, permission prompts,
and fallback behavior should be handled in the frontend through browser media
APIs. It should not add backend endpoints, database storage, Gemini token changes,
or any server-side audio routing.

The existing Live Translate audio path remains the same:

1. The browser captures microphone audio.
2. The frontend converts input audio to PCM16 16kHz mono.
3. The browser connects directly to Gemini Live API with a backend-issued
   ephemeral token.
4. The frontend plays translated PCM16 24kHz mono audio returned by Gemini.

Device selection should only change which local input device is opened in v1.
Output device routing remains future work.

## 2. Goals

- Let the user select an audio input device before starting a session.
- Use the selected input device in `navigator.mediaDevices.getUserMedia`.
- Detect whether output device selection might be supported by the browser, but
  do not route audio output in v1.
- Preserve the current default behavior when no device is selected.
- Fall back safely if the selected device is unavailable, disconnected, or no
  longer permitted.
- Handle permission-dependent device labels clearly.
- Keep device preferences local to the browser.
- Avoid changes to `/api/live-token`, Gemini token issuance, and backend
  security behavior.
- Avoid real Gemini API calls in automated validation.

## 3. Non-Goals

- Output device routing in v1.
- Backend device APIs.
- Server-side audio routing.
- Storing device preferences in a database.
- User accounts or cross-device preference sync.
- Raw audio recording.
- Speaker diarization.
- Source language selection.
- AudioWorklet migration.
- Reworking the Gemini Live session protocol.
- Changing the PCM input or output audio formats.
- Calling the real Gemini API in tests.

## 4. User Flow

1. The user opens the app.
2. The user opens audio device controls or sees device controls near the session
   controls.
3. If microphone permission has not been granted, the app shows that full device
   names may require permission.
4. The user grants microphone permission through the browser prompt when needed.
5. The app lists available microphones. Output device routing remains future
   browser-limited work.
6. The user selects an input device.
7. The user starts a live translation session.
8. The session captures audio from the selected input device.
9. Translated audio plays through the browser default output path.
10. If a selected input device is unavailable, the app falls back to the browser
    default device and shows a recoverable message.
11. The user can stop the session normally.

Changing devices during an active session should be a later explicit decision.
The initial implementation should prefer applying device changes to the next
session to avoid disrupting the latency-sensitive audio path.

## 5. Browser API Design

Primary browser APIs:

- `navigator.mediaDevices.enumerateDevices()` to list available media devices.
- `navigator.mediaDevices.getUserMedia()` to request microphone permission and
  open the selected input device.
- `MediaDevices.devicechange` to refresh available devices after hardware
  changes.
- `HTMLMediaElement.setSinkId()` where supported for output routing.

Input device enumeration:

- Filter `enumerateDevices()` results to `kind === "audioinput"`.
- Before microphone permission, device labels may be empty or generic.
- After permission is granted, refresh the list so labels can be displayed.
- Treat `deviceId` as an opaque browser-local preference, not a stable
  persistent identity.

Output device enumeration:

- Filter `enumerateDevices()` results to `kind === "audiooutput"`.
- v1 may detect support, but must not expose working output routing controls.
- Detect `setSinkId` support before enabling output routing controls.
- If unsupported, keep playback on the browser default output device and show an
  unavailable state rather than an error.

Suggested frontend state shape:

```js
{
  devices: {
    inputs: [],
    outputs: [],
    selectedInputDeviceId: "",
    selectedOutputDeviceId: "",
    permissionState: "unknown",
    outputRoutingSupported: false,
    lastDeviceError: null
  }
}
```

Suggested future module boundary:

- Device enumeration and selection helpers can live in a small frontend helper
  such as `src/lib/mediaDevices.js`.
- Session startup can pass the selected input device ID into the live session
  constructor or start method.
- Playback routing may require the output audio path to route through an
  `HTMLAudioElement` or another browser-supported sink-aware playback strategy
  if direct `AudioContext.destination` routing cannot apply `setSinkId`.

## 6. Input Device Selection

The selected input device should be applied through `getUserMedia` constraints.

Recommended constraints when an input device is selected:

```js
{
  audio: {
    deviceId: { exact: selectedInputDeviceId },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1
  }
}
```

Recommended constraints when no input device is selected:

```js
{
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1
  }
}
```

Input behavior requirements:

- Default to the browser default microphone when no selection exists.
- Store only the selected `deviceId` locally if persistence is implemented.
- Refresh the device list after permission is granted.
- If `exact` device selection fails with `NotFoundError` or
  `OverconstrainedError`, retry once with the default microphone.
- Stop any temporary permission-probe tracks immediately after enumeration.
- Do not keep microphone tracks open outside an active session except for the
  shortest permission or preview operation required by the UI.

## 7. Output Device Selection

Output device selection is future browser-limited work. The v1 implementation
must not route translated audio to a selected output device.

Output behavior requirements:

- Detect support with a capability check such as
  `"setSinkId" in HTMLMediaElement.prototype`.
- Keep output controls disabled, hidden, or marked as future when output routing
  is unsupported or not implemented.
- Use the browser default output device when no output device is selected.
- If a selected output device fails, continue playback through the default output
  and show a recoverable warning.
- Do not block session start solely because output device routing is unsupported.

Implementation risk:

- The current playback path schedules decoded PCM through `AudioContext` buffer
  sources connected to `audioContext.destination`.
- `setSinkId()` applies to media elements in supporting browsers, not directly to
  every Web Audio destination in all browsers.
- Before implementation, confirm whether the selected browser target can route
  Web Audio output through a sink-aware element or whether output selection
  should remain planned but disabled for unsupported paths.

## 8. Permission Handling

Permission behavior must be explicit because browser device labels and IDs are
permission-dependent.

Recommended states:

- `unknown`: Permission has not been requested or cannot be queried.
- `prompt`: The browser may prompt on microphone access.
- `granted`: Microphone access is available and labels can be shown.
- `denied`: The user or browser blocked microphone access.
- `unsupported`: Media device APIs are unavailable.

Permission handling requirements:

- Do not request microphone permission on initial page load unless the user takes
  an audio-related action.
- Request permission when the user starts a session or explicitly chooses to load
  device names.
- After permission is granted, call `enumerateDevices()` again.
- If permission is denied, keep session startup blocked and show a recoverable
  error with retry guidance.
- If `navigator.permissions.query({ name: "microphone" })` is unavailable or
  inconsistent, fall back to `getUserMedia` error handling.
- Never log raw audio, device labels, ephemeral tokens, or stack traces in user-
  visible errors.

## 9. UI Behavior

- Device controls should be placed near existing Start / Stop and language
  controls or inside a compact audio settings area.
- The default input option should be clearly represented as the browser default
  microphone.
- The default output option should be clearly represented as the browser default
  speaker.
- Before permission is granted, unavailable labels should be shown as generic
  device names rather than blank text.
- During an active session, initial implementation should disable device changes
  or mark them as applying to the next session.
- If devices are plugged in or removed, refresh the available list through the
  `devicechange` event.
- If the selected device disappears, keep the stored preference but mark it
  unavailable and fall back at session start.
- Device selection must not clear transcripts, stop an active session, or request
  a Gemini token by itself.
- The UI should avoid broad layout or styling changes as part of this feature.

## 10. Error Handling

- `NotAllowedError`: Microphone permission was denied. Stop setup, keep the app
  out of an active session, and show a retry path.
- `NotFoundError`: No matching microphone was found. Fall back to default if
  possible, otherwise show that no microphone is available.
- `OverconstrainedError`: The selected device or constraint cannot be satisfied.
  Retry once without the selected `deviceId`.
- `NotReadableError`: The microphone may be in use by another app or unavailable.
  Stop setup and show a recoverable message.
- `SecurityError`: The browser or page context blocked media access. Show an
  unsupported or blocked state.
- Output `setSinkId` failure: Continue with default output if playback can still
  proceed and show a non-fatal warning.
- `devicechange` during session: Do not abruptly stop the session unless the
  active media track ends or capture fails.

Error responses and logs must not expose `GEMINI_API_KEY`, ephemeral tokens, raw
audio, transcript content, or internal stack traces.

## 11. Testing Requirements

Automated tests must be deterministic and must not call the real Gemini API.

Suggested unit coverage:

- Normalize audio input and output device lists from mocked `MediaDeviceInfo`
  values.
- Preserve default device behavior when no selection exists.
- Select a preferred input device by `deviceId`.
- Fall back to default input when the selected input device is unavailable.
- Detect output routing support and unsupported states.
- Handle permission states and permission-denied errors.
- Clear or mark stale selections after device list refresh.

Suggested E2E coverage with mocked browser media APIs:

- Device controls show default microphone before selection.
- Granting microphone permission refreshes device labels.
- Starting a session passes the selected input device constraint to
  `getUserMedia`.
- Removing the selected device causes a fallback or unavailable state.
- Unsupported output routing disables output device selection without blocking
  session start.

Smallest relevant validation for v1:

```bash
node --test tests/unit/mediaDevices.test.js
```

If UI flow changes are implemented, run the targeted Playwright E2E test for the
device-selection flow. Do not run real Gemini validation for this feature unless
explicitly approved.

## 12. Risks / TODO

- Browser output device routing support varies and may not work with the current
  direct `AudioContext.destination` playback path.
- Device IDs can change between browser sessions and should be treated as
  preferences, not durable identifiers.
- Device labels may be unavailable until microphone permission is granted.
- Permission prompts differ across browsers and operating systems.
- Bluetooth devices may disconnect or switch profiles during a session.
- Retrying a failed selected microphone with the default microphone must not
  create duplicate Gemini sessions or duplicate token requests.
- Confirm target browser support for `setSinkId()` before enabling output
  selection in a future version.
- Decide whether device preferences should persist in `localStorage`; if used,
  store only opaque device IDs and avoid storing labels.
- Decide whether changing devices during an active session should be unsupported,
  apply on next session, or trigger an explicit restart.

## 13. Acceptance Criteria

- A feature spec exists at `docs/features/audio-device-selection.md`.
- The spec defines input device selection and future output device selection
  separately.
- The spec uses browser-local media APIs and does not require backend changes.
- The spec preserves the current backend-owned `GEMINI_API_KEY` and ephemeral
  token flow.
- The spec documents permission handling before and after microphone access is
  granted.
- The spec documents fallback behavior for unavailable selected devices.
- The spec documents unsupported output routing behavior as future
  browser-limited work.
- The spec includes deterministic testing requirements using mocks.
- The spec explicitly avoids real Gemini API validation by default.
- v1 implementation changes only frontend microphone selection, frontend helper
  utilities, tests, and documentation.
- v1 does not implement output device routing.
- v1 does not change backend APIs, database state, Gemini token issuance, or the
  translated-audio playback pipeline.
