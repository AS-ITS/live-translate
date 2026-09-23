create or replace function public.validate_meeting_recorder_write(
  p_meeting_id uuid,
  p_session_id uuid default null,
  p_segment_id uuid default null,
  p_lease_id text default null,
  p_fence_token bigint default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  contract_version smallint;
begin
  select lifecycle_contract_version
  into contract_version
  from public.meetings
  where id = p_meeting_id;

  if not found then
    raise exception 'meeting_not_found';
  end if;

  if contract_version <> 2 then
    return true;
  end if;

  if p_session_id is null or p_segment_id is null or
     nullif(trim(p_lease_id), '') is null or p_fence_token is null then
    raise exception 'recorder_lease_invalid';
  end if;

  if not exists (
    select 1
    from public.sessions s
    join public.meeting_segments ms
      on ms.owner_user_id = s.owner_user_id
     and ms.meeting_id = s.meeting_id
     and ms.session_id = s.id
     and ms.id = s.current_segment_id
    join public.recorder_leases rl
      on rl.owner_user_id = s.owner_user_id
     and rl.meeting_id = s.meeting_id
     and rl.session_id = s.id
    where s.meeting_id = p_meeting_id
      and s.id = p_session_id
      and ms.id = p_segment_id
      and ms.status = 'active'
      and rl.lease_id = p_lease_id
      and rl.fence_token = p_fence_token
      and rl.expires_at > clock_timestamp()
  ) then
    raise exception 'recorder_lease_invalid';
  end if;

  return true;
end;
$$;

revoke all on function public.validate_meeting_recorder_write(uuid, uuid, uuid, text, bigint) from public;
grant execute on function public.validate_meeting_recorder_write(uuid, uuid, uuid, text, bigint) to service_role;
