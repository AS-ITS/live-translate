-- Issue #31 P3-A: private meeting audio and persisted final-cue Realtime.

alter table public.subtitle_cues
  add column if not exists segment_id uuid;

update public.subtitle_cues cue
set segment_id = session.segment_id
from public.sessions session
where cue.owner_user_id = session.owner_user_id
  and cue.session_id = session.id
  and cue.segment_id is null;

alter table public.subtitle_cues
  drop constraint if exists subtitle_cues_owner_user_id_segment_id_fkey,
  add constraint subtitle_cues_owner_user_id_segment_id_fkey
    foreign key (owner_user_id, segment_id)
    references public.meeting_segments(owner_user_id, id)
    on delete cascade;

alter table public.audio_artifacts
  add column if not exists segment_id uuid,
  add column if not exists file_name text,
  add column if not exists byte_size bigint,
  add column if not exists mime_type text,
  add column if not exists status text not null default 'uploading',
  add column if not exists updated_at timestamptz not null default now();

alter table public.audio_artifacts
  drop constraint if exists audio_artifacts_owner_user_id_segment_id_fkey,
  add constraint audio_artifacts_owner_user_id_segment_id_fkey
    foreign key (owner_user_id, segment_id)
    references public.meeting_segments(owner_user_id, id)
    on delete cascade,
  drop constraint if exists audio_artifacts_status_check,
  add constraint audio_artifacts_status_check
    check (status in ('uploading', 'ready', 'failed')),
  drop constraint if exists audio_artifacts_byte_size_check,
  add constraint audio_artifacts_byte_size_check
    check (byte_size is null or byte_size between 1 and 67108864),
  drop constraint if exists audio_artifacts_source_webm_check,
  add constraint audio_artifacts_source_webm_check
    check (
      kind <> 'source_webm'
      or (
        segment_id is not null
        and mime_type in ('audio/webm', 'audio/webm;codecs=opus')
      )
    );

create unique index if not exists audio_artifacts_owner_segment_kind_key
  on public.audio_artifacts(owner_user_id, segment_id, kind)
  where segment_id is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meeting-audio',
  'meeting-audio',
  false,
  67108864,
  array['audio/webm', 'audio/webm;codecs=opus']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists meeting_audio_owner_insert on storage.objects;
create policy meeting_audio_owner_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'meeting-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
  and storage.filename(name) = 'recording.webm'
  and exists (
    select 1
    from public.meeting_segments segment
    where segment.owner_user_id = auth.uid()
      and segment.meeting_id::text = (storage.foldername(name))[2]
      and segment.id::text = (storage.foldername(name))[3]
  )
);

drop policy if exists meeting_audio_owner_select on storage.objects;
create policy meeting_audio_owner_select
on storage.objects for select to authenticated
using (
  bucket_id = 'meeting-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
  and storage.filename(name) = 'recording.webm'
  and exists (
    select 1
    from public.meeting_segments segment
    where segment.owner_user_id = auth.uid()
      and segment.meeting_id::text = (storage.foldername(name))[2]
      and segment.id::text = (storage.foldername(name))[3]
  )
);

drop policy if exists meeting_audio_owner_update on storage.objects;
create policy meeting_audio_owner_update
on storage.objects for update to authenticated
using (
  bucket_id = 'meeting-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'meeting-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
  and storage.filename(name) = 'recording.webm'
  and exists (
    select 1
    from public.meeting_segments segment
    where segment.owner_user_id = auth.uid()
      and segment.meeting_id::text = (storage.foldername(name))[2]
      and segment.id::text = (storage.foldername(name))[3]
  )
);

alter table public.viewer_shares
  add column if not exists role text not null default 'viewer',
  add column if not exists short_code text,
  add column if not exists session_id uuid,
  add column if not exists resource_type text not null default 'meeting';

alter table public.viewer_shares
  drop constraint if exists viewer_shares_role_check,
  add constraint viewer_shares_role_check check (role in ('viewer', 'recorder')),
  drop constraint if exists viewer_shares_resource_type_check,
  add constraint viewer_shares_resource_type_check check (resource_type in ('meeting', 'session')),
  drop constraint if exists viewer_shares_owner_user_id_session_id_fkey,
  add constraint viewer_shares_owner_user_id_session_id_fkey
    foreign key (owner_user_id, session_id)
    references public.sessions(owner_user_id, id)
    on delete cascade;

create or replace function public.is_active_realtime_viewer(
  requested_share_id uuid,
  requested_meeting_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.viewer_shares share
    where share.id = requested_share_id
      and share.meeting_id = requested_meeting_id
      and share.role = 'viewer'
      and share.revoked_at is null
      and (share.expires_at is null or share.expires_at > now())
  );
$$;

revoke all on function public.is_active_realtime_viewer(uuid, uuid) from public;
grant execute on function public.is_active_realtime_viewer(uuid, uuid) to authenticated;

drop policy if exists meeting_viewer_receive on realtime.messages;
create policy meeting_viewer_receive
on realtime.messages for select to authenticated
using (
  realtime.topic() = 'meeting:' || (current_setting('request.jwt.claims', true)::jsonb ->> 'meeting_id')
  and public.is_active_realtime_viewer(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'viewer_share_id')::uuid,
    (current_setting('request.jwt.claims', true)::jsonb ->> 'meeting_id')::uuid
  )
);

create or replace function public.broadcast_final_subtitle_cue()
returns trigger
language plpgsql
security definer
set search_path = public, realtime
as $$
declare
  meeting_record_id uuid;
  segment_order integer;
begin
  if tg_op = 'UPDATE' and new is not distinct from old then
    return null;
  end if;

  select segment.meeting_id, segment.sequence
  into meeting_record_id, segment_order
  from public.meeting_segments segment
  where segment.owner_user_id = new.owner_user_id
    and segment.id = new.segment_id;

  if meeting_record_id is null then
    return null;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'type', 'cue.append',
      'meetingId', meeting_record_id,
      'segmentId', new.segment_id,
      'segmentSequence', segment_order,
      'committedAt', floor(extract(epoch from clock_timestamp()) * 1000),
      'cue', jsonb_build_object(
        'cueId', new.id,
        'sessionId', new.session_id,
        'segmentId', new.segment_id,
        'sequence', new.sequence,
        'status', 'final',
        'sourceText', new.source_text,
        'translatedText', coalesce(new.translated_text, ''),
        'sourceVersion', new.source_version,
        'translationVersion', new.translation_version,
        'startTimeMs', new.started_at,
        'endTimeMs', new.ended_at
      )
    ),
    'cue.append',
    'meeting:' || meeting_record_id::text,
    true
  );

  return null;
end;
$$;

drop trigger if exists subtitle_cues_realtime_broadcast on public.subtitle_cues;
create trigger subtitle_cues_realtime_broadcast
after insert or update on public.subtitle_cues
for each row execute function public.broadcast_final_subtitle_cue();
