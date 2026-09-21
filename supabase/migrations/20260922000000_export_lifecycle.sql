alter table public.export_artifacts
  add column if not exists stream text not null default 'translation',
  add column if not exists source_hash text not null default '',
  add column if not exists status text not null default 'queued',
  add column if not exists file_name text,
  add column if not exists mime_type text,
  add column if not exists byte_size bigint,
  add column if not exists error_code text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz,
  add column if not exists attempt integer not null default 0;

alter table public.export_artifacts
  drop constraint if exists export_artifacts_format_check,
  drop constraint if exists export_artifacts_stream_check,
  drop constraint if exists export_artifacts_status_check;

alter table public.export_artifacts
  add constraint export_artifacts_format_check check (format in ('txt', 'srt', 'vtt')),
  add constraint export_artifacts_stream_check check (stream in ('source', 'translation', 'both')),
  add constraint export_artifacts_status_check check (status in ('queued', 'processing', 'ready', 'failed', 'stale')),
  add constraint export_artifacts_source_format_stream_key unique (owner_user_id, meeting_id, source_hash, format, stream);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meeting-exports',
  'meeting-exports',
  false,
  67108864,
  array['text/plain', 'application/x-subrip', 'text/vtt']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists meeting_exports_owner_select on storage.objects;
create policy meeting_exports_owner_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'meeting-exports'
    and exists (
      select 1 from public.export_artifacts artifact
      where artifact.owner_user_id = auth.uid()
        and artifact.storage_path = name
    )
  );

drop policy if exists meeting_exports_owner_insert on storage.objects;
create policy meeting_exports_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'meeting-exports'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.export_artifacts artifact
      where artifact.owner_user_id = auth.uid()
        and artifact.storage_path = name
    )
  );

drop policy if exists meeting_exports_owner_update on storage.objects;
create policy meeting_exports_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'meeting-exports' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'meeting-exports' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists meeting_exports_owner_delete on storage.objects;
create policy meeting_exports_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'meeting-exports'
    and exists (
      select 1 from public.export_artifacts artifact
      where artifact.owner_user_id = auth.uid()
        and artifact.storage_path = name
    )
  );

select pgmq.create('export_jobs');
