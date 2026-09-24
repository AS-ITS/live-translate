-- Preserve create-meeting RPC compatibility after retention columns were added.
-- jsonb_populate_record treats omitted keys as NULL, so table defaults do not apply.
create or replace function public.create_meeting_with_initial_segment(
  p_meeting jsonb,
  p_segment jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted_meeting public.meetings;
  inserted_segment public.meeting_segments;
  meeting_owner uuid;
  segment_owner uuid;
  segment_meeting uuid;
  normalized_meeting jsonb;
  normalized_segment jsonb;
begin
  meeting_owner := nullif(p_meeting->>'owner_user_id', '')::uuid;
  segment_owner := nullif(p_segment->>'owner_user_id', '')::uuid;
  segment_meeting := nullif(p_segment->>'meeting_id', '')::uuid;

  if auth.uid() is null
     or meeting_owner is null
     or meeting_owner <> auth.uid()
     or segment_owner is distinct from meeting_owner
     or segment_meeting is distinct from nullif(p_meeting->>'id', '')::uuid then
    raise exception using
      errcode = '42501',
      message = 'meeting owner does not match authenticated user';
  end if;

  normalized_meeting := p_meeting || jsonb_build_object(
    'lifecycle_contract_version', coalesce(nullif(p_meeting->>'lifecycle_contract_version', '')::smallint, 1),
    'lifecycle_version', coalesce(nullif(p_meeting->>'lifecycle_version', '')::bigint, 0),
    'retention_policy_version', coalesce(nullif(p_meeting->>'retention_policy_version', '')::smallint, 1),
    'purge_status', coalesce(
      nullif(p_meeting->>'purge_status', ''),
      case when p_meeting->>'purge_at' is null then 'not_scheduled' else 'pending' end
    ),
    'purge_attempt_count', coalesce(nullif(p_meeting->>'purge_attempt_count', '')::integer, 0)
  );
  normalized_segment := p_segment || jsonb_build_object(
    'lifecycle_contract_version', coalesce(nullif(p_segment->>'lifecycle_contract_version', '')::smallint, 1)
  );

  insert into public.meetings
  select * from jsonb_populate_record(null::public.meetings, normalized_meeting)
  returning * into inserted_meeting;

  insert into public.meeting_segments
  select * from jsonb_populate_record(null::public.meeting_segments, normalized_segment)
  returning * into inserted_segment;

  return jsonb_build_object(
    'meeting', to_jsonb(inserted_meeting),
    'segment', to_jsonb(inserted_segment)
  );
end;
$$;

revoke all on function public.create_meeting_with_initial_segment(jsonb, jsonb) from public, anon;
grant execute on function public.create_meeting_with_initial_segment(jsonb, jsonb) to authenticated;
