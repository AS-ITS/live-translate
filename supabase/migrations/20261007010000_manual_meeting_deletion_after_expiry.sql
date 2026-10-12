-- Expiry hides recording content from ordinary users and Viewer shares. Physical
-- cleanup is now an explicit super-admin deletion action, never a timer.

create or replace function public.claim_due_recording_cleanup(p_worker text)
returns table(recording_id uuid, meeting_id uuid, owner_user_id uuid, phase text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'auth_forbidden' using errcode = '42501';
  end if;
  return;
end;
$$;

create or replace function public.claim_due_meeting_purges(
  p_worker_id text,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'auth_forbidden' using errcode = '42501';
  end if;
  return '[]'::jsonb;
end;
$$;

comment on function public.claim_due_recording_cleanup(text) is
  'Deprecated no-op: expired Meeting content is deleted only by explicit authorized Meeting deletion.';
comment on function public.claim_due_meeting_purges(text, integer) is
  'Deprecated no-op: expired Meetings remain visible to super_admin until explicit deletion.';
