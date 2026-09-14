-- Local persistence completion: every runtime-owned record has a Supabase home.
-- The service role is used by the Node worker; RLS remains enabled for clients.

create table if not exists public.translation_queue_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  execution_id text not null,
  request_id text not null,
  status text not null default 'queued',
  enqueued_at timestamptz not null default now(),
  available_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  fence_token integer not null default 0,
  attempt integer not null default 0,
  last_failure jsonb,
  unique (owner_user_id, execution_id),
  unique (owner_user_id, request_id),
  check (status in ('queued', 'processing', 'completed', 'failed'))
);

create table if not exists public.translation_dead_letter_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  execution_id text not null,
  request_id text not null,
  attempt integer not null default 0,
  available_at timestamptz,
  last_failure jsonb,
  failed_at timestamptz not null default now(),
  failure jsonb not null,
  provider_key text,
  provider_metadata jsonb,
  execution_metadata jsonb,
  unique (owner_user_id, execution_id)
);

create table if not exists public.recorder_leases (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  lease_id text not null,
  fence_token integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, session_id),
  unique (owner_user_id, lease_id),
  foreign key (owner_user_id, session_id)
    references public.sessions(owner_user_id, id) on delete cascade
);

alter table public.glossary_categories add column if not exists system boolean not null default false;
alter table public.glossary_entries add column if not exists scope text not null default 'both';
alter table public.glossary_entries add column if not exists tags jsonb not null default '[]'::jsonb;
alter table public.glossary_entries add column if not exists enabled boolean not null default true;
alter table public.glossary_entries add column if not exists notes text not null default '';

create index if not exists translation_queue_items_available_idx
  on public.translation_queue_items (owner_user_id, status, available_at, enqueued_at);
create index if not exists translation_dead_letter_items_owner_idx
  on public.translation_dead_letter_items (owner_user_id, failed_at);
create index if not exists recorder_leases_expiry_idx
  on public.recorder_leases (owner_user_id, expires_at);

alter table public.translation_queue_items enable row level security;
alter table public.translation_dead_letter_items enable row level security;
alter table public.recorder_leases enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'translation_queue_items', 'translation_dead_letter_items', 'recorder_leases'
  ] loop
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
    execute format('create policy %I on public.%I for all using (auth.uid() = owner_user_id) with check (auth.uid() = owner_user_id)', table_name || '_owner', table_name);
  end loop;
end $$;

-- Session audio metadata is already represented by audio_artifacts. Keep a
-- dedicated owner index for the metadata-only download and cleanup paths.
create index if not exists audio_artifacts_owner_session_idx
  on public.audio_artifacts (owner_user_id, session_id, created_at);
