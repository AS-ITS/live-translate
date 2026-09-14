-- Issue #33 follow-up: keep the deployed transfer contract correct without
-- rewriting 20260916000000_account_admin_transfer.sql.
create or replace function public.disable_user_with_transfer(target_user_id uuid, transfer_to_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  source_profile public.profiles;
  transfer_profile public.profiles;
  active_admin_count integer;
begin
  if target_user_id is null or transfer_to_user_id is null or target_user_id = transfer_to_user_id then
    raise exception using errcode = '22023', message = 'A distinct transfer target is required.';
  end if;

  select * into source_profile from public.profiles where id = target_user_id for update;
  if source_profile.id is null then
    raise exception using errcode = 'P0002', message = 'Account not found.';
  end if;
  select * into transfer_profile from public.profiles where id = transfer_to_user_id for update;
  if transfer_profile.id is null or transfer_profile.status <> 'active' then
    raise exception using errcode = '22023', message = 'Transfer target must be active.';
  end if;
  if source_profile.role = 'super_admin' and source_profile.status = 'active' then
    select count(*) into active_admin_count from public.profiles
      where role = 'super_admin' and status = 'active';
    if active_admin_count <= 1 then
      raise exception using errcode = '22023', message = 'The last super admin cannot be disabled.';
    end if;
  end if;

  -- All updates are in this function's transaction. No credentials table is
  -- included intentionally.
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

  update public.profiles set status = 'disabled', disabled_at = now(), updated_at = now()
    where id = target_user_id returning * into source_profile;
  return source_profile;
end;
$$;

revoke all on function public.disable_user_with_transfer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.disable_user_with_transfer(uuid, uuid) to service_role;
