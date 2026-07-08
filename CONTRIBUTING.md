# Contributing

## Development Workflow

1. Read AGENTS.md
2. Read docs/ROADMAP.md
3. Identify the current capability
4. Check existing feature specs before creating new ones
5. Make minimal scoped changes
6. Update docs only when behavior changes
7. Run the smallest relevant tests
8. Report changed files and tests run

## Documentation Rules

- Do not create a new feature spec if an existing capability spec can be extended.
- Keep documentation minimal and scoped.
- Update ROADMAP.md when capability status changes.
- Update docs/TESTING.md when test commands change.
- Update CHANGELOG.md when a milestone or capability is completed.

## Testing Rules

- Run only relevant unit tests for small utility changes.
- Run E2E tests only for UI flow changes.
- Do not call real Gemini API unless explicitly enabled.
- Real Gemini tests require ENABLE_REAL_GEMINI_TEST=true.

## Safety Rules

- Do not expose GEMINI_API_KEY.
- Do not log ephemeral tokens.
- Do not commit secrets.
- Do not remove auth/rate limit/origin checks from /api/live-token.
- Do not change Gemini Live token flow unless explicitly requested.

## Scope Control

- Do not implement Phase 3 production features unless requested.
- Do not implement Auto Reconnect before Connection Resilience is planned.
- Do not add database, login, dashboard, or multi-user features without explicit approval.
