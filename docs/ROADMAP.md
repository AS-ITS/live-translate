# ROADMAP

This document helps AI coding agents and developers understand the intended project phases, current scope, and boundaries for future work.

## 1. Project Direction

This project is intended to evolve in the following order:

1. Phase 1 Demo
2. Phase 2 Internal Tool
3. Phase 3 Production

Each phase should build on the previous phase without expanding scope unless explicitly requested.

## 2. Current Status

Current milestone: v0.6.0 - Phase 2A Foundation.

Phase 1 Demo is completed. Phase 2A Foundation is completed. Phase 2 overall is
in progress and not completed.

Completed Phase 1 capabilities include:

- React frontend
- Node.js backend
- Gemini Live API integration
- Ephemeral token flow
- Real-time speech translation
- Target language selection
- Input/output transcripts
- Translated audio playback
- Start / Stop session
- Basic error handling
- Security hardening
- Testing documentation
- P0 hardening tests passed

Phase 2A Foundation completed:

- Transcript Engine
  - Better Transcript Handling
  - Transcript Export
- Audio Input Management
  - Audio Input Device Selection
- Session Design
  - Session Lifecycle Specification
- Connection Resilience
  - Failure Classification
  - Retry Policy
  - Reconnect Controller
  - Controlled `unexpected_close` reconnect
  - Failure-state mapping
- Session Records & Translation History
  - Session Records
  - History List
  - Session Detail
  - Saved Session Export

## 3. Phase 1 - Demo

Status: Completed

### Scope

- Real-time speech translation
- Target language selection
- Subtitle display
- Translated audio playback
- Start / Stop
- Local or controlled demo usage

### Non-Scope

- Login
- Database
- Dashboard
- Multi-user
- Persistent transcript history
- Payment
- Deployment automation

## 4. Phase 2 - Internal Tool

Status: In Progress. Phase 2A Foundation is completed; Phase 2B is planned.

### Candidate Features

- Basic login / access control
- Translation history. Deferred beyond the foundation milestone.
- Export transcript as TXT / SRT / VTT. Completed.
- Audio input device selection. Completed.
- Audio output device selection. Deferred.
- Recent target language. Deferred.
- Session history. Completed as the Phase 2A MVP.
- Session Lifecycle Specification. Completed.
- Connection Resilience. Phase 1 completed; depends on Session Lifecycle
  Specification.
  - Failure Classification
  - Retry Policy
  - Reconnect Controller
  - Controlled `unexpected_close` reconnect
  - Failure-state mapping
- AudioWorklet migration. Deferred.
- Better transcript handling. Completed.
- Usage logging. Deferred.
- Admin usage review. Deferred.

### Phase 2A Foundation

Completed:

- Transcript Engine
- Transcript Export
- Audio Input Device Selection
- Session Lifecycle
- Connection Resilience Phase 1
- Session Records
- History List
- Session Detail
- Saved Session Export

Deferred:

- Durable storage
- Backend persistence
- Search
- Bookmarks
- Delete
- Analytics
- Diagnostics dashboard
- Access control
- Token refresh
- Proactive reconnect
- Network reconnect
- Microphone reconnect
- Provider reconnect
- Settings
- Usage Metrics
- Diagnostics
- Transcript Search
- Audio Output Selection
- AudioWorklet migration

### Current Phase 2 Feature Status

- Phase 1 Demo: Completed
- Transcript Engine: Completed
  - Better Transcript Handling
  - Transcript Export
- Audio Input Management: Completed
  - Audio Input Device Selection
- Session Design: Completed
  - Session Lifecycle Specification
- Connection Resilience: Phase 1 Completed
  - Failure Classification
  - Retry Policy
  - Reconnect Controller
  - Controlled `unexpected_close` reconnect
  - Failure-state mapping
- Session Records & Translation History: MVP Completed
  - Session Records
  - History List
  - Session Detail
  - Saved Session Export
- Phase 2 overall: In Progress, Phase 2B next

### Phase 2 Planning Rule

Phase 2 capabilities should be grouped logically. Planning should prefer
capability specs that support related work instead of creating a new feature
spec for every small feature.

Completed capabilities:

- Transcript Engine
  - Better Transcript Handling
  - Transcript Export
- Audio Input Management
  - Audio Input Device Selection
- Session Design
  - Session Lifecycle Specification
- Connection Resilience
  - Failure Classification
  - Retry Policy
  - Reconnect Controller
  - Controlled `unexpected_close` reconnect
  - Failure-state mapping
- Session Records & Translation History
  - Session Records
  - History List
  - Session Detail
  - Saved Session Export

### Phase 2B - Planned

Current deferred capabilities:

- Settings
- Usage Metrics
- Diagnostics
- Transcript Search
- Storage, only if justified

## 5. Phase 3 - Production

Status: Future

### Candidate Features

- OAuth / SSO
- RBAC
- User management
- Team / organization support
- Monitoring
- Metrics
- Alerting
- Audit logs
- CI/CD
- Docker
- Production deployment guides
- Multi-user sessions
- Meeting translation mode
- Speaker diarization
- AI summary
- Transcript export / archive

## 6. Agent Guidance

- Always check ROADMAP.md before proposing new features.
- Do not implement Phase 2 or Phase 3 features unless explicitly requested.
- Keep Phase 1 stable.
- Prefer small scoped changes.
- When adding a feature, update ROADMAP.md status if relevant.
- If a request conflicts with current phase scope, ask for confirmation before implementation.

## 7. Definition of Done by Phase

### Phase 1 Demo DoD

- Core real-time speech translation flow works in a local or controlled demo environment.
- Users can select a target language.
- Input and output transcripts are visible during a session.
- Translated audio playback works.
- Users can start and stop a session.
- Basic error handling is present.
- Security hardening has been applied for the demo scope.
- Testing documentation exists.
- P0 hardening tests have passed.

### Phase 2 Internal Tool DoD

- Access is restricted with basic login or access control.
- Translation history or session history is available if selected for implementation.
- Transcript export is available if selected for implementation.
- Audio device selection is available if selected for implementation.
- Session reliability is improved through reconnect, token refresh, or equivalent safeguards.
- Usage logging and admin review are available if selected for implementation.
- Internal users can use the tool repeatedly with predictable behavior.

### Phase 3 Production DoD

- Production-grade authentication and authorization are implemented.
- User, team, or organization management is available if required.
- Monitoring, metrics, alerting, and audit logging are available.
- CI/CD and deployment guidance are in place.
- Production deployment is documented and repeatable.
- Multi-user, meeting translation, speaker diarization, AI summary, or archive features are implemented only if explicitly selected for production scope.
- Operational risks are documented and reviewed before launch.

## 8. Open Questions

- Is login required?
- Should translation records be saved?
- Should multi-person meeting support be added?
- Is formal deployment required?
- Which subtitle export formats are required?
