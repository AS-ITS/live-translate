-- Production readiness repairs for the background-job and credential RPCs.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.gemini_credentials'::regclass
      and conname = 'gemini_credentials_owner_user_id_key'
  ) then
    alter table public.gemini_credentials
      add constraint gemini_credentials_owner_user_id_key unique (owner_user_id);
  end if;
end;
$$;

create or replace function public.background_job_archive(
  queue_name text,
  message_id bigint,
  read_ct bigint,
  attempt integer,
  error_code text,
  message jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  archived boolean;
begin
  insert into public.background_job_dead_letters(
    queue_name,
    message_id,
    message,
    attempt,
    error_code
  )
  values (
    $1,
    $2,
    coalesce($6, '{}'::jsonb),
    greatest($4, 1),
    coalesce($5, 'background_job_retry_exhausted')
  )
  on conflict (queue_name, message_id) do nothing;

  archived := pgmq.archive($1, $2);
  return archived;
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
  if requested_user_id is null then
    raise exception using errcode = '42501', message = 'authenticated user required';
  end if;

  select vault_secret_id
    into existing_secret
  from public.gemini_credentials
  where owner_user_id = requested_user_id;

  if existing_secret is not null then
    delete from vault.secrets where id = existing_secret;
  end if;

  delete from public.gemini_credentials
  where owner_user_id = requested_user_id;
end;
$$;
