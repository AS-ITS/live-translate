begin;
\ir ../../supabase/migrations/20261010000000_transactional_legacy_resume.sql
set constraints all deferred;

do $$
declare
  owner_id uuid := gen_random_uuid();
  test_meeting_id uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  source_id uuid := gen_random_uuid();
  operation_id text := 'legacy-continue-contract';
  first_result jsonb;
  replay_result jsonb;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at, is_anonymous)
  values (owner_id, 'authenticated', 'authenticated', owner_id || '@example.test', now(), now(), false);

  insert into public.meetings (
    id, owner_user_id, name, source_language_code, target_language_code,
    status, lifecycle_contract_version, settings
  ) values (
    test_meeting_id, owner_id, 'Legacy resume contract', 'zh-Hant', 'en',
    'active', 1,
    jsonb_build_object(
      'glossaryEntries', jsonb_build_array(jsonb_build_object('source', '你好', 'target', 'su3cl3')),
      'privateGlossaryEntries', '[]'::jsonb
    )
  );

  insert into public.sessions (
    id, owner_user_id, meeting_id, status, target_language_code,
    created_at, payload, transcript_items, lifecycle_contract_version
  ) values (
    session_id, owner_id, test_meeting_id, 'paused', 'en', now(), '{}'::jsonb, '[]'::jsonb, 1
  );

  insert into public.meeting_segments (
    id, owner_user_id, meeting_id, session_id, sequence, status,
    lifecycle_contract_version, live_session_id, settings_snapshot
  ) values (
    source_id, owner_id, test_meeting_id, session_id, 1, 'active', 1, 'live-1',
    jsonb_build_object('glossaryEntries', '[]'::jsonb)
  );

  update public.sessions set segment_id = source_id, current_segment_id = source_id where id = session_id;

  first_result := public.resume_legacy_meeting_segment(
    owner_id, test_meeting_id, source_id, operation_id, 'payload-hash', 'live-2', session_id,
    jsonb_build_object('lastFinalCueSequence', 0, 'finalCues', '[]'::jsonb),
    jsonb_build_array(jsonb_build_object('source', 'global', 'target', 'Global'))
  );
  replay_result := public.resume_legacy_meeting_segment(
    owner_id, test_meeting_id, source_id, operation_id, 'payload-hash', 'live-2', session_id,
    jsonb_build_object('lastFinalCueSequence', 0, 'finalCues', '[]'::jsonb),
    jsonb_build_array(jsonb_build_object('source', 'changed-after-commit', 'target', 'ignored'))
  );

  if first_result->'segment'->>'id' is distinct from replay_result->'segment'->>'id' then
    raise exception 'duplicate request created a different successor';
  end if;
  if first_result->'segment'->'settings_snapshot'->'glossaryEntries'->0->>'target' <> 'su3cl3' then
    raise exception 'successor did not freeze latest Meeting glossary';
  end if;
  if replay_result->>'replayed' <> 'true' then
    raise exception 'duplicate request was not marked replayed';
  end if;

  begin
    perform public.resume_legacy_meeting_segment(
      owner_id, test_meeting_id, source_id, operation_id, 'different-hash', 'live-2', session_id,
      jsonb_build_object('lastFinalCueSequence', 0, 'finalCues', '[]'::jsonb), '[]'::jsonb
    );
    raise exception 'different payload unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'meeting_lifecycle_conflict' then raise; end if;
  end;

  if (select count(*) from public.meeting_segments where meeting_id = test_meeting_id and status = 'active') <> 1 then
    raise exception 'meeting does not have exactly one active successor';
  end if;
end;
$$;

rollback;
