-- Cloud execution status updates are delivered through Supabase Realtime.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'translation_executions'
  ) then
    alter publication supabase_realtime add table public.translation_executions;
  end if;
end $$;
