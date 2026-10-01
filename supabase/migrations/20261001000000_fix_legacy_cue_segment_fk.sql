-- Preserve lifecycle-v1 Cue writes after lifecycle-v2 introduced segment-owned
-- Sessions. Both contracts already have independent owner-scoped Session and
-- Segment foreign keys; this named Segment relationship is also used by the
-- PostgREST Viewer join.

alter table public.subtitle_cues
  drop constraint if exists subtitle_cues_session_segment_relationship_fkey,
  add constraint subtitle_cues_session_segment_relationship_fkey
    foreign key (owner_user_id, segment_id)
    references public.meeting_segments(owner_user_id, id)
    on delete cascade
    not valid;
