-- Recording identity and transitions for lifecycle v2 belong to the Host.
-- Keep historical rows and v1 data; reject new v2 Session, Segment, Lease,
-- and lifecycle-operation writes even through service-role or direct SQL.
create or replace function public.lt41_reject_parallel_recording_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_meeting_id uuid;
  contract_version smallint;
begin
  target_meeting_id := nullif(to_jsonb(new)->>'meeting_id', '')::uuid;
  contract_version := nullif(to_jsonb(new)->>'lifecycle_contract_version', '')::smallint;
  if contract_version = 2 or exists (
    select 1 from public.meetings
    where id = target_meeting_id and lifecycle_contract_version = 2
  ) then
    raise exception 'meeting_content_local_only' using errcode = 'P0043';
  end if;
  return new;
end;
$$;

-- Serialize End with settings PATCH and advance Viewer metadata version once.
create or replace function public.complete_local_only_meeting(
  p_owner_user_id uuid,
  p_meeting_id uuid
)
returns public.meetings
language plpgsql
security definer
set search_path = public
as $$
declare
  meeting_row public.meetings;
  completed_at timestamptz;
begin
  select * into meeting_row from public.meetings
  where id = p_meeting_id and owner_user_id = p_owner_user_id
    and lifecycle_contract_version = 2
  for update;
  if not found then
    raise exception 'meeting_not_found';
  end if;
  if meeting_row.status = 'completed' then
    return meeting_row;
  end if;
  if meeting_row.status in ('failed', 'deleted') then
    raise exception 'meeting_complete_not_allowed';
  end if;
  completed_at := clock_timestamp();
  update public.meetings set
    status = 'completed',
    started_at = coalesce(started_at, created_at),
    ended_at = completed_at,
    purge_at = completed_at + interval '30 minutes',
    lifecycle_version = lifecycle_version + 1,
    updated_at = completed_at
  where id = p_meeting_id and owner_user_id = p_owner_user_id
  returning * into meeting_row;
  return meeting_row;
end;
$$;

revoke all on function public.complete_local_only_meeting(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_local_only_meeting(uuid, uuid)
  to service_role;

do $$
declare
  table_name text;
  routine record;
begin
  foreach table_name in array array[
    'sessions', 'meeting_segments', 'recorder_leases', 'meeting_lifecycle_operations'
  ] loop
    execute format('drop trigger if exists lt41_no_parallel_lifecycle on public.%I', table_name);
    execute format(
      'create trigger lt41_no_parallel_lifecycle before insert or update on public.%I for each row execute function public.lt41_reject_parallel_recording_lifecycle()',
      table_name
    );
  end loop;

  for routine in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'execute_meeting_lifecycle_command',
        'lookup_meeting_lifecycle_operation',
        'recover_meeting_recorder_lease',
        'renew_meeting_recorder_lease',
        'touch_meeting_liveness',
        'expire_stale_meetings',
        'validate_meeting_recorder_write'
      ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', routine.signature);
  end loop;
end;
$$;
