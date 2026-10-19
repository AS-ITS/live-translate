-- Run against local Supabase with ON_ERROR_STOP=1. All fixture writes roll back.
begin;

insert into auth.users(id, email)
values ('11111111-1111-4111-8111-111111111111', 'recover-rls@example.test');

insert into public.meetings(
  id, owner_user_id, name, source_language_code, target_language_code,
  status, lifecycle_contract_version
) values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'recover-rls', 'zh-Hant', 'en', 'active', 1
);

insert into public.meeting_segments(
  id, owner_user_id, meeting_id, sequence, status, live_session_id,
  lifecycle_contract_version
) values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  0, 'active', 'old-provider-session', 1
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

-- The first nonempty checkpoint write requires the controlled writer.
do $$ begin
  begin
    update public.meeting_segments
    set checkpoint = '{"idempotencyKey":"checkpoint-probe"}'
    where id = '33333333-3333-4333-8333-333333333333';
    raise exception 'authenticated checkpoint write unexpectedly succeeded' using errcode = 'ZX001';
  exception when insufficient_privilege or sqlstate 'P0042' then null; end;
end $$;

reset role;
set local role service_role;
select public.apply_meeting_checkpoint_operation_v2(
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  0, 'checkpoint-probe', 'payload-probe',
  '{"revision":1,"idempotencyKey":"checkpoint-probe","_operationPayloads":{"checkpoint-probe":"payload-probe"},"finalCues":[]}'::jsonb,
  '[]'::jsonb, 'active', null, null
);
reset role;
set local role authenticated;

update public.meeting_segments
set status = 'interrupted', ended_at = now()
where id = '33333333-3333-4333-8333-333333333333';

insert into public.meeting_segments(
  id, owner_user_id, meeting_id, sequence, status, live_session_id,
  lifecycle_contract_version
) values (
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  1, 'active', 'next-provider-session', 1
);

do $$
begin
  if (select count(*) from public.meeting_segments
      where meeting_id = '22222222-2222-4222-8222-222222222222') <> 2 then
    raise exception 'recover did not persist both segments';
  end if;
end;
$$;

reset role;
insert into public.meeting_deletions(meeting_id, owner_user_id, state)
values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'deleting'
);
set local role authenticated;

do $$
begin
  begin
    update public.meeting_segments
    set checkpoint = '{"idempotencyKey":"must-not-write"}'
    where id = '44444444-4444-4444-8444-444444444444';
    if found then
      raise exception 'deletion marker allowed a segment write' using errcode = 'ZX001';
    end if;
  exception when sqlstate 'P0001' or insufficient_privilege then
    null;
  end;
end;
$$;

rollback;
