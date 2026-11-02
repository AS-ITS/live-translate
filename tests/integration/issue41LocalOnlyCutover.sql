\set ON_ERROR_STOP on
begin;
do $$ <<vars>>
declare
  owner_id uuid := gen_random_uuid();
  meeting_id uuid := gen_random_uuid();
  started jsonb;
  stopped jsonb;
  looked_up jsonb;
  session_id uuid;
  segment_id uuid;
  rejected boolean;
begin
  insert into auth.users(id,email) values (owner_id, 'issue41-cutover-' || owner_id || '@example.invalid');
  insert into public.meetings(id,owner_user_id,name,source_language_code,target_language_code,
    status,lifecycle_contract_version,lifecycle_version)
  values (meeting_id,owner_id,'cutover','zh-Hant','en','created',2,0);

  started := public.execute_meeting_lifecycle_command(owner_id,meeting_id,'start','cutover-start',0,
    'user',owner_id::text,null,null,false,'{}'::jsonb);
  session_id := (started->'session'->>'id')::uuid;
  segment_id := (started->'segment'->>'id')::uuid;
  assert session_id is not null and segment_id is not null, 'metadata Start failed';
  assert not exists (select 1 from public.sessions s where s.id=session_id
    and (s.payload ?| array['sourceText','translatedText','checkpoint','transcriptItems','audio']
      or s.transcript_items <> '[]'::jsonb)),
    'new lifecycle Session wrote content payload';

  rejected := false;
  begin
    insert into public.subtitle_cues default values;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'subtitle_cues insert was not rejected';

  rejected := false;
  begin
    insert into public.meeting_events default values;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'meeting_events insert was not rejected';

  rejected := false;
  begin
    update public.sessions set transcript_items='[{"text":"secret"}]'::jsonb where id=session_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Session transcript update was not rejected';

  rejected := false;
  begin
    update public.sessions set payload='{"sourceText":"secret"}'::jsonb where id=session_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Session content payload was not rejected';

  rejected := false;
  begin
    update public.meeting_segments set checkpoint='{"finalCues":[{"sourceText":"secret"}]}'::jsonb where id=segment_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Segment Checkpoint update was not rejected';
  rejected := false;
  begin
    update public.meetings set settings='{"transcript":"secret"}'::jsonb where id=meeting_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Meeting settings content was not rejected';
  rejected := false;
  begin
    update public.meetings set failure_info='{"transcript":"secret"}'::jsonb where id=meeting_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Meeting failure_info content was not rejected';
  rejected := false;
  begin
    update public.meeting_segments set settings_snapshot='{"transcript":"secret"}'::jsonb where id=segment_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Segment settings_snapshot content was not rejected';
  rejected := false;
  begin
    update public.meeting_segments set error_info='{"transcript":"secret"}'::jsonb where id=segment_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Segment error_info content was not rejected';
  rejected := false;
  begin
    update public.meetings set settings='{"echoTargetLanguage":{"sourceText":"secret"}}'::jsonb where id=meeting_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Meeting settings metadata type was not checked';
  rejected := false;
  begin
    update public.meetings set settings='{"glossaryEntries":[{"source":"a","target":"b","checkpoint":{"text":"secret"}}]}'::jsonb where id=meeting_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Nested glossary content was not rejected';
  rejected := false;
  begin
    update public.sessions set payload='{"name":{"sourceText":"secret"}}'::jsonb where id=session_id;
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Session payload metadata type was not checked';
  rejected := false;
  begin
    update public.meeting_lifecycle_operations op
    set request_payload=jsonb_set(request_payload, '{payload,failureReason}', '{"sourceText":"secret"}'::jsonb, true)
    where op.meeting_id=vars.meeting_id and op.operation_id='cutover-start';
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Lifecycle request nested content was not rejected';
  rejected := false;
  begin
    update public.meeting_lifecycle_operations op
    set result=jsonb_set(result, '{lease,leaseId}', '{"sourceText":"secret"}'::jsonb, true)
    where op.meeting_id=vars.meeting_id and op.operation_id='cutover-start';
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'Lifecycle result nested content was not rejected';

  rejected := false;
  begin
    insert into storage.objects(bucket_id,name) values ('meeting-audio',owner_id || '/' || meeting_id || '/recording.webm');
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'meeting-audio upload was not rejected';

  rejected := false;
  begin
    insert into storage.objects(bucket_id,name) values ('meeting-exports',owner_id || '/' || meeting_id || '/export.txt');
  exception when sqlstate 'P0043' then rejected := true;
  end;
  assert rejected, 'meeting-exports upload was not rejected';

  assert not has_function_privilege('service_role',
    'public.publish_meeting_cue_v2(uuid,uuid,jsonb)', 'EXECUTE'),
    'service_role can still publish Cue through old RPC';
  assert not has_column_privilege('authenticated','public.sessions','payload','SELECT'),
    'authenticated can still read historical Session payload';
  assert not has_column_privilege('authenticated','public.meeting_segments','checkpoint','SELECT'),
    'authenticated can still read historical Checkpoint';
  assert exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='meeting_storage_retention_guard' and permissive='RESTRICTIVE'),
    'Storage content denial must be restrictive';

  stopped := public.execute_meeting_lifecycle_command(owner_id,meeting_id,'stop','cutover-stop',1,
    'user',owner_id::text,started->'lease'->>'leaseId',
    (started->'lease'->>'fenceToken')::bigint,false,'{}'::jsonb);
  assert stopped->'meeting'->>'status' = 'completed', 'metadata Stop failed';
  looked_up := public.lookup_meeting_lifecycle_operation(owner_id,meeting_id,'cutover-stop','user',owner_id::text);
  assert looked_up->>'status' = 'committed' and looked_up->>'targetSegmentId'=segment_id::text,
    'metadata-only operation lookup failed';
  assert (select count(*) from public.meeting_segments s where s.meeting_id=vars.meeting_id) = 1,
    'Stop created an extra Segment';
  raise notice 'PASS: local-only table/RPC/Storage write rejection and metadata lifecycle';
end;
$$;
rollback;
