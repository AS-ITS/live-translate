create or replace function public.resume_legacy_meeting_segment(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_source_segment_id uuid,
  p_operation_id text,
  p_payload_hash text,
  p_next_live_session_id text,
  p_expected_session_id uuid,
  p_checkpoint jsonb,
  p_global_glossary_entries jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  locked_meeting public.meetings;
  source_segment public.meeting_segments;
  bound_session public.sessions;
  effective_session_id uuid;
  successor public.meeting_segments;
  prior_operation public.meeting_lifecycle_operations;
  request_value jsonb;
  settings_snapshot jsonb;
  response jsonb;
  now_at timestamptz := clock_timestamp();
begin
  if nullif(trim(p_operation_id), '') is null
    or nullif(trim(p_payload_hash), '') is null
    or nullif(trim(p_next_live_session_id), '') is null
    or p_checkpoint is null
    or jsonb_typeof(coalesce(p_global_glossary_entries, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_request';
  end if;

  select * into locked_meeting
  from public.meetings
  where owner_user_id = p_owner_user_id and id = p_meeting_id
  for update;

  if not found then raise exception 'meeting_not_found'; end if;
  if locked_meeting.lifecycle_contract_version <> 1 then
    raise exception 'meeting_lifecycle_conflict';
  end if;
  if locked_meeting.status in ('completed', 'failed') then
    raise exception 'meeting_terminal';
  end if;

  request_value := jsonb_build_object(
    'command', 'legacy_resume',
    'sourceSegmentId', p_source_segment_id,
    'payloadHash', p_payload_hash,
    'nextLiveSessionId', p_next_live_session_id,
    'expectedSessionId', p_expected_session_id,
    'checkpoint', p_checkpoint
  );

  select * into prior_operation
  from public.meeting_lifecycle_operations
  where owner_user_id = p_owner_user_id
    and meeting_id = p_meeting_id
    and operation_id = p_operation_id;

  if found then
    if prior_operation.command <> 'legacy_resume'
      or prior_operation.request_payload <> request_value then
      raise exception 'meeting_lifecycle_conflict';
    end if;
    return prior_operation.result || jsonb_build_object('replayed', true);
  end if;

  select * into source_segment
  from public.meeting_segments
  where owner_user_id = p_owner_user_id
    and meeting_id = p_meeting_id
    and id = p_source_segment_id
  for update;

  if not found then raise exception 'meeting_segment_not_found'; end if;
  if source_segment.lifecycle_contract_version <> 1
    or source_segment.status <> 'active'
  then
    raise exception 'meeting_segment_invalid_state';
  end if;

  if source_segment.session_id is not null then
    if p_expected_session_id is null
      or source_segment.session_id is distinct from p_expected_session_id
    then
      raise exception 'meeting_segment_invalid_state';
    end if;
    effective_session_id := source_segment.session_id;
  else
    if p_expected_session_id is null then
      raise exception 'meeting_segment_invalid_state';
    end if;

    select * into bound_session
    from public.sessions
    where owner_user_id = p_owner_user_id
      and id = p_expected_session_id
    for share;

    if not found
      or bound_session.owner_user_id is distinct from p_owner_user_id
      or bound_session.meeting_id is distinct from p_meeting_id
      or bound_session.segment_id is distinct from p_source_segment_id
      or bound_session.lifecycle_contract_version <> 1
      or bound_session.status not in ('created', 'active', 'paused')
    then
      raise exception 'meeting_segment_invalid_state';
    end if;

    effective_session_id := bound_session.id;
  end if;
  if (p_checkpoint ? 'meetingId' and p_checkpoint->>'meetingId' <> p_meeting_id::text)
    or (p_checkpoint ? 'segmentId' and p_checkpoint->>'segmentId' <> p_source_segment_id::text)
    or exists (
      select 1
      from jsonb_array_elements(coalesce(p_checkpoint->'finalCues', '[]'::jsonb)) cue
      where cue->>'segmentId' is distinct from p_source_segment_id::text
    ) then
    raise exception 'checkpoint_conflict';
  end if;

  select * into successor
  from public.meeting_segments
  where owner_user_id = p_owner_user_id
    and meeting_id = p_meeting_id
    and sequence = source_segment.sequence + 1;
  if found then raise exception 'meeting_lifecycle_conflict'; end if;

  settings_snapshot := jsonb_build_object(
    'name', locked_meeting.name,
    'sourceLanguageCode', locked_meeting.source_language_code,
    'targetLanguageCode', locked_meeting.target_language_code,
    'echoTargetLanguage', coalesce((locked_meeting.settings->>'echoTargetLanguage')::boolean, true),
    'shouldRecordInputAudio', coalesce((locked_meeting.settings->>'shouldRecordInputAudio')::boolean, false),
    'glossaryEntries', coalesce(locked_meeting.settings->'glossaryEntries', '[]'::jsonb),
    'privateGlossaryEntries', coalesce(locked_meeting.settings->'privateGlossaryEntries', '[]'::jsonb),
    'globalGlossaryEntries', coalesce(p_global_glossary_entries, '[]'::jsonb)
  );

  update public.meeting_segments
  set status = 'interrupted',
      session_id = effective_session_id,
      ended_at = now_at,
      checkpoint = (coalesce(checkpoint, '{}'::jsonb) || (p_checkpoint - 'finalCues'))
        || jsonb_build_object('idempotencyKey', p_operation_id, 'payloadHash', p_payload_hash, 'updatedAt', now_at),
      error_info = jsonb_build_object('reason', 'manual_resume', 'category', 'user_intent'),
      updated_at = now_at
  where owner_user_id = p_owner_user_id and id = p_source_segment_id
  returning * into source_segment;

  insert into public.meeting_segments (
    id, owner_user_id, meeting_id, session_id, lifecycle_contract_version,
    sequence, status, started_at, live_session_id, settings_snapshot,
    checkpoint, created_at, updated_at
  ) values (
    gen_random_uuid(), p_owner_user_id, p_meeting_id, effective_session_id, 1,
    source_segment.sequence + 1, 'active', now_at, p_next_live_session_id, settings_snapshot,
    '{}'::jsonb, now_at, now_at
  ) returning * into successor;

  response := jsonb_build_object(
    'meeting', to_jsonb(locked_meeting),
    'interruptedSegment', to_jsonb(source_segment),
    'segment', to_jsonb(successor),
    'operation', jsonb_build_object(
      'operationId', p_operation_id,
      'payloadHash', p_payload_hash,
      'sourceSegmentId', p_source_segment_id,
      'successorSegmentId', successor.id,
      'state', 'committed'
    )
  );

  insert into public.meeting_lifecycle_operations (
    owner_user_id, meeting_id, operation_id, command, request_payload,
    result, resulting_lifecycle_version
  ) values (
    p_owner_user_id, p_meeting_id, p_operation_id, 'legacy_resume', request_value,
    response, locked_meeting.lifecycle_version
  );

  return response;
exception
  when unique_violation or serialization_failure or deadlock_detected then
    raise exception 'meeting_lifecycle_conflict';
end;
$$;

revoke all on function public.resume_legacy_meeting_segment(uuid, uuid, uuid, text, text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.resume_legacy_meeting_segment(uuid, uuid, uuid, text, text, text, uuid, jsonb, jsonb) to service_role;
