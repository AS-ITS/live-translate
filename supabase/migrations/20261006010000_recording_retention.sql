-- A recording is a durable meeting-owned capture, not a provider or Session id.
-- Existing rows are left unmapped: their historical end time is not trustworthy.
create table public.meeting_recordings (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  meeting_id uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  expires_at timestamptz,
  cleanup_state text not null default 'not_due'
    check (cleanup_state in ('not_due', 'pending', 'claimed', 'cleared', 'failed')),
  claimed_at timestamptz,
  claimed_by text,
  cleanup_attempt_count integer not null default 0,
  cleanup_last_error text,
  unique (owner_user_id, meeting_id, id),
  foreign key (owner_user_id, meeting_id)
    references public.meetings (owner_user_id, id) on delete cascade,
  check ((ended_at is null and expires_at is null) or expires_at = ended_at + interval '30 minutes')
);

create unique index meeting_recordings_one_open_per_meeting_idx
  on public.meeting_recordings (owner_user_id, meeting_id)
  where ended_at is null;
create index meeting_recordings_due_idx
  on public.meeting_recordings (cleanup_state, expires_at)
  where cleanup_state in ('pending', 'failed', 'claimed') and expires_at is not null;

alter table public.sessions add column recording_id uuid;
alter table public.sessions add constraint sessions_meeting_recording_fkey
  foreign key (owner_user_id, meeting_id, recording_id)
  references public.meeting_recordings (owner_user_id, meeting_id, id)
  deferrable initially deferred;
create index sessions_recording_idx on public.sessions (owner_user_id, meeting_id, recording_id);

alter table public.meeting_recordings enable row level security;
revoke all on public.meeting_recordings from public, anon, authenticated;
grant select, insert, update, delete on public.meeting_recordings to service_role;

create or replace function public.assign_meeting_recording()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  target_meeting public.meetings%rowtype;
  current_recording_id uuid;
begin
  if new.meeting_id is null then return new; end if;
  select * into target_meeting from public.meetings
  where id = new.meeting_id and owner_user_id = new.owner_user_id for update;
  if target_meeting.id is null or target_meeting.status = 'completed'
     or exists (select 1 from public.meeting_deletions where meeting_id = new.meeting_id) then
    raise exception 'meeting_terminal' using errcode = 'P0001';
  end if;
  select id into current_recording_id from public.meeting_recordings
  where owner_user_id = new.owner_user_id and meeting_id = new.meeting_id and ended_at is null
  for update;
  if current_recording_id is null then
    insert into public.meeting_recordings (owner_user_id, meeting_id)
    values (new.owner_user_id, new.meeting_id) returning id into current_recording_id;
  end if;
  if new.recording_id is not null and new.recording_id <> current_recording_id then
    raise exception 'recording_mismatch' using errcode = 'P0001';
  end if;
  new.recording_id := current_recording_id;
  return new;
end;
$$;

create trigger sessions_assign_meeting_recording before insert on public.sessions
for each row execute function public.assign_meeting_recording();

create or replace function public.keep_session_recording_identity()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.recording_id is distinct from old.recording_id
     or new.meeting_id is distinct from old.meeting_id then
    raise exception 'recording_identity_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger sessions_keep_recording_identity before update of recording_id, meeting_id on public.sessions
for each row execute function public.keep_session_recording_identity();

create or replace function public.freeze_meeting_recording_deadline()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and old.status = 'completed' then
    if new.status <> 'completed' then
      raise exception 'meeting_terminal' using errcode = 'P0001';
    end if;
    new.ended_at := old.ended_at;
    new.purge_at := old.purge_at;
    return new;
  end if;
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then
    new.ended_at := clock_timestamp();
    new.purge_at := new.ended_at + interval '30 minutes';
    new.retention_policy_version := 2;
    new.purge_status := 'pending';
  elsif new.status <> 'completed' then
    new.purge_at := null;
    new.purge_status := 'not_scheduled';
  end if;
  return new;
end;
$$;

create trigger meetings_freeze_recording_deadline
before insert or update of status, ended_at, purge_at on public.meetings
for each row execute function public.freeze_meeting_recording_deadline();

create or replace function public.finish_meeting_recordings()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'completed' and old.status <> 'completed' then
    update public.meeting_recordings
    set ended_at = new.ended_at,
        expires_at = new.purge_at,
        cleanup_state = 'pending'
    where owner_user_id = new.owner_user_id and meeting_id = new.id and ended_at is null;
  end if;
  return null;
end;
$$;
create trigger meetings_finish_recordings after update of status on public.meetings
for each row execute function public.finish_meeting_recordings();

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
revoke all on function public.meeting_recording_accessible(uuid, uuid) from public, anon;
grant execute on function public.meeting_recording_accessible(uuid, uuid) to authenticated, service_role;

create or replace function public.meeting_recording_accessible_for_segment(p_owner uuid, p_segment uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.meeting_recording_accessible(owner_user_id, meeting_id)
    from public.meeting_segments where owner_user_id = p_owner and id = p_segment), false);
$$;
create or replace function public.meeting_recording_accessible_for_session(p_owner uuid, p_session uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select meeting_id is null or public.meeting_recording_accessible(owner_user_id, meeting_id)
    from public.sessions where owner_user_id = p_owner and id = p_session), false);
$$;
create or replace function public.meeting_recording_accessible_for_cue(p_owner uuid, p_cue text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.meeting_recording_accessible_for_session(owner_user_id, session_id)
    from public.subtitle_cues where owner_user_id = p_owner and id = p_cue), false);
$$;
create or replace function public.meeting_recording_accessible_for_request(p_owner uuid, p_request uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.meeting_recording_accessible_for_cue(owner_user_id, cue_id)
    from public.translation_requests where owner_user_id = p_owner and id = p_request), false);
$$;
create or replace function public.meeting_recording_accessible_for_execution(p_owner uuid, p_execution uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.meeting_recording_accessible_for_request(owner_user_id, translation_request_id)
    from public.translation_executions where owner_user_id = p_owner and id = p_execution), false);
$$;
grant execute on function public.meeting_recording_accessible_for_segment(uuid, uuid),
  public.meeting_recording_accessible_for_session(uuid, uuid),
  public.meeting_recording_accessible_for_cue(uuid, text),
  public.meeting_recording_accessible_for_request(uuid, uuid),
  public.meeting_recording_accessible_for_execution(uuid, uuid) to authenticated, service_role;

create policy meeting_segments_retention_guard on public.meeting_segments as restrictive for all to authenticated
  using (public.meeting_recording_accessible(owner_user_id, meeting_id))
  with check (public.meeting_recording_accessible(owner_user_id, meeting_id));
create policy sessions_retention_guard on public.sessions as restrictive for all to authenticated
  using (meeting_id is null or public.meeting_recording_accessible(owner_user_id, meeting_id))
  with check (meeting_id is null or public.meeting_recording_accessible(owner_user_id, meeting_id));
create policy subtitle_cues_retention_guard on public.subtitle_cues as restrictive for all to authenticated
  using (public.meeting_recording_accessible_for_session(owner_user_id, session_id))
  with check (public.meeting_recording_accessible_for_session(owner_user_id, session_id));
create policy audio_artifacts_retention_guard on public.audio_artifacts as restrictive for all to authenticated
  using (meeting_id is null or public.meeting_recording_accessible(owner_user_id, meeting_id))
  with check (meeting_id is null or public.meeting_recording_accessible(owner_user_id, meeting_id));
create policy export_artifacts_retention_guard on public.export_artifacts as restrictive for all to authenticated
  using (meeting_id is null or public.meeting_recording_accessible(owner_user_id, meeting_id))
  with check (meeting_id is null or public.meeting_recording_accessible(owner_user_id, meeting_id));
create policy meeting_events_retention_guard on public.meeting_events as restrictive for all to authenticated
  using (public.meeting_recording_accessible(owner_user_id, meeting_id))
  with check (public.meeting_recording_accessible(owner_user_id, meeting_id));
create policy meeting_summaries_retention_guard on public.meeting_summaries as restrictive for all to authenticated
  using (public.meeting_recording_accessible(owner_user_id, meeting_id))
  with check (public.meeting_recording_accessible(owner_user_id, meeting_id));
create policy translation_requests_retention_guard on public.translation_requests as restrictive for all to authenticated
  using (public.meeting_recording_accessible_for_cue(owner_user_id, cue_id))
  with check (public.meeting_recording_accessible_for_cue(owner_user_id, cue_id));
create policy translation_executions_retention_guard on public.translation_executions as restrictive for all to authenticated
  using (public.meeting_recording_accessible_for_request(owner_user_id, translation_request_id))
  with check (public.meeting_recording_accessible_for_request(owner_user_id, translation_request_id));
create policy translation_outputs_retention_guard on public.translation_outputs as restrictive for all to authenticated
  using (public.meeting_recording_accessible_for_execution(owner_user_id, translation_execution_id))
  with check (public.meeting_recording_accessible_for_execution(owner_user_id, translation_execution_id));

create or replace function public.enforce_meeting_recording_write()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  target_meeting_id uuid;
  target_owner_id uuid := new.owner_user_id;
  target_status text;
begin
  if tg_table_name = 'subtitle_cues' then
    select meeting_id into target_meeting_id from public.sessions
    where owner_user_id = target_owner_id and id = new.session_id;
  elsif tg_table_name = 'translation_requests' then
    select segment.meeting_id into target_meeting_id
    from public.subtitle_cues cue join public.sessions segment on segment.id = cue.session_id
    where cue.owner_user_id = target_owner_id and cue.id = new.cue_id;
  elsif tg_table_name = 'translation_executions' then
    select segment.meeting_id into target_meeting_id
    from public.translation_requests request
    join public.subtitle_cues cue on cue.id = request.cue_id
    join public.sessions segment on segment.id = cue.session_id
    where request.owner_user_id = target_owner_id and request.id = new.translation_request_id;
  elsif tg_table_name = 'translation_outputs' then
    select segment.meeting_id into target_meeting_id
    from public.translation_executions execution
    join public.translation_requests request on request.id = execution.translation_request_id
    join public.subtitle_cues cue on cue.id = request.cue_id
    join public.sessions segment on segment.id = cue.session_id
    where execution.owner_user_id = target_owner_id and execution.id = new.translation_execution_id;
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

create trigger meeting_segments_retention_write before insert or update on public.meeting_segments
  for each row execute function public.enforce_meeting_recording_write();
create trigger sessions_retention_write before insert or update on public.sessions
  for each row execute function public.enforce_meeting_recording_write();
create trigger subtitle_cues_retention_write before insert or update on public.subtitle_cues
  for each row execute function public.enforce_meeting_recording_write();
create trigger audio_artifacts_retention_write before insert or update on public.audio_artifacts
  for each row execute function public.enforce_meeting_recording_write();
create trigger export_artifacts_retention_write before insert or update on public.export_artifacts
  for each row execute function public.enforce_meeting_recording_write();
create trigger meeting_events_retention_write before insert or update on public.meeting_events
  for each row execute function public.enforce_meeting_recording_write();
create trigger meeting_summaries_retention_write before insert or update on public.meeting_summaries
  for each row execute function public.enforce_meeting_recording_write();
create trigger translation_requests_retention_write before insert or update on public.translation_requests
  for each row execute function public.enforce_meeting_recording_write();
create trigger translation_executions_retention_write before insert or update on public.translation_executions
  for each row execute function public.enforce_meeting_recording_write();
create trigger translation_outputs_retention_write before insert or update on public.translation_outputs
  for each row execute function public.enforce_meeting_recording_write();

create or replace function public.meeting_storage_content_accessible(p_owner text, p_meeting text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.meeting_recording_accessible(owner_user_id, id)
    from public.meetings where owner_user_id::text = p_owner and id::text = p_meeting), false);
$$;
revoke all on function public.meeting_storage_content_accessible(text, text) from public, anon;
grant execute on function public.meeting_storage_content_accessible(text, text) to authenticated;
drop policy meeting_storage_reject_deleted on storage.objects;
create policy meeting_storage_retention_guard on storage.objects as restrictive for all to authenticated
  using (bucket_id not in ('meeting-audio', 'meeting-exports')
    or public.meeting_storage_content_accessible((storage.foldername(name))[1], (storage.foldername(name))[2]))
  with check (bucket_id not in ('meeting-audio', 'meeting-exports')
    or public.meeting_storage_content_accessible((storage.foldername(name))[1], (storage.foldername(name))[2]));
