-- Local Supabase only. Fixtures and deletion roll back at the end.
begin;
insert into auth.users(id, email) values
  ('11111111-1111-4111-8111-111111111111', 'deletion-owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'deletion-other@example.test');
insert into public.meetings(id, owner_user_id, name, source_language_code, target_language_code, status)
values ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
  'completed deletion', 'en', 'zh-TW', 'created');
insert into public.meeting_segments(id, owner_user_id, meeting_id, sequence, status)
values ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333', 1, 'active');
insert into public.sessions(id, owner_user_id, meeting_id, segment_id, target_language_code, status)
values ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'zh-TW', 'active');
update public.meetings set status = 'completed' where id = '33333333-3333-4333-8333-333333333333';
insert into public.audit_logs(actor_user_id, action, target_meeting_id, result)
values ('11111111-1111-4111-8111-111111111111', 'member_invited',
  '33333333-3333-4333-8333-333333333333', 'success');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare result jsonb;
begin
  begin
    perform public.begin_meeting_deletion('33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222');
    raise exception 'unauthorized deletion accepted' using errcode = 'ZX001';
  exception when sqlstate '42501' then null;
  end;
  result := public.begin_meeting_deletion('33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111');
  if result->>'state' <> 'deleting' then raise exception 'delete marker not created'; end if;
  if not public.finish_meeting_deletion('33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111') then raise exception 'deletion failed'; end if;
  if (select count(*) from public.meetings where id = '33333333-3333-4333-8333-333333333333') <> 0 then
    raise exception 'meeting row remained';
  end if;
  if (select count(*) from public.audit_logs where target_meeting_id = '33333333-3333-4333-8333-333333333333') <> 1 then
    raise exception 'audit record was lost';
  end if;
  if (select state from public.meeting_deletions where meeting_id = '33333333-3333-4333-8333-333333333333') <> 'deleted' then
    raise exception 'protected tombstone missing';
  end if;
  result := public.begin_meeting_deletion('33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111');
  if result->>'state' <> 'deleted' then raise exception 'owner retry lost idempotence'; end if;
  begin
    perform public.begin_meeting_deletion('33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222');
    raise exception 'unauthorized retry accepted' using errcode = 'ZX001';
  exception when sqlstate '42501' then null;
  end;
end $$;
reset role;
rollback;
