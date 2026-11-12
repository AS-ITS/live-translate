-- New v2 Meetings have no Segment until the authoritative lifecycle Start RPC.
-- Preserve the existing v1 creation path and invoker/RLS metadata permissions.
create or replace function public.create_meeting_with_initial_segment(
  p_meeting jsonb,
  p_segment jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted_meeting record;
  inserted_segment record;
  meeting_owner uuid;
  segment_owner uuid;
  segment_meeting uuid;
  normalized_meeting jsonb;
  normalized_segment jsonb;
  contract_version smallint;
begin
  meeting_owner := nullif(p_meeting->>'owner_user_id', '')::uuid;
  contract_version := coalesce(nullif(p_meeting->>'lifecycle_contract_version', '')::smallint, 1);
  if auth.uid() is null or meeting_owner is null or meeting_owner <> auth.uid() then
    raise exception using errcode = '42501', message = 'meeting owner does not match authenticated user';
  end if;
  if contract_version = 2 then
    if p_segment is not null or p_meeting->>'status' is distinct from 'created'
      or p_meeting->>'started_at' is not null
      or coalesce(nullif(p_meeting->>'lifecycle_version', '')::bigint, 0) <> 0 then
      raise exception 'invalid_request';
    end if;
  else
    segment_owner := nullif(p_segment->>'owner_user_id', '')::uuid;
    segment_meeting := nullif(p_segment->>'meeting_id', '')::uuid;
    if contract_version <> 1 or p_segment is null
      or segment_owner is distinct from meeting_owner
      or segment_meeting is distinct from nullif(p_meeting->>'id', '')::uuid then
      raise exception using errcode = '42501', message = 'meeting owner does not match authenticated user';
    end if;
  end if;

  normalized_meeting := p_meeting || jsonb_build_object(
    'lifecycle_contract_version', contract_version,
    'lifecycle_version', coalesce(nullif(p_meeting->>'lifecycle_version', '')::bigint, 0),
    'retention_policy_version', coalesce(nullif(p_meeting->>'retention_policy_version', '')::smallint, 1),
    'purge_status', coalesce(nullif(p_meeting->>'purge_status', ''),
      case when p_meeting->>'purge_at' is null then 'not_scheduled' else 'pending' end),
    'purge_attempt_count', coalesce(nullif(p_meeting->>'purge_attempt_count', '')::integer, 0)
  );
  if contract_version = 1 then
    normalized_segment := p_segment || jsonb_build_object(
      'lifecycle_contract_version', coalesce(nullif(p_segment->>'lifecycle_contract_version', '')::smallint, 1)
    );
  end if;

  insert into public.meetings (
    id, owner_user_id, name, source_language_code, target_language_code,
    status, created_at, started_at, ended_at, updated_at, settings,
    lifecycle_contract_version, lifecycle_version, last_heartbeat_at,
    purge_at, retention_policy_version, purge_status, purge_attempt_count
  )
  select id, owner_user_id, name, source_language_code, target_language_code,
    status, created_at, started_at, ended_at, updated_at, settings,
    lifecycle_contract_version, lifecycle_version, last_heartbeat_at,
    purge_at, retention_policy_version, purge_status, purge_attempt_count
  from jsonb_populate_record(null::public.meetings, normalized_meeting)
  returning id, owner_user_id, name, source_language_code, target_language_code,
    status, created_at, started_at, ended_at, updated_at, settings,
    lifecycle_contract_version, lifecycle_version, last_heartbeat_at,
    purge_at, retention_policy_version, purge_status
  into inserted_meeting;

  if contract_version = 2 then
    return jsonb_build_object('meeting', to_jsonb(inserted_meeting), 'segment', null);
  end if;

  insert into public.meeting_segments (
    id, owner_user_id, meeting_id, session_id, sequence, status,
    started_at, ended_at, live_session_id, settings_snapshot, error_info,
    created_at, updated_at, lifecycle_contract_version
  )
  select id, owner_user_id, meeting_id, session_id, sequence, status,
    started_at, ended_at, live_session_id, settings_snapshot, error_info,
    created_at, updated_at, lifecycle_contract_version
  from jsonb_populate_record(null::public.meeting_segments, normalized_segment)
  returning id, owner_user_id, meeting_id, session_id, sequence, status,
    started_at, ended_at, live_session_id, created_at, updated_at,
    lifecycle_contract_version
  into inserted_segment;

  return jsonb_build_object('meeting', to_jsonb(inserted_meeting),
    'segment', to_jsonb(inserted_segment));
end;
$$;

revoke all on function public.create_meeting_with_initial_segment(jsonb, jsonb) from public, anon;
grant execute on function public.create_meeting_with_initial_segment(jsonb, jsonb) to authenticated;
