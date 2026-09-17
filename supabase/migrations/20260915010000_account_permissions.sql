-- Issue #33: account roles, status, and meeting membership.
alter table public.profiles
  add column if not exists role text not null default 'member',
  add column if not exists status text not null default 'active',
  add column if not exists disabled_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_role_check,
  add constraint profiles_role_check check (role in ('member', 'super_admin')),
  drop constraint if exists profiles_status_check,
  add constraint profiles_status_check check (status in ('active', 'disabled'));

create table if not exists public.meeting_members (
  owner_user_id uuid not null,
  meeting_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_user_id, meeting_id, user_id),
  foreign key (owner_user_id, meeting_id) references public.meetings(owner_user_id, id) on delete cascade
);

create index if not exists meeting_members_user_idx on public.meeting_members(user_id, meeting_id);
alter table public.meeting_members enable row level security;
revoke all on public.meeting_members from anon, authenticated;
grant all on public.meeting_members to service_role;
grant select, insert, update, delete on public.meeting_members to authenticated;

-- Deployment supplies the issued UUID and verifies its email before promotion.
create or replace function public.bootstrap_super_admin(target_user_id uuid, expected_email text)
returns public.profiles language plpgsql security definer set search_path = public
as $$
declare result public.profiles;
begin
  update public.profiles set role = 'super_admin', status = 'active', disabled_at = null, updated_at = now()
  where id = target_user_id and lower(email) = lower(expected_email) returning * into result;
  if result.id is null then raise exception using errcode = '22023', message = 'Bootstrap user UUID and email do not match.'; end if;
  return result;
end;
$$;
revoke all on function public.bootstrap_super_admin(uuid, text) from public, anon, authenticated;
grant execute on function public.bootstrap_super_admin(uuid, text) to service_role;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin' and status = 'active'); $$;
revoke all on function public.is_super_admin() from public, anon;
grant execute on function public.is_super_admin() to authenticated, service_role;

create policy meeting_members_select on public.meeting_members for select to authenticated
  using (owner_user_id = auth.uid() or user_id = auth.uid() or public.is_super_admin());
create policy meeting_members_owner_write on public.meeting_members for all to authenticated
  using (owner_user_id = auth.uid() or public.is_super_admin())
  with check (owner_user_id = auth.uid() or public.is_super_admin());
