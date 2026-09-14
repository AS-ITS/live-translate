-- P1-A: make durable translation queue ownership transitions atomic across
-- worker instances. The service-role worker calls these functions through RPC.

create or replace function public.translation_queue_claim(
  p_execution_id text,
  p_owner_user_id uuid,
  p_lease_id text,
  p_lease_expires_at timestamptz
)
returns setof public.translation_queue_items
language sql
security definer
set search_path = public
as $$
  update public.translation_queue_items
     set status = 'processing',
         lease_id = p_lease_id,
         lease_expires_at = p_lease_expires_at,
         fence_token = fence_token + 1
   where execution_id = p_execution_id
     and owner_user_id = p_owner_user_id
     and status = 'queued'
     and (available_at is null or available_at <= now())
  returning *;
$$;

create or replace function public.translation_queue_acknowledge_claim(
  p_execution_id text,
  p_owner_user_id uuid,
  p_lease_id text,
  p_fence_token integer
)
returns setof public.translation_queue_items
language sql
security definer
set search_path = public
as $$
  delete from public.translation_queue_items
   where execution_id = p_execution_id
     and owner_user_id = p_owner_user_id
     and status = 'processing'
     and lease_id = p_lease_id
     and fence_token = p_fence_token
  returning *;
$$;

create or replace function public.translation_queue_renew_claim(
  p_execution_id text,
  p_owner_user_id uuid,
  p_lease_id text,
  p_fence_token integer,
  p_lease_expires_at timestamptz,
  p_now timestamptz
)
returns setof public.translation_queue_items
language sql
security definer
set search_path = public
as $$
  update public.translation_queue_items
     set lease_expires_at = p_lease_expires_at
   where execution_id = p_execution_id
     and owner_user_id = p_owner_user_id
     and status = 'processing'
     and lease_id = p_lease_id
     and fence_token = p_fence_token
     and lease_expires_at > p_now
  returning *;
$$;

create or replace function public.translation_queue_requeue_expired(
  p_execution_id text,
  p_owner_user_id uuid,
  p_now timestamptz
)
returns setof public.translation_queue_items
language sql
security definer
set search_path = public
as $$
  update public.translation_queue_items
     set status = 'queued', lease_id = null, lease_expires_at = null,
         available_at = null
   where execution_id = p_execution_id
     and owner_user_id = p_owner_user_id
     and status = 'processing'
     and lease_expires_at <= p_now
  returning *;
$$;

revoke all on function public.translation_queue_claim(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.translation_queue_acknowledge_claim(text, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.translation_queue_renew_claim(text, uuid, text, integer, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.translation_queue_requeue_expired(text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.translation_queue_claim(text, uuid, text, timestamptz) to service_role;
grant execute on function public.translation_queue_acknowledge_claim(text, uuid, text, integer) to service_role;
grant execute on function public.translation_queue_renew_claim(text, uuid, text, integer, timestamptz, timestamptz) to service_role;
grant execute on function public.translation_queue_requeue_expired(text, uuid, timestamptz) to service_role;
