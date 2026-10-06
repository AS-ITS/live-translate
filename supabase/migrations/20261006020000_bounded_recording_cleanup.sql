-- Cleanup is opportunistic. A durable throttle and claim make independent API
-- instances cooperate; no scheduler or assumption of traffic is required.
alter table public.meeting_recordings
  add column cleanup_phase text not null default 'storage';

create table public.meeting_cleanup_throttle (
  id boolean primary key default true check (id),
  next_run_at timestamptz not null default '-infinity'::timestamptz
);
insert into public.meeting_cleanup_throttle(id) values (true);
alter table public.meeting_cleanup_throttle enable row level security;
revoke all on public.meeting_cleanup_throttle from public, anon, authenticated;
grant all on public.meeting_cleanup_throttle to service_role;

-- The v1 function was applied locally before the terminal-transition guard was added.
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

create or replace function public.claim_due_recording_cleanup(p_worker text)
returns table(recording_id uuid, meeting_id uuid, owner_user_id uuid, phase text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare throttle_row public.meeting_cleanup_throttle%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'auth_forbidden' using errcode = '42501';
  end if;
  select * into throttle_row from public.meeting_cleanup_throttle
    where id = true for update skip locked;
  if not found or throttle_row.next_run_at > clock_timestamp() then return; end if;
  update public.meeting_cleanup_throttle
    set next_run_at = clock_timestamp() + interval '15 seconds' where id = true;
  return query
    with chosen as (
      select r.id from public.meeting_recordings r
      join public.meetings m on m.id = r.meeting_id and m.owner_user_id = r.owner_user_id
      where r.expires_at <= clock_timestamp() and m.status = 'completed'
        and r.cleanup_state <> 'cleared'
        and (r.cleanup_state <> 'claimed' or r.claimed_at < clock_timestamp() - interval '45 seconds')
      order by r.expires_at, r.id limit 1 for update of r skip locked
    ), claimed as (
      update public.meeting_recordings r set cleanup_state = 'claimed',
        claimed_at = clock_timestamp(), claimed_by = p_worker,
        cleanup_attempt_count = cleanup_attempt_count + 1
      from chosen where r.id = chosen.id
      returning r.id, r.meeting_id, r.owner_user_id, r.cleanup_phase
    ) select claimed.id, claimed.meeting_id, claimed.owner_user_id, claimed.cleanup_phase from claimed;
end;
$$;

create or replace function public.advance_recording_cleanup(
  p_recording_id uuid, p_worker text, p_next_phase text, p_error text default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare updated_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'auth_forbidden' using errcode = '42501'; end if;
  if p_next_phase not in ('storage','outputs','executions','requests','cues',
    'events','audio','exports','summaries','operations','segments','sessions','done') then
    raise exception 'invalid_cleanup_phase' using errcode = '22023';
  end if;
  update public.meeting_recordings set cleanup_phase = p_next_phase,
    cleanup_state = case when p_next_phase = 'done' then 'cleared'
      when p_error is null then 'pending' else 'failed' end,
    cleanup_last_error = left(p_error, 200), claimed_by = null, claimed_at = null
    where id = p_recording_id and claimed_by = p_worker and cleanup_state = 'claimed'
    returning id into updated_id;
  if updated_id is null then return false; end if;
  if p_next_phase = 'done' then
    update public.meetings set purge_status = 'purged'
      where id = (select meeting_id from public.meeting_recordings where id = updated_id);
  end if;
  return true;
end;
$$;

-- Exactly one content category and at most 50 rows per invocation. The next
-- invocation advances after seeing an empty category. Session/segment identity
-- is retained, but their content-bearing JSON is zeroed in bounded batches.
create or replace function public.purge_recording_content_batch(
  p_recording_id uuid, p_worker text, p_limit integer default 50
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.meeting_recordings%rowtype;
declare affected integer := 0;
declare next_phase text;
begin
  if auth.role() <> 'service_role' then raise exception 'auth_forbidden' using errcode = '42501'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'invalid_request' using errcode = '22023'; end if;
  select * into r from public.meeting_recordings where id = p_recording_id
    and cleanup_state = 'claimed' and claimed_by = p_worker for update;
  if not found or r.expires_at > clock_timestamp() then return 0; end if;
  perform set_config('statement_timeout', '1500ms', true);
  case r.cleanup_phase
    when 'outputs' then
      delete from public.translation_outputs t where t.ctid in (
        select t2.ctid from public.translation_outputs t2
        join public.translation_executions e on e.id = t2.translation_execution_id
        join public.translation_requests q on q.id = e.translation_request_id
        join public.subtitle_cues c on c.id = q.cue_id
        join public.sessions s on s.id = c.session_id
        where s.meeting_id = r.meeting_id limit p_limit);
      next_phase := 'executions';
    when 'executions' then
      delete from public.translation_executions t where t.ctid in (
        select e.ctid from public.translation_executions e
        join public.translation_requests q on q.id = e.translation_request_id
        join public.subtitle_cues c on c.id = q.cue_id
        join public.sessions s on s.id = c.session_id
        where s.meeting_id = r.meeting_id limit p_limit);
      next_phase := 'requests';
    when 'requests' then
      delete from public.translation_requests t where t.ctid in (
        select q.ctid from public.translation_requests q
        join public.subtitle_cues c on c.id = q.cue_id
        join public.sessions s on s.id = c.session_id
        where s.meeting_id = r.meeting_id limit p_limit);
      next_phase := 'cues';
    when 'cues' then
      delete from public.subtitle_cues t where t.ctid in (
        select c.ctid from public.subtitle_cues c join public.sessions s on s.id = c.session_id
        where s.meeting_id = r.meeting_id limit p_limit);
      next_phase := 'events';
    when 'events' then
      delete from public.meeting_events t where t.ctid in (
        select ctid from public.meeting_events where meeting_id = r.meeting_id limit p_limit);
      next_phase := 'audio';
    when 'audio' then
      delete from public.audio_artifacts t where t.ctid in (
        select ctid from public.audio_artifacts where meeting_id = r.meeting_id limit p_limit);
      next_phase := 'exports';
    when 'exports' then
      delete from public.export_artifacts t where t.ctid in (
        select ctid from public.export_artifacts where meeting_id = r.meeting_id limit p_limit);
      next_phase := 'summaries';
    when 'summaries' then
      delete from public.meeting_summaries t where t.ctid in (
        select ctid from public.meeting_summaries where meeting_id = r.meeting_id limit p_limit);
      next_phase := 'operations';
    when 'operations' then
      delete from public.meeting_lifecycle_operations t where t.ctid in (
        select ctid from public.meeting_lifecycle_operations where meeting_id = r.meeting_id limit p_limit);
      next_phase := 'segments';
    when 'segments' then
      update public.meeting_segments t set checkpoint = '{}'::jsonb where t.ctid in (
        select ctid from public.meeting_segments where meeting_id = r.meeting_id
          and checkpoint <> '{}'::jsonb limit p_limit);
      next_phase := 'sessions';
    when 'sessions' then
      update public.sessions t set payload = '{}'::jsonb, transcript_items = '[]'::jsonb where t.ctid in (
        select ctid from public.sessions where meeting_id = r.meeting_id
          and (payload <> '{}'::jsonb or transcript_items <> '[]'::jsonb) limit p_limit);
      next_phase := 'done';
    else
      raise exception 'invalid_cleanup_phase' using errcode = '22023';
  end case;
  get diagnostics affected = row_count;
  perform public.advance_recording_cleanup(p_recording_id, p_worker,
    case when affected = 0 then next_phase else r.cleanup_phase end);
  return affected;
end;
$$;

revoke all on function public.claim_due_recording_cleanup(text),
  public.advance_recording_cleanup(uuid,text,text,text),
  public.purge_recording_content_batch(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.claim_due_recording_cleanup(text),
  public.advance_recording_cleanup(uuid,text,text,text),
  public.purge_recording_content_batch(uuid,text,integer) to service_role;

create index meeting_events_cleanup_idx on public.meeting_events(meeting_id);
create index meeting_lifecycle_operations_cleanup_idx on public.meeting_lifecycle_operations(meeting_id);
