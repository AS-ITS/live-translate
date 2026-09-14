-- MP3 is a derived per-segment artifact. WebM remains the source of truth.
alter table public.audio_artifacts add column if not exists attempt integer not null default 0;
alter table public.audio_artifacts add column if not exists error_code text;
alter table public.audio_artifacts add column if not exists file_name text;
alter table public.audio_artifacts add column if not exists byte_size bigint;
alter table public.audio_artifacts add column if not exists mime_type text;
alter table public.audio_artifacts add column if not exists status text not null default 'queued';
create unique index if not exists audio_artifacts_one_mp3_per_segment on public.audio_artifacts(owner_user_id, segment_id, kind) where kind = 'mp3' and segment_id is not null;
update storage.buckets set allowed_mime_types = array['audio/webm', 'audio/webm;codecs=opus', 'audio/mpeg'] where id = 'meeting-audio';
drop policy if exists meeting_audio_owner_mp3_insert on storage.objects;
create policy meeting_audio_owner_mp3_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'meeting-audio' and (storage.foldername(name))[1] = auth.uid()::text
  and storage.filename(name) = 'recording.mp3'
  and exists (select 1 from public.audio_artifacts artifact where artifact.owner_user_id = auth.uid() and artifact.kind = 'mp3' and artifact.storage_path = name and artifact.status in ('queued', 'processing'))
);
