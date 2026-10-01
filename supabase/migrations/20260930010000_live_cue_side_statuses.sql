-- Allow either side of a Live Translate Cue to become durable first.
alter table public.subtitle_cues
  alter column source_text drop not null,
  add column if not exists source_status text not null default 'pending',
  add column if not exists translation_status text not null default 'pending';

update public.subtitle_cues
set source_status = case
      when nullif(btrim(source_text), '') is null then 'pending'
      else 'finalized'
    end,
    translation_status = case
      when nullif(btrim(translated_text), '') is null then 'pending'
      else 'finalized'
    end;

alter table public.subtitle_cues
  drop constraint if exists subtitle_cues_source_status_check,
  add constraint subtitle_cues_source_status_check
    check (source_status in ('pending', 'finalized', 'unavailable')),
  drop constraint if exists subtitle_cues_translation_status_check,
  add constraint subtitle_cues_translation_status_check
    check (translation_status in ('pending', 'finalized', 'unavailable')),
  drop constraint if exists subtitle_cues_has_stable_text_check,
  add constraint subtitle_cues_has_stable_text_check
    check (
      nullif(btrim(source_text), '') is not null
      or nullif(btrim(translated_text), '') is not null
    );
