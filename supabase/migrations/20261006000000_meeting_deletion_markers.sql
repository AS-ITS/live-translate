-- Keep only the owner and deletion outcome after a manual meeting delete.
-- Audit rows retain their historical meeting id without keeping the meeting alive.
create table if not exists public.meeting_deletions (
  meeting_id uuid primary key,
  owner_user_id uuid not null,
  state text not null check (state in ('deleting', 'deleted')),
  requested_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);

create index if not exists meeting_deletions_owner_idx
  on public.meeting_deletions (owner_user_id, requested_at);

alter table public.meeting_deletions enable row level security;
revoke all on public.meeting_deletions from public, anon, authenticated;
grant select, insert, update on public.meeting_deletions to service_role;

alter table public.audit_logs
  drop constraint if exists audit_logs_target_meeting_id_fkey;

create or replace function public.begin_meeting_deletion(
  p_meeting_id uuid,
  p_actor_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  target public.meetings%rowtype;
  marker public.meeting_deletions%rowtype;
  actor_can_manage boolean;
begin
  select * into target from public.meetings where id = p_meeting_id for update;
  if not found then
    select * into marker from public.meeting_deletions where meeting_id = p_meeting_id;
    if marker.meeting_id is null then
      raise exception 'meeting_not_found' using errcode = 'P0002';
    end if;
  end if;

  actor_can_manage := p_actor_user_id is not null and (
    p_actor_user_id = coalesce(target.owner_user_id, marker.owner_user_id)
    or exists (
      select 1 from public.profiles
      where id = p_actor_user_id and role = 'super_admin' and status = 'active'
    )
  );
  if not actor_can_manage then
    raise exception 'auth_forbidden' using errcode = '42501';
  end if;
  if target.id is null then
    return jsonb_build_object('state', marker.state, 'ownerUserId', marker.owner_user_id);
  end if;

  if target.status <> 'completed' and (
    target.status = 'active'
    or exists (select 1 from public.meeting_segments where meeting_id = p_meeting_id and status = 'active')
    or exists (select 1 from public.sessions where meeting_id = p_meeting_id and status in ('active', 'paused'))
  ) then
    raise exception 'meeting_delete_active_not_allowed' using errcode = 'P0001';
  end if;

  insert into public.meeting_deletions (meeting_id, owner_user_id, state)
  values (p_meeting_id, target.owner_user_id, 'deleting')
  on conflict (meeting_id) do nothing;
  return jsonb_build_object('state', 'deleting', 'ownerUserId', target.owner_user_id);
end;
$$;

create or replace function public.finish_meeting_deletion(
  p_meeting_id uuid,
  p_actor_user_id uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  marker public.meeting_deletions%rowtype;
begin
  select * into marker from public.meeting_deletions
  where meeting_id = p_meeting_id for update;
  if marker.meeting_id is null then
    raise exception 'meeting_not_found' using errcode = 'P0002';
  end if;
  if p_actor_user_id is null or not (
    p_actor_user_id = marker.owner_user_id
    or exists (
      select 1 from public.profiles
      where id = p_actor_user_id and role = 'super_admin' and status = 'active'
    )
  ) then
    raise exception 'auth_forbidden' using errcode = '42501';
  end if;
  if marker.state = 'deleted' then return true; end if;

  delete from public.meetings
  where id = p_meeting_id and owner_user_id = marker.owner_user_id;
  update public.meeting_deletions
  set state = 'deleted', deleted_at = coalesce(deleted_at, clock_timestamp())
  where meeting_id = p_meeting_id;
  return true;
end;
$$;

revoke all on function public.begin_meeting_deletion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_meeting_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_meeting_deletion(uuid, uuid) to service_role;
grant execute on function public.finish_meeting_deletion(uuid, uuid) to service_role;

create or replace function public.list_meeting_storage_paths(
  p_owner_user_id uuid,
  p_meeting_id uuid,
  p_limit integer default 101
) returns table(bucket text, path text)
language plpgsql stable security definer set search_path = public, storage, pg_temp as $$
begin
  if p_limit < 1 or p_limit > 101 then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  return query
    select object.bucket_id::text, object.name::text
    from storage.objects object
    where object.bucket_id in ('meeting-audio', 'meeting-exports')
      and object.name like p_owner_user_id::text || '/' || p_meeting_id::text || '/%'
    order by object.bucket_id, object.name
    limit p_limit;
end;
$$;

revoke all on function public.list_meeting_storage_paths(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.list_meeting_storage_paths(uuid, uuid, integer) to service_role;

create or replace function public.reject_deleted_meeting_write()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  target_meeting_id uuid;
begin
  if tg_table_name = 'subtitle_cues' then
    select meeting_id into target_meeting_id from public.meeting_segments
    where id = new.segment_id and owner_user_id = new.owner_user_id;
    if target_meeting_id is null then
      select meeting_id into target_meeting_id from public.sessions
      where id = new.session_id and owner_user_id = new.owner_user_id;
    end if;
  elsif tg_table_name = 'audio_artifacts' then
    target_meeting_id := new.meeting_id;
    if target_meeting_id is null then
      select meeting_id into target_meeting_id from public.sessions
      where id = new.session_id and owner_user_id = new.owner_user_id;
    end if;
  else
    target_meeting_id := coalesce(to_jsonb(new)->>'meeting_id', to_jsonb(new)->>'id')::uuid;
  end if;
  if target_meeting_id is not null and exists (
    select 1 from public.meeting_deletions
    where meeting_id = target_meeting_id
  ) then
    raise exception 'meeting_deleted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger meetings_reject_deleted_write before insert or update on public.meetings
for each row execute function public.reject_deleted_meeting_write();
create trigger meeting_segments_reject_deleted_write before insert or update on public.meeting_segments
for each row execute function public.reject_deleted_meeting_write();
create trigger sessions_reject_deleted_write before insert or update on public.sessions
for each row execute function public.reject_deleted_meeting_write();
create trigger subtitle_cues_reject_deleted_write before insert or update on public.subtitle_cues
for each row execute function public.reject_deleted_meeting_write();
create trigger audio_artifacts_reject_deleted_write before insert or update on public.audio_artifacts
for each row execute function public.reject_deleted_meeting_write();
create trigger export_artifacts_reject_deleted_write before insert or update on public.export_artifacts
for each row execute function public.reject_deleted_meeting_write();
create trigger viewer_shares_reject_deleted_write before insert or update on public.viewer_shares
for each row execute function public.reject_deleted_meeting_write();
create trigger meeting_events_reject_deleted_write before insert or update on public.meeting_events
for each row execute function public.reject_deleted_meeting_write();
create trigger meeting_glossary_reject_deleted_write before insert or update on public.meeting_glossary_entries
for each row execute function public.reject_deleted_meeting_write();
create trigger meeting_summaries_reject_deleted_write before insert or update on public.meeting_summaries
for each row execute function public.reject_deleted_meeting_write();
create trigger meeting_members_reject_deleted_write before insert or update on public.meeting_members
for each row execute function public.reject_deleted_meeting_write();
create trigger meeting_lifecycle_operations_reject_deleted_write before insert or update on public.meeting_lifecycle_operations
for each row execute function public.reject_deleted_meeting_write();
create trigger recorder_leases_reject_deleted_write before insert or update on public.recorder_leases
for each row execute function public.reject_deleted_meeting_write();

create or replace function public.meeting_storage_is_deleting(p_owner text, p_meeting text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.meeting_deletions
    where owner_user_id::text = p_owner and meeting_id::text = p_meeting
  );
$$;
revoke all on function public.meeting_storage_is_deleting(text, text) from public, anon;
grant execute on function public.meeting_storage_is_deleting(text, text) to authenticated;

create policy meeting_storage_reject_deleted on storage.objects
as restrictive for all to authenticated
using (
  bucket_id not in ('meeting-audio', 'meeting-exports')
  or not public.meeting_storage_is_deleting((storage.foldername(name))[1], (storage.foldername(name))[2])
)
with check (
  bucket_id not in ('meeting-audio', 'meeting-exports')
  or not public.meeting_storage_is_deleting((storage.foldername(name))[1], (storage.foldername(name))[2])
);
