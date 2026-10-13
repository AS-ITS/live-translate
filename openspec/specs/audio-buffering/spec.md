# Audio Buffering

## Purpose

Define the implemented browser microphone PCM conversion and bounded pre-roll queue. These requirements do not promise lossless capture or a real Gemini acceptance acknowledgement.

## Requirements

### Requirement: Capture produces 16 kHz mono PCM16 frames

The capture path SHALL resample microphone samples to 16 kHz and encode signed little-endian PCM16. Its chunker SHALL emit complete 100 ms frames and retain the remainder until another push or an explicit flush.

#### Scenario: Samples fill one frame

- **GIVEN** mono samples from a 16 kHz capture source
- **WHEN** the chunker receives 1,600 samples
- **THEN** it emits one 100 ms, 3,200-byte PCM16 frame

#### Scenario: Capture ends with a partial frame

- **GIVEN** the chunker holds fewer than 1,600 samples
- **WHEN** it is flushed
- **THEN** it emits the remaining samples as one PCM16 frame and clears its remainder

### Requirement: Capture has a ScriptProcessor fallback

The live capture setup SHALL attempt its AudioWorklet path when supported and SHALL fall back to ScriptProcessor when AudioWorklet construction fails, without treating the failed worklet as a second active capture graph.

#### Scenario: AudioWorklet cannot be constructed

- **GIVEN** the browser exposes an AudioWorklet path but its node construction throws
- **WHEN** live audio capture starts
- **THEN** capture uses the ScriptProcessor fallback

### Requirement: Pending provider input is bounded and overflow is explicit

For ordinary PCM chunks no larger than the configured byte capacity, the live session MUST keep its pending input queue within its configured chunk and byte limits. The default limits SHALL be 64 chunks and 480,000 bytes. On overflow it SHALL evict oldest pending chunks and report a `provider_input_buffer_overflow` diagnostic rather than silently claiming lossless delivery.

#### Scenario: Pending input exceeds its limit

- **GIVEN** the provider cannot yet accept input and the queue is at its configured limit
- **WHEN** another ordinary PCM chunk is queued
- **THEN** the oldest pending chunk is dropped, the new chunk remains pending, and an overflow diagnostic is emitted

### Requirement: Buffered input drains only through the active transition path

The live session SHALL buffer input captured before provider readiness and drain pending PCM when the active provider path becomes ready. If an uncommitted provider transition is cancelled, it SHALL resume the old provider and drain that transition's queued PCM once.

#### Scenario: Provider becomes ready after capture

- **GIVEN** microphone PCM was queued while provider input was not ready
- **WHEN** the active provider path becomes ready and pre-roll drains
- **THEN** the pending chunk is sent through that path and removed from the pending queue

#### Scenario: Uncommitted transition is cancelled

- **GIVEN** PCM was queued during a provider transition that has not committed
- **WHEN** that transition is cancelled
- **THEN** the old provider resumes and receives the queued PCM once

## Evidence by Requirement

- PCM frame conversion: `src/lib/audio.js` (`INPUT_SAMPLE_RATE`, `CHUNK_MS`, `resampleLinear`, `floatToPcm16`, `createPcmChunker`) and `src/lib/liveSession.js`; `tests/unit/audio.test.js` checks conversion, 100 ms frames, and partial-frame flush.
- Capture fallback: `src/lib/liveSession.js` worklet construction and `createScriptProcessor(4096, 1, 1)` fallback; `tests/unit/liveSessionFailureSignal.test.js` checks failed and healthy worklet cases.
- Bounded pre-roll: `src/lib/liveSession.js` (`MAX_PENDING_INPUT_AUDIO_CHUNKS`, `MAX_PRE_ROLL_BYTES`, queue and overflow helpers); `tests/unit/liveSessionProviderTransition.test.js` checks eviction, diagnostic, drain, and cleanup; `tests/unit/liveSessionFailureSignal.test.js` checks the newest-window bound.
- Transition drain: `src/lib/liveSession.js` (`sendInputAudioChunk`, `drainPreRoll`, `cancelProviderTransition`); `tests/unit/liveSessionFailureSignal.test.js` checks pre-ready input and `tests/unit/liveSessionProviderTransition.test.js` checks cancelled pre-commit drain to the old provider once.

## Known Limits and Unverified Conditions

- Overflow deliberately drops data. An oversized single input chunk is not covered by the bounded-queue Scenario; the normal capture chunk is 3,200 bytes.
- Unit/mock evidence does not verify a physical microphone, browser-specific callback timing, long-duration backlog, Preview or Production behavior, or Gemini acceptance of sent PCM.
- The pre-commit cancellation Scenario is an explicit exception to the Phase 3A candidate's broad “no old-provider replay” wording. Committed provider replacement and gap-recovery guarantees are reserved for a separately reviewed lifecycle specification.
