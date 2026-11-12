-- Issue #41: reject new cloud meeting content while preserving lifecycle metadata
-- and historical rows for a separate controlled cleanup.

create or replace function public.lt41_reject_cloud_content_write()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'meeting_content_local_only' using errcode = 'P0043';
end;
$$;

do $$
declare content_table text;
begin
  foreach content_table in array array[
    'subtitle_cues', 'meeting_events', 'meeting_summaries',
    'audio_artifacts', 'export_artifacts', 'translation_requests',
    'translation_executions', 'translation_outputs',
    'translation_queue_items', 'translation_dead_letter_items'
  ] loop
    execute format('drop trigger if exists lt41_local_only_content_guard on public.%I', content_table);
    execute format('create trigger lt41_local_only_content_guard before insert or update on public.%I for each row execute function public.lt41_reject_cloud_content_write()', content_table);
    execute format('revoke insert, update, select on public.%I from anon, authenticated', content_table);
  end loop;
end;
$$;

create or replace function public.lt41_valid_glossary(value jsonb, private_entries boolean default false)
returns boolean language plpgsql immutable set search_path = public as $$
declare entry jsonb; field record; alias_value jsonb;
begin
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) > 200 then return false; end if;
  for entry in select jsonb_array_elements(value) loop
    if jsonb_typeof(entry) <> 'object' or not public.lt41_valid_metadata_value('source', entry->'source') then return false; end if;
    if private_entries then
      if entry - 'source' - 'translations' - 'replacementAliases' <> '{}'::jsonb
        or jsonb_typeof(entry->'translations') <> 'object'
        or (select count(*) from jsonb_object_keys(entry->'translations')) > 32
      then return false; end if;
      for field in select * from jsonb_each(entry->'translations') loop
        if length(field.key) > 32 or not public.lt41_valid_metadata_value('target', field.value) then return false; end if;
      end loop;
      if entry ? 'replacementAliases' then
        if jsonb_typeof(entry->'replacementAliases') <> 'object' then return false; end if;
        for field in select * from jsonb_each(entry->'replacementAliases') loop
          if length(field.key) > 32 or jsonb_typeof(field.value) <> 'array' or jsonb_array_length(field.value) > 16 then return false; end if;
          for alias_value in select jsonb_array_elements(field.value) loop
            if not public.lt41_valid_metadata_value('alias', alias_value) then return false; end if;
          end loop;
        end loop;
      end if;
    else
      if entry - 'id' - 'source' - 'target' - 'replacementAliases' <> '{}'::jsonb
        or not public.lt41_valid_metadata_value('target', entry->'target')
      then return false; end if;
      if entry ? 'id' and not public.lt41_valid_metadata_value('id', entry->'id') then return false; end if;
      if entry ? 'replacementAliases' then
        if jsonb_typeof(entry->'replacementAliases') <> 'array' or jsonb_array_length(entry->'replacementAliases') > 16 then return false; end if;
        for alias_value in select jsonb_array_elements(entry->'replacementAliases') loop
          if not public.lt41_valid_metadata_value('alias', alias_value) then return false; end if;
        end loop;
      end if;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function public.lt41_valid_metadata_value(key text, value jsonb)
returns boolean language plpgsql immutable set search_path = public as $$
declare text_value text;
begin
  if value is null then return false; end if;
  if value = 'null'::jsonb then
    return key = any(array['segmentId','recordingId','endedAt','selectedInputDeviceId',
      'inputDeviceLabelSnapshot','targetLanguageLabel','targetSegmentId','targetSessionId',
      'sessionId','priorLeaseId','priorFenceToken','leaseId','fenceToken','failureReason',
      'failureCategory','current_segment_id','live_session_id','expiresAt']);
  end if;
  if key = any(array['glossaryEntries','globalGlossaryEntries','meetingGlossaryEntries']) then
    return public.lt41_valid_glossary(value, false);
  end if;
  if key = 'privateGlossaryEntries' then return public.lt41_valid_glossary(value, true); end if;
  if key = any(array['echoTargetLanguage','shouldRecordInputAudio','confirmTakeover','replayed']) then
    return jsonb_typeof(value) = 'boolean';
  end if;
  if key = any(array['expectedLifecycleVersion','fenceToken','priorFenceToken',
      'resultingLifecycleVersion','lifecycleContractVersion','lifecycle_version','sequence']) then
    return jsonb_typeof(value) = 'number' and value::text ~ '^[0-9]{1,16}$';
  end if;
  if jsonb_typeof(value) <> 'string' then return false; end if;
  text_value := value #>> '{}';
  if key = any(array['source','target','alias']) then return length(text_value) between 1 and 256; end if;
  if key = any(array['name','failureReason','failureCategory','reason','category',
      'selectedInputDeviceId','inputDeviceLabelSnapshot']) then return length(text_value) between 1 and 256; end if;
  if key = any(array['id','meetingId','sessionId','segmentId','recordingId','nextLiveSessionId',
      'targetSessionId','targetSegmentId','originalOperationId','recoveryOperationId',
      'operationId','attemptOperationId','leaseId','priorLeaseId','principalId','live_session_id',
      'meeting_id','session_id','current_segment_id']) then
    return length(text_value) between 1 and 256;
  end if;
  if key = any(array['command','status','principalType','sourceLanguageCode',
      'targetLanguageCode','targetLanguageLabel','expiresAt','startedAt','endedAt','createdAt']) then
    return length(text_value) between 1 and 128;
  end if;
  return false;
end;
$$;

create or replace function public.lt41_guard_session_metadata()
returns trigger language plpgsql set search_path = public as $$
declare allowed text[] := array[
  'id','meetingId','segmentId','recordingId','name','status',
  'sourceLanguageCode','targetLanguageCode','targetLanguageLabel',
  'startedAt','endedAt','createdAt','lifecycleContractVersion',
  'echoTargetLanguage','shouldRecordInputAudio','selectedInputDeviceId',
  'inputDeviceLabelSnapshot','meetingGlossaryEntries'
];
payload_changed boolean := true;
begin
  if tg_op = 'INSERT' and coalesce(new.transcript_items, '[]'::jsonb) <> '[]'::jsonb then
    raise exception 'meeting_content_local_only' using errcode = 'P0043';
  end if;
  if tg_op = 'UPDATE' and new.transcript_items is distinct from old.transcript_items then
    raise exception 'meeting_content_local_only' using errcode = 'P0043';
  end if;
  if tg_op = 'UPDATE' then payload_changed := new.payload is distinct from old.payload; end if;
  if payload_changed then
    if jsonb_typeof(coalesce(new.payload, '{}'::jsonb)) <> 'object'
      or exists (select 1 from jsonb_object_keys(coalesce(new.payload, '{}'::jsonb)) as key where not key = any(allowed))
      or exists (select 1 from jsonb_each(coalesce(new.payload, '{}'::jsonb)) item
        where not public.lt41_valid_metadata_value(item.key, item.value))
    then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lt41_local_only_session_guard on public.sessions;
create trigger lt41_local_only_session_guard before insert or update on public.sessions
for each row execute function public.lt41_guard_session_metadata();

create or replace function public.lt41_guard_segment_metadata()
returns trigger language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and coalesce(new.checkpoint, '{}'::jsonb) <> '{}'::jsonb)
    or (tg_op = 'UPDATE' and new.checkpoint is distinct from old.checkpoint)
  then
    raise exception 'meeting_content_local_only' using errcode = 'P0043';
  end if;
  if tg_op = 'INSERT' or new.settings_snapshot is distinct from old.settings_snapshot then
    if jsonb_typeof(coalesce(new.settings_snapshot, '{}'::jsonb)) <> 'object' then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
    if exists (
      select 1 from jsonb_object_keys(coalesce(new.settings_snapshot, '{}'::jsonb)) key
      where key <> all(array[
        'name','sourceLanguageCode','targetLanguageCode','echoTargetLanguage',
        'shouldRecordInputAudio','glossaryEntries','privateGlossaryEntries','globalGlossaryEntries'
      ])
    ) then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
    if exists (select 1 from jsonb_each(coalesce(new.settings_snapshot, '{}'::jsonb)) item
      where not public.lt41_valid_metadata_value(item.key, item.value)) then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
  end if;
  if tg_op = 'INSERT' or new.error_info is distinct from old.error_info then
    if new.error_info is not null and (
      jsonb_typeof(new.error_info) <> 'object'
      or new.error_info - 'reason' - 'category' <> '{}'::jsonb
      or exists (select 1 from jsonb_each(new.error_info) item
        where not public.lt41_valid_metadata_value(item.key, item.value))
    ) then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lt41_local_only_segment_guard on public.meeting_segments;
create trigger lt41_local_only_segment_guard before insert or update on public.meeting_segments
for each row execute function public.lt41_guard_segment_metadata();

create or replace function public.lt41_guard_meeting_metadata()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.settings is distinct from old.settings then
    if jsonb_typeof(coalesce(new.settings, '{}'::jsonb)) <> 'object' then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
    if exists (
      select 1 from jsonb_object_keys(coalesce(new.settings, '{}'::jsonb)) key
      where key <> all(array[
        'echoTargetLanguage','shouldRecordInputAudio','glossaryEntries','privateGlossaryEntries'
      ])
    ) then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
    if exists (select 1 from jsonb_each(coalesce(new.settings, '{}'::jsonb)) item
      where not public.lt41_valid_metadata_value(item.key, item.value)) then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
  end if;
  if tg_op = 'INSERT' or new.failure_info is distinct from old.failure_info then
    if new.failure_info is not null and (
      jsonb_typeof(new.failure_info) <> 'object'
      or new.failure_info - 'reason' - 'category' <> '{}'::jsonb
      or exists (select 1 from jsonb_each(new.failure_info) item
        where not public.lt41_valid_metadata_value(item.key, item.value))
    ) then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists lt41_local_only_meeting_guard on public.meetings;
create trigger lt41_local_only_meeting_guard before insert or update on public.meetings
for each row execute function public.lt41_guard_meeting_metadata();

-- New lifecycle results are metadata-only even when an older Segment still has
-- a historical checkpoint. The original request payload and idempotency key stay intact.
create or replace function public.lt41_guard_lifecycle_result()
returns trigger language plpgsql set search_path = public as $$
declare request_changed boolean := true;
  nested_key text;
begin
  if tg_op = 'UPDATE' then request_changed := new.request_payload is distinct from old.request_payload; end if;
  if request_changed then
    if jsonb_typeof(new.request_payload) <> 'object'
      or exists (select 1 from jsonb_object_keys(new.request_payload) as key where not key = any(array[
        'command','expectedLifecycleVersion','principalType','principalId','leaseId','fenceToken','payload',
        'originalOperationId','sessionId','segmentId','priorLeaseId','priorFenceToken'
      ]))
      or (new.request_payload ? 'payload' and (
        jsonb_typeof(new.request_payload->'payload') <> 'object'
        or exists (select 1 from jsonb_object_keys(new.request_payload->'payload') as key where not key = any(array[
          'sessionId','segmentId','nextLiveSessionId','failureReason','failureCategory',
          'originalOperationId','recoveryOperationId','confirmTakeover'
        ]))
      ))
    then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
    if exists (select 1 from jsonb_each(new.request_payload) item
      where item.key <> 'payload' and not public.lt41_valid_metadata_value(item.key, item.value))
      or (new.request_payload ? 'payload' and exists (
        select 1 from jsonb_each(new.request_payload->'payload') item
        where not public.lt41_valid_metadata_value(item.key, item.value)
      ))
    then
      raise exception 'meeting_content_local_only' using errcode = 'P0043';
    end if;
  end if;
  if jsonb_typeof(new.result) <> 'object' or exists (
    select 1 from jsonb_object_keys(new.result) as key where not key = any(array[
      'operationId','replayed','targetSessionId','targetSegmentId','meeting','session','segment','lease',
      'status','originalOperationId','recoveryOperationId','attemptOperationId',
      'resultingLifecycleVersion','sessionId','segmentId','leaseId','fenceToken','expiresAt'
    ])
  ) then
    raise exception 'meeting_content_local_only' using errcode = 'P0043';
  end if;
  if new.result ? 'meeting' and jsonb_typeof(new.result->'meeting') = 'object' then
    new.result := jsonb_set(new.result, '{meeting}',
      jsonb_build_object(
        'id', new.result->'meeting'->'id',
        'status', new.result->'meeting'->'status',
        'lifecycle_version', new.result->'meeting'->'lifecycle_version'
      ), true);
  end if;
  if new.result ? 'session' and jsonb_typeof(new.result->'session') = 'object' then
    new.result := jsonb_set(new.result, '{session}',
      jsonb_build_object(
        'id', new.result->'session'->'id',
        'meeting_id', new.result->'session'->'meeting_id',
        'status', new.result->'session'->'status',
        'current_segment_id', new.result->'session'->'current_segment_id'
      ), true);
  end if;
  if new.result ? 'segment' and jsonb_typeof(new.result->'segment') = 'object' then
    new.result := jsonb_set(new.result, '{segment}',
      jsonb_build_object(
        'id', new.result->'segment'->'id',
        'session_id', new.result->'segment'->'session_id',
        'status', new.result->'segment'->'status',
        'sequence', new.result->'segment'->'sequence',
        'live_session_id', new.result->'segment'->'live_session_id'
      ), true);
  end if;
  if new.result ? 'lease' and jsonb_typeof(new.result->'lease') = 'object' then
    new.result := jsonb_set(new.result, '{lease}',
      jsonb_build_object(
        'leaseId', new.result->'lease'->'leaseId',
        'fenceToken', new.result->'lease'->'fenceToken',
        'expiresAt', new.result->'lease'->'expiresAt'
      ), true);
  end if;
  foreach nested_key in array array['meeting','session','segment','lease'] loop
    if new.result ? nested_key then
      if jsonb_typeof(new.result->nested_key) not in ('object','null') then
        raise exception 'meeting_content_local_only' using errcode = 'P0043';
      end if;
      if jsonb_typeof(new.result->nested_key) = 'object' and exists (
        select 1 from jsonb_each(new.result->nested_key) item
        where not public.lt41_valid_metadata_value(item.key, item.value)
      ) then
        raise exception 'meeting_content_local_only' using errcode = 'P0043';
      end if;
    end if;
  end loop;
  if exists (select 1 from jsonb_each(new.result) item
    where item.key <> all(array['meeting','session','segment','lease'])
      and not public.lt41_valid_metadata_value(item.key, item.value)) then
    raise exception 'meeting_content_local_only' using errcode = 'P0043';
  end if;
  return new;
end;
$$;

drop trigger if exists lt41_local_only_lifecycle_result on public.meeting_lifecycle_operations;
create trigger lt41_local_only_lifecycle_result before insert or update of request_payload, result
on public.meeting_lifecycle_operations for each row execute function public.lt41_guard_lifecycle_result();

-- Direct PostgREST reads cannot select historical content columns.
revoke select on public.sessions, public.meeting_segments, public.meetings,
  public.meeting_lifecycle_operations from anon, authenticated;
grant select (id, owner_user_id, meeting_id, segment_id, current_segment_id,
  recording_id, status, source_language_code, target_language_code,
  started_at, ended_at, created_at, lifecycle_contract_version)
  on public.sessions to authenticated;
grant select (id, owner_user_id, meeting_id, session_id, sequence, status,
  started_at, ended_at, live_session_id, created_at, updated_at,
  lifecycle_contract_version)
  on public.meeting_segments to authenticated;
grant select (id, owner_user_id, name, source_language_code,
  target_language_code, status, created_at, started_at, ended_at, updated_at,
  settings, lifecycle_contract_version, lifecycle_version, last_heartbeat_at,
  purge_at, retention_policy_version, purge_status)
  on public.meetings to authenticated;

do $$
declare routine regprocedure;
begin
  for routine in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'apply_meeting_checkpoint_operation', 'apply_meeting_checkpoint_operation_v2',
      'lt41_upsert_cue_checked', 'publish_meeting_cue_v2',
      'rollover_legacy_meeting_segment_v1'
    )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', routine);
  end loop;
end;
$$;

create or replace function public.lt41_reject_meeting_storage_write()
returns trigger language plpgsql set search_path = public, storage as $$
begin
  if new.bucket_id in ('meeting-audio', 'meeting-exports')
    or (tg_op = 'UPDATE' and old.bucket_id in ('meeting-audio', 'meeting-exports'))
  then
    raise exception 'meeting_content_local_only' using errcode = 'P0043';
  end if;
  return new;
end;
$$;

drop trigger if exists lt41_local_only_storage_guard on storage.objects;
create trigger lt41_local_only_storage_guard before insert or update on storage.objects
for each row execute function public.lt41_reject_meeting_storage_write();

drop policy if exists meeting_audio_owner_insert on storage.objects;
drop policy if exists meeting_audio_owner_mp3_insert on storage.objects;
drop policy if exists meeting_audio_owner_select on storage.objects;
drop policy if exists meeting_audio_owner_update on storage.objects;
drop policy if exists meeting_exports_owner_insert on storage.objects;
drop policy if exists meeting_exports_owner_select on storage.objects;
drop policy if exists meeting_exports_owner_update on storage.objects;
drop policy if exists meeting_storage_retention_guard on storage.objects;
create policy meeting_storage_retention_guard on storage.objects as restrictive
  for all using (bucket_id not in ('meeting-audio', 'meeting-exports'))
  with check (bucket_id not in ('meeting-audio', 'meeting-exports'));
