-- Atomic account role management for active system administrators.
alter table public.audit_logs
  add column if not exists target_email text,
  add column if not exists old_role text,
  add column if not exists new_role text;

alter table public.audit_logs drop constraint if exists audit_logs_action_check;
alter table public.audit_logs add constraint audit_logs_action_check check (
  action in (
    'member_invited',
    'member_removed',
    'member_recording_permission_changed',
    'user_approved',
    'user_enabled',
    'user_disabled',
    'asset_transfer',
    'auth_login',
    'account.role.promoted',
    'account.role.demoted'
  )
);

alter table public.audit_logs drop constraint if exists audit_logs_old_role_check;
alter table public.audit_logs add constraint audit_logs_old_role_check
  check (old_role is null or old_role in ('member', 'super_admin'));

alter table public.audit_logs drop constraint if exists audit_logs_new_role_check;
alter table public.audit_logs add constraint audit_logs_new_role_check
  check (new_role is null or new_role in ('member', 'super_admin'));

create or replace function public.update_account_role(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_new_role text,
  p_request_id text default null
)
returns table (
  outcome text,
  changed boolean,
  id uuid,
  email text,
  full_name text,
  avatar_url text,
  role text,
  status text,
  disabled_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_profile public.profiles%rowtype;
  target_profile public.profiles%rowtype;
  remaining_admins bigint;
  audit_action text;
  previous_role text;
begin
  -- Every actor/target read, validation, update, and audit insert happens
  -- after this transaction-scoped lock is held.
  perform pg_advisory_xact_lock(hashtext('public.update_account_role'));

  select *
    into actor_profile
    from public.profiles
    where profiles.id = p_actor_user_id
    for update;

  if actor_profile.id is null
    or actor_profile.status <> 'active'
    or actor_profile.role <> 'super_admin' then
    return query select
      'auth_forbidden', false,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_new_role is null or p_new_role not in ('member', 'super_admin') then
    return query select
      'invalid_account_role', false,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select *
    into target_profile
    from public.profiles
    where profiles.id = p_target_user_id
    for update;

  if target_profile.id is null then
    return query select
      'account_not_found', false,
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  if target_profile.role = p_new_role then
    return query select
      'ok', false,
      target_profile.id, target_profile.email, target_profile.full_name,
      target_profile.avatar_url, target_profile.role, target_profile.status,
      target_profile.disabled_at, target_profile.created_at, target_profile.updated_at;
    return;
  end if;

  if p_actor_user_id = p_target_user_id and p_new_role = 'member' then
    return query select
      'cannot_demote_self', false,
      target_profile.id, target_profile.email, target_profile.full_name,
      target_profile.avatar_url, target_profile.role, target_profile.status,
      target_profile.disabled_at, target_profile.created_at, target_profile.updated_at;
    return;
  end if;

  if target_profile.role = 'super_admin' and p_new_role = 'member' then
    select count(*)
      into remaining_admins
      from public.profiles
      where profiles.role = 'super_admin';

    if remaining_admins <= 1 then
      return query select
        'last_super_admin', false,
        target_profile.id, target_profile.email, target_profile.full_name,
        target_profile.avatar_url, target_profile.role, target_profile.status,
        target_profile.disabled_at, target_profile.created_at, target_profile.updated_at;
      return;
    end if;
  end if;

  audit_action := case
    when p_new_role = 'super_admin' then 'account.role.promoted'
    else 'account.role.demoted'
  end;
  previous_role := target_profile.role;

  update public.profiles
    set role = p_new_role,
        updated_at = now()
    where profiles.id = p_target_user_id
    returning * into target_profile;

  insert into public.audit_logs (
    actor_user_id,
    target_user_id,
    target_email,
    old_role,
    new_role,
    request_id,
    action,
    result
  ) values (
    p_actor_user_id,
    p_target_user_id,
    target_profile.email,
    previous_role,
    p_new_role,
    p_request_id,
    audit_action,
    'success'
  );

  return query select
    'ok', true,
    target_profile.id, target_profile.email, target_profile.full_name,
    target_profile.avatar_url, target_profile.role, target_profile.status,
    target_profile.disabled_at, target_profile.created_at, target_profile.updated_at;
end;
$$;

revoke all on function public.update_account_role(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.update_account_role(uuid, uuid, text, text)
  to service_role;
