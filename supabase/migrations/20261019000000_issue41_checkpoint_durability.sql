-- Checkpoint changes must use the locked operation RPC. Lifecycle commands may
-- still add metadata, but cannot replace acknowledged checkpoint content.
create or replace function public.guard_meeting_checkpoint_durability()
returns trigger language plpgsql set search_path = public as $$
declare
  old_revision bigint := coalesce((old.checkpoint->>'revision')::bigint, 0);
  new_revision bigint := coalesce((new.checkpoint->>'revision')::bigint, 0);
begin
  if new.checkpoint is not distinct from old.checkpoint then return new; end if;
  if old.checkpoint is null or old.checkpoint = '{}'::jsonb then return new; end if;
  if current_setting('app.checkpoint_operation', true) = 'on' then
    if new_revision <> old_revision + 1 or
       not coalesce(new.checkpoint->'_operationPayloads', '{}'::jsonb)
         @> coalesce(old.checkpoint->'_operationPayloads', '{}'::jsonb) or
       exists (
         select 1 from jsonb_array_elements(coalesce(old.checkpoint->'finalCues', '[]'::jsonb)) prior
         where not exists (
           select 1 from jsonb_array_elements(coalesce(new.checkpoint->'finalCues', '[]'::jsonb)) next_cue
           where next_cue.value->>'cueId' = prior.value->>'cueId'
         )
       ) then
      raise exception 'checkpoint_conflict' using errcode = 'P0042';
    end if;
    return new;
  end if;
  if new_revision <> old_revision or
     (new.checkpoint - 'terminalReason' - 'expiredAt') is distinct from
     (old.checkpoint - 'terminalReason' - 'expiredAt') then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  return new;
end;
$$;

drop trigger if exists meeting_checkpoint_durability_guard on public.meeting_segments;
create trigger meeting_checkpoint_durability_guard
before update of checkpoint on public.meeting_segments
for each row execute function public.guard_meeting_checkpoint_durability();

create or replace function public.apply_meeting_checkpoint_operation(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_segment_id uuid,
  p_expected_revision bigint,
  p_operation_key text,
  p_canonical_payload text,
  p_next_checkpoint jsonb,
  p_cues jsonb,
  p_next_status text,
  p_ended_at timestamptz,
  p_error_info jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  segment_row public.meeting_segments;
  cue_row public.subtitle_cues;
  cue jsonb;
  saved_id uuid;
  old_revision bigint;
  prior_payload text;
begin
  select * into segment_row from public.meeting_segments
    where id = p_segment_id and meeting_id = p_meeting_id and owner_user_id = p_owner_user_id
    for update;
  if not found then raise exception 'meeting_not_found' using errcode = 'P0042'; end if;
  if segment_row.status in ('completed', 'failed', 'interrupted') then
    raise exception 'meeting_segment_invalid_state' using errcode = 'P0042';
  end if;
  prior_payload := segment_row.checkpoint->'_operationPayloads'->>p_operation_key;
  if prior_payload is not null then
    if prior_payload <> p_canonical_payload then
      raise exception 'checkpoint_conflict' using errcode = 'P0042';
    end if;
    return segment_row.checkpoint;
  end if;
  if segment_row.checkpoint->>'idempotencyKey' = p_operation_key then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;
  old_revision := coalesce((segment_row.checkpoint->>'revision')::bigint, 0);
  if old_revision <> p_expected_revision then
    raise exception 'checkpoint_revision_conflict' using errcode = 'P0041';
  end if;
  if (p_next_checkpoint->>'revision')::bigint <> old_revision + 1 or
     p_next_checkpoint->'_operationPayloads'->>p_operation_key <> p_canonical_payload or
     jsonb_typeof(p_cues) <> 'array' or
     p_next_status not in ('created', 'active', 'paused', 'completed', 'failed', 'interrupted') then
    raise exception 'checkpoint_conflict' using errcode = 'P0042';
  end if;

  for cue in select value from jsonb_array_elements(p_cues) loop
    select * into cue_row from public.subtitle_cues where id = (cue->>'id')::uuid for update;
    if found and (cue_row.owner_user_id <> p_owner_user_id or
       cue_row.session_id <> (cue->>'session_id')::uuid or
       cue_row.segment_id <> p_segment_id or
       cue_row.source_version > (cue->>'source_version')::integer or
       cue_row.translation_version > (cue->>'translation_version')::integer or
       ((cue->>'source_version')::integer = cue_row.source_version
         and coalesce(cue->>'source_text', '') <> coalesce(cue_row.source_text, '')) or
       ((cue->>'translation_version')::integer = cue_row.translation_version
         and coalesce(cue->>'translated_text', '') <> coalesce(cue_row.translated_text, ''))) then
      raise exception 'checkpoint_conflict' using errcode = 'P0042';
    end if;
    saved_id := null;
    insert into public.subtitle_cues as stored (
      id, owner_user_id, session_id, segment_id, sequence,
      source_text, translated_text, source_status, translation_status,
      source_version, translation_version, started_at, ended_at
    ) values (
      (cue->>'id')::uuid, p_owner_user_id, (cue->>'session_id')::uuid, p_segment_id,
      (cue->>'sequence')::integer, coalesce(cue->>'source_text', ''), cue->>'translated_text',
      cue->>'source_status', cue->>'translation_status',
      (cue->>'source_version')::integer, (cue->>'translation_version')::integer,
      (cue->>'started_at')::timestamptz, (cue->>'ended_at')::timestamptz
    ) on conflict (id) do update set
      source_text = excluded.source_text, translated_text = excluded.translated_text,
      source_status = excluded.source_status, translation_status = excluded.translation_status,
      source_version = excluded.source_version, translation_version = excluded.translation_version,
      started_at = excluded.started_at, ended_at = excluded.ended_at
    where stored.owner_user_id = excluded.owner_user_id and
      stored.session_id = excluded.session_id and stored.segment_id = excluded.segment_id and
      stored.source_version <= excluded.source_version and
      stored.translation_version <= excluded.translation_version
    returning id into saved_id;
    if saved_id is null then raise exception 'checkpoint_conflict' using errcode = 'P0042'; end if;
  end loop;

  perform set_config('app.checkpoint_operation', 'on', true);
  update public.meeting_segments set checkpoint = p_next_checkpoint,
    status = p_next_status, ended_at = p_ended_at, error_info = p_error_info
    where id = p_segment_id and owner_user_id = p_owner_user_id;
  perform set_config('app.checkpoint_operation', 'off', true);
  return p_next_checkpoint;
end;
$$;

revoke all on function public.apply_meeting_checkpoint_operation(uuid, uuid, uuid, bigint, text, text, jsonb, jsonb, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.apply_meeting_checkpoint_operation(uuid, uuid, uuid, bigint, text, text, jsonb, jsonb, text, timestamptz, jsonb) to service_role;
