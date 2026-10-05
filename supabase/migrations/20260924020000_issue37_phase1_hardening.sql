-- Issue #37 Phase 1 hardening. This is additive so lifecycle v1 rows remain
-- readable and the already-applied lifecycle v2 migration is never rewritten.

alter table public.meetings
  add column if not exists retention_policy_version smallint not null default 1,
  add column if not exists purge_status text not null default 'not_scheduled',
  add column if not exists purge_claimed_at timestamptz,
  add column if not exists purge_claimed_by text,
  add column if not exists purge_attempt_count integer not null default 0,
  add column if not exists purge_last_error text;

alter table public.meetings
  drop constraint if exists meetings_retention_policy_version_check,
  add constraint meetings_retention_policy_version_check
    check (retention_policy_version >= 1),
  drop constraint if exists meetings_purge_status_check,
  add constraint meetings_purge_status_check
    check (purge_status in ('not_scheduled', 'pending', 'claimed', 'purged', 'failed')),
  drop constraint if exists meetings_purge_claim_check,
  add constraint meetings_purge_claim_check
    check (
      (purge_status = 'claimed' and purge_claimed_at is not null and purge_claimed_by is not null)
      or (purge_status <> 'claimed')
    );

update public.meetings
set purge_status = case when purge_at is null then 'not_scheduled' else 'pending' end
where purge_status = 'not_scheduled' and purge_at is not null;

create index if not exists meetings_purge_due_idx
  on public.meetings (purge_status, purge_at)
  where purge_status in ('pending', 'failed', 'claimed') and purge_at is not null;

alter table public.meeting_segments
  drop constraint if exists meeting_segments_v2_session_required_check,
  add constraint meeting_segments_v2_session_required_check
    check (lifecycle_contract_version <> 2 or session_id is not null) not valid;

create or replace function public.schedule_meeting_retention()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.purge_at is null then
    if tg_op = 'update' and old.purge_at is not null then
      new.purge_status := 'not_scheduled';
      new.purge_claimed_at := null;
      new.purge_claimed_by := null;
      new.purge_last_error := null;
    end if;
    return new;
  end if;

  if tg_op = 'insert' or old.purge_at is distinct from new.purge_at then
    if new.purge_status = 'not_scheduled' then
      new.purge_status := 'pending';
    end if;
    if new.purge_status <> 'claimed' then
      new.purge_claimed_at := null;
      new.purge_claimed_by := null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists meetings_schedule_retention on public.meetings;
create trigger meetings_schedule_retention
before insert or update of purge_at on public.meetings
for each row execute function public.schedule_meeting_retention();

create or replace function public.enforce_v2_current_segment_active()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  current_session public.sessions;
begin
  if tg_table_name = 'sessions' then
    -- Constraint triggers are deferred. Re-read the row because the first
    -- insert of a start transaction precedes its current_segment_id update.
    select * into current_session
    from public.sessions
    where id = new.id and owner_user_id = new.owner_user_id;

    if current_session.lifecycle_contract_version = 2
      and current_session.status = 'active'
      and current_session.current_segment_id is null then
      raise exception 'v2_active_session_requires_current_segment';
    end if;

    if current_session.lifecycle_contract_version = 2
      and current_session.current_segment_id is not null
      and not exists (
      select 1
      from public.meeting_segments segment
      where segment.id = current_session.current_segment_id
        and segment.owner_user_id = current_session.owner_user_id
        and segment.meeting_id = current_session.meeting_id
        and segment.session_id = current_session.id
        and segment.lifecycle_contract_version = 2
        and segment.status = 'active'
    ) then
      raise exception 'v2_current_segment_must_be_active';
    end if;
  elsif tg_table_name = 'meeting_segments'
    and new.lifecycle_contract_version = 2
    and new.status <> 'active'
    and exists (
      select 1
      from public.sessions session
      where session.id = new.session_id
        and session.owner_user_id = new.owner_user_id
        and session.current_segment_id = new.id
    ) then
    raise exception 'v2_current_segment_must_be_active';
  end if;

  return null;
end;
$$;

drop trigger if exists sessions_enforce_v2_current_segment_active on public.sessions;
create constraint trigger sessions_enforce_v2_current_segment_active
after insert or update of lifecycle_contract_version, status, current_segment_id, meeting_id on public.sessions
deferrable initially deferred
for each row execute function public.enforce_v2_current_segment_active();

drop trigger if exists meeting_segments_enforce_v2_current_segment_active on public.meeting_segments;
create constraint trigger meeting_segments_enforce_v2_current_segment_active
after update of lifecycle_contract_version, status, session_id, meeting_id on public.meeting_segments
deferrable initially deferred
for each row execute function public.enforce_v2_current_segment_active();

create or replace function public.reject_terminal_v2_meeting_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_meeting_id uuid;
  target_owner_user_id uuid;
  target_contract_version smallint;
  target_status text;
begin
  target_owner_user_id := new.owner_user_id;

  if tg_table_name = 'sessions' or tg_table_name = 'meeting_segments' or tg_table_name = 'viewer_shares' then
    target_meeting_id := new.meeting_id;
  elsif tg_table_name = 'subtitle_cues' then
    select session.meeting_id into target_meeting_id
    from public.sessions session
    where session.id = new.session_id
      and session.owner_user_id = new.owner_user_id;
  end if;

  select lifecycle_contract_version, status
  into target_contract_version, target_status
  from public.meetings
  where id = target_meeting_id and owner_user_id = target_owner_user_id;

  if target_contract_version = 2 and target_status not in ('created', 'active', 'paused') then
    raise exception 'meeting_terminal';
  end if;

  return new;
end;
$$;

drop trigger if exists sessions_reject_terminal_v2_meeting_write on public.sessions;
create trigger sessions_reject_terminal_v2_meeting_write
before insert on public.sessions
for each row execute function public.reject_terminal_v2_meeting_write();

drop trigger if exists meeting_segments_reject_terminal_v2_meeting_write on public.meeting_segments;
create trigger meeting_segments_reject_terminal_v2_meeting_write
before insert on public.meeting_segments
for each row execute function public.reject_terminal_v2_meeting_write();

drop trigger if exists viewer_shares_reject_terminal_v2_meeting_write on public.viewer_shares;
create trigger viewer_shares_reject_terminal_v2_meeting_write
before insert on public.viewer_shares
for each row execute function public.reject_terminal_v2_meeting_write();

drop trigger if exists subtitle_cues_reject_terminal_v2_meeting_write on public.subtitle_cues;
create trigger subtitle_cues_reject_terminal_v2_meeting_write
before insert on public.subtitle_cues
for each row execute function public.reject_terminal_v2_meeting_write();

create or replace function public.reject_expired_v2_audio_artifact_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_contract_version smallint;
  target_status text;
  target_purge_at timestamptz;
begin
  select lifecycle_contract_version, status, purge_at
  into target_contract_version, target_status, target_purge_at
  from public.meetings
  where id = new.meeting_id and owner_user_id = new.owner_user_id;

  if target_contract_version = 2
    and target_status not in ('created', 'active', 'paused')
    and target_purge_at is not null
    and clock_timestamp() >= target_purge_at then
    raise exception 'meeting_purge_deadline_expired';
  end if;

  return new;
end;
$$;

drop trigger if exists audio_artifacts_reject_expired_v2_meeting_write on public.audio_artifacts;
create trigger audio_artifacts_reject_expired_v2_meeting_write
before insert or update on public.audio_artifacts
for each row execute function public.reject_expired_v2_audio_artifact_write();

create or replace function public.expire_stale_meetings(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  locked_meeting public.meetings;
  now_at timestamptz := clock_timestamp();
  expired_count integer := 0;
  expired_meeting_ids jsonb := '[]'::jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid_request';
  end if;

  for locked_meeting in
    select *
    from public.meetings
    where lifecycle_contract_version = 2
      and status in ('active', 'paused')
      and last_heartbeat_at is not null
      and last_heartbeat_at <= now_at - interval '15 minutes'
    order by last_heartbeat_at
    limit p_limit
    for update skip locked
  loop
    update public.meeting_segments
    set status = 'interrupted',
        ended_at = coalesce(ended_at, now_at),
        updated_at = now_at,
        checkpoint = checkpoint || jsonb_build_object('terminalReason', 'recorder_lost', 'expiredAt', now_at)
    where owner_user_id = locked_meeting.owner_user_id
      and meeting_id = locked_meeting.id
      and lifecycle_contract_version = 2
      and status = 'active';

    update public.sessions
    set status = 'stopped',
        ended_at = coalesce(ended_at, now_at),
        current_segment_id = null
    where owner_user_id = locked_meeting.owner_user_id
      and meeting_id = locked_meeting.id
      and lifecycle_contract_version = 2
      and status in ('created', 'active', 'paused');

    update public.viewer_shares
    set revoked_at = coalesce(revoked_at, now_at)
    where owner_user_id = locked_meeting.owner_user_id
      and meeting_id = locked_meeting.id;

    update public.recorder_leases
    set expires_at = now_at,
        updated_at = now_at
    where owner_user_id = locked_meeting.owner_user_id
      and meeting_id = locked_meeting.id;

    update public.meetings
    set status = 'completed',
        ended_at = coalesce(ended_at, now_at),
        updated_at = now_at,
        purge_at = coalesce(purge_at, now_at + interval '30 minutes'),
        purge_status = 'pending',
        purge_claimed_at = null,
        purge_claimed_by = null,
        lifecycle_version = lifecycle_version + 1
    where id = locked_meeting.id
      and owner_user_id = locked_meeting.owner_user_id;

    expired_count := expired_count + 1;
    expired_meeting_ids := expired_meeting_ids || to_jsonb(locked_meeting.id);
  end loop;

  return jsonb_build_object(
    'expiredCount', expired_count,
    'meetingIds', expired_meeting_ids,
    'expiredAt', now_at
  );
end;
$$;

create or replace function public.claim_due_meeting_purges(
  p_worker_id text,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_meeting public.meetings;
  now_at timestamptz := clock_timestamp();
  claims jsonb := '[]'::jsonb;
begin
  if nullif(trim(p_worker_id), '') is null or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid_request';
  end if;

  for claimed_meeting in
    select *
    from public.meetings
    where lifecycle_contract_version = 2
      and purge_at is not null
      and purge_at <= now_at
      and (
        purge_status in ('pending', 'failed')
        or (purge_status = 'claimed' and purge_claimed_at <= now_at - interval '5 minutes')
      )
    order by purge_at
    limit p_limit
    for update skip locked
  loop
    update public.meetings
    set purge_status = 'claimed',
        purge_claimed_at = now_at,
        purge_claimed_by = p_worker_id,
        purge_attempt_count = purge_attempt_count + 1,
        purge_last_error = null
    where id = claimed_meeting.id
      and owner_user_id = claimed_meeting.owner_user_id;

    claims := claims || jsonb_build_array(jsonb_build_object(
      'meetingId', claimed_meeting.id,
      'ownerUserId', claimed_meeting.owner_user_id,
      'purgeAt', claimed_meeting.purge_at,
      'retentionPolicyVersion', claimed_meeting.retention_policy_version
    ));
  end loop;

  return claims;
end;
$$;

revoke all on function public.expire_stale_meetings(integer) from public, anon, authenticated;
revoke all on function public.claim_due_meeting_purges(text, integer) from public, anon, authenticated;
grant execute on function public.expire_stale_meetings(integer) to service_role;
grant execute on function public.claim_due_meeting_purges(text, integer) to service_role;
