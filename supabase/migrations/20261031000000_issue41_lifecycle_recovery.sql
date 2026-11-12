-- Issue #41: metadata-only lifecycle result lookup and fenced lease recovery.
-- Existing lifecycle commands and their idempotency comparison are unchanged.

create or replace function public.reject_lifecycle_content_payload()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
declare
  payload jsonb := new.request_payload->'payload';
  allowed text[];
begin
  if new.command = 'lease_recover' then return new; end if;
  if payload ? 'checkpoint' then raise exception 'checkpoint_conflict'; end if;
  allowed := case new.command
    when 'start' then array['sessionId', 'segmentId']
    when 'takeover' then array['confirmTakeover']
    when 'rollover' then array['nextLiveSessionId', 'originalOperationId', 'recoveryOperationId']
    when 'recover' then array['failureReason', 'failureCategory', 'originalOperationId', 'recoveryOperationId']
    when 'stop' then array['failureReason', 'failureCategory', 'originalOperationId', 'recoveryOperationId']
    when 'pause' then array['originalOperationId', 'recoveryOperationId']
    when 'resume' then array['originalOperationId', 'recoveryOperationId']
    else null
  end;
  if allowed is null or jsonb_typeof(payload) <> 'object'
    or exists (select 1 from jsonb_each(payload) entry
      where entry.key <> all(allowed)
        or (entry.key = 'confirmTakeover' and jsonb_typeof(entry.value) <> 'boolean')
        or (entry.key <> 'confirmTakeover' and (
          jsonb_typeof(entry.value) <> 'string'
          or length(entry.value #>> '{}') > 128
          or (entry.value #>> '{}') !~ '^[A-Za-z0-9_-]+$'))) then
    raise exception 'invalid_request';
  end if;
  return new;
end;
$$;

drop trigger if exists meeting_lifecycle_operations_metadata_guard on public.meeting_lifecycle_operations;
create trigger meeting_lifecycle_operations_metadata_guard
before insert on public.meeting_lifecycle_operations
for each row execute function public.reject_lifecycle_content_payload();

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
begin
  if nullif(trim(p_operation_id), '') is null
    or p_principal_type not in ('user', 'share')
    or nullif(trim(p_principal_id), '') is null then
    raise exception 'invalid_request';
  end if;

  -- The command RPC locks this row before inserting its operation record.
  -- Under READ COMMITTED, the subsequent SELECT observes its commit/abort.
  select * into locked_meeting from public.meetings
  where owner_user_id = p_owner_user_id and id = p_meeting_id
  for share;
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
  if committed.command = 'lease_recover' then
    raise exception 'invalid_request';
  end if;

  return jsonb_build_object(
    'status', 'committed',
    'operationId', committed.operation_id,
    'command', committed.command,
    'resultingLifecycleVersion', committed.resulting_lifecycle_version,
    'sessionId', committed.result->'session'->>'id',
    'segmentId', committed.result->'segment'->>'id'
  );
end;
$$;

create or replace function public.recover_meeting_recorder_lease(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_original_operation_id text,
  p_recovery_operation_id text,
  p_command text,
  p_expected_lifecycle_version bigint,
  p_session_id uuid,
  p_segment_id uuid,
  p_prior_lease_id text,
  p_prior_fence_token bigint,
  p_principal_type text,
  p_principal_id text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  locked_meeting public.meetings;
  current_session public.sessions;
  current_segment public.meeting_segments;
  current_lease public.recorder_leases;
  existing_recovery public.meeting_lifecycle_operations;
  committed public.meeting_lifecycle_operations;
  committed_count integer;
  request_value jsonb;
  response jsonb;
  next_lease_id text;
  next_fence bigint;
  next_attempt_id text;
  now_at timestamptz := clock_timestamp();
begin
  if p_command not in ('start', 'pause', 'resume', 'rollover', 'recover', 'stop')
    or nullif(trim(p_original_operation_id), '') is null
    or nullif(trim(p_recovery_operation_id), '') is null
    or p_original_operation_id = p_recovery_operation_id
    or p_expected_lifecycle_version is null or p_expected_lifecycle_version < 0
    or p_session_id is null
    or p_principal_type not in ('user', 'share')
    or nullif(trim(p_principal_id), '') is null then
    raise exception 'invalid_request';
  end if;

  request_value := jsonb_build_object(
    'originalOperationId', p_original_operation_id,
    'command', p_command,
    'expectedLifecycleVersion', p_expected_lifecycle_version,
    'sessionId', p_session_id,
    'segmentId', p_segment_id,
    'priorLeaseId', p_prior_lease_id,
    'priorFenceToken', p_prior_fence_token,
    'principalType', p_principal_type,
    'principalId', p_principal_id
  );

  select * into locked_meeting from public.meetings
  where owner_user_id = p_owner_user_id and id = p_meeting_id
  for update;
  if not found then raise exception 'meeting_not_found'; end if;
  now_at := clock_timestamp();
  if locked_meeting.purge_at is not null and locked_meeting.purge_at <= now_at then
    raise exception 'meeting_terminal';
  end if;
  if locked_meeting.lifecycle_contract_version <> 2 then
    raise exception 'meeting_lifecycle_conflict';
  end if;

  -- Search the original and every committed attempt. The meeting lock makes
  -- this check atomic with competing lifecycle commands.
  select count(*), (array_agg(operation_id order by created_at))[1]
    into committed_count, next_attempt_id
  from public.meeting_lifecycle_operations
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
    and command <> 'lease_recover'
    and (operation_id = p_original_operation_id
      or request_payload->'payload'->>'originalOperationId' = p_original_operation_id);
  if committed_count > 1 then raise exception 'meeting_lifecycle_conflict'; end if;
  if committed_count = 1 then
    select * into committed from public.meeting_lifecycle_operations
    where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
      and operation_id = next_attempt_id;
    if committed.command <> p_command
      or committed.request_payload->>'principalType' is distinct from p_principal_type
      or committed.request_payload->>'principalId' is distinct from p_principal_id then
      raise exception 'meeting_lifecycle_conflict';
    end if;
    response := jsonb_build_object(
      'status', 'committed',
      'operationId', committed.operation_id,
      'command', committed.command,
      'resultingLifecycleVersion', committed.resulting_lifecycle_version,
      'sessionId', committed.result->'session'->>'id',
      'segmentId', committed.result->'segment'->>'id'
    );
    -- After a lost Start/Rollover response, the same recorder may need its
    -- active lease to continue. A completed Stop has no active session.
    if locked_meeting.status in ('active', 'paused') then
      select * into current_session from public.sessions
      where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
        and id = (committed.result->'session'->>'id')::uuid
        and status in ('active', 'paused') for update;
      if found and current_session.current_segment_id is not distinct from
        nullif(committed.result->'segment'->>'id', '')::uuid then
        select * into current_lease from public.recorder_leases
        where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
          and session_id = current_session.id for update;
        if found and current_lease.principal_type = p_principal_type
          and current_lease.principal_id = p_principal_id then
          if current_lease.expires_at <= now_at then
            next_lease_id := 'lease-' || gen_random_uuid()::text;
            next_fence := current_lease.fence_token + 1;
            update public.recorder_leases
            set lease_id = next_lease_id, fence_token = next_fence,
              expires_at = now_at + interval '10 seconds', updated_at = now_at
            where id = current_lease.id returning * into current_lease;
          end if;
          response := response || jsonb_build_object(
            'leaseId', current_lease.lease_id,
            'fenceToken', current_lease.fence_token,
            'expiresAt', current_lease.expires_at
          );
        end if;
      end if;
    end if;
    return response;
  end if;

  select * into existing_recovery from public.meeting_lifecycle_operations
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
    and operation_id = p_recovery_operation_id;
  if found then
    if existing_recovery.command <> 'lease_recover'
      or existing_recovery.request_payload <> request_value then
      raise exception 'meeting_lifecycle_conflict';
    end if;
    return existing_recovery.result || jsonb_build_object('replayed', true);
  end if;

  if locked_meeting.lifecycle_version <> p_expected_lifecycle_version
    or locked_meeting.status not in ('active', 'paused') then
    raise exception 'meeting_lifecycle_conflict';
  end if;
  select * into current_session from public.sessions
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
    and id = p_session_id and lifecycle_contract_version = 2
    and status in ('active', 'paused')
  for update;
  if not found or current_session.current_segment_id is distinct from p_segment_id then
    raise exception 'meeting_lifecycle_conflict';
  end if;
  if p_segment_id is not null then
    select * into current_segment from public.meeting_segments
    where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
      and session_id = p_session_id and id = p_segment_id and status = 'active'
    for update;
    if not found then raise exception 'meeting_lifecycle_conflict'; end if;
  end if;

  select * into current_lease from public.recorder_leases
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
  for update;
  if not found or current_lease.session_id <> p_session_id
    or current_lease.principal_type <> p_principal_type
    or current_lease.principal_id <> p_principal_id
    or (p_prior_lease_id is not null and current_lease.lease_id <> p_prior_lease_id)
    or (p_prior_fence_token is not null and current_lease.fence_token <> p_prior_fence_token) then
    raise exception 'recorder_lease_invalid';
  end if;
  if current_lease.expires_at > now_at then raise exception 'recorder_already_active'; end if;
  -- A Start whose response was lost may omit prior lease/fence; other commands cannot.
  if p_command <> 'start'
    and (p_prior_lease_id is null or p_prior_fence_token is null) then
    raise exception 'invalid_request';
  end if;

  next_lease_id := 'lease-' || gen_random_uuid()::text;
  next_fence := current_lease.fence_token + 1;
  next_attempt_id := gen_random_uuid()::text;
  update public.recorder_leases
  set lease_id = next_lease_id, fence_token = next_fence,
    expires_at = now_at + interval '10 seconds', updated_at = now_at
  where id = current_lease.id;

  response := jsonb_build_object(
    'status', 'ready',
    'replayed', false,
    'originalOperationId', p_original_operation_id,
    'recoveryOperationId', p_recovery_operation_id,
    'attemptOperationId', next_attempt_id,
    'resultingLifecycleVersion', locked_meeting.lifecycle_version,
    'sessionId', p_session_id,
    'segmentId', p_segment_id,
    'leaseId', next_lease_id,
    'fenceToken', next_fence,
    'expiresAt', now_at + interval '10 seconds'
  );
  insert into public.meeting_lifecycle_operations (
    owner_user_id, meeting_id, operation_id, command, request_payload,
    result, resulting_lifecycle_version
  ) values (
    p_owner_user_id, p_meeting_id, p_recovery_operation_id, 'lease_recover',
    request_value, response, locked_meeting.lifecycle_version
  );
  return response;
end;
$$;

revoke all on function public.lookup_meeting_lifecycle_operation(uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.recover_meeting_recorder_lease(uuid,uuid,text,text,text,bigint,uuid,uuid,text,bigint,text,text) from public, anon, authenticated;
grant execute on function public.lookup_meeting_lifecycle_operation(uuid,uuid,text,text,text) to service_role;
grant execute on function public.recover_meeting_recorder_lease(uuid,uuid,text,text,text,bigint,uuid,uuid,text,bigint,text,text) to service_role;
