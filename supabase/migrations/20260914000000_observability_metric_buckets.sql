create table if not exists public.observability_metric_buckets (
  bucket_start timestamptz not null,
  instance_id text not null check (length(instance_id) between 1 and 128),
  metric_name text not null check (length(metric_name) between 1 and 128),
  provider text not null default 'none' check (provider in ('none', 'gemini')),
  status_class text not null default 'none' check (status_class in ('none', '200', '401', '403', '429', '5xx', 'other')),
  count bigint not null default 0 check (count >= 0),
  sum_value double precision not null default 0 check (sum_value >= 0),
  max_value double precision not null default 0 check (max_value >= 0),
  gauge_value double precision,
  primary key (bucket_start, instance_id, metric_name, provider, status_class)
);
create index if not exists observability_metric_buckets_query_idx on public.observability_metric_buckets(metric_name, bucket_start);
alter table public.observability_metric_buckets enable row level security;
revoke all on public.observability_metric_buckets from anon, authenticated;
grant all on public.observability_metric_buckets to service_role;

create or replace function public.record_observability_metric(
  p_bucket_start timestamptz, p_instance_id text default 'unknown', p_metric_name text default '',
  p_provider text default 'none', p_status_class text default 'none',
  p_count bigint default 0, p_sum_value double precision default 0, p_max_value double precision default 0,
  p_gauge_value double precision default null
) returns public.observability_metric_buckets language plpgsql security definer set search_path = public as $$
declare result public.observability_metric_buckets;
begin
  insert into public.observability_metric_buckets(bucket_start, instance_id, metric_name, provider, status_class, count, sum_value, max_value, gauge_value)
  values (date_trunc('minute', p_bucket_start), left(p_instance_id, 128), left(p_metric_name, 128), p_provider, p_status_class, greatest(p_count, 0), greatest(p_sum_value, 0), greatest(p_max_value, 0), p_gauge_value)
  on conflict (bucket_start, instance_id, metric_name, provider, status_class) do update set
    count = public.observability_metric_buckets.count + excluded.count,
    sum_value = public.observability_metric_buckets.sum_value + excluded.sum_value,
    max_value = greatest(public.observability_metric_buckets.max_value, excluded.max_value),
    gauge_value = coalesce(excluded.gauge_value, public.observability_metric_buckets.gauge_value)
  returning * into result;
  return result;
end; $$;
create or replace function public.cleanup_observability_metric_buckets() returns bigint language sql security definer set search_path = public as $$
  with deleted as (delete from public.observability_metric_buckets where bucket_start < date_trunc('minute', now() - interval '30 days') returning 1) select count(*) from deleted;
$$;
revoke all on function public.record_observability_metric(timestamptz, text, text, text, text, bigint, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.cleanup_observability_metric_buckets() from public, anon, authenticated;
grant execute on function public.record_observability_metric(timestamptz, text, text, text, text, bigint, double precision, double precision, double precision) to service_role;
grant execute on function public.cleanup_observability_metric_buckets() to service_role;
