-- Recorder writes run as authenticated. The guard must inspect a private
-- deletion marker without granting clients direct access to that table.
alter function public.reject_deleted_meeting_write() security definer;
alter function public.reject_deleted_meeting_write() set search_path = public, pg_temp;
revoke all on function public.reject_deleted_meeting_write() from public, anon, authenticated;
