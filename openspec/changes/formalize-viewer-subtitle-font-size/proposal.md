# Proposal

## Why

The Viewer already contains a first implementation of three subtitle sizes, but the newly initialized OpenSpec workspace has no capability contract for it. This pilot records the intended behavior and verification boundary before any further product-code work, so future changes preserve the Viewer presentation and transport separation.

## Changes

- Define small, medium, and large Viewer subtitle sizes, with medium preserving the current default presentation as closely as practical.
- Apply one selected size to both source and translated subtitle text in inline and fullscreen presentation.
- Persist the Viewer-specific preference across reloads and transport reconstruction without coupling it to connection, recovery, ordering, or replay state.
- Require touch-operable controls and no horizontal subtitle overflow on mobile layouts.
- Preserve the existing title, QR code, share link, source/translation visibility controls, Cue history position, and fullscreen behavior.
- Complete the missing focused unit and browser acceptance coverage for storage failures, all three choices, hidden-stream inheritance, fullscreen, reconnect, long mobile text, and preserved Viewer controls.
- Do not change Viewer connection, recovery, Cue ordering, replay, Gemini Live, API, or security behavior.

## Capabilities

### New Capabilities

- `viewer-subtitle-display`: Viewer-owned subtitle presentation preferences, synchronized bilingual sizing, responsive controls, and preservation across presentation and transport lifecycle changes.

### Modified Capabilities

None. The OpenSpec workspace currently has no main capability specs.

## Impact

- Planning and later verification concern `src/pages/viewer/MeetingViewerPage.jsx`, `src/lib/viewerFontSizePreference.js`, `src/styles/meeting-viewer.css`, and focused Viewer unit/E2E tests.
- The existing `docs/features/meeting-center-live-viewer.md` remains the product documentation source and should only be adjusted if OpenSpec review identifies a mismatch.
- No backend API, dependency, persistence schema, transport protocol, recovery state machine, Cue merge/order/replay mechanism, or authentication boundary is affected.
