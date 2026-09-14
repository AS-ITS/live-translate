-- Issue #33: server-only audit records and atomic account transfer.
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id),
  action text not null check (action in ('member_invited', 'member_removed', 'user_enabled', 'user_disabled', 'asset_transfer')),
  target_user_id uuid references auth.users(id),
  target_meeting_id uuid references public.meetings(id),
  request_id text,
  result text not null check (result in ('success', 'failure')),
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant all on public.audit_logs to service_role;

do $$
declare constraint_row record;
begin
  for constraint_row in
    select n.nspname as schema_name, c.relname as table_name, con.conname
    from pg_constraint con join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and con.contype = 'f'
      and c.relname in ('meeting_members','meetings','meeting_segments','sessions','subtitle_cues',
        'translation_requests','translation_executions','translation_outputs','glossary_categories',
        'glossary_entries','meeting_glossary_entries','meeting_summaries','audio_artifacts',
        'export_artifacts','viewer_shares','translation_queue_items','translation_dead_letter_items',
        'recorder_leases','meeting_events')
  loop
    begin
      execute format('alter table %I.%I alter constraint %I deferrable initially deferred', constraint_row.schema_name, constraint_row.table_name, constraint_row.conname);
    exception when others then null;
    end;
  end loop;
end $$;

create or replace function public.disable_user_with_transfer(target_user_id uuid, transfer_to_user_id uuid)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare source_profile public.profiles; target_profile public.profiles; active_admin_count integer;
begin
  if target_user_id is null or transfer_to_user_id is null or target_user_id = transfer_to_user_id then
    raise exception using errcode = '22023', message = 'A distinct transfer target is required.';
  end if;
  select * into source_profile from public.profiles where id = target_user_id for update;
  if source_profile.id is null then raise exception using errcode = 'P0002', message = 'Account not found.'; end if;
  select * into target_profile from public.profiles where id = transfer_to_user_id for update;
  if target_profile.id is null or target_profile.status <> 'active' then raise exception using errcode = '22023', message = 'Transfer target must be active.'; end if;
  if source_profile.role = 'super_admin' and source_profile.status = 'active' then
    select count(*) into active_admin_count from public.profiles where role = 'super_admin' and status = 'active';
    if active_admin_count <= 1 then raise exception using errcode = '22023', message = 'The last super admin cannot be disabled.'; end if;
  end if;
  update public.meeting_members set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meetings set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meeting_segments set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.sessions set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.subtitle_cues set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.translation_requests set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.translation_executions set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.translation_outputs set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.glossary_categories set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.glossary_entries set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meeting_glossary_entries set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meeting_summaries set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.audio_artifacts set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.export_artifacts set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.viewer_shares set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.translation_queue_items set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.translation_dead_letter_items set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.recorder_leases set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.meeting_events set owner_user_id = transfer_to_user_id where owner_user_id = target_user_id;
  update public.profiles set status = 'disabled', disabled_at = now(), updated_at = now() where id = target_user_id returning * into source_profile;
  return source_profile;
end; $$;

revoke all on function public.disable_user_with_transfer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.disable_user_with_transfer(uuid, uuid) to service_role;
