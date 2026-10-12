# Issue #41 Phase A — Instrumentation and Browser Spike

Date: 2026-10-12

## Scope and result

Phase A adds bounded evidence collection and an isolated WebM experiment. It does not change the production Recorder container lifecycle, Viewer recovery policy, Gemini rollover behavior, schemas, recovery APIs, ASR, or cue merge behavior.

The 60-second stop/start rotation candidate **fails** the predeclared 20 ms experiment gate in the available Chromium run. This result does not select a Phase B alternative. Production Viewer root cause remains **NOT CONFIRMED** until paired Recorder/Viewer traces from the same production incident are available.

## Verified data flow

| Flow | Current implementation |
| --- | --- |
| Microphone → PCM queue → Gemini | `src/lib/liveSession.js`: browser capture produces PCM16; the bounded pending queue is limited by 64 chunks and 480,000 bytes by default, then drained to the provider session. Overflow drops the oldest queued record. |
| MediaRecorder → Blob → OPFS → manifest | `src/lib/microphoneRecording.js` emits 1-second slices; `src/features/live/useLiveRecordingController.js` sends them to `src/lib/localMeetingPersistence.js`; `src/lib/localMeetingRecorder.js` writes OPFS and seals the IndexedDB manifest record. |
| Legacy input chunks and retry | `src/features/live/useLiveRecordingController.js` appends copied PCM to `inputChunksRef`; `src/lib/audioUploadController.js` detaches a batch and prepends it again after retryable failure. |
| Cue/snapshot/replay/diagnostics | Recorder cues are in `App.jsx` cue state. `src/webrtc/subtitleDataChannel.js` owns snapshot cues and a bounded replay history (500 in the device sidecar). `src/lib/livePipelineTrace.js` is an existing 20,000-entry ring. |
| Pause/Continue, rollover, stop | Pause stops and drains the active MediaRecorder without completing diagnostics. Continue creates the next capture epoch. Provider transition stays in `liveSession.js`/persistence and does not own MediaRecorder. Finalize/cleanup wait for the serialized Blob writer before the final diagnostic sample and timer cleanup. |

These are capacity and ownership facts from current source, not evidence of a memory leak.

## Instrumentation contract

- Sampling interval: 30 seconds. Capacity: 256 samples, covering about 128 minutes. Old samples are discarded and counted.
- Samples retain only numbers, short enums, timestamps, and capability flags. They do not retain Blob, PCM, Cue, transcript, credential, token, API key, SDP, ICE candidate, or URL payloads.
- `current` is the value at sampling time; `cumulative` is since `reset`; `highWater` is the largest observed current value.
- OPFS append p95 uses a fixed histogram for the recording-since-reset window: `<50`, `<100`, `<250`, `<500`, `<1000`, `<3000`, and `>=3000` ms. It is reported separately from high-water. If p95 falls in the open-ended bucket, `p95Status=overflow_bucket`, upper bound is `null`, lower bound is 3000 ms, and exact max remains available.
- JS heap is `available` with bytes or `unavailable` with `null`; unsupported heap data is never reported as zero.
- Export schema is `recording-diagnostics/v1`. Export includes build SHA when injected by Vite, browser capability flags, sample wall time, and recording-relative time.

Measured counters cover PCM pending/drop, Blob backlog, OPFS pending/sealed/unsealed and append results, legacy queue/retry, cue/snapshot/replay counts, diagnostic map/buffer counts, and cleanup. Updates are O(1). The 30-second sample clones only the small metric object. Diagnostic exceptions are swallowed and tested so they cannot change recorder or writer behavior.

Stop handling is deliberately two-stage: PCM capture stops first; Blob serialization and OPFS append/seal continue to be observed through the existing writer promise; only after it settles does `complete()` take the final sample and clear the timer.

## WebM method and predeclared gate

Harness: `spikes/webm-continuity/`. It uses deterministic 48 kHz multi-tone PCM with a 10 ms changing marker, records real `MediaRecorder` output, and retains capture/audio-clock timing as ground truth. It compares:

1. one continuous MediaRecorder with 1-second WebM slices;
2. two self-contained MediaRecorder containers with stop/start at 60 seconds.

Each run checks the full container, selected individual slices, and selected prefixes from container start. Duration is derived from decoded sample count. Capture time uses the AudioContext sample clock; wall time is reported separately. The fine numeric resolution is one 48 kHz sample (0.0208 ms), with a 2 ms uncertainty window around the 20 ms gate. The 10 ms content marker is coarser and is not used to turn a near-threshold result into PASS.

Gate: absolute rotation penalty, calculated as rotated decoded-vs-capture drift minus continuous decoded-vs-capture drift, must be at most 20 ms. Passing would mean only that the candidate met this experiment gate; it would not prove absence of an audible gap.

## Available browser result

Environment: Playwright Headless Chromium 149.0.7827.55 on the available macOS host. MIME requested and produced: `audio/webm;codecs=opus`, decoded at 48 kHz stereo.

| Measurement | Continuous slices | 60 s rotation |
| --- | ---: | ---: |
| Wall duration | 65,001.70 ms | 65,002.40 ms |
| Capture duration excluding pause | 64,378.67 ms | 64,464.00 ms |
| Decoded duration | 64,380.00 ms | 64,440.00 ms |
| Decoded vs capture drift | +1.33 ms | −24.00 ms |
| Rotation penalty vs continuous | n/a | **−25.33 ms** |
| Container decode | PASS (1/1) | PASS (2/2) |
| Boundary capture-clock stop/start gap | n/a | 0.00 ms |
| 20 ms candidate gate | n/a | **FAIL** |

Additional evidence:

- First 1-second slice decoded to 900–960 ms. Sampled middle and final standalone slices failed with `EncodingError`; arbitrary WebM slices are not independently decodable.
- Prefixes assembled from byte zero decoded in sampled cases, including the full continuous recording. Their byte and decode-memory cost grows with recording length, so this is **not evidence of bounded range decode**.
- Pause/Continue was exercised in both scenarios; the approximately 500 ms pause was excluded from expected capture duration.
- The harness mock provider generation changed without a recorder restart. This proves only the harness contract. Formal source tests separately verify provider-transition PCM draining and that provider recovery/rollover does not block OPFS persistence; no real Gemini rollover was called.

The quick 4-second rotation smoke also failed (about 70.67 ms rotation penalty in the final fine-clock run), supporting preservation of the failure evidence rather than tuning the gate.

## Viewer evidence

The existing trace was extended rather than replaced. Exports now include build SHA when available, meeting scope, transport generation, PC/ICE/DataChannel state, signaling outcome/error metadata, recovery attempt/reason/generation, sequence/last-success timing, bounded cue/snapshot/replay/map counts, and transport cleanup reason. Text and signaling credentials remain excluded/redacted.

Deterministic unit coverage confirms:

1. UI state follows authoritative transport health;
2. a transient signaling 503 does not fail an already healthy DataChannel;
3. stale generation timers/callbacks are ignored;
4. real transport failure reaches `recovery_failed` only after the existing six scheduled attempts.

The policy remains unchanged: no automatic refresh, six attempts, then the manual refresh prompt. These tests establish program-level behavior only. They do not confirm why Preview and Production differ or identify the reported production root cause.

## Phase A status

| Item | Status | Evidence / limitation |
| --- | --- | --- |
| Bounded Recorder/OPFS diagnostics | PASS | Unit tests cover cap, current/cumulative/high-water, p95 overflow, unavailable heap, cleanup, and fault isolation. |
| Stop-through-OPFS-drain observation | PASS | Final sample/timer cleanup occurs after serialized writer settlement. |
| Isolated harness does not alter production Recorder | PASS | Separate page/module and targeted E2E only. |
| Continuous full-container and sampled prefix decode | PASS (one environment) | Prefix resource use grows with total length; not bounded decode. |
| Standalone non-initial 1-second slices | FAIL | Sampled middle/final slices returned `EncodingError`. |
| 60-second rotation candidate | FAIL | −25.33 ms penalty exceeds 20 ms gate. This is decoded sample deficit evidence, not an assertion about perceptual audibility. |
| Pause/Continue harness contract | PASS (one environment) | Exercised in continuous and rotated scenarios. |
| Formal Provider/Recorder separation | PASS (program contract) | Existing production controllers are covered without a Gemini call. Real Gemini rollover is NOT VERIFIED. |
| Viewer diagnostic completeness | PASS (program evidence) | Existing bounded trace extended; recovery behavior unchanged. |
| Production Viewer root cause | NOT CONFIRMED | Requires synchronized Recorder and Viewer trace from the same incident/build. |
| Headed Chrome on macOS; Chrome on Windows; Safari/WebKit | NOT VERIFIED | No corresponding real-device run was available. `bunwv` exited during initialization; Playwright Chromium was used. |

## Phase B recommendation and gates

Do not promote the tested 60-second stop/start rotation candidate. Do not assume a continuous WebM prefix is bounded merely because sampled prefixes decode.

Phase B should remain a design/evidence decision among container-aware alternatives. Before selecting one, require:

1. headed Chrome/macOS, Chrome/Windows, and Safari/WebKit evidence with the same fixed gate and saved raw JSON;
2. repeated boundary measurements (not a single run), including pause near a boundary;
3. explicit peak bytes and decode memory/time versus recording length for continuous-prefix approaches;
4. a container/parser design that starts only at verified initialization/cluster boundaries, or another self-contained format, with failure recovery and rollback specified;
5. paired production Viewer/Recorder traces before proposing any Viewer behavior change.

Rollback is commit-local: remove instrumentation wiring without touching storage schema; remove the isolated `spikes/webm-continuity` page/test; or remove Viewer metadata fields while retaining the previous recovery policy. No database migration or production deployment is involved.

## Commits and reproduction

- `9cc3d9f` — Recorder/PCM/Blob/OPFS/legacy instrumentation.
- `fcad972` — isolated WebM continuity harness and Chromium E2E.
- `a28efa2` — Viewer recovery evidence and bounded source counts.
- `43cc74e` — explicit p95 overflow semantics.
- `2adb829` — refresh O(1) collection counts immediately before each sample.

Commands:

```bash
node --test tests/unit/recordingDiagnostics.test.js tests/unit/microphoneRecording.test.js tests/unit/localMeetingPersistence.test.js tests/unit/audioUploadController.test.js tests/unit/liveSessionProviderTransition.test.js
node --test tests/unit/livePipelineTrace.test.js tests/unit/webrtcSubtitleDataChannel.test.js tests/unit/webrtcSubtitleTransport.test.js tests/unit/viewerTransportState.test.js
./node_modules/.bin/playwright test tests/e2e/webmContinuitySpike.spec.js --config tests/e2e/playwright.config.js --project chromium
npm run dev -- --port 4179
```

After starting Vite, open `http://127.0.0.1:4179/spikes/webm-continuity/` and choose the 65-second run. The two scenarios take about 130 seconds total. Download the JSON before closing the page.
