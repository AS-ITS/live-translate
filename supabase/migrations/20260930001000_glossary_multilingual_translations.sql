-- Preserve every target-language translation on one logical glossary entry.
-- Legacy scalar columns remain synchronized by the application for compatibility.
alter table public.glossary_entries
  add column if not exists translations jsonb not null default '{}'::jsonb;

update public.glossary_entries
set translations = jsonb_build_object(target_language_code, translation)
where translations = '{}'::jsonb;

alter table public.glossary_entries
  drop constraint if exists glossary_entries_translations_object;

alter table public.glossary_entries
  add constraint glossary_entries_translations_object
  check (jsonb_typeof(translations) = 'object');
