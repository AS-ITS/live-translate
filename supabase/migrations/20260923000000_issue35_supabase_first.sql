-- Issue #35: complete the member read matrix and make cloud meeting creation
-- atomic. Member policies are read-only; the owner policies from the cloud
-- foundation migration remain the only write path for these tables.

create index if not exists meeting_glossary_entries_owner_meeting_idx
  on public.meeting_glossary_entries(owner_user_id, meeting_id, glossary_entry_id);

create index if not exists meeting_summaries_owner_meeting_idx
  on public.meeting_summaries(owner_user_id, meeting_id, version desc);

create index if not exists audio_artifacts_owner_meeting_idx
  on public.audio_artifacts(owner_user_id, meeting_id, created_at);

create index if not exists export_artifacts_owner_meeting_idx
  on public.export_artifacts(owner_user_id, meeting_id, created_at desc);

create index if not exists meeting_members_user_owner_meeting_idx
  on public.meeting_members(user_id, owner_user_id, meeting_id);

alter table public.audit_logs drop constraint if exists audit_logs_action_check;
alter table public.audit_logs add constraint audit_logs_action_check check (
  action in (
    'member_invited', 'member_removed', 'member_recording_permission_changed',
    'user_approved', 'user_enabled', 'user_disabled', 'asset_transfer', 'auth_login'
  )
);

drop policy if exists meeting_members_member_select on public.meeting_members;
create policy meeting_members_member_select
  on public.meeting_members
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or owner_user_id = auth.uid()
    or public.is_super_admin()
  );

drop policy if exists meeting_glossary_entries_member_select on public.meeting_glossary_entries;
create policy meeting_glossary_entries_member_select
  on public.meeting_glossary_entries
  for select
  to authenticated
  using (
    public.is_active_meeting_member(owner_user_id, meeting_id)
    or public.is_super_admin()
  );

drop policy if exists meeting_summaries_member_select on public.meeting_summaries;
create policy meeting_summaries_member_select
  on public.meeting_summaries
  for select
  to authenticated
  using (
    public.is_active_meeting_member(owner_user_id, meeting_id)
    or public.is_super_admin()
  );

create or replace function public.create_meeting_with_initial_segment(
  p_meeting jsonb,
  p_segment jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted_meeting public.meetings;
  inserted_segment public.meeting_segments;
  meeting_owner uuid;
  segment_owner uuid;
  segment_meeting uuid;
begin
  meeting_owner := nullif(p_meeting->>'owner_user_id', '')::uuid;
  segment_owner := nullif(p_segment->>'owner_user_id', '')::uuid;
  segment_meeting := nullif(p_segment->>'meeting_id', '')::uuid;

  if auth.uid() is null or meeting_owner is null or meeting_owner <> auth.uid()
     or segment_owner is distinct from meeting_owner
     or segment_meeting is distinct from nullif(p_meeting->>'id', '')::uuid then
    raise exception using errcode = '42501', message = 'meeting owner does not match authenticated user';
  end if;

  insert into public.meetings
  select * from jsonb_populate_record(null::public.meetings, p_meeting)
  returning * into inserted_meeting;

  insert into public.meeting_segments
  select * from jsonb_populate_record(null::public.meeting_segments, p_segment)
  returning * into inserted_segment;

  return jsonb_build_object(
    'meeting', to_jsonb(inserted_meeting),
    'segment', to_jsonb(inserted_segment)
  );
end;
$$;

revoke all on function public.create_meeting_with_initial_segment(jsonb, jsonb) from public, anon;
grant execute on function public.create_meeting_with_initial_segment(jsonb, jsonb) to authenticated;
