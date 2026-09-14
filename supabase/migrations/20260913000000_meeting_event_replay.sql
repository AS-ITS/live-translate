-- Durable, owner-scoped Meeting Cue event history for cross-instance Viewer replay.
create table if not exists public.meeting_events (
  event_id bigint generated always as identity primary key,
  id uuid not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  meeting_id uuid not null,
  segment_id uuid,
  event_key text not null,
  event_type text not null check (event_type in ('cue.append')),
  cue_id uuid not null,
  cue_sequence integer not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  unique (owner_user_id, id),
  unique (owner_user_id, meeting_id, event_key),
  foreign key (owner_user_id, meeting_id) references public.meetings(owner_user_id, id) on delete cascade,
  foreign key (owner_user_id, segment_id) references public.meeting_segments(owner_user_id, id) on delete cascade
);
create index if not exists meeting_events_cursor_idx on public.meeting_events(owner_user_id, meeting_id, event_id);
alter table public.meeting_events enable row level security;
revoke all on public.meeting_events from anon, authenticated;
grant all on public.meeting_events to service_role;
grant usage, select on sequence public.meeting_events_event_id_seq to service_role;

create or replace function public.broadcast_meeting_event()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform realtime.send(jsonb_build_object(
    'eventId', new.event_id,
    'eventType', new.event_type,
    'type', new.event_type,
    'meetingId', new.meeting_id,
    'segmentId', new.segment_id,
    'cueId', new.cue_id,
    'cueSequence', new.cue_sequence,
    'occurredAt', new.occurred_at,
    'committedAt', floor(extract(epoch from new.occurred_at) * 1000),
    'cue', new.payload
  ), new.event_type, 'meeting:' || new.meeting_id::text, true);
  return new;
end;
$$;
drop trigger if exists meeting_events_realtime_broadcast on public.meeting_events;
create trigger meeting_events_realtime_broadcast after insert on public.meeting_events
for each row execute function public.broadcast_meeting_event();

-- The old cue trigger would publish the same cue without a durable cursor.
drop trigger if exists subtitle_cues_realtime_broadcast on public.subtitle_cues;
