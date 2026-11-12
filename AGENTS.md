# AGENTS.md

This document defines project-specific working rules for AI coding agents working on the Gemini Live Translate Web App.

## 1. Project Context

This project is a Gemini Live Translate Web App. Its purpose is to provide real-time speech translation through a web interface, using a React frontend, a Node.js backend, and the Gemini Live API.

The project roadmap is:

1. Phase 1 Demo
2. Phase 2 Internal Tool
3. Phase 3 Production

Phase 1 Demo is currently completed. Future work should move toward Phase 2 and Phase 3 only when explicitly requested.

Core architecture:

- React frontend
- Node.js backend
- Gemini Live API integration
- Ephemeral token flow
- Backend-owned `GEMINI_API_KEY`
- Frontend session startup through backend-issued ephemeral tokens

## 2. Development Principles

- Read `docs/spec.md` first.
- Read `docs/architecture/architecture-overview.md` after the spec.
- Use `docs/architecture/architecture-overview.md` as the main architecture entry; consult `docs/architecture.md` only for older detailed design notes.
- Read `docs/api.md` before changing APIs.
- Read `docs/TESTING.md` before making or validating test-related changes.
- Check `CHANGELOG.md` before starting milestone-related work.
- Follow `CONTRIBUTING.md` for development workflow.
- Do not add features that were not requested.
- Do not modify the core Live API session unless the task explicitly requires it.
- Prefer the smallest safe change that satisfies the request.
- Preserve existing behavior unless the request requires a behavior change.
- Phase 2 follow-up development should be capability-centered.
- Do not create a separate feature spec for every small feature.
- One feature spec should usually support 2-3 related implementation features.
- Add a new `docs/features/*.md` file only when existing specs cannot support
  the design.
- Before creating a new feature spec, check whether an existing spec can be
  extended.
- Keep documentation minimal, scoped, and maintainable.
- Update `CHANGELOG.md` when completing a capability or milestone.
- Do not keep expanding documentation unless it supports the current capability.
- Before modifying cross-cutting architecture or multiple capabilities, read
  `docs/architecture/architecture-overview.md`.

## Decision Gate

Before making any architectural or workflow change, determine its impact.

### Minor Change

Examples:
- Utility functions
- Bug fixes
- Tests
- Documentation updates

Action:
- Implement directly within the requested scope.

### Medium Change

Examples:
- New feature within an existing capability
- New UI component
- New internal module

Action:
- Confirm the existing feature specification is sufficient before implementation.
- If the existing spec is sufficient, proceed with minimal scoped changes.
- If the spec is insufficient, stop and report the missing requirements.

### Major Change

Examples:
- New capability
- Architecture change
- New dependency
- Data model change
- Backend API change
- Security model change
- Gemini Live integration change
- Ephemeral token flow change

Action:
- Stop implementation.
- Propose the design first.
- Wait for user approval before coding.

## Architecture Protection

Do not change these areas unless the requested task explicitly requires it:

- Gemini Live integration flow
- Ephemeral token architecture
- Security model
- Transcript engine
- Session lifecycle
- Testing strategy

Prefer extending existing architecture over replacing it.

## Regression Protection

Before modifying an existing module:

- Identify its current responsibilities.
- Preserve current behavior unless explicitly requested.
- Run the smallest relevant tests.
- Report potential regression risks.

Do not introduce behavior changes without documenting them.

## 3. Agent Workflow

1. Understand the request.
2. Inspect relevant docs.
3. Inspect the current implementation.
4. Make minimal scoped changes.
5. Update docs when behavior changes.
6. Run the smallest relevant tests.
7. Report changed files and rationale.

## 4. Phase Rules

### Phase 1 Demo

- Do not add login.
- Do not add a database.
- Do not add a dashboard.
- Do not add multi-user support.
- Do not add transcript persistence.
- Keep the MVP simple.

### Phase 2 Internal Tool

- Login may be added.
- Translation history may be added.
- Subtitle export may be added.
- Device selection may be added.
- Usage records may be added.
- Before implementing Auto Reconnect or Token Refresh, read
  `docs/features/session-lifecycle.md` and
  `docs/features/connection-resilience.md`.
- Before implementing Session History or Usage Logging, read
  `docs/features/session-lifecycle.md`.
- Do not implement reconnect behavior unless explicitly requested.

### Phase 3 Production

- OAuth / SSO may be added.
- RBAC may be added.
- Monitoring may be added.
- CI/CD may be added.
- Docker may be added.
- Production operations capabilities may be added.

## 5. Security Rules

- Never expose `GEMINI_API_KEY` to the frontend.
- Never log `GEMINI_API_KEY`.
- Never log ephemeral tokens.
- `/api/live-token` must keep its auth gate.
- `/api/live-token` must keep its rate limit.
- Origin checks must be preserved.
- Error messages must not expose internal stack traces.

## 6. Testing Rules

- When modifying audio/lib code, run audio unit tests.
- When modifying the server token API, run integration tests.
- When modifying UI flow, run E2E tests.
- Real Gemini tests may run only when `ENABLE_REAL_GEMINI_TEST=true`.
- Do not call the real Gemini API by default.
- Use the smallest relevant validation command for the changed files.

## 7. Coding Rules

- Prefer small changes.
- Do not perform large-scale refactors.
- Do not change UI appearance unless the task requires it.
- Do not add packages unless necessary, and explain why.
- Do not modify `.env`.
- Do not commit secrets.
- Keep production code and test code separate.

## 8. Reporting Format

After each completed task, report:

- Summary
- Changed Files
- Tests Run
- Risks / TODO
- Next Recommended Step

## 9. Out of Scope Unless Explicitly Requested

- Database
- User accounts
- Payment
- Dashboard
- Meeting room features
- Unrelated AI model benchmark
- Deployment automation

## 10. Definition of Done

A task is considered complete only if:

- Functional requirements are satisfied.
- Related documentation is updated if behavior changed.
- Relevant tests pass.
- No secrets are exposed.
- Existing functionality is not regressed.
- Code follows project conventions.
- Scope stays within the current project phase.

## Documentation Stop Rule

Documentation should support implementation, not replace it.

Before creating a new document, verify whether the required information can be incorporated into an existing document.

Only create a new Markdown document when:
- A new capability is introduced.
- Existing documentation cannot accurately represent the new design.
- The user explicitly requests a separate document.

Otherwise:
- Extend existing documentation.
- Keep documentation concise.
- Avoid duplicate specifications.

## Capability Boundary Rule

Every capability should own a clear responsibility.

Avoid expanding an existing capability beyond its original scope.

If a capability grows to include multiple independent implementation areas,
prefer creating a new capability specification rather than continually expanding
an existing one.

Capability specifications should remain cohesive and maintainable.
