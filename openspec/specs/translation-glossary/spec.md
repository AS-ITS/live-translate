# Translation Glossary

## Purpose

Define the implemented effective glossary, provider Segment snapshot, and local correction revision boundaries. This spec does not promise that Gemini follows glossary instructions or define glossary-import scale limits.

## Requirements

### Requirement: Effective glossary revision is deterministic

The effective glossary revision MUST be computed from the versioned canonical payload of source language, target language, and normalized entries. Reordering equivalent entries or aliases SHALL NOT change the revision; a meaningful source, target, alias, or language change SHALL change it.

#### Scenario: Equivalent entries arrive in a different order

- **GIVEN** two effective glossaries contain equivalent normalized entries and aliases for the same language pair
- **WHEN** their revisions are computed with different entry or alias ordering
- **THEN** both revisions are identical

#### Scenario: An effective term changes

- **GIVEN** an effective glossary revision already exists
- **WHEN** a source term, target term, replacement alias, or language code changes
- **THEN** the resulting revision differs from the previous revision

### Requirement: Meeting terms override matching global terms

The effective Meeting glossary SHALL merge selected global terms with Meeting-local terms and use the Meeting-local target for a matching source term. It SHALL retain correction aliases according to the current merge contract.

#### Scenario: A Meeting overrides a global source term

- **GIVEN** a selected global term and a Meeting-local term share the same source
- **WHEN** the effective Meeting glossary is assembled for the target language
- **THEN** the Meeting-local target is used and the merge contract's correction aliases remain available

### Requirement: Provider glossary uses the authoritative Segment snapshot

The Live token configuration for a Meeting Segment MUST derive its effective provider glossary from that Segment's authoritative settings snapshot. Edits to Meeting settings during recording SHALL NOT alter the current Segment's provider glossary; a later Segment MAY receive a new snapshot and revision.

#### Scenario: Glossary is edited during an active Segment

- **GIVEN** an active Segment has a glossary snapshot and the Meeting settings are edited
- **WHEN** a token is issued again for that same authoritative Segment
- **THEN** the provider glossary and revision remain those of the Segment snapshot

#### Scenario: A later Segment uses changed settings

- **GIVEN** the Meeting glossary changed after the current Segment snapshot
- **WHEN** a later Segment is created with the changed settings snapshot and receives a token
- **THEN** its effective provider glossary reflects that later snapshot

### Requirement: Local correction binds a stable Turn to its first revision

The local correction glossary registry MUST bind a Turn with a stable identity to the active correction revision when first seen. Later updates to that same Turn SHALL use its bound revision; a new Turn SHALL use the latest active revision.

#### Scenario: Existing Turn finalizes after a glossary edit

- **GIVEN** Turn A was bound to revision A and revision B subsequently became active
- **WHEN** a late final event for Turn A and a new Turn B are processed
- **THEN** Turn A continues to use revision A and Turn B uses revision B

## Evidence by Requirement

- Deterministic revision: `src/lib/glossaryRevision.js` (`effective-glossary-v1`, normalization, sorting, SHA-256); `tests/unit/glossaryRevision.test.js` checks reorder equivalence, browser/server hash agreement, and changed inputs.
- Meeting override: `src/lib/meetingGlossary.js` (`effectiveMeetingGlossaryEntries`, `mergeMeetingGlossaryEntries`); `tests/unit/meetingGlossary.test.js` checks same-source override and alias retention, and `tests/unit/glossaryContinueContract.test.js` checks token configuration.
- Segment snapshot: `server/tokenService.js` authoritative Segment binding and `src/lib/meetingGlossary.js`; `tests/unit/glossaryContinueContract.test.js` checks Save-then-Continue revisions, same-Segment reconnect, and later-Segment settings.
- Turn correction binding: `src/lib/correctionGlossarySnapshot.js` (`createCorrectionGlossaryRegistry`, `bindTurn`) and `src/lib/glossaryReplacement.js`; `tests/unit/correctionGlossarySnapshot.test.js` checks late-final and new-Turn revisions, and `tests/unit/glossaryReplacement.test.js` checks Cue-owned correction.

## Known Limits and Unverified Conditions

- Unit, mocked HTTP, and token-configuration tests do not establish real Gemini adherence, Preview/Production verification, large-glossary quality, or concurrent-edit behavior.
- A Turn without a stable identity uses the current snapshot without a persistent binding; the stable-Turn Scenario does not apply to it.
- Global/Meeting CRUD and CSV/JSON/XLSX import routes have source and route-test evidence, but their full persistence/invalid-row semantics were not established for this narrow current-contract baseline. They remain in the audit for a later focused migration, not an implied requirement here.
