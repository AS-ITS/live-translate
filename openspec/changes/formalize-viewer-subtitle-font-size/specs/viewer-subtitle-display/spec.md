# Spec Delta

## Purpose

Define stable Viewer subtitle presentation preferences without coupling display choices to live subtitle delivery or recovery behavior.

## ADDED Requirements

### Requirement: Three subtitle size choices

The Viewer SHALL provide small, medium, and large subtitle size choices, with medium as the default when no valid Viewer preference is available.

#### Scenario: First visit selects medium for both subtitle streams

- **WHEN** a Viewer opens without a stored valid subtitle size
- **THEN** medium is selected and both source and translated Cue text use the same medium size setting

#### Scenario: Invalid preference falls back safely

- **WHEN** the stored subtitle size is missing, unreadable, or not small, medium, or large
- **THEN** the Viewer selects medium and remains operable

### Requirement: Bilingual sizing stays synchronized

The Viewer SHALL apply the selected subtitle size immediately to both source and translated subtitle text without changing Cue content or visibility choices.

#### Scenario: Size changes both visible streams

- **WHEN** both source and translation are visible and the Viewer selects another size
- **THEN** both streams render with the selected size in the existing Cue rows

#### Scenario: Hidden stream inherits the active size

- **WHEN** one stream is hidden, the size changes, and the hidden stream is shown again
- **THEN** the newly shown stream uses the same active size as the visible stream

### Requirement: Inline and fullscreen share one preference

The Viewer SHALL use one subtitle size preference across inline, native fullscreen, and CSS fullscreen presentation modes.

#### Scenario: Enter and exit fullscreen

- **WHEN** a Viewer selects a size and enters or exits any supported fullscreen mode
- **THEN** the selected size remains active without remounting or replacing the Viewer content

### Requirement: Preference survives delivery lifecycle changes

The Viewer SHALL keep the selected size independent from transport instances and SHALL restore it on reload when browser storage is available.

#### Scenario: Transport reconnect preserves size

- **WHEN** Viewer delivery disconnects and reconstructs its transport or recovers through snapshot or replay
- **THEN** the selected size, rendered Cues, and current source/translation visibility remain unchanged

#### Scenario: Reload restores size

- **WHEN** a Viewer selects a valid size and later reloads the same browser profile
- **THEN** the Viewer restores that size without requiring a new selection

#### Scenario: Storage is unavailable

- **WHEN** browser preference storage cannot be read or written
- **THEN** subtitle controls remain usable for the current page and the Viewer does not fail

### Requirement: Mobile controls and subtitles remain usable

The Viewer SHALL keep all three size controls operable at mobile viewport widths and SHALL wrap subtitle content without horizontal page or subtitle-viewport overflow.

#### Scenario: Select every size on a phone viewport

- **WHEN** a Viewer uses each size control at a 390 CSS-pixel-wide viewport
- **THEN** every control can be activated and its selected state is exposed to assistive technology

#### Scenario: Long bilingual text at the largest size

- **WHEN** long source and translated text render at the large size on a mobile viewport
- **THEN** text wraps within the subtitle viewport and neither the document nor subtitle viewport requires horizontal scrolling

### Requirement: Existing Viewer presentation remains available

The Viewer SHALL retain its title, meeting name, QR code, share link, source/translation visibility controls, fullscreen control, Cue history, and reading-position behavior when subtitle sizing is used.

#### Scenario: Existing controls remain present

- **WHEN** the Viewer changes subtitle size in inline or fullscreen presentation
- **THEN** the header, QR code, share link, visibility controls, fullscreen control, and existing Cues remain available

#### Scenario: Reading history while changing size

- **WHEN** a Viewer has scrolled away from the latest Cue and changes subtitle size
- **THEN** the Viewer preserves history mode and its stable reading anchor instead of forcing the view to the newest Cue

### Requirement: Delivery behavior is unchanged

Subtitle sizing SHALL be presentation-only and MUST NOT alter Viewer connection, recovery, Cue ordering, deduplication, snapshot, or replay behavior.

#### Scenario: New Cue arrives after size selection

- **WHEN** a Cue arrives through the existing delivery path after a size is selected
- **THEN** the Cue is merged and ordered by the existing rules and renders using the active size
