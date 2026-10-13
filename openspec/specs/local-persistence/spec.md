# Local Persistence

## Purpose

Define the implemented browser-local recording journal: OPFS holds chunk bytes, and IndexedDB holds the manifest, Cue, checkpoint, and operation records. This is a local program-level contract, not a guarantee of unlimited storage or cloud delivery.

## Requirements

### Requirement: Audio chunks follow reserve, write, seal

The local recorder MUST reserve a chunk identity in the manifest before writing its bytes to OPFS and SHALL seal the manifest record only after the write succeeds. A sealed chunk MUST retain its identity, sequence, path, byte size, and checksum; a conflicting retry SHALL be rejected instead of overwriting sealed content.

#### Scenario: New audio chunk is persisted

- **GIVEN** an active local recorder and a new chunk identity
- **WHEN** the chunk is appended successfully
- **THEN** its manifest moves from reserved/writing to sealed after the OPFS bytes are written

#### Scenario: Retry conflicts with sealed bytes

- **GIVEN** a chunk identity and bytes have already been sealed
- **WHEN** a retry supplies different bytes or conflicting seal metadata for that identity
- **THEN** persistence rejects the retry and leaves the original sealed content unchanged

### Requirement: Recovery distinguishes complete, incomplete, and orphaned data

The local reconciliation path MUST compare manifest records with OPFS files. It SHALL seal a matching completed write, mark a missing or mismatched manifest file as corrupt, and report an unreferenced OPFS file as an orphan rather than treating it as a sealed chunk.

#### Scenario: Browser reload follows a completed OPFS write but precedes seal

- **GIVEN** the manifest says writing and the matching completed OPFS file exists
- **WHEN** the recorder reconciles after reload
- **THEN** the manifest chunk is sealed without writing another file

#### Scenario: OPFS contains an unreferenced file

- **GIVEN** an OPFS file has no corresponding manifest entry
- **WHEN** reconciliation runs
- **THEN** the file is reported as an orphan and is not presented as sealed audio

### Requirement: Browser-local metadata survives a same-origin reload

The IndexedDB journal SHALL retain its stored Cue, checkpoint, and lifecycle-operation metadata across reloads of the same origin when browser storage is available. OPFS SHALL retain the corresponding audio bytes under its stored path; retrying a different write to an existing path MUST fail.

#### Scenario: Same-origin page reloads

- **GIVEN** Cue/checkpoint/operation metadata and an OPFS chunk were stored successfully
- **WHEN** the page reloads under the same origin and opens the journal again
- **THEN** the stored metadata and original chunk remain readable, while a different write to the same OPFS path is rejected

### Requirement: Credential-shaped fields are excluded from the journal

The IndexedDB projection MUST omit recognized credential-shaped keys from persisted or hydrated recording, operation, Cue, and checkpoint records; encountering such a field SHALL NOT make it part of the application-visible journal record.

#### Scenario: Legacy stored record contains a credential-shaped field

- **GIVEN** an IndexedDB journal record contains a recognized credential-shaped key
- **WHEN** the local store hydrates or projects that record
- **THEN** the returned journal record omits the credential-shaped field

## Evidence by Requirement

- Reserve/write/seal: `src/lib/localMeetingRecorder.js` (`appendChunk`) and `src/lib/localMeetingStorage.js` (`reserveLocalChunk`, `sealLocalChunk`, IndexedDB manifest, OPFS chunk store); `tests/unit/localMeetingRecorder.test.js` and `tests/unit/localMeetingStorage.test.js` cover sealing, retry, and overwrite conflicts.
- Recovery classification: `src/lib/localMeetingStorage.js` (`reconcileLocalMeetingChunks`) and `src/lib/localMeetingRecorder.js` (`reconcile`, `restore`); `tests/unit/localMeetingStorage.test.js` covers matching/corrupt/orphan files, and `tests/unit/localMeetingRecorder.test.js` covers the pre-seal crash window.
- Same-origin reload: `src/lib/localMeetingStorage.js` (`createIndexedDbLocalMeetingManifestStore`, `createOpfsChunkStore`) and `src/lib/localMeetingPersistence.js`; `tests/unit/localMeetingStorage.test.js` checks Cue/checkpoint hydration, operation replay, and OPFS overwrite refusal in Headless Chromium.
- Credential projection: `src/lib/localMeetingStorage.js` projection helpers and credential-key matcher; `tests/unit/localMeetingStorage.test.js` injects credential-shaped fields and checks hydration, reload, and operation projections in Headless Chromium.

## Known Limits and Unverified Conditions

- The browser tests exercise Headless Chromium and mocks. They do not establish Safari/private-mode support, quota-exhaustion behavior, cross-tab durability under stress, Preview/Production storage behavior, or lossless recovery after arbitrary crashes.
- This spec does not define cloud ACK, offline resend, automatic deletion, or WebM container decode behavior. The isolated WebM failures in `docs/spec-audit/known-gaps.md` remain test-only evidence, not a Production defect assertion.
- The credential projection recognizes a defined family of key names; it is not a proof that arbitrary secret values under unrelated field names cannot be stored.
