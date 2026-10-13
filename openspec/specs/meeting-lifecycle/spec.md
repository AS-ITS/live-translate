# Meeting Lifecycle

## Purpose

Define the implemented lifecycle-v2 Meeting, Session, Segment, command, and recorder-write boundaries. This is a program-level contract, not a claim that a particular Preview or Production database has these migrations deployed.

## Requirements

### Requirement: One open Session and one active Segment per lifecycle-v2 Meeting

For a Meeting with `lifecycle_contract_version = 2`, persistence SHALL permit at most one Session in `created`, `active`, or `paused` status and at most one `active` Segment for that Meeting.

#### Scenario: A second open Session is attempted

- **GIVEN** a lifecycle-v2 Meeting already has a Session in an open status
- **WHEN** another open Session for the same owner and Meeting is inserted
- **THEN** the persistence uniqueness constraint rejects the second open Session

#### Scenario: A second active Segment is attempted

- **GIVEN** a lifecycle-v2 Meeting already has an active Segment
- **WHEN** another active Segment for that Meeting is inserted
- **THEN** the persistence uniqueness constraint rejects the second active Segment

### Requirement: Lifecycle-v2 commands use operation identity and optimistic version

The lifecycle-v2 command RPC MUST use `operationId` and `expectedLifecycleVersion`. It SHALL return the recorded result for an identical repeated operation, reject reuse of that identity with a different command or payload, and reject a new operation whose expected lifecycle version is stale.

#### Scenario: Identical command is retried

- **GIVEN** a lifecycle-v2 command has committed with a particular operation ID
- **WHEN** the same command, operation ID, and request payload are submitted again
- **THEN** the RPC returns the recorded result marked as replayed without creating a second lifecycle boundary

#### Scenario: A fresh command carries a stale version

- **GIVEN** the Meeting lifecycle version has advanced
- **WHEN** a new operation ID is submitted with an older expected lifecycle version
- **THEN** the RPC rejects it with `meeting_lifecycle_conflict`

### Requirement: Lifecycle-v2 recorder writes require the current fence

The lifecycle-v2 recorder write validator MUST require a current Session and active Segment, matching lease ID and fence token, and an unexpired lease. It SHALL reject a stale or incomplete writer as `recorder_lease_invalid`; lifecycle-v1 compatibility is outside this requirement.

#### Scenario: Stale recorder attempts a write

- **GIVEN** a lifecycle-v2 Meeting has an active Segment and a newer valid recorder fence
- **WHEN** a writer presents an old fence token or expired lease
- **THEN** write validation rejects it as `recorder_lease_invalid` before persistence

## Evidence by Requirement

- One open Session and one active Segment: `supabase/migrations/20260924000000_issue37_meeting_lifecycle_v2.sql` defines both partial unique indexes; `tests/unit/meetingLifecycleMigration.test.js` checks their presence in the migration text.
- Lifecycle-v2 commands: `src/infrastructure/supabaseMeetingLifecycleService.js` forwards identity/version; the lifecycle-v2 SQL migration checks operation replay before version. `tests/unit/meetingLifecycleMigration.test.js` checks RPC presence, while `tests/unit/meetingCheckpointService.test.js` exercises repeated/conflicting rollover in the local service. SQL replay is not deployment-tested here.
- Current recorder fence: `supabase/migrations/20260924010000_issue37_validate_recorder_fence.sql` defines the validator; `src/infrastructure/supabaseMeetingLifecycleService.js` invokes it. `tests/unit/meetingLifecycleMigration.test.js` checks fence/expiry predicates and `tests/unit/meetingLifecycleHttpApi.test.js` checks stale-fence rejection.

## Known Limits and Unverified Conditions

- The migration and unit/HTTP test evidence does not establish the migration head, RLS state, concurrency behavior, or successful lifecycle execution in Preview or Production.
- The older file-backed lifecycle and lifecycle-v1 compatibility paths are not redefined here. Real provider rollover, lease takeover under deployed concurrency, and retention/deletion operations need separate verification.
- A repeated command with the same operation ID is checked before the expected-version guard; the stale-version Scenario deliberately uses a **new** operation ID.
