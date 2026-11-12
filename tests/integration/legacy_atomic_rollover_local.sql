-- Run only against an explicitly identified, migrated local PostgreSQL instance.
-- psql -X -v ON_ERROR_STOP=1 -f tests/integration/legacy_atomic_rollover_local.sql
-- The surrounding transaction rolls back all fixture rows and test triggers.
begin;
set constraints all deferred;

create temporary table issue41_atomic_fixture (
  owner_id uuid not null,
  meeting_id uuid not null,
  foreign_meeting_id uuid not null,
  source_id uuid not null,
  session_id uuid not null,
  other_session_id uuid not null,
  successor_id uuid
);
insert into issue41_atomic_fixture
values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), null);

do $$
declare f issue41_atomic_fixture%rowtype;
begin
  select * into f from issue41_atomic_fixture;
  insert into auth.users (id, aud, role, email, created_at, updated_at, is_anonymous)
  values (f.owner_id, 'authenticated', 'authenticated',
    f.owner_id || '@example.test', now(), now(), false);
  insert into public.meetings (
    id, owner_user_id, name, source_language_code, target_language_code,
    status, lifecycle_contract_version, settings
  ) values
    (f.meeting_id, f.owner_id, 'Atomic rollover fixture', 'en', 'fr',
      'active', 1, '{}'::jsonb),
    (f.foreign_meeting_id, f.owner_id, 'Foreign fixture', 'en', 'fr',
      'active', 1, '{}'::jsonb);
  insert into public.meeting_segments (
    id, owner_user_id, meeting_id, session_id, sequence, status,
    lifecycle_contract_version, live_session_id, settings_snapshot
  ) values (
    f.source_id, f.owner_id, f.meeting_id, null, 0, 'active',
    1, 'live-1', '{}'::jsonb
  );
  insert into public.sessions (
    id, owner_user_id, meeting_id, segment_id, status, target_language_code,
    created_at, payload, transcript_items, lifecycle_contract_version
  ) values (
    f.session_id, f.owner_id, f.meeting_id, f.source_id, 'active', 'fr',
    now(), '{}'::jsonb, '[]'::jsonb, 1
  );
end;
$$;

create function pg_temp.issue41_atomic_rollover(p_operation_id text,
  p_expected_session_id uuid default null, p_meeting_id uuid default null,
  p_canonical_payload text default 'fixture-canonical')
returns jsonb language plpgsql as $$
declare
  f issue41_atomic_fixture%rowtype;
  old_revision bigint;
  canonical text := p_canonical_payload;
  next_checkpoint jsonb;
begin
  select * into f from issue41_atomic_fixture;
  select coalesce((checkpoint->>'revision')::bigint, 0) into old_revision
  from public.meeting_segments where id = f.source_id;
  next_checkpoint := jsonb_build_object(
    'meetingId', f.meeting_id, 'segmentId', f.source_id,
    'idempotencyKey', p_operation_id, 'revision', old_revision + 1,
    'durableChunks', '[]'::jsonb, 'finalCues', '[]'::jsonb,
    '_operationPayloads', jsonb_build_object(p_operation_id, canonical)
  );
  return public.rollover_legacy_meeting_segment_v1(
    f.owner_id, coalesce(p_meeting_id, f.meeting_id), f.source_id,
    p_expected_session_id, p_operation_id, canonical, old_revision,
    next_checkpoint, '[]'::jsonb, now(), 'live-2', '{}'::jsonb
  );
end;
$$;

create function public.issue41_atomic_fault() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare point text := current_setting('issue41.atomic_fail_point', true);
begin
  if tg_op = 'INSERT' and point = 'after_s1_insert'
    and new.sequence = 1 and new.status = 'created' then
    raise exception 'issue41 injected failure';
  end if;
  if tg_op = 'UPDATE' and ((point = 'after_s0_update'
      and old.sequence = 0 and new.status = 'completed')
    or (point = 'before_s1_activation'
      and old.sequence = 1 and new.status = 'active')) then
    raise exception 'issue41 injected failure';
  end if;
  return new;
end;
$$;
create trigger issue41_atomic_fault_after
after insert or update on public.meeting_segments
for each row execute function public.issue41_atomic_fault();
create trigger issue41_atomic_fault_before
before update of status on public.meeting_segments
for each row execute function public.issue41_atomic_fault();

do $$
declare
  f issue41_atomic_fixture%rowtype;
  point text;
  failed boolean;
  first_result jsonb;
  replay_result jsonb;
  cue_id uuid;
begin
  select * into f from issue41_atomic_fixture;
  foreach point in array array['after_s0_update', 'after_s1_insert', 'before_s1_activation'] loop
    perform set_config('issue41.atomic_fail_point', point, true);
    failed := false;
    begin
      perform pg_temp.issue41_atomic_rollover('atomic-main');
    exception when raise_exception then
      failed := sqlerrm = 'issue41 injected failure';
      if not failed then raise; end if;
    end;
    if not failed then raise exception 'fault point % did not fire', point; end if;
    if (select status from public.meeting_segments where id = f.source_id) <> 'active'
      or (select session_id from public.meeting_segments where id = f.source_id) is not null
      or (select count(*) from public.meeting_segments
          where meeting_id = f.meeting_id and sequence = 1) <> 0
      or (select count(*) from public.meeting_lifecycle_operations
          where meeting_id = f.meeting_id and operation_id = 'atomic-main') <> 0
      or (select coalesce((checkpoint->>'revision')::integer, 0)
          from public.meeting_segments where id = f.source_id) <> 0 then
      raise exception 'partial commit after %', point;
    end if;
  end loop;

  perform set_config('issue41.atomic_fail_point', '', true);
  first_result := pg_temp.issue41_atomic_rollover('atomic-main');
  f.successor_id := (first_result->'segment'->>'id')::uuid;
  update issue41_atomic_fixture set successor_id = f.successor_id;
  if (first_result->>'replayed')::boolean
    or (select status from public.meeting_segments where id = f.source_id) <> 'completed'
    or (select session_id from public.meeting_segments where id = f.source_id) <> f.session_id
    or (select status from public.meeting_segments where id = f.successor_id) <> 'active'
    or (select session_id from public.meeting_segments where id = f.successor_id) <> f.session_id
    or (select (checkpoint->>'revision')::integer from public.meeting_segments
        where id = f.source_id) <> 1 then
    raise exception 'committed rollover state is invalid';
  end if;
  replay_result := pg_temp.issue41_atomic_rollover('atomic-main');
  if (replay_result->>'replayed')::boolean is distinct from true
    or (replay_result->'segment'->>'id')::uuid <> f.successor_id
    or (select count(*) from public.meeting_segments
        where meeting_id = f.meeting_id and sequence = 1) <> 1 then
    raise exception 'idempotent replay created or returned another successor';
  end if;

  failed := false;
  begin
    perform pg_temp.issue41_atomic_rollover('atomic-main', null, null, 'changed-payload');
  exception when sqlstate 'P0042' then failed := true;
  end;
  if not failed then raise exception 'same operation accepted changed payload'; end if;

  -- S0 is completed, yet its bound Session can retry a delayed Cue.
  cue_id := gen_random_uuid();
  perform public.publish_meeting_cue_v2(f.meeting_id, f.source_id,
    jsonb_build_object('id', cue_id, 'session_id', f.session_id,
      'sequence', 1, 'source_text', 'fixture', 'source_status', 'finalized',
      'translation_status', 'pending', 'source_version', 1,
      'translation_version', 0, 'started_at', 1, 'ended_at', 2));
  for point in select unnest(array['2', '3']) loop
    perform public.publish_meeting_cue_v2(f.meeting_id, f.successor_id,
      jsonb_build_object('id', gen_random_uuid(), 'session_id', f.session_id,
        'sequence', point::integer, 'source_text', 'fixture',
        'source_status', 'finalized', 'translation_status', 'pending',
        'source_version', 1, 'translation_version', 0,
        'started_at', point::integer * 10, 'ended_at', point::integer * 10 + 1));
  end loop;
  if (select count(*) from public.subtitle_cues
      where owner_user_id = f.owner_id and session_id = f.session_id
        and segment_id in (f.source_id, f.successor_id)) <> 3 then
    raise exception 'S0 or S1 Cue persistence failed';
  end if;

  insert into public.sessions (
    id, owner_user_id, meeting_id, segment_id, status, target_language_code,
    created_at, payload, transcript_items, lifecycle_contract_version
  ) values (
    f.other_session_id, f.owner_id, f.meeting_id, f.source_id,
    'active', 'fr', now(), '{}'::jsonb, '[]'::jsonb, 1
  );
  failed := false;
  begin
    perform public.publish_meeting_cue_v2(f.meeting_id, f.successor_id,
      jsonb_build_object('id', gen_random_uuid(), 'session_id', f.other_session_id,
        'sequence', 4, 'source_text', 'fixture', 'source_status', 'finalized',
        'translation_status', 'pending', 'source_version', 1,
        'translation_version', 0, 'started_at', 40, 'ended_at', 41));
  exception when sqlstate 'P0042' then failed := true;
  end;
  if not failed then raise exception 'cross-Session Cue accepted'; end if;

  failed := false;
  begin
    perform pg_temp.issue41_atomic_rollover('wrong-meeting', null, f.foreign_meeting_id);
  exception when sqlstate 'P0043' then failed := true;
  end;
  if not failed then raise exception 'cross-Meeting rollover accepted'; end if;

  update public.meetings set lifecycle_contract_version = 2 where id = f.meeting_id;
  failed := false;
  begin
    perform pg_temp.issue41_atomic_rollover('v2-contract');
  exception when sqlstate 'P0044' then failed := true;
  end;
  if not failed then raise exception 'v2 Meeting used v1 rollover'; end if;
end;
$$;

rollback;
