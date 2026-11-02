-- Keep Session metadata updates atomic without granting SELECT on payload.
create or replace function public.patch_session_metadata(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_session_id uuid,
  p_patch jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  locked_owner uuid;
  locked_meeting uuid;
  contract_version integer;
  active_segment uuid;
  previous_payload jsonb;
  merged_payload jsonb;
  field record;
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is distinct from p_owner_user_id then
    raise exception 'auth_forbidden' using errcode = '42501';
  end if;
  if p_session_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or (select count(*) from jsonb_object_keys(p_patch)) > 9 then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  -- Match the lifecycle lock order: Meeting before Session.
  if p_meeting_id is not null then
    select owner_user_id into locked_owner
      from public.meetings where id = p_meeting_id for update;
    if locked_owner is distinct from p_owner_user_id
       or not public.meeting_recording_accessible(p_owner_user_id, p_meeting_id) then
      raise exception 'auth_forbidden' using errcode = '42501';
    end if;
  end if;
  select owner_user_id, meeting_id, lifecycle_contract_version, current_segment_id, payload
    into locked_owner, locked_meeting, contract_version, active_segment, previous_payload
    from public.sessions where id = p_session_id for update;
  if not found or locked_owner is distinct from p_owner_user_id
     or locked_meeting is distinct from p_meeting_id then
    raise exception 'auth_forbidden' using errcode = '42501';
  end if;
  if previous_payload is null or jsonb_typeof(previous_payload) <> 'object'
     or exists (
       select 1 from jsonb_each(previous_payload) as old_field(key, value)
       where old_field.key <> all(array[
         'id','meetingId','segmentId','recordingId','name','status',
         'sourceLanguageCode','targetLanguageCode','targetLanguageLabel',
         'startedAt','endedAt','createdAt','lifecycleContractVersion',
         'echoTargetLanguage','shouldRecordInputAudio','selectedInputDeviceId',
         'inputDeviceLabelSnapshot','meetingGlossaryEntries'
       ]) or not public.lt41_valid_metadata_value(old_field.key, old_field.value)
     ) then
    raise exception 'meeting_content_local_only' using errcode = 'P0043';
  end if;

  merged_payload := previous_payload;
  for field in select key, value from jsonb_each(p_patch) loop
    if field.key <> all(array[
      'meetingId','segmentId','name','status','sourceLanguageCode',
      'targetLanguageCode','targetLanguageLabel','startedAt','endedAt'
    ]) then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
    if field.key = 'meetingId' then
      if jsonb_typeof(field.value) is distinct from 'string'
         or (field.value #>> '{}') is distinct from p_meeting_id::text then
        raise exception 'auth_forbidden' using errcode = '42501';
      end if;
      continue;
    end if;
    -- Omitted keys are unchanged. Explicit null clears only optional fields.
    if field.value = 'null'::jsonb then
      if field.key <> all(array['name','sourceLanguageCode','targetLanguageLabel','startedAt','endedAt']) then
        raise exception 'invalid_request' using errcode = '22023';
      end if;
      merged_payload := merged_payload - field.key;
      continue;
    end if;
    if not public.lt41_valid_metadata_value(field.key, field.value) then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
    if field.key = 'segmentId' and not exists (
      select 1 from public.meeting_segments
      where id = (field.value #>> '{}')::uuid
        and meeting_id = p_meeting_id and owner_user_id = p_owner_user_id
    ) then
      raise exception 'auth_forbidden' using errcode = '42501';
    end if;
    if field.key = 'segmentId' and contract_version = 2
       and (field.value #>> '{}')::uuid is distinct from active_segment then
      raise exception 'meeting_lifecycle_conflict' using errcode = 'P0042';
    end if;
    merged_payload := merged_payload || jsonb_build_object(field.key, field.value);
  end loop;

  update public.sessions set
    payload = merged_payload,
    segment_id = case when contract_version = 1 and p_patch ? 'segmentId'
      then (p_patch->>'segmentId')::uuid else segment_id end,
    status = case when p_patch ? 'status' then p_patch->>'status' else status end,
    source_language_code = case when p_patch ? 'sourceLanguageCode'
      then p_patch->>'sourceLanguageCode' else source_language_code end,
    target_language_code = case when p_patch ? 'targetLanguageCode'
      then p_patch->>'targetLanguageCode' else target_language_code end,
    started_at = case when p_patch ? 'startedAt'
      then (p_patch->>'startedAt')::timestamptz else started_at end,
    ended_at = case when p_patch ? 'endedAt'
      then (p_patch->>'endedAt')::timestamptz else ended_at end
  where id = p_session_id and owner_user_id = p_owner_user_id
    and meeting_id is not distinct from p_meeting_id;

  select jsonb_build_object(
    'id', id, 'owner_user_id', owner_user_id, 'meeting_id', meeting_id,
    'segment_id', segment_id, 'current_segment_id', current_segment_id,
    'recording_id', recording_id, 'status', status,
    'source_language_code', source_language_code,
    'target_language_code', target_language_code,
    'started_at', started_at, 'ended_at', ended_at,
    'created_at', created_at, 'lifecycle_contract_version', lifecycle_contract_version
  ) into result from public.sessions where id = p_session_id;
  return result;
end;
$$;

revoke all on function public.patch_session_metadata(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.patch_session_metadata(uuid,uuid,uuid,jsonb)
  to authenticated;

-- The deferred v2 constraint also runs for authenticated v1 INSERT/UPDATE.
-- Its old SELECT * required the content columns revoked by the Cutover.
-- Keep the same invariant and invoker privileges with a metadata projection.
create or replace function public.enforce_v2_current_segment_active()
returns trigger language plpgsql set search_path = public as $$
declare
  checked_session_id uuid;
  session_owner uuid;
  session_meeting uuid;
  session_segment uuid;
  session_status text;
  session_contract integer;
begin
  if tg_table_name = 'sessions' then
    select s.id, s.owner_user_id, s.meeting_id, s.current_segment_id,
           s.status, s.lifecycle_contract_version
      into checked_session_id, session_owner, session_meeting, session_segment,
           session_status, session_contract
      from public.sessions s where s.id = new.id and s.owner_user_id = new.owner_user_id;
    if session_contract = 2 and session_status = 'active' and session_segment is null then
      raise exception 'v2_active_session_requires_current_segment';
    end if;
    if session_contract = 2 and session_segment is not null and not exists (
      select 1 from public.meeting_segments segment
      where segment.id = session_segment and segment.owner_user_id = session_owner
        and segment.meeting_id = session_meeting and segment.session_id = checked_session_id
        and segment.lifecycle_contract_version = 2 and segment.status = 'active'
    ) then
      raise exception 'v2_current_segment_must_be_active';
    end if;
  elsif tg_table_name = 'meeting_segments' and new.lifecycle_contract_version = 2
    and new.status <> 'active' and exists (
      select 1 from public.sessions session
      where session.id = new.session_id and session.owner_user_id = new.owner_user_id
        and session.current_segment_id = new.id
    ) then
    raise exception 'v2_current_segment_must_be_active';
  end if;
  return null;
end;
$$;
