-- Historical non-completed deadlines are not reliable deletion evidence.
create or replace function public.meeting_recording_accessible(p_owner_user_id uuid, p_meeting_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.meetings meeting
    where meeting.owner_user_id = p_owner_user_id and meeting.id = p_meeting_id
      and not exists (select 1 from public.meeting_deletions where meeting_id = meeting.id)
      and (meeting.status <> 'completed' or meeting.retention_policy_version <> 2
        or meeting.purge_at is null or meeting.purge_at > now())
  );
$$;
