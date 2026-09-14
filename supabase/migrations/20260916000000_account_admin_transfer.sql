-- Issue #33: atomic account disable, asset transfer, and server-only audit records.
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id),
  action text not null,
  target_user_id uuid references auth.users(id),
  target_meeting_id uuid references public.meetings(id),
  request_id text,
  result text not null,
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant all on public.audit_logs to service_role;

alter table public.meeting_segments alter constraint meeting_segments_owner_user_id_meeting_id_fkey deferrable initially deferred;
alter table public.sessions alter constraint sessions_owner_user_id_meeting_id_fkey deferrable initially deferred;
alter table public.subtitle_cues alter constraint subtitle_cues_owner_user_id_session_id_fkey deferrable initially deferred;
alter table public.translation_requests alter constraint translation_requests_owner_user_id_subtitle_cue_id_fkey deferrable initially deferred;
alter table public.translation_executions alter constraint translation_executions_owner_user_id_translation_request_id_fkey deferrable initially deferred;
alter table public.translation_outputs alter constraint translation_outputs_owner_user_id_execution_id_fkey deferrable initially deferred;
alter table public.meeting_glossary_entries alter constraint meeting_glossary_entries_owner_user_id_meeting_id_fkey deferrable initially deferred;
alter table public.meeting_summaries alter constraint meeting_summaries_owner_user_id_meeting_id_fkey deferrable initially deferred;
alter table public.audio_artifacts alter constraint audio_artifacts_owner_user_id_meeting_id_fkey deferrable initially deferred;
alter table public.export_artifacts alter constraint export_artifacts_owner_user_id_meeting_id_fkey deferrable initially deferred;
alter table public.viewer_shares alter constraint viewer_shares_owner_user_id_meeting_id_fkey deferrable initially deferred;
alter table public.translation_queue_items alter constraint translation_queue_items_owner_user_id_fkey deferrable initially deferred;
alter table public.translation_dead_letter_items alter constraint translation_dead_letter_items_owner_user_id_fkey deferrable initially deferred;
alter table public.recorder_leases alter constraint recorder_leases_owner_user_id_session_id_fkey deferrable initially deferred;
alter table public.meeting_events alter constraint meeting_events_owner_user_id_meeting_id_fkey deferrable initially deferred;
alter table public.meeting_events alter constraint meeting_events_owner_user_id_segment_id_fkey deferrable initially deferred;

create or replace function public.disable_user_with_transfer(target_user_id uuid, transfer_to_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  source_profile public.profiles;
  target_profile public.profiles;
  remaining_super_admins integer;
begin
  select * into source_profile from public.profiles where id = target_user_id for update;
  select * into target_profile from public.profiles where id = transfer_to_user_id for update;
  if source_profile.id is null or target_profile.id is null then
    raise exception using errcode = '22023', message = 'Account not found.';
  end if;
  if source_profile.id = target_profile.id or target_profile.status <> 'active' then
    raise exception using errcode = '22023', message = 'Transfer target must be a different active account.';
  end if;
  if source_profile.role = 'super_admin' then
    select count(*) into remaining_super_admins from public.profiles
      where role = 'super_admin' and status = 'active' and id <> target_user_id;
    if remaining_super_admins < 1 then
      raise exception using errcode = '22023', message = 'The last super admin cannot be disabled.';
    end if;
  end if;

  update public.meeting_members set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meetings set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meeting_segments set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.sessions set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.subtitle_cues set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.translation_requests set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.translation_executions set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.translation_outputs set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.glossary_categories set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.glossary_entries set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meeting_glossary_entries set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meeting_summaries set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.audio_artifacts set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.export_artifacts set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
 update public.viewer_shares set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
 update public.translation_queue_items set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
 update public.translation_dead_letter_items set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
 update public.recorder_leases set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
 update public.meeting_events set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;

  update public.profiles set status = 'disabled', disabled_at = now(), updated_at = now() where id = target_user_id returning * into source_profile;
  return source_profile;
end;
$$;

revoke all on function public.disable_user_with_transfer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.disable_user_with_transfer(uuid, uuid) to service_role;
