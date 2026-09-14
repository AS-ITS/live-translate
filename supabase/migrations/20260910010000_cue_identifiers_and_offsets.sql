-- Cue ids are deterministic application keys, and cue times are media offsets.
alter table public.translation_requests
  drop constraint if exists translation_requests_owner_user_id_cue_id_fkey;

alter table public.translation_requests
  alter column cue_id type text using cue_id::text;

alter table public.subtitle_cues
  alter column id type text using id::text,
  alter column started_at type bigint using (
    case when started_at is null then null else floor(extract(epoch from started_at) * 1000)::bigint end
  ),
  alter column ended_at type bigint using (
    case when ended_at is null then null else floor(extract(epoch from ended_at) * 1000)::bigint end
  );

alter table public.translation_requests
  add constraint translation_requests_owner_user_id_cue_id_fkey
  foreign key (owner_user_id, cue_id)
  references public.subtitle_cues(owner_user_id, id)
  on delete cascade;
