alter table public.meeting_members
  add column if not exists can_record boolean not null default true;

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);
