-- Issue #41: capture the pre-transition lifecycle target in the existing operation result.
-- Preserve the original command signature, request_payload, and idempotency comparison.

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
  target_session_id uuid;
  target_segment_id uuid;
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

  -- Capture the authoritative pre-transition identity under the Meeting lock.
  target_session_id := current_session.id;
  target_segment_id := current_segment.id;

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
    'targetSessionId', target_session_id,
    'targetSegmentId', target_segment_id,
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

create or replace function public.lookup_meeting_lifecycle_operation(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_operation_id text,
  p_principal_type text,
  p_principal_id text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  locked_meeting public.meetings;
  committed public.meeting_lifecycle_operations;
  identity_recorded boolean;
  metadata jsonb;
begin
  if nullif(trim(p_operation_id), '') is null
    or p_principal_type not in ('user', 'share')
    or nullif(trim(p_principal_id), '') is null then
    raise exception 'invalid_request';
  end if;
  -- The command RPC takes FOR UPDATE before inserting its operation row.
  select * into locked_meeting from public.meetings
  where owner_user_id = p_owner_user_id and id = p_meeting_id for share;
  if not found then raise exception 'meeting_not_found'; end if;
  if locked_meeting.purge_at is not null
    and locked_meeting.purge_at <= clock_timestamp() then
    return jsonb_build_object('status', 'expired');
  end if;
  select * into committed from public.meeting_lifecycle_operations
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
    and operation_id = p_operation_id;
  if not found then return jsonb_build_object('status', 'unknown'); end if;
  if committed.request_payload->>'principalType' is distinct from p_principal_type
    or committed.request_payload->>'principalId' is distinct from p_principal_id then
    raise exception 'auth_forbidden';
  end if;
  if committed.command = 'lease_recover' then raise exception 'invalid_request'; end if;
  identity_recorded := committed.result ? 'targetSessionId'
    and committed.result ? 'targetSegmentId';
  metadata := jsonb_build_object(
    'status', 'committed',
    'operationId', committed.operation_id,
    'command', committed.command,
    'resultingLifecycleVersion', committed.resulting_lifecycle_version,
    'targetIdentityRecorded', identity_recorded,
    'sessionId', committed.result->'session'->>'id',
    'segmentId', committed.result->'segment'->>'id'
  );
  if identity_recorded then
    metadata := metadata || jsonb_build_object(
      'targetSessionId', committed.result->'targetSessionId',
      'targetSegmentId', committed.result->'targetSegmentId'
    );
  end if;
  return metadata;
end;
$$;

revoke all on function public.execute_meeting_lifecycle_command(uuid,uuid,text,text,bigint,text,text,text,bigint,boolean,jsonb)
  from public, anon, authenticated;
revoke all on function public.lookup_meeting_lifecycle_operation(uuid,uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.execute_meeting_lifecycle_command(uuid,uuid,text,text,bigint,text,text,text,bigint,boolean,jsonb)
  to service_role;
grant execute on function public.lookup_meeting_lifecycle_operation(uuid,uuid,text,text,text)
  to service_role;
