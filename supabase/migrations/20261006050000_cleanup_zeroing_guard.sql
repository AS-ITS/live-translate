-- Content zeroing is the sole write allowed after expiry. It cannot change
-- identity, status, or any other field, and remains blocked by authenticated
-- restrictive RLS; only the service-role cleanup RPC can reach it.
create or replace function public.enforce_meeting_recording_write()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare target_meeting_id uuid;
declare target_owner_id uuid := new.owner_user_id;
declare target_status text;
begin
  if tg_table_name = 'subtitle_cues' then
    select meeting_id into target_meeting_id from public.sessions
      where owner_user_id = target_owner_id and id = new.session_id;
  elsif tg_table_name = 'translation_requests' then
    select s.meeting_id into target_meeting_id from public.subtitle_cues c
      join public.sessions s on s.id = c.session_id
      where c.owner_user_id = target_owner_id and c.id = new.cue_id;
  elsif tg_table_name = 'translation_executions' then
    select s.meeting_id into target_meeting_id from public.translation_requests q
      join public.subtitle_cues c on c.id = q.cue_id
      join public.sessions s on s.id = c.session_id
      where q.owner_user_id = target_owner_id and q.id = new.translation_request_id;
  elsif tg_table_name = 'translation_outputs' then
    select s.meeting_id into target_meeting_id from public.translation_executions e
      join public.translation_requests q on q.id = e.translation_request_id
      join public.subtitle_cues c on c.id = q.cue_id
      join public.sessions s on s.id = c.session_id
      where e.owner_user_id = target_owner_id and e.id = new.translation_execution_id;
  else
    target_meeting_id := (to_jsonb(new)->>'meeting_id')::uuid;
  end if;
  if target_meeting_id is null then return new; end if;
  select status into target_status from public.meetings
    where id = target_meeting_id and owner_user_id = target_owner_id;
  if tg_op = 'UPDATE' then
    if tg_table_name = 'meeting_segments' then
      if new.checkpoint = '{}'::jsonb and
        to_jsonb(new) - 'checkpoint' = to_jsonb(old) - 'checkpoint' then
        return new;
      end if;
    elsif tg_table_name = 'sessions' then
      if new.payload = '{}'::jsonb and new.transcript_items = '[]'::jsonb and
        to_jsonb(new) - 'payload' - 'transcript_items' = to_jsonb(old) - 'payload' - 'transcript_items' then
        return new;
      end if;
    end if;
  end if;
  if not public.meeting_recording_accessible(target_owner_id, target_meeting_id) then
    raise exception 'meeting_content_expired' using errcode = 'P0001';
  end if;
  if target_status = 'completed' then
    if tg_table_name = 'sessions' then
      if new.status in ('active', 'paused') then
        raise exception 'meeting_terminal' using errcode = 'P0001';
      end if;
    elsif tg_table_name = 'meeting_segments' then
      if new.status = 'active' then
        raise exception 'meeting_terminal' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
