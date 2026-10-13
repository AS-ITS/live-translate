# Design

## Context

The current branch already contains the first implementation in commit `6bde950`. `MeetingViewerPage` owns the selected size and stable fullscreen shell; a Viewer-only preference helper normalizes browser storage; CSS variables size both subtitle streams; focused unit and Playwright tests cover the main path. This change formalizes that behavior without changing product code in the planning round.

### Confirmed current behavior

- The Viewer renders small, medium, and large buttons and exposes the active choice with `aria-pressed`.
- Medium is the default. On the existing 1280×900 browser fixture it renders both source and translation at 36 px; large renders both at 52 px.
- One size attribute is placed on the stable shell shared by inline, native fullscreen, and CSS fullscreen modes.
- A Viewer-specific localStorage key persists a normalized value. The helper catches storage read/write errors; existing unit coverage verifies missing and invalid values, but has not exercised throwing or unavailable storage.
- Size changes invalidate measured row heights and participate in reading-anchor and follow-latest layout effects.
- Existing CSS stacks bilingual rows below 720 px, shrinks controls below 440 px, and applies wrapping/min-width constraints.
- Existing mocked browser coverage checks medium/large bilingual sizing, reload persistence, CSS fullscreen continuity, 390×844 overflow with short text, QR presence in CSS fullscreen, visibility across a simulated fallback reconnect, and part of reading-position preservation. A separate test exercises native fullscreen without asserting size continuity.
- Viewer title, meeting name, QR code, share link, visibility controls, Cue renderer, and delivery controllers remain separate from the size preference helper.

### Proposed behavior

- Treat `viewer-subtitle-display/spec.md` as the normative contract for later implementation review and regression coverage.
- Keep sizing presentation-only and owned above transport construction so transport generation changes cannot reset it.
- Close focused coverage gaps during apply rather than altering connection or Cue delivery code.

### Assumptions to verify

- Medium is visually close enough to the pre-control Viewer appearance on supported desktop and mobile browsers.
- Current mobile button dimensions and spacing are sufficiently touch-operable on real devices, beyond programmatic clickability.
- Existing wrapping remains safe for unusually long unbroken source or translated strings at the large size.
- Native fullscreen behavior and persisted sizing are consistent on supported browsers where automation can exercise the Fullscreen API.
- Small-size rendering, hidden-stream inheritance, size retention during reconnect, and long unbroken bilingual text at 390 CSS pixels remain acceptance gaps in the current tests.

## Goals / Non-Goals

**Goals:**

- Establish a reviewable contract for three synchronized Viewer subtitle sizes.
- Keep one preference across presentation modes, reloads, and transport reconstruction.
- Preserve responsive layout, reading position, and all existing Viewer controls and information.
- Identify the smallest focused verification needed before the capability is accepted.

**Non-Goals:**

- Change Viewer transport, recovery budgets, snapshot/replay, Cue merge, ordering, or deduplication.
- Change Recorder subtitle settings or introduce a shared Recorder/Viewer preference.
- Add a backend preference API, account synchronization, dependency, or data-model migration.
- Redesign the Viewer header, QR code, share flow, visibility controls, or fullscreen behavior.

## Decisions

### Keep preference state in the stable Viewer presentation owner

The selected size remains page-level presentation state initialized from Viewer-specific browser storage. Transport controllers may be stopped and recreated beneath it. Alternative transport-owned state was rejected because reconnect would then reset an unrelated display preference.

### Apply one semantic size to the fullscreen shell

The stable shell exposes one semantic value, and CSS maps it to responsive typography for both subtitle streams. This avoids duplicated source/translation state and automatically carries the same setting between inline and fullscreen modes. Per-stream sizes were rejected because they conflict with synchronized bilingual presentation.

### Preserve medium as the compatibility default

Missing or invalid preferences normalize to medium. Exact responsive pixel values remain a styling concern; acceptance is based on the semantic choice, synchronized streams, and preserving the current-equivalent default rather than freezing one pixel size for every viewport.

### Fail open when browser storage is unavailable

Read or write failures retain a usable in-memory selection for the current page. The Viewer does not surface storage failure as a connection error because subtitle display controls must not interfere with live delivery.

### Recalculate layout without discarding reading context

Changing font size may change virtualized row heights, so measured layout data is refreshed while the existing stable Cue anchor and follow-latest mode remain authoritative. Resetting the Cue list or forcing the latest position was rejected.

### Verify through focused unit and browser scenarios

Preference normalization and storage errors belong in the focused unit test. Cross-stream rendering, fullscreen continuity, simulated reconnect continuity, preserved controls, mobile operation, and overflow belong in the focused Viewer Playwright spec. Record the browser project and commit SHA with results. No real Gemini API is needed for these presentation tests; real-device touch comfort remains separately unverified.

## Risks / Trade-offs

- **Responsive type uses ranges rather than universal fixed pixels** → Assert semantic state and critical fixture sizes, then visually verify representative supported viewports.
- **localStorage is browser-profile local** → Accept device-local persistence; account-level synchronization is outside scope.
- **Synthetic mobile clicks do not prove physical touch comfort** → Keep automated reachability checks and record real-device verification as an acceptance assumption until performed.
- **Long unbroken text can expose wrapping differences across engines** → Add a focused large-size overflow fixture with both source and translation content.
- **Existing implementation predates the OpenSpec change** → During apply, compare code and tests to the contract first; change only demonstrated gaps and avoid rewriting already-conforming code.
