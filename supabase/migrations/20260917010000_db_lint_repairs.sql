-- Keep the background job archive RPC unambiguous for Supabase DB lint.
drop function if exists public.background_job_archive(text, bigint, bigint, integer, text, jsonb);

create function public.background_job_archive(
  p_queue_name text,
  p_message_id bigint,
  p_read_ct bigint,
  p_attempt integer,
  p_error_code text,
  p_message jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  archived boolean;
begin
  insert into public.background_job_dead_letters
    (queue_name, message_id, message, attempt, error_code)
  values
    (p_queue_name, p_message_id, coalesce(p_message, '{}'::jsonb), greatest(p_attempt, 1), coalesce(p_error_code, 'background_job_retry_exhausted'))
  on conflict (queue_name, message_id) do nothing;
  archived := pgmq.archive(p_queue_name, p_message_id);
  return archived;
end;
$$;
