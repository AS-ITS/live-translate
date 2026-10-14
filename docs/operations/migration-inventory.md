STATUS: CANCELLED_BY_STRATEGY_CHANGE
REPLACED_BY: SCHEMA_ONLY_MIGRATION
DATA_MIGRATION: CANCELLED

STATUS: CANCELLED_BY_STRATEGY_CHANGE
REPLACED_BY: SCHEMA_ONLY_MIGRATION
DATA_MIGRATION: CANCELLED
# Migration Inventory & Dependency Order

## 1. Data Classification

| Table / Object | Classification | Rationale |
| :--- | :--- | :--- |
| auth.users | MUST_MIGRATE | Identity Root |
| auth.identities | MUST_MIGRATE | Auth Provider Link |
| public.profiles | MUST_MIGRATE | User Profile Info |
| public.meetings | MUST_MIGRATE | Core Entity |
| public.sessions | MUST_MIGRATE | Meeting Session |
| public.meeting_segments | MUST_MIGRATE | Session breakdown |
| public.subtitle_cues | MUST_MIGRATE | Actual Translation data |
| public.checkpoints | MUST_MIGRATE | State markers |
| public.dictionaries | MUST_MIGRATE | User-defined terms |
| public.meeting_recordings | MUST_MIGRATE | Recording metadata |
| public.audit_logs | MUST_MIGRATE | Compliance/Audit |
| public.meeting_members | MUST_MIGRATE | Membership tracking |
| public.meeting_events | MUST_MIGRATE | Timeline events |
| public.meeting_lifecycle_operations | MUST_MIGRATE | State machine history |
| public.meeting_glossary_entries | MUST_MIGRATE | Meeting-specific terms |
| public.glossary_categories | MUST_MIGRATE | Glossary structure |
| public.glossary_entries | MUST_MIGRATE | Global glossary |
| public.translation_requests | MUST_MIGRATE | Translation jobs |
| public.translation_executions | MUST_MIGRATE | Job execution details |
| public.translation_outputs | MUST_MIGRATE | Job results |
| public.translation_queue_items | MUST_MIGRATE | Current queue state |
| public.audio_artifacts | MUST_MIGRATE | Audio metadata |
| public.export_artifacts | MUST_MIGRATE | Export metadata |
| public.viewer_shares | MUST_MIGRATE | Access control |
| public.recorder_leases | MUST_MIGRATE | Recorder ownership |
| public.meeting_cleanup_throttle | MUST_MIGRATE | Cleanup state |
| public.meeting_deletions | MUST_MIGRATE | Deletion markers |
| public.background_job_dead_letters | OPTIONAL | Debugging info |
| public.translation_dead_letter_items | OPTIONAL | Debugging info |
| public.observability_metric_buckets | EPHEMERAL | Monitoring metrics |

## 2. Dependency Order (Insertion Order)

To maintain referential integrity, data must be migrated in the following levels:

**Level 0: Auth Core**
- `auth.users`
- `auth.identities`

**Level 1: User Profiles & Global Config**
- `public.profiles`
- `public.glossary_categories`
- `public.glossary_entries`

**Level 2: Meeting Root**
- `public.meetings`

**Level 3: Meeting Structural Context**
- `public.meeting_members`
- `public.meeting_recordings`
- `public.meeting_summaries`
- `public.meeting_lifecycle_operations`
- `public.meeting_deletions`

**Level 4: Session Context**
- `public.sessions` (Depends on meetings, recordings)

**Level 5: Segment Context**
- `public.meeting_segments` (Depends on sessions)

**Level 6: Detailed Data (Cues, Events)**
- `public.subtitle_cues` (Depends on segments)
- `public.meeting_events` (Depends on segments)
- `public.checkpoints`
- `public.meeting_glossary_entries` (Depends on glossary_entries)

**Level 7: Async Processing & Artifacts**
- `public.translation_requests` (Depends on cues)
- `public.translation_executions` (Depends on requests)
- `public.translation_outputs` (Depends on executions)
- `public.translation_queue_items`
- `public.audio_artifacts` (Depends on meetings/sessions/segments)
- `public.export_artifacts` (Depends on meetings)

**Level 8: Metadata & Audit**
- `public.audit_logs`
- `public.viewer_shares`
- `public.recorder_leases`
- `public.meeting_cleanup_throttle`

**Level 9: Error Logs**
- `public.background_job_dead_letters`
- `public.translation_dead_letter_items`
- `public.observability_metric_buckets`
