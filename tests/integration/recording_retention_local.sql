-- Run only against local Supabase: psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f this-file
-- All fixture writes roll back. Deadlines are moved under a disabled trigger in
-- this disposable transaction; no 30-minute wall-clock wait is required.
begin;
insert into auth.users(id, email) values
  ('10101010-1010-4010-8010-101010101010', 'retention-owner@example.test'),
  ('20202020-2020-4020-8020-202020202020', 'retention-other@example.test');
insert into public.meetings(id, owner_user_id, name, source_language_code, target_language_code, status)
values
  ('30303030-3030-4030-8030-303030303030', '10101010-1010-4010-8010-101010101010', 'due', 'en', 'zh-TW', 'created'),
  ('40404040-4040-4040-8040-404040404040', '10101010-1010-4010-8010-101010101010', 'ongoing', 'en', 'zh-TW', 'created');
insert into public.meeting_segments(id, owner_user_id, meeting_id, sequence)
values
  ('50505050-5050-4050-8050-505050505050', '10101010-1010-4010-8010-101010101010', '30303030-3030-4030-8030-303030303030', 1),
  ('60606060-6060-4060-8060-606060606060', '10101010-1010-4010-8010-101010101010', '40404040-4040-4040-8040-404040404040', 1);
insert into storage.objects(bucket_id, name, owner_id)
values ('meeting-audio',
  '10101010-1010-4010-8010-101010101010/30303030-3030-4030-8030-303030303030/50505050-5050-4050-8050-505050505050/recording.webm',
  '10101010-1010-4010-8010-101010101010');
insert into public.sessions(id, owner_user_id, meeting_id, segment_id, target_language_code)
values
  ('70707070-7070-4070-8070-707070707070', '10101010-1010-4010-8010-101010101010', '30303030-3030-4030-8030-303030303030', '50505050-5050-4050-8050-505050505050', 'zh-TW'),
  ('80808080-8080-4080-8080-808080808080', '10101010-1010-4010-8010-101010101010', '40404040-4040-4040-8040-404040404040', '60606060-6060-4060-8060-606060606060', 'zh-TW');
insert into public.meeting_segments(id, owner_user_id, meeting_id, sequence)
values ('90909090-9090-4090-8090-909090909090', '10101010-1010-4010-8010-101010101010', '30303030-3030-4030-8030-303030303030', 2);
insert into public.sessions(id, owner_user_id, meeting_id, segment_id, target_language_code)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10101010-1010-4010-8010-101010101010', '30303030-3030-4030-8030-303030303030', '90909090-9090-4090-8090-909090909090', 'zh-TW');
update public.meeting_segments set checkpoint = '{"secret":"cue"}'::jsonb
  where id = '50505050-5050-4050-8050-505050505050';
update public.sessions set payload = '{"secret":"session"}'::jsonb,
  transcript_items = '[{"source":"speech"}]'::jsonb
  where id = '70707070-7070-4070-8070-707070707070';
do $$ begin
  if (select count(distinct recording_id) from public.sessions where meeting_id = '30303030-3030-4030-8030-303030303030') <> 1 then
    raise exception 'rollover created multiple recording identities';
  end if;
  if (select count(*) from public.meeting_recordings where meeting_id = '30303030-3030-4030-8030-303030303030' and expires_at is not null) <> 0 then
    raise exception 'recording began retention before successful completion';
  end if;
end $$;
update public.meetings set status = 'completed' where id = '30303030-3030-4030-8030-303030303030';
do $$ begin
  if (select extract(epoch from (purge_at - ended_at)) from public.meetings where id = '30303030-3030-4030-8030-303030303030') <> 1800 then
    raise exception 'meeting deadline was not DB time plus 30 minutes';
  end if;
end $$;
update public.meetings set ended_at = '2000-01-01', purge_at = '2000-01-01'
  where id = '30303030-3030-4030-8030-303030303030';
do $$ begin
  if (select extract(epoch from (purge_at - ended_at)) from public.meetings where id = '30303030-3030-4030-8030-303030303030') <> 1800 then
    raise exception 'repeated completion extended or changed deadline';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '10101010-1010-4010-8010-101010101010', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.sessions where meeting_id = '30303030-3030-4030-8030-303030303030') <> 2 then
    raise exception 'content unavailable before expiry';
  end if;
  if (select count(*) from storage.objects where bucket_id = 'meeting-audio' and name like '%30303030%') <> 1 then
    raise exception 'Storage object unavailable before expiry';
  end if;
end $$;
reset role;

set local session_replication_role = replica;
update public.meetings set purge_at = clock_timestamp() - interval '1 second'
  where id = '30303030-3030-4030-8030-303030303030';
set local session_replication_role = origin;
do $$ begin
  begin
    insert into storage.objects(bucket_id, name, owner_id) values
      ('meeting-audio',
       '10101010-1010-4010-8010-101010101010/30303030-3030-4030-8030-303030303030/50505050-5050-4050-8050-505050505050/late.webm',
       '10101010-1010-4010-8010-101010101010');
    raise exception 'service-role Storage write accepted after expiry' using errcode = 'ZX001';
  exception when sqlstate 'P0001' then null;
  end;
end $$;
set local role authenticated;
do $$ begin
  if (select count(*) from public.sessions where meeting_id = '30303030-3030-4030-8030-303030303030') <> 0 then
    raise exception 'expired Session still directly visible';
  end if;
  if (select count(*) from public.sessions where meeting_id = '40404040-4040-4040-8040-404040404040') <> 1 then
    raise exception 'other active Meeting was affected';
  end if;
  if (select count(*) from storage.objects where bucket_id = 'meeting-audio' and name like '%30303030%') <> 0 then
    raise exception 'expired Storage object still directly visible';
  end if;
  if (select count(*) from public.meetings where id = '30303030-3030-4030-8030-303030303030') <> 1 then
    raise exception 'expired Meeting settings disappeared';
  end if;
  begin
    insert into public.subtitle_cues(id, owner_user_id, session_id, segment_id, sequence, source_text)
    values ('late-cue', '10101010-1010-4010-8010-101010101010',
      '70707070-7070-4070-8070-707070707070', '50505050-5050-4050-8050-505050505050', 1, 'late');
    raise exception 'late cue was accepted' using errcode = 'ZX001';
  exception when sqlstate '42501' or sqlstate 'P0001' then null;
  end;
end $$;
reset role;

with fixed as (select clock_timestamp() - interval '31 minutes' as ended_at)
update public.meeting_recordings r set ended_at = fixed.ended_at,
  expires_at = fixed.ended_at + interval '30 minutes', cleanup_state = 'pending'
from fixed where r.meeting_id = '30303030-3030-4030-8030-303030303030';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
begin
  if (select count(*) from public.claim_due_recording_cleanup('integration-worker')) <> 0 then
    raise exception 'automatic recording cleanup claim remained enabled';
  end if;
  if (select count(*) from public.sessions where meeting_id = '30303030-3030-4030-8030-303030303030') <> 2 then
    raise exception 'expired Session rows were physically removed before manual deletion';
  end if;
  if (select checkpoint from public.meeting_segments where id = '50505050-5050-4050-8050-505050505050') = '{}'::jsonb then
    raise exception 'expired segment checkpoint was cleared before manual deletion';
  end if;
end $$;
reset role;
rollback;
