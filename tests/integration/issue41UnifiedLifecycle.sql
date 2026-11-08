-- Run against an isolated Local Supabase with the B2-L migration applied.
-- This test creates and removes its fixture in one transaction.
begin;
do $$
declare
  fixture_owner uuid;
  fixture_id uuid := gen_random_uuid();
  completed public.meetings;
  first_version bigint;
  first_ended_at timestamptz;
  glossary_count_before bigint;
begin
  select id into fixture_owner from auth.users limit 1;
  if fixture_owner is null then
    raise exception 'A Local Supabase v2 fixture owner is required';
  end if;
  insert into public.meetings (
    id, owner_user_id, name, source_language_code, target_language_code,
    status, lifecycle_contract_version, lifecycle_version
  ) values (fixture_id, fixture_owner, 'B2-L transaction fixture', 'zh-Hant', 'en', 'created', 2, 0);

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'execute_meeting_lifecycle_command', 'recover_meeting_recorder_lease',
        'renew_meeting_recorder_lease', 'touch_meeting_liveness'
      ])
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'Cloud lifecycle RPC remains executable';
  end if;

  begin
    insert into public.sessions (id, owner_user_id, meeting_id, lifecycle_contract_version)
    values (gen_random_uuid(), fixture_owner, fixture_id, 2);
    raise exception 'Parallel Session insert succeeded';
  exception when sqlstate 'P0043' then null;
  end;
  begin
    insert into public.meeting_segments (id, owner_user_id, meeting_id, lifecycle_contract_version)
    values (gen_random_uuid(), fixture_owner, fixture_id, 2);
    raise exception 'Parallel Segment insert succeeded';
  exception when sqlstate 'P0043' then null;
  end;
  begin
    insert into public.recorder_leases (owner_user_id, meeting_id)
    values (fixture_owner, fixture_id);
    raise exception 'Parallel Lease insert succeeded';
  exception when sqlstate 'P0043' then null;
  end;
  begin
    insert into public.meeting_lifecycle_operations (owner_user_id, meeting_id)
    values (fixture_owner, fixture_id);
    raise exception 'Parallel operation insert succeeded';
  exception when sqlstate 'P0043' then null;
  end;

  completed := public.complete_local_only_meeting(fixture_owner, fixture_id);
  if completed.status <> 'completed' or completed.lifecycle_version <> 1
    or completed.ended_at is null or completed.purge_at <> completed.ended_at + interval '30 minutes' then
    raise exception 'Local-only End metadata contract failed';
  end if;
  first_version := completed.lifecycle_version;
  first_ended_at := completed.ended_at;
  completed := public.complete_local_only_meeting(fixture_owner, fixture_id);
  if completed.lifecycle_version <> first_version or completed.ended_at <> first_ended_at then
    raise exception 'Local-only End was not idempotent';
  end if;
  update public.meetings set name = 'stale settings patch', ended_at = null
  where id = fixture_id and status <> 'completed';
  if found then raise exception 'Settings patch overwrote completed Meeting'; end if;
  select count(*) into glossary_count_before from public.glossary_entries
  where owner_user_id = fixture_owner;
  delete from public.meetings where id = fixture_id;
  if (select count(*) from public.glossary_entries where owner_user_id = fixture_owner)
    <> glossary_count_before then
    raise exception 'Meeting deletion removed shared glossary entries';
  end if;
end;
$$;
rollback;
