-- One transaction owns the legacy v1 checkpoint, Cue and Segment transition.
-- The checked checkpoint writer remains the only path that changes durable
-- checkpoint content or upserts final Cues.
create function public.rollover_legacy_meeting_segment_v1(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_source_segment_id uuid,
  p_expected_session_id uuid,
  p_operation_id text,
  p_canonical_payload text,
  p_expected_revision bigint,
  p_next_checkpoint jsonb,
  p_cues jsonb,
  p_ended_at timestamptz,
  p_next_live_session_id text,
  p_settings_snapshot jsonb
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  locked_meeting public.meetings;
  source_segment public.meeting_segments;
  bound_session public.sessions;
  successor public.meeting_segments;
  prior_operation public.meeting_lifecycle_operations;
  request_value jsonb;
  response jsonb;
  candidate_count integer;
  now_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_owner_user_id is null or p_meeting_id is null or p_source_segment_id is null
    or nullif(pg_catalog.btrim(p_operation_id), '') is null
    or nullif(p_canonical_payload, '') is null
    or p_expected_revision is null or p_next_checkpoint is null
    or pg_catalog.jsonb_typeof(p_next_checkpoint) <> 'object'
    or p_cues is null or pg_catalog.jsonb_typeof(p_cues) <> 'array'
    or p_ended_at is null or nullif(pg_catalog.btrim(p_next_live_session_id), '') is null
    or p_settings_snapshot is null or pg_catalog.jsonb_typeof(p_settings_snapshot) <> 'object'
  then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;

  select * into locked_meeting from public.meetings
  where id = p_meeting_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'recorder_session_mismatch' using errcode = 'P0043';
  end if;
  if locked_meeting.lifecycle_contract_version <> 1 then
    raise exception 'meeting_lifecycle_conflict' using errcode = 'P0044';
  end if;

  select * into source_segment from public.meeting_segments
  where id = p_source_segment_id and meeting_id = p_meeting_id
    and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'recorder_session_mismatch' using errcode = 'P0043';
  end if;
  if source_segment.lifecycle_contract_version <> 1 then
    raise exception 'meeting_lifecycle_conflict' using errcode = 'P0044';
  end if;

  request_value := pg_catalog.jsonb_build_object(
    'command', 'legacy_rollover',
    'sourceSegmentId', p_source_segment_id,
    'expectedSessionId', p_expected_session_id,
    'nextLiveSessionId', p_next_live_session_id,
    'canonicalPayload', p_canonical_payload
  );
  select * into prior_operation from public.meeting_lifecycle_operations
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
    and operation_id = p_operation_id for update;
  if found then
    if prior_operation.command <> 'legacy_rollover'
      or prior_operation.request_payload <> request_value then
      raise exception 'checkpoint_conflict' using errcode = 'P0042';
    end if;
    return prior_operation.result || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if locked_meeting.status <> 'active' or source_segment.status <> 'active' then
    raise exception 'meeting_lifecycle_conflict' using errcode = 'P0044';
  end if;
  if (p_next_checkpoint->'_operationPayloads'->>p_operation_id) is distinct from p_canonical_payload
    or (p_next_checkpoint->>'revision')::bigint is distinct from p_expected_revision + 1 then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;

  -- Lock every existing Session in this Meeting before inferring a unique v1
  -- Session. The Meeting FOR UPDATE lock also blocks FK-backed new inserts.
  perform id from public.sessions
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id for update;
  if p_expected_session_id is not null then
    select * into bound_session from public.sessions
    where id = p_expected_session_id and owner_user_id = p_owner_user_id
      and meeting_id = p_meeting_id;
  elsif source_segment.session_id is not null then
    select * into bound_session from public.sessions
    where id = source_segment.session_id and owner_user_id = p_owner_user_id
      and meeting_id = p_meeting_id;
  else
    select count(*) into candidate_count from public.sessions
    where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
      and segment_id = p_source_segment_id and status = 'active'
      and lifecycle_contract_version = 1;
    if candidate_count <> 1 then
      raise exception 'recorder_session_mismatch' using errcode = 'P0043';
    end if;
    select * into bound_session from public.sessions
    where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
      and segment_id = p_source_segment_id and status = 'active'
      and lifecycle_contract_version = 1;
  end if;
  if bound_session.id is null or bound_session.status <> 'active'
    or bound_session.lifecycle_contract_version <> 1
    or (bound_session.segment_id is distinct from p_source_segment_id
      and source_segment.session_id is distinct from bound_session.id)
    or (source_segment.session_id is not null
      and source_segment.session_id <> bound_session.id) then
    raise exception 'recorder_session_mismatch' using errcode = 'P0043';
  end if;
  if exists (
    select 1 from public.subtitle_cues
    where owner_user_id = p_owner_user_id and segment_id = p_source_segment_id
      and session_id is distinct from bound_session.id
  ) then
    raise exception 'recorder_session_mismatch' using errcode = 'P0043';
  end if;

  select * into successor from public.meeting_segments
  where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
    and sequence = source_segment.sequence + 1;
  if found or exists (
    select 1 from public.meeting_segments
    where owner_user_id = p_owner_user_id and meeting_id = p_meeting_id
      and sequence > source_segment.sequence
  ) then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;

  -- Bind S0 before checked Cue writes. Both this update and the checked writer
  -- call roll back if any later step fails.
  if source_segment.session_id is null then
    update public.meeting_segments set session_id = bound_session.id,
      updated_at = now_at
    where id = p_source_segment_id and owner_user_id = p_owner_user_id;
  end if;
  perform public.apply_meeting_checkpoint_operation_v2(
    p_meeting_id, p_source_segment_id, p_expected_revision,
    p_operation_id, p_canonical_payload, p_next_checkpoint, p_cues,
    'completed', p_ended_at, source_segment.error_info
  );
  select * into source_segment from public.meeting_segments
  where id = p_source_segment_id and owner_user_id = p_owner_user_id;

  insert into public.meeting_segments (
    id, owner_user_id, meeting_id, session_id, lifecycle_contract_version,
    sequence, status, live_session_id, settings_snapshot, checkpoint,
    created_at, updated_at
  ) values (
    pg_catalog.gen_random_uuid(), p_owner_user_id, p_meeting_id, bound_session.id, 1,
    source_segment.sequence + 1, 'created', p_next_live_session_id,
    p_settings_snapshot, '{}'::jsonb, now_at, now_at
  ) returning * into successor;
  update public.meeting_segments set status = 'active',
    started_at = now_at, updated_at = now_at
  where id = successor.id and owner_user_id = p_owner_user_id
  returning * into successor;

  response := pg_catalog.jsonb_build_object(
    'completedSegment', pg_catalog.to_jsonb(source_segment),
    'segment', pg_catalog.to_jsonb(successor),
    'replayed', false
  );
  insert into public.meeting_lifecycle_operations (
    owner_user_id, meeting_id, operation_id, command, request_payload,
    result, resulting_lifecycle_version
  ) values (
    p_owner_user_id, p_meeting_id, p_operation_id, 'legacy_rollover',
    request_value, response, locked_meeting.lifecycle_version
  );
  return response;
end;
$$;

revoke all on function public.rollover_legacy_meeting_segment_v1(
  uuid, uuid, uuid, uuid, text, text, bigint, jsonb, jsonb,
  timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.rollover_legacy_meeting_segment_v1(
  uuid, uuid, uuid, uuid, text, text, bigint, jsonb, jsonb,
  timestamptz, text, jsonb
) to service_role;

-- A completed v1 Segment can receive a delayed Cue from its bound Session.
-- The checked writer still enforces Meeting, Session, Segment and Cue identity.
-- Lifecycle v2 terminal Segments retain the original rejection rule.
create or replace function public.publish_meeting_cue_v2(
  p_meeting_id uuid, p_segment_id uuid, p_cue jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  owner_id uuid;
  segment_row public.meeting_segments;
begin
  select owner_user_id into owner_id from public.meetings
  where id = p_meeting_id for update;
  select * into segment_row from public.meeting_segments
  where id = p_segment_id and meeting_id = p_meeting_id
    and owner_user_id = owner_id for update;
  if owner_id is null or segment_row.id is null
    or not (segment_row.status in ('created', 'active', 'paused')
      or (segment_row.lifecycle_contract_version = 1
        and segment_row.status = 'completed'
        and segment_row.session_id::text = p_cue->>'session_id'
        and exists (
          select 1 from public.meeting_segments active_later
          where active_later.owner_user_id = owner_id
            and active_later.meeting_id = p_meeting_id
            and active_later.lifecycle_contract_version = 1
            and active_later.session_id = segment_row.session_id
            and active_later.sequence > segment_row.sequence
            and active_later.status = 'active'
        ))) then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  perform public.lt41_upsert_cue_checked(owner_id, p_meeting_id, p_segment_id, p_cue);
  return p_cue;
end;
$$;
alter function public.publish_meeting_cue_v2(uuid, uuid, jsonb)
  owner to lt41_checkpoint_writer;
revoke all on function public.publish_meeting_cue_v2(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_meeting_cue_v2(uuid, uuid, jsonb)
  to service_role;
