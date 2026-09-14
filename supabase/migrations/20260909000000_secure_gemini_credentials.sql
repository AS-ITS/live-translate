-- P2: Keep user Gemini keys inside Supabase Vault. The application only receives
-- a plaintext value from these service-role-only RPCs in server memory.

alter table public.meetings
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists failure_info jsonb,
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table public.meeting_segments
  add column if not exists live_session_id text,
  add column if not exists settings_snapshot jsonb,
  add column if not exists checkpoint jsonb not null default '{}'::jsonb,
  add column if not exists error_info jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.sessions
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists transcript_items jsonb not null default '[]'::jsonb;

alter table public.subtitle_cues
  add column if not exists segment_id uuid references public.meeting_segments(id) on delete cascade;

alter table public.subtitle_cues
  drop constraint if exists subtitle_cues_owner_segment_fkey;

alter table public.subtitle_cues
  add constraint subtitle_cues_owner_segment_fkey
  foreign key (owner_user_id, segment_id)
  references public.meeting_segments(owner_user_id, id)
  on delete cascade;

alter table public.gemini_credentials
  add column if not exists vault_secret_id uuid unique;

revoke all on public.gemini_credentials from anon, authenticated;

create or replace function public.get_my_gemini_credential(requested_user_id uuid)
returns table (configured boolean, last_four text, key_version text, verified_at timestamptz)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if requested_user_id is null then
    raise exception using errcode = '42501', message = 'authenticated user required';
  end if;

  return query
    select true, c.last_four, c.key_version, c.verified_at
    from public.gemini_credentials c
    where c.owner_user_id = requested_user_id;
end;
$$;

create or replace function public.upsert_my_gemini_credential(
  requested_user_id uuid,
  plaintext_key text
)
returns table (configured boolean, last_four text, key_version text, verified_at timestamptz)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  existing_secret uuid;
  next_secret uuid;
  version text := 'vault-v1';
begin
  if requested_user_id is null or plaintext_key is null or length(trim(plaintext_key)) < 10 then
    raise exception using errcode = '22023', message = 'invalid credential';
  end if;

  select vault_secret_id into existing_secret
  from public.gemini_credentials
  where owner_user_id = requested_user_id;

  if existing_secret is null then
    next_secret := vault.create_secret(trim(plaintext_key), 'gemini-' || requested_user_id::text);
  else
    perform vault.update_secret(existing_secret, trim(plaintext_key), 'gemini-' || requested_user_id::text);
    next_secret := existing_secret;
  end if;

  insert into public.gemini_credentials(owner_user_id, encrypted_value, vault_secret_id, last_four, key_version, verified_at)
  values (requested_user_id, '[vault]', next_secret, right(trim(plaintext_key), 4), version, now())
  on conflict (owner_user_id) do update set
    encrypted_value = '[vault]',
    vault_secret_id = excluded.vault_secret_id,
    last_four = excluded.last_four,
    key_version = excluded.key_version,
    verified_at = excluded.verified_at;

  return query select true, right(trim(plaintext_key), 4), version, now();
end;
$$;

create or replace function public.delete_my_gemini_credential(requested_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  existing_secret uuid;
begin
  select vault_secret_id into existing_secret
  from public.gemini_credentials
  where owner_user_id = requested_user_id;

  if existing_secret is not null then
    perform vault.delete_secret(existing_secret);
  end if;
  delete from public.gemini_credentials where owner_user_id = requested_user_id;
end;
$$;

create or replace function public.read_my_gemini_key(requested_user_id uuid)
returns table (api_key text)
language sql
security definer
set search_path = public, vault
as $$
  select d.decrypted_secret
  from public.gemini_credentials c
  join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.owner_user_id = requested_user_id;
$$;

revoke all on function public.read_my_gemini_key(uuid) from public;
revoke all on function public.get_my_gemini_credential(uuid) from public;
revoke all on function public.upsert_my_gemini_credential(uuid, text) from public;
revoke all on function public.delete_my_gemini_credential(uuid) from public;
grant execute on function public.get_my_gemini_credential(uuid) to service_role;
grant execute on function public.upsert_my_gemini_credential(uuid, text) to service_role;
grant execute on function public.delete_my_gemini_credential(uuid) to service_role;
grant execute on function public.read_my_gemini_key(uuid) to service_role;
