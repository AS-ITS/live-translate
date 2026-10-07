-- Domain-approved accounts are activated only after the backend validates the
-- Supabase JWT and AUTH_ALLOWED_EMAIL_DOMAINS. The auth trigger keeps the
-- profile pending until that trusted request completes.
alter table public.profiles
  alter column role set default 'member',
  alter column status set default 'pending';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url, role, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url',
    'member',
    'pending'
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = excluded.full_name,
      avatar_url = excluded.avatar_url,
      updated_at = now();
  return new;
end;
$$;

create or replace function public.activate_pending_profile(target_user_id uuid)
returns setof public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.profiles;
begin
  update public.profiles
  set status = 'active',
      updated_at = now()
  where id = target_user_id
    and status = 'pending'
  returning * into result;

  if result.id is null then
    select * into result
    from public.profiles
    where id = target_user_id;
  end if;

  if result.id is not null then
    return next result;
  end if;
end;
$$;

revoke all on function public.activate_pending_profile(uuid) from public, anon, authenticated;
grant execute on function public.activate_pending_profile(uuid) to service_role;
