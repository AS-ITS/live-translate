-- Issue #35 P3/P5: enforce active member read and recording scope in RLS.
-- Owner-only policies from the cloud foundation migration remain unchanged.

create or replace function public.is_active_meeting_member(
  requested_owner_user_id uuid,
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
    from public.meeting_members member
    join public.profiles profile on profile.id = member.user_id
    where member.owner_user_id = requested_owner_user_id
      and member.meeting_id = requested_meeting_id
      and member.user_id = auth.uid()
      and profile.status = 'active'
  );
$$;

create or replace function public.can_record_meeting(
  requested_owner_user_id uuid,
  requested_meeting_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select requested_owner_user_id = auth.uid()
    or public.is_super_admin()
    or exists (
      select 1
      from public.meeting_members member
      join public.profiles profile on profile.id = member.user_id
      where member.owner_user_id = requested_owner_user_id
        and member.meeting_id = requested_meeting_id
        and member.user_id = auth.uid()
        and member.can_record = true
        and profile.status = 'active'
    );
$$;

revoke all on function public.is_active_meeting_member(uuid, uuid) from public, anon;
revoke all on function public.can_record_meeting(uuid, uuid) from public, anon;
grant execute on function public.is_active_meeting_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.can_record_meeting(uuid, uuid) to authenticated, service_role;

create index if not exists meeting_members_owner_meeting_user_idx
  on public.meeting_members(owner_user_id, meeting_id, user_id);

create index if not exists meeting_segments_owner_meeting_idx
  on public.meeting_segments(owner_user_id, meeting_id, sequence);

create index if not exists sessions_owner_meeting_idx
  on public.sessions(owner_user_id, meeting_id, created_at);

create index if not exists subtitle_cues_owner_segment_idx
  on public.subtitle_cues(owner_user_id, segment_id, sequence);

create policy meetings_member_select
  on public.meetings
  for select
  to authenticated
  using (
    public.is_active_meeting_member(owner_user_id, id)
    or public.is_super_admin()
  );

create policy meeting_segments_member_select
  on public.meeting_segments
  for select
  to authenticated
  using (
    public.is_active_meeting_member(owner_user_id, meeting_id)
    or public.is_super_admin()
  );

create policy meeting_segments_record_insert
  on public.meeting_segments
  for insert
  to authenticated
  with check (
    public.can_record_meeting(owner_user_id, meeting_id)
  );

create policy meeting_segments_record_update
  on public.meeting_segments
  for update
  to authenticated
  using (
    public.can_record_meeting(owner_user_id, meeting_id)
  )
  with check (
    public.can_record_meeting(owner_user_id, meeting_id)
  );

create policy sessions_member_select
  on public.sessions
  for select
  to authenticated
  using (
    public.is_active_meeting_member(owner_user_id, meeting_id)
    or public.is_super_admin()
  );

create policy sessions_record_insert
  on public.sessions
  for insert
  to authenticated
  with check (
    public.can_record_meeting(owner_user_id, meeting_id)
  );

create policy sessions_record_update
  on public.sessions
  for update
  to authenticated
  using (
    public.can_record_meeting(owner_user_id, meeting_id)
  )
  with check (
    public.can_record_meeting(owner_user_id, meeting_id)
  );

create policy subtitle_cues_member_select
  on public.subtitle_cues
  for select
  to authenticated
  using (
    public.is_super_admin()
    or exists (
      select 1
      from public.meeting_segments segment
      where segment.owner_user_id = subtitle_cues.owner_user_id
        and segment.id = subtitle_cues.segment_id
        and public.is_active_meeting_member(segment.owner_user_id, segment.meeting_id)
    )
  );

create policy subtitle_cues_record_insert
  on public.subtitle_cues
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.meeting_segments segment
      where segment.owner_user_id = subtitle_cues.owner_user_id
        and segment.id = subtitle_cues.segment_id
        and public.can_record_meeting(segment.owner_user_id, segment.meeting_id)
    )
  );

create policy subtitle_cues_record_update
  on public.subtitle_cues
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.meeting_segments segment
      where segment.owner_user_id = subtitle_cues.owner_user_id
        and segment.id = subtitle_cues.segment_id
        and public.can_record_meeting(segment.owner_user_id, segment.meeting_id)
    )
  )
  with check (
    exists (
      select 1
      from public.meeting_segments segment
      where segment.owner_user_id = subtitle_cues.owner_user_id
        and segment.id = subtitle_cues.segment_id
        and public.can_record_meeting(segment.owner_user_id, segment.meeting_id)
    )
  );

create policy audio_artifacts_member_select
  on public.audio_artifacts
  for select
  to authenticated
  using (
    public.is_active_meeting_member(owner_user_id, meeting_id)
    or public.is_super_admin()
  );

create policy audio_artifacts_record_insert
  on public.audio_artifacts
  for insert
  to authenticated
  with check (
    public.can_record_meeting(owner_user_id, meeting_id)
  );

create policy audio_artifacts_record_update
  on public.audio_artifacts
  for update
  to authenticated
  using (
    public.can_record_meeting(owner_user_id, meeting_id)
  )
  with check (
    public.can_record_meeting(owner_user_id, meeting_id)
  );
