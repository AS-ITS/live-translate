alter table public.glossary_entries
  add column if not exists created_at timestamptz not null default now();

alter table public.glossary_entries
  add column if not exists updated_at timestamptz not null default now();
