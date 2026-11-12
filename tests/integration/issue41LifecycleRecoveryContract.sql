-- Run against isolated local Supabase PostgreSQL after the Issue #41 recovery migration.
\set ON_ERROR_STOP on
begin;
do $$
<<vars>>
declare
  owner_id uuid := gen_random_uuid();
  other_owner_id uuid := gen_random_uuid();
  meeting_id uuid := gen_random_uuid();
  other_meeting_id uuid := gen_random_uuid();
  started jsonb;
  looked_up jsonb;
  recovery jsonb;
  start_lease jsonb;
  replayed jsonb;
  rolled jsonb;
  stopped jsonb;
  lease_id text;
  fence_token bigint;
  session_id uuid;
  segment_id uuid;
begin
  insert into auth.users(id,email) values
    (owner_id, 'issue41-recovery-' || owner_id || '@example.invalid'),
    (other_owner_id, 'issue41-recovery-' || other_owner_id || '@example.invalid');
  insert into public.meetings(id,owner_user_id,name,source_language_code,target_language_code,
    status,lifecycle_contract_version,lifecycle_version) values
    (meeting_id,owner_id,'issue41-recovery-contract','zh-Hant','en','created',2,0),
    (other_meeting_id,owner_id,'issue41-recovery-other','zh-Hant','en','created',2,0);
  assert not has_function_privilege('anon',
    'public.lookup_meeting_lifecycle_operation(uuid,uuid,text,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated',
    'public.lookup_meeting_lifecycle_operation(uuid,uuid,text,text,text)', 'EXECUTE')
    and has_function_privilege('service_role',
    'public.lookup_meeting_lifecycle_operation(uuid,uuid,text,text,text)', 'EXECUTE'),
    'lookup EXECUTE grants are too broad';

  looked_up := public.lookup_meeting_lifecycle_operation(owner_id,meeting_id,'start-a','user',owner_id::text);
  assert looked_up->>'status' = 'unknown', 'pre-commit lookup must be unknown';
  started := public.execute_meeting_lifecycle_command(owner_id,meeting_id,'start','start-a',0,
    'user',owner_id::text,null,null,false,'{}'::jsonb);
  session_id := (started->'session'->>'id')::uuid;
  segment_id := (started->'segment'->>'id')::uuid;
  lease_id := started->'lease'->>'leaseId';
  fence_token := (started->'lease'->>'fenceToken')::bigint;
  looked_up := public.lookup_meeting_lifecycle_operation(owner_id,meeting_id,'start-a','user',owner_id::text);
  assert looked_up->>'status' = 'committed' and looked_up->>'sessionId' = session_id::text
    and looked_up->>'segmentId' = segment_id::text, 'committed lookup identity mismatch';
  assert looked_up->>'targetIdentityRecorded' = 'true'
    and looked_up ? 'targetSessionId' and looked_up->'targetSessionId' = 'null'::jsonb
    and looked_up ? 'targetSegmentId' and looked_up->'targetSegmentId' = 'null'::jsonb,
    'Start must record a known empty pre-transition target';
  assert (select count(*) from jsonb_object_keys(looked_up)) = 9, 'lookup exposed extra fields';
  start_lease := public.recover_meeting_recorder_lease(owner_id,meeting_id,'start-a','resume-start-a',
    'start',1,session_id,segment_id,null,null,'user',owner_id::text);
  assert start_lease->>'status' = 'committed' and start_lease->>'leaseId' = lease_id,
    'committed Start did not recover its valid lease';
  assert public.lookup_meeting_lifecycle_operation(owner_id,other_meeting_id,'start-a','user',owner_id::text)->>'status' = 'unknown',
    'operation leaked across meetings';
  begin
    perform public.lookup_meeting_lifecycle_operation(other_owner_id,meeting_id,'start-a','user',other_owner_id::text);
    raise exception 'owner_scope_missing';
  exception when others then
    if sqlerrm <> 'meeting_not_found' then raise; end if;
  end;
  begin
    perform public.lookup_meeting_lifecycle_operation(owner_id,meeting_id,'start-a','user',other_owner_id::text);
    raise exception 'principal_scope_missing';
  exception when others then
    if sqlerrm <> 'auth_forbidden' then raise; end if;
  end;
  raise notice 'PASS: metadata-only lookup and owner/meeting/principal scope';

  begin
    perform public.execute_meeting_lifecycle_command(owner_id,meeting_id,'pause','old-checkpoint',1,
      'user',owner_id::text,lease_id,fence_token,false,'{"checkpoint":{"durableChunks":[]}}'::jsonb);
    raise exception 'checkpoint_rejection_missing';
  exception when others then
    if sqlerrm not in ('checkpoint_conflict', 'meeting_content_local_only') then raise; end if;
  end;
  assert not exists(select 1 from public.meeting_lifecycle_operations op
    where op.meeting_id = vars.meeting_id and op.operation_id = 'old-checkpoint'), 'old payload was stored';
  raise notice 'PASS: old checkpoint payload rejected before commit';

  update public.recorder_leases lease set expires_at=clock_timestamp()-interval '1 second'
    where lease.owner_user_id=owner_id and lease.meeting_id=vars.meeting_id;
  start_lease := public.recover_meeting_recorder_lease(owner_id,meeting_id,'start-a','resume-start-b',
    'start',1,session_id,segment_id,null,null,'user',owner_id::text);
  assert start_lease->>'status' = 'committed'
    and (start_lease->>'fenceToken')::bigint = fence_token + 1
    and (select count(*) from public.meeting_segments s where s.meeting_id=vars.meeting_id) = 1,
    'committed Start lease recovery changed segment identity';
  lease_id := start_lease->>'leaseId';
  fence_token := (start_lease->>'fenceToken')::bigint;
  update public.recorder_leases lease set expires_at=clock_timestamp()-interval '1 second'
    where lease.owner_user_id=owner_id and lease.meeting_id=vars.meeting_id;
  recovery := public.recover_meeting_recorder_lease(owner_id,meeting_id,'rollover-pending','lease-recovery-a',
    'rollover',1,session_id,segment_id,lease_id,fence_token,'user',owner_id::text);
  assert recovery->>'status' = 'ready' and (recovery->>'fenceToken')::bigint = fence_token+1,
    'expired lease was not fenced';
  assert (select count(*) from public.meeting_segments s where s.meeting_id=vars.meeting_id) = 1,
    'lease recovery created a segment';
  replayed := public.recover_meeting_recorder_lease(owner_id,meeting_id,'rollover-pending','lease-recovery-a',
    'rollover',1,session_id,segment_id,lease_id,fence_token,'user',owner_id::text);
  assert replayed->>'replayed' = 'true'
    and replayed->>'attemptOperationId' = recovery->>'attemptOperationId',
    'recovery RPC replay changed attempt identity';
  raise notice 'PASS: expired lease recovery is idempotent and creates no segment';

  rolled := public.execute_meeting_lifecycle_command(owner_id,meeting_id,'rollover',
    recovery->>'attemptOperationId',1,'user',owner_id::text,
    recovery->>'leaseId',(recovery->>'fenceToken')::bigint,false,
    jsonb_build_object('originalOperationId','rollover-pending',
      'recoveryOperationId','lease-recovery-a'));
  assert rolled->>'replayed' = 'false'
    and (select count(*) from public.meeting_segments s where s.meeting_id=vars.meeting_id) = 2,
    'attempt did not create exactly one successor';
  looked_up := public.lookup_meeting_lifecycle_operation(owner_id,meeting_id,
    recovery->>'attemptOperationId','user',owner_id::text);
  assert looked_up->>'targetIdentityRecorded' = 'true'
    and looked_up->>'targetSessionId' = session_id::text
    and looked_up->>'targetSegmentId' = segment_id::text
    and looked_up->>'segmentId' = rolled->'segment'->>'id',
    'Rollover lookup did not preserve the original target and successor';
  assert (select count(*) from jsonb_object_keys(looked_up)) = 9,
    'Rollover lookup exposed extra fields';
  looked_up := public.recover_meeting_recorder_lease(owner_id,meeting_id,'rollover-pending','lease-recovery-b',
    'rollover',1,session_id,segment_id,recovery->>'leaseId',
    (recovery->>'fenceToken')::bigint,'user',owner_id::text);
  assert looked_up->>'status' = 'committed'
    and looked_up->>'operationId' = recovery->>'attemptOperationId',
    'committed attempt was not found before new lease';
  replayed := public.recover_meeting_recorder_lease(owner_id,meeting_id,'rollover-pending','lease-recovery-a',
    'rollover',1,session_id,segment_id,lease_id,fence_token,'user',owner_id::text);
  assert replayed->>'status' = 'committed', 'replayed recovery missed committed attempt';
  assert (select count(*) from public.meeting_segments s where s.meeting_id=vars.meeting_id) = 2,
    'committed retry created a duplicate segment';
  raise notice 'PASS: committed attempt detected without duplicate rollover';

  stopped := public.execute_meeting_lifecycle_command(owner_id,meeting_id,'stop',
    'stop-after-rollover',2,'user',owner_id::text,
    rolled->'lease'->>'leaseId',(rolled->'lease'->>'fenceToken')::bigint,false,'{}'::jsonb);
  looked_up := public.lookup_meeting_lifecycle_operation(owner_id,meeting_id,
    'stop-after-rollover','user',owner_id::text);
  assert looked_up->>'targetIdentityRecorded' = 'true'
    and looked_up->>'targetSessionId' = session_id::text
    and looked_up->>'targetSegmentId' = rolled->'segment'->>'id'
    and looked_up->'segmentId' = 'null'::jsonb,
    'Stop lookup lost its target after clearing current Segment';
  assert (select current_segment_id from public.sessions where id = session_id) is null,
    'Stop did not clear current_segment_id';
  replayed := public.execute_meeting_lifecycle_command(owner_id,meeting_id,'stop',
    'stop-after-rollover',2,'user',owner_id::text,
    rolled->'lease'->>'leaseId',(rolled->'lease'->>'fenceToken')::bigint,false,'{}'::jsonb);
  assert replayed->>'replayed' = 'true'
    and (select count(*) from public.meeting_segments s where s.meeting_id=vars.meeting_id) = 2,
    'Stop replay changed Segment count';
  raise notice 'PASS: Stop and Rollover targets survive commit, lookup, and replay';

  update public.meeting_lifecycle_operations op
  set result = jsonb_set(result - 'targetSessionId' - 'targetSegmentId',
    '{segment,checkpoint}', '{"secretCue":"must-not-leak"}'::jsonb)
  where op.owner_user_id = owner_id and op.meeting_id = vars.meeting_id
    and op.operation_id = 'start-a';
  looked_up := public.lookup_meeting_lifecycle_operation(owner_id,meeting_id,
    'start-a','user',owner_id::text);
  assert looked_up->>'targetIdentityRecorded' = 'false'
    and not looked_up ? 'targetSessionId' and not looked_up ? 'targetSegmentId'
    and looked_up::text not like '%must-not-leak%'
    and (select count(*) from jsonb_object_keys(looked_up)) = 7,
    'legacy operation must remain evidence-insufficient and content-free';
  raise notice 'PASS: legacy missing identity is explicit and lookup omits content';
end;
$$;
rollback;
