-- Issue #37 Phase 1: Meeting lifecycle v2 is owned by Supabase.
-- Existing rows stay on contract v1; v2 rows are created only by the new RPC.

alter table public.meetings
  add column if not exists lifecycle_contract_version smallint not null default 1,
  add column if not exists lifecycle_version bigint not null default 0,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists purge_at timestamptz;

alter table public.sessions
  add column if not exists lifecycle_contract_version smallint not null default 1,
  add column if not exists current_segment_id uuid;

alter table public.meeting_segments
  add column if not exists lifecycle_contract_version smallint not null default 1,
  add column if not exists session_id uuid;

alter table public.recorder_leases
  add column if not exists meeting_id uuid,
  add column if not exists principal_type text,
  add column if not exists principal_id text;

alter table public.meetings
  drop constraint if exists meetings_lifecycle_contract_version_check,
  add constraint meetings_lifecycle_contract_version_check
    check (lifecycle_contract_version in (1, 2));

alter table public.sessions
  drop constraint if exists sessions_lifecycle_contract_version_check,
  add constraint sessions_lifecycle_contract_version_check
    check (lifecycle_contract_version in (1, 2));

alter table public.meeting_segments
  drop constraint if exists meeting_segments_lifecycle_contract_version_check,
  add constraint meeting_segments_lifecycle_contract_version_check
    check (lifecycle_contract_version in (1, 2));

alter table public.recorder_leases
  drop constraint if exists recorder_leases_principal_check,
  add constraint recorder_leases_principal_check check (
    (meeting_id is null and principal_type is null and principal_id is null)
    or
    (meeting_id is not null and principal_type in ('user', 'share') and principal_id is not null)
  );

create unique index if not exists sessions_owner_meeting_id_idx
  on public.sessions(owner_user_id, meeting_id, id);

create unique index if not exists meeting_segments_owner_session_id_idx
  on public.meeting_segments(owner_user_id, session_id, id);

create unique index if not exists meeting_segments_owner_meeting_session_id_idx
  on public.meeting_segments(owner_user_id, meeting_id, session_id, id);

create unique index if not exists sessions_one_open_v2_per_meeting_idx
  on public.sessions(owner_user_id, meeting_id)
  where lifecycle_contract_version = 2
    and status in ('created', 'active', 'paused');

create unique index if not exists meeting_segments_one_active_v2_per_meeting_idx
  on public.meeting_segments(owner_user_id, meeting_id)
  where lifecycle_contract_version = 2 and status = 'active';

create unique index if not exists recorder_leases_owner_meeting_idx
  on public.recorder_leases(owner_user_id, meeting_id)
  where meeting_id is not null;

alter table public.meeting_segments
  drop constraint if exists meeting_segments_owner_meeting_session_fkey,
  add constraint meeting_segments_owner_meeting_session_fkey
    foreign key (owner_user_id, meeting_id, session_id)
    references public.sessions(owner_user_id, meeting_id, id)
    on delete cascade
    deferrable initially deferred
    not valid;

alter table public.sessions
  drop constraint if exists sessions_current_segment_relationship_fkey,
  add constraint sessions_current_segment_relationship_fkey
    foreign key (owner_user_id, meeting_id, id, current_segment_id)
    references public.meeting_segments(owner_user_id, meeting_id, session_id, id)
    deferrable initially deferred
    not valid;

alter table public.subtitle_cues
  drop constraint if exists subtitle_cues_session_segment_relationship_fkey,
  add constraint subtitle_cues_session_segment_relationship_fkey
    foreign key (owner_user_id, session_id, segment_id)
    references public.meeting_segments(owner_user_id, session_id, id)
    on delete cascade
    not valid;

alter table public.recorder_leases
  drop constraint if exists recorder_leases_owner_meeting_fkey,
  add constraint recorder_leases_owner_meeting_fkey
    foreign key (owner_user_id, meeting_id)
    references public.meetings(owner_user_id, id)
    on delete cascade
    not valid;

create table if not exists public.meeting_lifecycle_operations (
  owner_user_id uuid not null,
  meeting_id uuid not null,
  operation_id text not null,
  command text not null,
  request_payload jsonb not null,
  result jsonb not null,
  resulting_lifecycle_version bigint not null,
  created_at timestamptz not null default now(),
  primary key (owner_user_id, meeting_id, operation_id),
  foreign key (owner_user_id, meeting_id)
    references public.meetings(owner_user_id, id)
    on delete cascade
);

alter table public.meeting_lifecycle_operations enable row level security;
revoke all on public.meeting_lifecycle_operations from public, anon, authenticated;
grant all on public.meeting_lifecycle_operations to service_role;

-- Keep the expand migration compatible with the previous application release.
-- Old callers omit contract fields and therefore continue creating v1 rows;
-- the v2-aware repository sends explicit version 2 values.
create or replace function public.create_meeting_with_initial_segment(
  p_meeting jsonb,
  p_segment jsonb
) returns jsonb
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
  normalized_meeting jsonb;
  normalized_segment jsonb;
begin
  meeting_owner := nullif(p_meeting->>'owner_user_id', '')::uuid;
  segment_owner := nullif(p_segment->>'owner_user_id', '')::uuid;
  segment_meeting := nullif(p_segment->>'meeting_id', '')::uuid;
  if auth.uid() is null
    or meeting_owner is null
    or meeting_owner <> auth.uid()
    or segment_owner is distinct from meeting_owner
    or segment_meeting is distinct from nullif(p_meeting->>'id', '')::uuid then
    raise exception using errcode = '42501', message = 'meeting owner does not match authenticated user';
  end if;

  normalized_meeting := p_meeting || jsonb_build_object(
    'lifecycle_contract_version', coalesce((p_meeting->>'lifecycle_contract_version')::smallint, 1),
    'lifecycle_version', coalesce((p_meeting->>'lifecycle_version')::bigint, 0)
  );
  normalized_segment := p_segment || jsonb_build_object(
    'lifecycle_contract_version', coalesce((p_segment->>'lifecycle_contract_version')::smallint, 1)
  );

  insert into public.meetings
  select * from jsonb_populate_record(null::public.meetings, normalized_meeting)
  returning * into inserted_meeting;

  insert into public.meeting_segments
  select * from jsonb_populate_record(null::public.meeting_segments, normalized_segment)
  returning * into inserted_segment;

  return jsonb_build_object(
    'meeting', to_jsonb(inserted_meeting),
    'segment', to_jsonb(inserted_segment)
  );
end;
$$;

create or replace function public.execute_meeting_lifecycle_command(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_command text,
  p_operation_id text,
  p_expected_lifecycle_version bigint,
  p_principal_type text,
  p_principal_id text,
  p_lease_id text default null,
  p_fence_token bigint default null,
  p_force_allowed boolean default false,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  locked_meeting public.meetings;
  current_session public.sessions;
  current_segment public.meeting_segments;
  current_lease public.recorder_leases;
  prior_operation public.meeting_lifecycle_operations;
  next_session_id uuid;
  next_segment_id uuid;
  next_lease_id text;
  next_fence bigint;
  now_at timestamptz := clock_timestamp();
  response jsonb;
  request_value jsonb;
  confirmed_force boolean := coalesce((p_payload->>'confirmTakeover')::boolean, false);
begin
  if p_command not in ('start', 'pause', 'resume', 'rollover', 'recover', 'stop', 'takeover')
    or nullif(trim(p_operation_id), '') is null
    or p_principal_type not in ('user', 'share')
    or nullif(trim(p_principal_id), '') is null then
    raise exception 'invalid_request';
  end if;

  select * into locked_meeting
  from public.meetings
  where id = p_meeting_id and owner_user_id = p_owner_user_id
  for update;

  if not found then raise exception 'meeting_not_found'; end if;
  if locked_meeting.lifecycle_contract_version <> 2 then
    raise exception 'meeting_lifecycle_conflict';
  end if;

  request_value := jsonb_build_object(
    'command', p_command,
    'expectedLifecycleVersion', p_expected_lifecycle_version,
    'principalType', p_principal_type,
    'principalId', p_principal_id,
    'leaseId', p_lease_id,
    'fenceToken', p_fence_token,
    'payload', coalesce(p_payload, '{}'::jsonb)
  );

  select * into prior_operation
  from public.meeting_lifecycle_operations
  where owner_user_id = p_owner_user_id
    and meeting_id = p_meeting_id
    and operation_id = p_operation_id;

  if found then
    if prior_operation.command <> p_command or prior_operation.request_payload <> request_value then
      raise exception 'meeting_lifecycle_conflict';
    end if;
    return prior_operation.result || jsonb_build_object('replayed', true);
  end if;

  if locked_meeting.lifecycle_version <> p_expected_lifecycle_version then
    raise exception 'meeting_lifecycle_conflict';
  end if;

  select * into current_session
  from public.sessions
  where owner_user_id = p_owner_user_id
    and meeting_id = p_meeting_id
    and lifecycle_contract_version = 2
    and status in ('created', 'active', 'paused')
  for update;

  if found and current_session.current_segment_id is not null then
    select * into current_segment
    from public.meeting_segments
    where owner_user_id = p_owner_user_id
      and meeting_id = p_meeting_id
      and id = current_session.current_segment_id
    for update;
  end if;

  select * into current_lease
  from public.recorder_leases
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
  for update;

  if p_command = 'start' then
    if current_session.id is not null then raise exception 'recorder_already_active'; end if;
    if current_lease.id is not null and current_lease.expires_at > now_at then
      raise exception 'recorder_already_active';
    end if;

    next_session_id := coalesce(nullif(p_payload->>'sessionId', '')::uuid, gen_random_uuid());
    next_segment_id := coalesce(nullif(p_payload->>'segmentId', '')::uuid, gen_random_uuid());
    next_lease_id := 'lease-' || gen_random_uuid()::text;
    next_fence := coalesce(current_lease.fence_token, 0) + 1;

    insert into public.sessions (
      id, owner_user_id, meeting_id, status, source_language_code,
      target_language_code, started_at, created_at, payload,
      lifecycle_contract_version
    ) values (
      next_session_id, p_owner_user_id, p_meeting_id, 'active',
      locked_meeting.source_language_code, locked_meeting.target_language_code,
      now_at, now_at, jsonb_build_object('name', locked_meeting.name), 2
    );

    insert into public.meeting_segments (
      id, owner_user_id, meeting_id, session_id, sequence, status,
      started_at, settings_snapshot, checkpoint, created_at, updated_at,
      lifecycle_contract_version
    ) values (
      next_segment_id, p_owner_user_id, p_meeting_id, next_session_id, 0,
      'active', now_at, locked_meeting.settings, '{}'::jsonb, now_at, now_at, 2
    );

    update public.sessions
    set segment_id = next_segment_id, current_segment_id = next_segment_id
    where id = next_session_id and owner_user_id = p_owner_user_id;

    insert into public.recorder_leases (
      owner_user_id, meeting_id, session_id, lease_id, fence_token,
      expires_at, updated_at, principal_type, principal_id
    ) values (
      p_owner_user_id, p_meeting_id, next_session_id, next_lease_id, next_fence,
      now_at + interval '10 seconds', now_at, p_principal_type, p_principal_id
    ) on conflict (owner_user_id, meeting_id) where meeting_id is not null
    do update set
      session_id = excluded.session_id,
      lease_id = excluded.lease_id,
      fence_token = excluded.fence_token,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at,
      principal_type = excluded.principal_type,
      principal_id = excluded.principal_id;

    update public.meetings
    set status = 'active', started_at = coalesce(started_at, now_at),
        ended_at = null, updated_at = now_at,
        lifecycle_version = lifecycle_version + 1,
        last_heartbeat_at = now_at
    where id = p_meeting_id and owner_user_id = p_owner_user_id
    returning * into locked_meeting;

  elsif p_command = 'takeover' then
    if current_session.id is null then raise exception 'meeting_lifecycle_conflict'; end if;
    if current_lease.id is null then raise exception 'recorder_lease_invalid'; end if;
    if current_lease.expires_at > now_at then
      if not (p_force_allowed and confirmed_force) then
        if p_force_allowed then raise exception 'recorder_takeover_confirmation_required'; end if;
        raise exception 'recorder_already_active';
      end if;
    elsif current_lease.principal_type <> p_principal_type
       or current_lease.principal_id <> p_principal_id then
      if not p_force_allowed then raise exception 'recorder_already_active'; end if;
      if not confirmed_force then raise exception 'recorder_takeover_confirmation_required'; end if;
    end if;

    next_segment_id := gen_random_uuid();
    next_lease_id := 'lease-' || gen_random_uuid()::text;
    next_fence := current_lease.fence_token + 1;

    if current_segment.id is not null then
      update public.meeting_segments
      set status = 'interrupted', ended_at = now_at, updated_at = now_at,
          error_info = jsonb_build_object('reason', 'recorder_takeover', 'category', 'browser')
      where id = current_segment.id and owner_user_id = p_owner_user_id;
    end if;

    insert into public.meeting_segments (
      id, owner_user_id, meeting_id, session_id, sequence, status,
      started_at, settings_snapshot, checkpoint, created_at, updated_at,
      lifecycle_contract_version
    ) select
      next_segment_id, p_owner_user_id, p_meeting_id, current_session.id,
      coalesce(max(sequence), -1) + 1, 'active', now_at,
      locked_meeting.settings, '{}'::jsonb, now_at, now_at, 2
    from public.meeting_segments
    where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id;

    update public.sessions
    set status = 'active', segment_id = next_segment_id,
        current_segment_id = next_segment_id
    where id = current_session.id and owner_user_id = p_owner_user_id;

    update public.recorder_leases
    set lease_id = next_lease_id, fence_token = next_fence,
        expires_at = now_at + interval '10 seconds', updated_at = now_at,
        principal_type = p_principal_type, principal_id = p_principal_id
    where id = current_lease.id;

    update public.meetings
    set lifecycle_version = lifecycle_version + 1, updated_at = now_at,
        last_heartbeat_at = now_at
    where id = p_meeting_id and owner_user_id = p_owner_user_id
    returning * into locked_meeting;

  else
    if current_session.id is null then raise exception 'meeting_lifecycle_conflict'; end if;
    if current_lease.id is null
      or current_lease.lease_id <> p_lease_id
      or current_lease.fence_token <> p_fence_token
      or current_lease.expires_at <= now_at
      or current_lease.principal_type <> p_principal_type
      or current_lease.principal_id <> p_principal_id then
      raise exception 'recorder_lease_invalid';
    end if;

    if p_command in ('pause', 'rollover', 'recover') and current_segment.id is null then
      raise exception 'meeting_lifecycle_conflict';
    end if;

    if p_command = 'pause' then
      update public.meeting_segments
      set status = 'completed', ended_at = now_at, updated_at = now_at,
          checkpoint = coalesce(p_payload->'checkpoint', checkpoint)
      where id = current_segment.id and owner_user_id = p_owner_user_id;
      update public.sessions
      set status = 'paused', current_segment_id = null
      where id = current_session.id and owner_user_id = p_owner_user_id;

    elsif p_command in ('resume', 'rollover', 'recover') then
      if p_command = 'resume' and current_session.status <> 'paused' then
        raise exception 'meeting_lifecycle_conflict';
      end if;
      if p_command = 'rollover' then
        update public.meeting_segments
        set status = 'completed', ended_at = now_at, updated_at = now_at,
            checkpoint = coalesce(p_payload->'checkpoint', checkpoint)
        where id = current_segment.id and owner_user_id = p_owner_user_id;
      elsif p_command = 'recover' then
        update public.meeting_segments
        set status = 'interrupted', ended_at = now_at, updated_at = now_at,
            checkpoint = coalesce(p_payload->'checkpoint', checkpoint),
            error_info = jsonb_build_object(
              'reason', coalesce(p_payload->>'failureReason', 'browser_recovery'),
              'category', coalesce(p_payload->>'failureCategory', 'browser')
            )
        where id = current_segment.id and owner_user_id = p_owner_user_id;
      end if;

      next_segment_id := gen_random_uuid();
      insert into public.meeting_segments (
        id, owner_user_id, meeting_id, session_id, sequence, status,
        started_at, settings_snapshot, checkpoint, created_at, updated_at,
        lifecycle_contract_version
      ) select
        next_segment_id, p_owner_user_id, p_meeting_id, current_session.id,
        coalesce(max(sequence), -1) + 1, 'active', now_at,
        locked_meeting.settings, '{}'::jsonb, now_at, now_at, 2
      from public.meeting_segments
      where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id;

      update public.sessions
      set status = 'active', segment_id = next_segment_id,
          current_segment_id = next_segment_id
      where id = current_session.id and owner_user_id = p_owner_user_id;

    elsif p_command = 'stop' then
      if current_segment.id is not null then
        update public.meeting_segments
        set status = 'completed', ended_at = now_at, updated_at = now_at,
            checkpoint = coalesce(p_payload->'checkpoint', checkpoint)
        where id = current_segment.id and owner_user_id = p_owner_user_id;
      end if;
      update public.sessions
      set status = 'stopped', ended_at = now_at, current_segment_id = null
      where id = current_session.id and owner_user_id = p_owner_user_id;
      update public.viewer_shares
      set revoked_at = coalesce(revoked_at, now_at)
      where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id;
      update public.recorder_leases
      set expires_at = now_at, updated_at = now_at
      where id = current_lease.id;
      update public.meetings
      set status = 'completed', ended_at = now_at, updated_at = now_at,
          purge_at = now_at + interval '30 minutes',
          lifecycle_version = lifecycle_version + 1
      where id = p_meeting_id and owner_user_id = p_owner_user_id
      returning * into locked_meeting;
    end if;

    if p_command <> 'stop' then
      update public.meetings
      set lifecycle_version = lifecycle_version + 1, updated_at = now_at
      where id = p_meeting_id and owner_user_id = p_owner_user_id
      returning * into locked_meeting;
    end if;
  end if;

  select * into current_session
  from public.sessions
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
    and lifecycle_contract_version = 2
  order by created_at desc limit 1;

  if current_session.current_segment_id is not null then
    select * into current_segment
    from public.meeting_segments
    where owner_user_id = p_owner_user_id and id = current_session.current_segment_id;
  else
    current_segment := null;
  end if;

  select * into current_lease
  from public.recorder_leases
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id;

  response := jsonb_build_object(
    'operationId', p_operation_id,
    'replayed', false,
    'meeting', to_jsonb(locked_meeting),
    'session', to_jsonb(current_session),
    'segment', case when current_segment.id is null then null else to_jsonb(current_segment) end,
    'lease', jsonb_build_object(
      'leaseId', current_lease.lease_id,
      'fenceToken', current_lease.fence_token,
      'expiresAt', current_lease.expires_at
    )
  );

  insert into public.meeting_lifecycle_operations (
    owner_user_id, meeting_id, operation_id, command, request_payload,
    result, resulting_lifecycle_version
  ) values (
    p_owner_user_id, p_meeting_id, p_operation_id, p_command, request_value,
    response, locked_meeting.lifecycle_version
  );

  return response;
exception
  when unique_violation or serialization_failure or deadlock_detected then
    raise exception 'meeting_lifecycle_conflict';
end;
$$;

create or replace function public.renew_meeting_recorder_lease(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_principal_type text,
  p_principal_id text,
  p_lease_id text,
  p_fence_token bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare renewed public.recorder_leases;
begin
  update public.recorder_leases
  set expires_at = clock_timestamp() + interval '10 seconds',
      updated_at = clock_timestamp()
  where owner_user_id = p_owner_user_id
    and meeting_id = p_meeting_id
    and principal_type = p_principal_type
    and principal_id = p_principal_id
    and lease_id = p_lease_id
    and fence_token = p_fence_token
    and expires_at > clock_timestamp()
  returning * into renewed;
  if renewed.id is null then raise exception 'recorder_lease_invalid'; end if;
  return jsonb_build_object(
    'leaseId', renewed.lease_id,
    'fenceToken', renewed.fence_token,
    'expiresAt', renewed.expires_at
  );
end;
$$;

create or replace function public.touch_meeting_liveness(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_principal_type text,
  p_principal_id text,
  p_lease_id text,
  p_fence_token bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare touched public.meetings;
begin
  if not exists (
    select 1 from public.recorder_leases
    where owner_user_id = p_owner_user_id
      and meeting_id = p_meeting_id
      and principal_type = p_principal_type
      and principal_id = p_principal_id
      and lease_id = p_lease_id
      and fence_token = p_fence_token
      and expires_at > clock_timestamp()
  ) then raise exception 'recorder_lease_invalid'; end if;

  update public.meetings
  set last_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
  where owner_user_id = p_owner_user_id and id = p_meeting_id
    and (last_heartbeat_at is null or last_heartbeat_at <= clock_timestamp() - interval '30 seconds')
  returning * into touched;

  if touched.id is null then
    select * into touched from public.meetings
    where owner_user_id = p_owner_user_id and id = p_meeting_id;
  end if;
  return jsonb_build_object('meetingId', touched.id, 'lastHeartbeatAt', touched.last_heartbeat_at);
end;
$$;

revoke all on function public.execute_meeting_lifecycle_command(uuid, uuid, text, text, bigint, text, text, text, bigint, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.renew_meeting_recorder_lease(uuid, uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.touch_meeting_liveness(uuid, uuid, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.execute_meeting_lifecycle_command(uuid, uuid, text, text, bigint, text, text, text, bigint, boolean, jsonb) to service_role;
grant execute on function public.renew_meeting_recorder_lease(uuid, uuid, text, text, text, bigint) to service_role;
grant execute on function public.touch_meeting_liveness(uuid, uuid, text, text, text, bigint) to service_role;
