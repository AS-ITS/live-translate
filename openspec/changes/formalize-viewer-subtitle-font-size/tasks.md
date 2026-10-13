# Tasks

The first implementation is present in commit `6bde950`; these checkboxes record acceptance of the complete contract, not the existence of UI controls. Keep a task open until its focused checks have passed. A failed check may require a minimal product fix in a separately authorized implementation phase. Do not infer real-device acceptance from mocked browser results.

## 1. Reconcile the existing implementation with the contract

- [ ] 1.1 Compare the committed Viewer size state, preference helper, fullscreen shell, responsive CSS, and reading-anchor behavior with `viewer-subtitle-display/spec.md`; change only demonstrated gaps and verify the product diff does not touch transport, recovery, Cue ordering, or replay modules.
- [ ] 1.2 Complete focused preference-helper coverage for small, medium, large, invalid values, and unavailable storage; verify with `node --test tests/unit/viewerFontSizePreference.test.js`.

## 2. Close browser acceptance gaps

- [ ] 2.1 Update the focused Viewer Playwright spec to exercise all three choices, synchronized source/translation sizing, hidden-stream inheritance, inline/native-or-CSS fullscreen continuity, reload persistence, and transport reconnect preservation; verify with the matching `meetingViewerFullscreen.spec.js` test title filter.
- [ ] 2.2 Add a 390 CSS-pixel mobile scenario that activates every size control and renders long or unbroken bilingual text at large size; verify selected `aria-pressed` state and that both the document and subtitle viewport have no horizontal overflow using the matching focused Playwright test.
- [ ] 2.3 In the same focused Viewer flow, assert the title, meeting name, QR code, share link, source/translation toggles, fullscreen control, existing Cues, and history-mode anchor remain available after size changes; verify with the matching focused Playwright test.

## 3. Review and acceptance

- [ ] 3.1 Compare `docs/features/meeting-center-live-viewer.md` with the accepted OpenSpec contract and update it only if a mismatch exists; verify no unrelated documentation or capability is changed.
- [ ] 3.2 Run `openspec validate formalize-viewer-subtitle-font-size --strict`, the focused unit test, and only the affected Viewer Playwright scenarios; record command, commit SHA, browser project, result, and any unverified real-device touch or native-fullscreen condition.

## Workflow follow-up

- After implementation review and focused validation pass, sync or archive the capability through the installed OpenSpec workflow in a separate user-approved turn.
