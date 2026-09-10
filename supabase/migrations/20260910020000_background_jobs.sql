-- Issue #31 P4: durable background work. Messages contain identifiers only.
create schema if not exists pgmq;
create extension if not exists pgmq with schema pgmq;
select pgmq.create('translation_jobs');
select pgmq.create('mp3_jobs');

create table if not exists public.background_job_dead_letters (
  id bigint generated always as identity primary key,
  queue_name text not null,
  message_id bigint not null,
  message jsonb not null,
  attempt integer not null default 1,
  error_code text not null,
  archived_at timestamptz not null default now(),
  unique(queue_name, message_id)
);

alter table public.background_job_dead_letters enable row level security;
revoke all on public.background_job_dead_letters from anon, authenticated;
grant all on public.background_job_dead_letters to service_role;

create or replace function public.background_job_enqueue(queue_name text, message jsonb)
returns bigint language sql security definer set search_path = public, pgmq as $$
  select pgmq.send(queue_name, message);
$$;

drop function if exists public.background_job_claim(text, integer, integer);
create function public.background_job_claim(queue_name text, visibility_timeout integer, quantity integer)
returns setof pgmq.message_record
language sql security definer set search_path = public, pgmq as $$
  select * from pgmq.read(queue_name, visibility_timeout, quantity);
$$;

create or replace function public.background_job_renew(queue_name text, message_id bigint, read_ct bigint, visibility_timeout integer)
returns boolean language sql security definer set search_path = public, pgmq as $$
  select (pgmq.set_vt(queue_name, message_id, visibility_timeout) is not null);
$$;

create or replace function public.background_job_acknowledge(queue_name text, message_id bigint, read_ct bigint)
returns boolean language sql security definer set search_path = public, pgmq as $$
  select pgmq.delete(queue_name, message_id);
$$;

create or replace function public.background_job_retry(queue_name text, message_id bigint, read_ct bigint, attempt integer, error_code text)
returns boolean language sql security definer set search_path = public, pgmq as $$
  select (pgmq.set_vt(queue_name, message_id, least(60 * greatest(attempt, 1), 3600)) is not null);
$$;

create or replace function public.background_job_archive(queue_name text, message_id bigint, read_ct bigint, attempt integer, error_code text, message jsonb)
returns boolean language plpgsql security definer set search_path = public, pgmq as $$
declare archived boolean;
begin
  insert into public.background_job_dead_letters(queue_name, message_id, message, attempt, error_code)
  values (queue_name, message_id, coalesce(message, '{}'::jsonb), greatest(attempt, 1), coalesce(error_code, 'background_job_retry_exhausted'))
  on conflict (queue_name, message_id) do nothing;
  archived := pgmq.archive(queue_name, message_id);
  return archived;
end;
$$;

create or replace function public.background_job_depth(queue_name text)
returns bigint language sql security definer set search_path = public, pgmq as $$
  select 0::bigint;
$$;

grant execute on function public.background_job_enqueue(text, jsonb) to service_role;
grant execute on function public.background_job_claim(text, integer, integer) to service_role;
grant execute on function public.background_job_renew(text, bigint, bigint, integer) to service_role;
grant execute on function public.background_job_acknowledge(text, bigint, bigint) to service_role;
grant execute on function public.background_job_retry(text, bigint, bigint, integer, text) to service_role;
grant execute on function public.background_job_archive(text, bigint, bigint, integer, text, jsonb) to service_role;
grant execute on function public.background_job_depth(text) to service_role;

create or replace function public.enqueue_translation_job() returns trigger
language plpgsql security definer set search_path = public, pgmq as $$
begin
  if new.status = 'queued' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform pgmq.send('translation_jobs', jsonb_build_object(
      'ownerUserId', new.owner_user_id, 'executionId', new.id,
      'requestId', new.translation_request_id
    ));
  end if;
  return new;
end;
$$;
drop trigger if exists translation_execution_background_job on public.translation_executions;
create trigger translation_execution_background_job
after insert or update of status on public.translation_executions
for each row execute function public.enqueue_translation_job();

create or replace function public.enqueue_mp3_job() returns trigger
language plpgsql security definer set search_path = public, pgmq as $$
begin
  if new.kind = 'source_webm' and new.status = 'ready' and new.segment_id is not null and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform pgmq.send('mp3_jobs', jsonb_build_object(
      'ownerUserId', new.owner_user_id, 'artifactId', new.id,
      'segmentId', new.segment_id, 'kind', 'mp3'
    ));
  end if;
  return new;
end;
$$;
drop trigger if exists source_webm_mp3_background_job on public.audio_artifacts;
create trigger source_webm_mp3_background_job
after insert or update of status on public.audio_artifacts
for each row execute function public.enqueue_mp3_job();
