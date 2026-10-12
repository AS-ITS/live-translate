# Design QA

- Source visual truth: `/Users/pochun/Desktop/截圖 2026-09-30 09.09.28.png`
- Implementation card screenshot: `/private/tmp/global-glossary-card-after.png`
- Implementation full-page screenshot: `/private/tmp/global-glossary-page-after.png`
- Viewport: 1440 × 900 CSS px, device scale factor 1
- Source pixels: 350 × 325; source density metadata unavailable
- Implementation pixels: card crop 255 × 268; full page 1440 × 900
- State: enabled global glossary entry; default card state plus action-button hover; authenticated test workspace

## Comparison evidence

The source and implementation card crops were reviewed together. The source showed a native outlined square action button whose ellipsis sat above the visual center. The implementation uses a borderless 40 × 40 rounded action area with the icon centered by flex alignment. The full-page capture confirmed the treatment remains consistent with the surrounding card, toolbar, spacing, and responsive grid.

Focused comparison was required because the requested change concerns the small top-right card action. The rest of the screen was checked in the full-page capture for layout regressions.

## Required fidelity surfaces

- Fonts and typography: unchanged; card hierarchy, weights, line heights, and wrapping remain consistent.
- Spacing and layout rhythm: card padding and header spacing are unchanged; the action target is centered and does not shift status text or card content.
- Colors and visual tokens: the default action is transparent with muted text; hover uses the existing muted surface and primary color tokens.
- Image and asset fidelity: the existing Lucide `MoreHorizontal` icon is preserved; no replacement or generated asset was required.
- Copy and content: unchanged.

## Interaction and runtime checks

- Hover state displayed the muted background treatment.
- Clicking the action opened the entry editor dialog.
- Computed styles confirmed centered alignment, zero border width, and less than 1 px vertical center delta.
- Browser console errors: none.
- bunwv verification was unavailable because both WebKit and Chrome daemons failed to start; the existing Playwright Chromium environment provided the browser-rendered evidence instead.

## Comparison history

1. Initial P2 finding: native square border conflicted with the card language and the ellipsis was not vertically centered.
2. Fix: added a card-scoped borderless rounded action style with explicit flex centering and hover feedback.
3. Post-fix evidence: `/private/tmp/global-glossary-card-after.png` and `/private/tmp/global-glossary-page-after.png`; no remaining P0, P1, or P2 findings.

## Findings

No actionable P0, P1, or P2 differences remain for the requested card action treatment.

## Follow-up polish

No P3 follow-up is required for this scoped change.

final result: passed
