\set ON_ERROR_STOP on
begin;

insert into auth.users(id,email) values
  ('f51c7000-0000-4000-8000-000000000001','issue41-session-patch@example.invalid'),
  ('f51c7000-0000-4000-8000-000000000002','issue41-session-other@example.invalid');
insert into public.meetings(id,owner_user_id,name,source_language_code,target_language_code,status,lifecycle_contract_version)
values
  ('f51c7000-0000-4000-8000-000000000011','f51c7000-0000-4000-8000-000000000001','session patch','en','zh-TW','active',1),
  ('f51c7000-0000-4000-8000-000000000012','f51c7000-0000-4000-8000-000000000002','other meeting','en','zh-TW','active',1);
insert into public.meeting_segments(id,owner_user_id,meeting_id,sequence,status,lifecycle_contract_version)
values ('f51c7000-0000-4000-8000-000000000021','f51c7000-0000-4000-8000-000000000001',
        'f51c7000-0000-4000-8000-000000000011',1,'active',1);
insert into public.sessions(id,owner_user_id,meeting_id,segment_id,status,target_language_code,payload,transcript_items)
values ('f51c7000-0000-4000-8000-000000000031','f51c7000-0000-4000-8000-000000000001',
        'f51c7000-0000-4000-8000-000000000011','f51c7000-0000-4000-8000-000000000021',
        'created','zh-TW',
        '{"name":"original","targetLanguageLabel":"Mandarin","shouldRecordInputAudio":true,"echoTargetLanguage":false}'::jsonb,
        '[]'::jsonb);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'f51c7000-0000-4000-8000-000000000001';
do $$
declare result jsonb; rejected boolean;
begin
  result := public.patch_session_metadata(
    'f51c7000-0000-4000-8000-000000000001',
    'f51c7000-0000-4000-8000-000000000011',
    'f51c7000-0000-4000-8000-000000000031',
    '{"status":"active"}'::jsonb);
  assert result->>'status' = 'active' and not result ?| array['payload','transcript_items','checkpoint'],
    'RPC returned content or wrong status';
  perform public.patch_session_metadata(
    'f51c7000-0000-4000-8000-000000000001',
    'f51c7000-0000-4000-8000-000000000011',
    'f51c7000-0000-4000-8000-000000000031',
    '{"name":"changed"}'::jsonb);
  perform public.patch_session_metadata(
    'f51c7000-0000-4000-8000-000000000001',
    'f51c7000-0000-4000-8000-000000000011',
    'f51c7000-0000-4000-8000-000000000031',
    '{"targetLanguageLabel":null}'::jsonb);
  rejected := false;
  begin
    perform public.patch_session_metadata(
      'f51c7000-0000-4000-8000-000000000001',
      'f51c7000-0000-4000-8000-000000000012',
      'f51c7000-0000-4000-8000-000000000031', '{"name":"wrong meeting"}'::jsonb);
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'cross Meeting patch allowed';
  rejected := false;
  begin
    perform public.patch_session_metadata(
      'f51c7000-0000-4000-8000-000000000002',
      'f51c7000-0000-4000-8000-000000000011',
      'f51c7000-0000-4000-8000-000000000031', '{"name":"wrong owner"}'::jsonb);
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'cross owner patch allowed';
  rejected := false;
  begin
    perform public.patch_session_metadata(
      'f51c7000-0000-4000-8000-000000000001',
      'f51c7000-0000-4000-8000-000000000011',
      'f51c7000-0000-4000-8000-000000000031', '{"checkpoint":{"text":"secret"}}'::jsonb);
  exception when sqlstate 'P0043' then rejected := true; end;
  assert rejected, 'content patch allowed';
  rejected := false;
  begin
    perform public.patch_session_metadata(
      'f51c7000-0000-4000-8000-000000000001',
      'f51c7000-0000-4000-8000-000000000011',
      'f51c7000-0000-4000-8000-000000000031', '{"unknown":"value"}'::jsonb);
  exception when sqlstate 'P0043' then rejected := true; end;
  assert rejected, 'unknown key allowed';
  rejected := false;
  begin perform (select payload from public.sessions where id='f51c7000-0000-4000-8000-000000000031');
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'payload SELECT allowed';
  rejected := false;
  begin perform (select transcript_items from public.sessions where id='f51c7000-0000-4000-8000-000000000031');
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'transcript SELECT allowed';
end;
$$;
reset role;
do $$
declare saved jsonb;
begin
  select payload into saved from public.sessions where id='f51c7000-0000-4000-8000-000000000031';
  assert saved->>'name' = 'changed', 'name patch lost';
  assert saved->>'shouldRecordInputAudio' = 'true', 'recording setting lost';
  assert saved->>'echoTargetLanguage' = 'false', 'echo setting lost';
  assert not saved ? 'targetLanguageLabel', 'explicit null failed to clear optional field';
end;
$$;
rollback;
