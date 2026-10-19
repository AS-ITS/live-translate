-- Issue 41: all acknowledged Cue/checkpoint changes use a restricted writer.
-- This migration is forward-only; the preceding candidate migration may already exist.
create role lt41_checkpoint_writer nologin nobypassrls;
grant lt41_checkpoint_writer to postgres;
grant usage, create on schema public to lt41_checkpoint_writer;
grant select on public.meetings, public.meeting_segments, public.sessions,
  public.subtitle_cues to lt41_checkpoint_writer;
grant update (id) on public.meetings to lt41_checkpoint_writer; -- FOR UPDATE row lock
grant update (checkpoint, status, ended_at, error_info, updated_at)
  on public.meeting_segments to lt41_checkpoint_writer;
grant insert, update on public.subtitle_cues to lt41_checkpoint_writer;

create policy lt41_writer_meetings on public.meetings
  for all to lt41_checkpoint_writer using (true) with check (true);
create policy lt41_writer_segments on public.meeting_segments
  for all to lt41_checkpoint_writer using (true) with check (true);
create policy lt41_writer_sessions on public.sessions
  for select to lt41_checkpoint_writer using (true);
create policy lt41_writer_cues on public.subtitle_cues
  for all to lt41_checkpoint_writer using (true) with check (true);

-- RLS is kept for reads; table grants close direct Cue writes, including upsert.
revoke insert, update, delete on public.subtitle_cues from authenticated;
revoke delete on public.meetings, public.meeting_segments, public.sessions
  from authenticated;
revoke insert, update on public.meeting_segments from authenticated;
grant insert (id, owner_user_id, meeting_id, sequence, status, started_at,
  ended_at, live_session_id, settings_snapshot, error_info, created_at,
  updated_at, lifecycle_contract_version, session_id)
  on public.meeting_segments to authenticated;
grant update (status, started_at, ended_at, live_session_id, settings_snapshot,
  error_info, updated_at, session_id)
  on public.meeting_segments to authenticated;

create or replace function public.guard_meeting_checkpoint_durability()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.checkpoint is distinct from null
      and new.checkpoint <> '{}'::jsonb
      and current_user <> 'lt41_checkpoint_writer' then
      raise exception 'checkpoint_conflict' using errcode = 'P0042';
    end if;
    return new;
  end if;
  if new.checkpoint is not distinct from old.checkpoint then return new; end if;
  if current_user = 'lt41_checkpoint_writer' then return new; end if;

  -- Existing definer-owned expiry/legacy-resume operations change only these
  -- terminal markers; they cannot replace finalCues or revision content.
  if current_user = 'postgres'
    and new.status in ('interrupted', 'completed', 'failed')
    and coalesce((new.checkpoint->>'revision')::bigint, 0)
      = coalesce((old.checkpoint->>'revision')::bigint, 0)
    and (new.checkpoint - 'terminalReason' - 'expiredAt'
      - 'idempotencyKey' - 'payloadHash' - 'updatedAt')
      is not distinct from
      (old.checkpoint - 'terminalReason' - 'expiredAt'
      - 'idempotencyKey' - 'payloadHash' - 'updatedAt') then
    return new;
  end if;

  -- Existing explicit retention cleanup zeroes content after its deadline.
  if current_user = 'postgres' and new.checkpoint = '{}'::jsonb
    and exists (
      select 1 from public.meeting_recordings r
      where r.meeting_id = old.meeting_id
        and r.owner_user_id = old.owner_user_id
        and r.cleanup_state = 'claimed'
        and r.cleanup_phase = 'segments'
        and r.expires_at <= pg_catalog.clock_timestamp()
    ) then return new; end if;
  raise exception 'checkpoint_conflict' using errcode = 'P0042';
end;
$$;
drop trigger if exists meeting_checkpoint_durability_guard on public.meeting_segments;
create trigger meeting_checkpoint_durability_guard
  before insert or update on public.meeting_segments for each row
  execute function public.guard_meeting_checkpoint_durability();
revoke all on function public.guard_meeting_checkpoint_durability()
  from public, anon, authenticated;

-- This helper is invoker-only and executable solely by the NOLOGIN writer.
create function public.lt41_upsert_cue_checked(
  p_owner_user_id uuid, p_meeting_id uuid, p_segment_id uuid, p_cue jsonb
) returns void language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp as $$
declare prior public.subtitle_cues;
declare stored public.subtitle_cues;
declare bound_session public.sessions;
declare bound_segment public.meeting_segments;
declare cue_id text := p_cue->>'id';
declare session_id uuid := (p_cue->>'session_id')::uuid;
declare source_version integer := (p_cue->>'source_version')::integer;
declare translation_version integer := (p_cue->>'translation_version')::integer;
begin
  if jsonb_typeof(p_cue) is distinct from 'object'
    or cue_id is null or session_id is null
    or source_version is null or translation_version is null
    or source_version < 0 or translation_version < 0
    or (p_cue->>'sequence')::integer < 1
    or (coalesce(p_cue->>'source_text','') = ''
      and coalesce(p_cue->>'translated_text','') = '') then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  select * into bound_segment from public.meeting_segments
    where id = p_segment_id and meeting_id = p_meeting_id
      and owner_user_id = p_owner_user_id;
  select * into bound_session from public.sessions
    where id = session_id and owner_user_id = p_owner_user_id
      and meeting_id = p_meeting_id;
  if bound_segment.id is null or bound_session.id is null
    or bound_segment.session_id is distinct from session_id
    or not (coalesce(bound_session.segment_id = p_segment_id, false)
      or coalesce(bound_session.current_segment_id = p_segment_id, false)
      or coalesce((bound_segment.lifecycle_contract_version = 1
        and bound_session.lifecycle_contract_version = 1
        and bound_segment.session_id = session_id), false)) then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  select * into prior from public.subtitle_cues where id = cue_id for update;
  if prior.id is not null and (
    prior.owner_user_id <> p_owner_user_id
    or prior.session_id <> session_id or prior.segment_id <> p_segment_id
    or prior.sequence <> (p_cue->>'sequence')::integer
    or prior.started_at is distinct from (p_cue->>'started_at')::bigint
    or prior.ended_at is distinct from (p_cue->>'ended_at')::bigint
    or source_version < prior.source_version
    or translation_version < prior.translation_version
    or (source_version = prior.source_version and (
      prior.source_text is distinct from coalesce(p_cue->>'source_text', '')
      or prior.source_status is distinct from p_cue->>'source_status'))
    or (translation_version = prior.translation_version and (
      prior.translated_text is distinct from p_cue->>'translated_text'
      or prior.translation_status is distinct from p_cue->>'translation_status'))
  ) then raise exception 'checkpoint_conflict' using errcode = 'P0042'; end if;
  insert into public.subtitle_cues as stored (
    id, owner_user_id, session_id, segment_id, sequence,
    source_text, translated_text, source_status, translation_status,
    source_version, translation_version, started_at, ended_at
  ) values (
    cue_id, p_owner_user_id, session_id, p_segment_id,
    (p_cue->>'sequence')::integer, coalesce(p_cue->>'source_text', ''),
    p_cue->>'translated_text', p_cue->>'source_status',
    p_cue->>'translation_status', source_version, translation_version,
    (p_cue->>'started_at')::bigint, (p_cue->>'ended_at')::bigint
  ) on conflict (id) do update set
    source_text = excluded.source_text,
    translated_text = excluded.translated_text,
    source_status = excluded.source_status,
    translation_status = excluded.translation_status,
    source_version = excluded.source_version,
    translation_version = excluded.translation_version
  returning * into stored;
  if stored.id is distinct from cue_id
    or stored.owner_user_id is distinct from p_owner_user_id
    or stored.session_id is distinct from session_id
    or stored.segment_id is distinct from p_segment_id
    or stored.source_text is distinct from coalesce(p_cue->>'source_text','')
    or stored.translated_text is distinct from p_cue->>'translated_text'
    or stored.source_status is distinct from p_cue->>'source_status'
    or stored.translation_status is distinct from p_cue->>'translation_status'
    or stored.source_version is distinct from source_version
    or stored.translation_version is distinct from translation_version then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
end;
$$;
alter function public.lt41_upsert_cue_checked(uuid,uuid,uuid,jsonb)
  owner to lt41_checkpoint_writer;
revoke all on function public.lt41_upsert_cue_checked(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.lt41_upsert_cue_checked(uuid,uuid,uuid,jsonb)
  to lt41_checkpoint_writer;

create function public.publish_meeting_cue_v2(
  p_meeting_id uuid, p_segment_id uuid, p_cue jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare owner_id uuid;
declare segment_row public.meeting_segments;
begin
  select owner_user_id into owner_id from public.meetings
    where id = p_meeting_id for update;
  select * into segment_row from public.meeting_segments
    where id = p_segment_id and meeting_id = p_meeting_id
      and owner_user_id = owner_id for update;
  if owner_id is null or segment_row.id is null
    or segment_row.status not in ('created','active','paused') then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  perform public.lt41_upsert_cue_checked(
    owner_id, p_meeting_id, p_segment_id, p_cue);
  return p_cue;
end;
$$;
alter function public.publish_meeting_cue_v2(uuid,uuid,jsonb)
  owner to lt41_checkpoint_writer;
revoke all on function public.publish_meeting_cue_v2(uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_meeting_cue_v2(uuid,uuid,jsonb)
  to service_role;

create function public.apply_meeting_checkpoint_operation_v2(
  p_meeting_id uuid, p_segment_id uuid, p_expected_revision bigint,
  p_operation_key text, p_canonical_payload text, p_next_checkpoint jsonb,
  p_cues jsonb, p_next_status text, p_ended_at timestamptz,
  p_error_info jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare owner_id uuid;
declare segment_row public.meeting_segments;
declare cue jsonb;
declare checkpoint_cue jsonb;
declare prior_cue jsonb;
declare old_revision bigint;
declare prior_payload text;
begin
  if p_operation_key is null or btrim(p_operation_key) = ''
    or p_canonical_payload is null or p_expected_revision is null
    or p_next_checkpoint is null or jsonb_typeof(p_next_checkpoint) <> 'object'
    or p_cues is null or jsonb_typeof(p_cues) <> 'array'
    or jsonb_typeof(p_next_checkpoint->'finalCues') <> 'array'
    or p_next_status is null
    or p_next_status not in ('created','active','paused','completed','failed','interrupted') then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  select owner_user_id into owner_id from public.meetings
    where id = p_meeting_id for update;
  select * into segment_row from public.meeting_segments
    where id = p_segment_id and meeting_id = p_meeting_id
      and owner_user_id = owner_id for update;
  if owner_id is null or segment_row.id is null then
    raise exception 'meeting_not_found' using errcode = 'P0042';
  end if;
  prior_payload := segment_row.checkpoint->'_operationPayloads'->>p_operation_key;
  if prior_payload is not null then
    if prior_payload <> p_canonical_payload then
      raise exception 'checkpoint_conflict' using errcode = 'P0042';
    end if;
    return segment_row.checkpoint;
  end if;
  if segment_row.status in ('completed','failed','interrupted')
    or segment_row.checkpoint->>'idempotencyKey' = p_operation_key then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  old_revision := coalesce((segment_row.checkpoint->>'revision')::bigint, 0);
  if old_revision <> p_expected_revision then
    raise exception 'checkpoint_revision_conflict' using errcode = 'P0041';
  end if;
  if (p_next_checkpoint->>'revision')::bigint is distinct from old_revision + 1
    or p_next_checkpoint->'_operationPayloads'->>p_operation_key
      is distinct from p_canonical_payload
    or not coalesce(p_next_checkpoint->'_operationPayloads', '{}'::jsonb)
      @> coalesce(segment_row.checkpoint->'_operationPayloads', '{}'::jsonb)
    or jsonb_array_length(p_cues)
      <> jsonb_array_length(p_next_checkpoint->'finalCues') then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_cues) c
    group by c.value->>'id' having count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(p_next_checkpoint->'finalCues') c
    group by c.value->>'cueId' having count(*) > 1
  ) then raise exception 'checkpoint_conflict' using errcode = 'P0042'; end if;
  for prior_cue in select value from jsonb_array_elements(
    coalesce(segment_row.checkpoint->'finalCues','[]'::jsonb)) loop
    if not exists (
      select 1 from jsonb_array_elements(p_next_checkpoint->'finalCues') c
      where c.value->>'cueId' = prior_cue->>'cueId'
    ) then raise exception 'checkpoint_conflict' using errcode = 'P0042'; end if;
  end loop;
  for cue in select value from jsonb_array_elements(p_cues)
    order by value->>'id' loop
    select value into checkpoint_cue
      from jsonb_array_elements(p_next_checkpoint->'finalCues') c
      where c.value->>'cueId' = cue->>'id';
    if checkpoint_cue is null
      or checkpoint_cue->>'sessionId' is distinct from cue->>'session_id'
      or checkpoint_cue->>'segmentId' is distinct from p_segment_id::text
      or (checkpoint_cue->>'sequence')::integer
        is distinct from (cue->>'sequence')::integer
    or (checkpoint_cue->>'startTimeMs')::bigint
      is distinct from (cue->>'started_at')::bigint
    or (checkpoint_cue->>'endTimeMs')::bigint
      is distinct from (cue->>'ended_at')::bigint
      or coalesce(checkpoint_cue->>'sourceText','')
        is distinct from coalesce(cue->>'source_text','')
      or checkpoint_cue->>'translatedText' is distinct from cue->>'translated_text'
      or checkpoint_cue->>'sourceStatus' is distinct from cue->>'source_status'
      or checkpoint_cue->>'translationStatus' is distinct from cue->>'translation_status'
      or (checkpoint_cue->>'sourceVersion')::integer
        is distinct from (cue->>'source_version')::integer
      or (checkpoint_cue->>'translationVersion')::integer
        is distinct from (cue->>'translation_version')::integer then
      raise exception 'checkpoint_conflict' using errcode = 'P0042';
    end if;
    perform public.lt41_upsert_cue_checked(
      owner_id, p_meeting_id, p_segment_id, cue);
  end loop;
  update public.meeting_segments set checkpoint = p_next_checkpoint,
    status = p_next_status, ended_at = p_ended_at,
    error_info = p_error_info
    where id = p_segment_id and owner_user_id = owner_id;
  return p_next_checkpoint;
end;
$$;
alter function public.apply_meeting_checkpoint_operation_v2(
  uuid,uuid,bigint,text,text,jsonb,jsonb,text,timestamptz,jsonb)
  owner to lt41_checkpoint_writer;
revoke all on function public.apply_meeting_checkpoint_operation_v2(
  uuid,uuid,bigint,text,text,jsonb,jsonb,text,timestamptz,jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_meeting_checkpoint_operation_v2(
  uuid,uuid,bigint,text,text,jsonb,jsonb,text,timestamptz,jsonb)
  to service_role;
revoke all on function public.apply_meeting_checkpoint_operation(
  uuid,uuid,uuid,bigint,text,text,jsonb,jsonb,text,timestamptz,jsonb)
  from public, anon, authenticated, service_role;

-- CREATE was needed only while assigning function ownership during migration.
revoke create on schema public from lt41_checkpoint_writer;
