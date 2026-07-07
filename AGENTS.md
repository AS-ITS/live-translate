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
- Read `docs/architecture.md` after the spec.
- Read `docs/api.md` before changing APIs.
- Read `TESTING.md` before making or validating test-related changes.
- Do not add features that were not requested.
- Do not modify the core Live API session unless the task explicitly requires it.
- Prefer the smallest safe change that satisfies the request.
- Preserve existing behavior unless the request requires a behavior change.

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
