-- Run only against an isolated local Supabase PostgreSQL database.
-- Every fixture and lifecycle write is rolled back at the end.
\set ON_ERROR_STOP on
begin;

create function pg_temp.lifecycle_command(
  owner_id uuid, meeting_id uuid, command_name text, operation_id text,
  expected_version bigint, lease_id text default null, fence_token bigint default null
) returns jsonb language sql as $$
  select public.execute_meeting_lifecycle_command(
    owner_id, meeting_id, command_name, operation_id, expected_version,
    'user', owner_id::text, lease_id, fence_token, false, '{}'::jsonb
  );
$$;

do $$
declare
  owner_id uuid := gen_random_uuid();
  meeting_a uuid := gen_random_uuid();
  meeting_b uuid := gen_random_uuid();
  meeting_c uuid := gen_random_uuid();
  first_result jsonb;
  result_value jsonb;
  lease_id text;
  fence_token bigint;
  first_segment uuid;
  second_segment uuid;
  operation_count integer;
begin
  insert into auth.users (id, email) values (owner_id, 'issue41-recovery@example.invalid');
  insert into public.meetings (
    id, owner_user_id, name, source_language_code, target_language_code,
    status, lifecycle_contract_version, lifecycle_version
  ) values
    (meeting_a, owner_id, 'issue41-recovery-a', 'zh-Hant', 'en', 'created', 2, 0),
    (meeting_b, owner_id, 'issue41-recovery-b', 'zh-Hant', 'en', 'created', 2, 0),
    (meeting_c, owner_id, 'issue41-recovery-c', 'zh-Hant', 'en', 'created', 2, 0);

  first_result := pg_temp.lifecycle_command(owner_id, meeting_a, 'start', 'start-a', 0);
  assert first_result->>'replayed' = 'false', 'first start did not commit';
  first_segment := (first_result->'segment'->>'id')::uuid;
  lease_id := first_result->'lease'->>'leaseId';
  fence_token := (first_result->'lease'->>'fenceToken')::bigint;
  result_value := pg_temp.lifecycle_command(owner_id, meeting_a, 'start', 'start-a', 0);
  assert result_value->>'replayed' = 'true', 'same start did not replay';
  assert (result_value->'segment'->>'id')::uuid = first_segment, 'start made duplicate segment';
  raise notice 'PASS: successful start and same-operation replay keep one segment';

  -- Simulate a committed RPC whose client response was lost: discard its result.
  perform pg_temp.lifecycle_command(owner_id, meeting_a, 'rollover', 'rollover-lost-reply', 1, lease_id, fence_token);
  result_value := pg_temp.lifecycle_command(owner_id, meeting_a, 'rollover', 'rollover-lost-reply', 1, lease_id, fence_token);
  assert result_value->>'replayed' = 'true', 'committed rollover did not replay';
  second_segment := (result_value->'segment'->>'id')::uuid;
  assert second_segment <> first_segment, 'rollover did not make a new segment';
  raise notice 'PASS: committed/lost-reply rollover returns its original segment';

  -- An exception rolls back only this subtransaction, modeling no commit.
  begin
    perform pg_temp.lifecycle_command(owner_id, meeting_a, 'rollover', 'rollover-not-committed', 2, lease_id, fence_token);
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then raise; end if;
  end;
  select count(*) into operation_count from public.meeting_lifecycle_operations
    where meeting_id = meeting_a and operation_id = 'rollover-not-committed';
  assert operation_count = 0, 'rolled-back operation was persisted';
  result_value := pg_temp.lifecycle_command(owner_id, meeting_a, 'rollover', 'rollover-not-committed', 2, lease_id, fence_token);
  assert result_value->>'replayed' = 'false', 'uncommitted valid-lease operation did not execute';
  raise notice 'PASS: uncommitted operation can execute with still-valid lease';

  -- A distinct operation with a stale lifecycleVersion must not execute.
  begin
    perform pg_temp.lifecycle_command(owner_id, meeting_a, 'stop', 'stale-version', 1, lease_id, fence_token);
    raise exception 'expected_conflict_missing';
  exception when others then
    if sqlerrm <> 'meeting_lifecycle_conflict' then raise; end if;
  end;
  raise notice 'PASS: stale lifecycleVersion is rejected';

  first_result := pg_temp.lifecycle_command(owner_id, meeting_b, 'start', 'start-b', 0);
  lease_id := first_result->'lease'->>'leaseId';
  fence_token := (first_result->'lease'->>'fenceToken')::bigint;
  update public.recorder_leases set expires_at = clock_timestamp() - interval '1 second'
    where meeting_id = meeting_b;
  begin
    perform pg_temp.lifecycle_command(owner_id, meeting_b, 'stop', 'stop-expired', 1, lease_id, fence_token);
    raise exception 'expected_lease_rejection_missing';
  exception when others then
    if sqlerrm <> 'recorder_lease_invalid' then raise; end if;
  end;
  select count(*) into operation_count from public.meeting_lifecycle_operations
    where meeting_id = meeting_b and operation_id = 'stop-expired';
  assert operation_count = 0, 'expired uncommitted operation was recorded';
  begin
    perform public.renew_meeting_recorder_lease(owner_id, meeting_b, 'user', owner_id::text, lease_id, fence_token);
    raise exception 'expected_renew_rejection_missing';
  exception when others then
    if sqlerrm <> 'recorder_lease_invalid' then raise; end if;
  end;
  raise notice 'PASS: expired, uncommitted stop is rejected; expired lease cannot renew';

  -- Existing takeover reacquires a lease, but also creates a new segment.
  first_result := pg_temp.lifecycle_command(owner_id, meeting_b, 'takeover', 'takeover-b', 1);
  assert (select count(*) from public.meeting_segments where meeting_id = meeting_b) = 2,
    'takeover did not create its documented second segment';
  begin
    perform pg_temp.lifecycle_command(owner_id, meeting_b, 'stop', 'stop-expired', 1, lease_id, fence_token);
    raise exception 'expected_stale_version_missing';
  exception when others then
    if sqlerrm <> 'meeting_lifecycle_conflict' then raise; end if;
  end;
  raise notice 'PASS: takeover changes segment identity/version; original stop remains unusable';

  first_result := pg_temp.lifecycle_command(owner_id, meeting_c, 'start', 'start-c', 0);
  result_value := pg_temp.lifecycle_command(owner_id, meeting_c, 'stop', 'stop-c', 1,
    first_result->'lease'->>'leaseId', (first_result->'lease'->>'fenceToken')::bigint);
  assert result_value->>'replayed' = 'false', 'stop did not commit';
  assert result_value->'meeting'->>'status' = 'completed', 'stop did not complete meeting';
  assert (result_value->'meeting'->>'lifecycle_version')::bigint = 2, 'stop did not advance lifecycleVersion';
  assert result_value->'session'->>'status' = 'stopped', 'stop did not stop session';
  assert result_value->'session'->>'current_segment_id' is null, 'stop retained current segment';
  assert (select status from public.meeting_segments
    where id = (first_result->'segment'->>'id')::uuid) = 'completed', 'stop did not complete segment';
  assert (select expires_at <= clock_timestamp() from public.recorder_leases
    where meeting_id = meeting_c), 'stop did not expire lease';
  result_value := pg_temp.lifecycle_command(owner_id, meeting_c, 'stop', 'stop-c', 1,
    first_result->'lease'->>'leaseId', (first_result->'lease'->>'fenceToken')::bigint);
  assert result_value->>'replayed' = 'true', 'committed stop did not replay after lease expiry';
  update public.meetings set purge_at = clock_timestamp() - interval '1 second'
    where id = meeting_c;
  result_value := pg_temp.lifecycle_command(owner_id, meeting_c, 'stop', 'stop-c', 1,
    first_result->'lease'->>'leaseId', (first_result->'lease'->>'fenceToken')::bigint);
  assert result_value->>'replayed' = 'true', 'retention-due committed stop did not replay';
  begin
    perform pg_temp.lifecycle_command(owner_id, meeting_c, 'stop', 'stop-new-id', 2,
      first_result->'lease'->>'leaseId', (first_result->'lease'->>'fenceToken')::bigint);
    raise exception 'expected_duplicate_stop_rejection_missing';
  exception when others then
    if sqlerrm <> 'meeting_lifecycle_conflict' then raise; end if;
  end;
  raise notice 'PASS: stopped meeting replays same operation even after purge_at; new stop is rejected';

  assert not exists (
    select 1 from public.meeting_lifecycle_operations
    where meeting_id in (meeting_a, meeting_b, meeting_c)
      and request_payload->'payload' <> '{}'::jsonb
  ), 'non-metadata payload was written';
  raise notice 'PASS: every test request_payload.payload is empty metadata';
end;
$$;

rollback;
