-- RLS does not cover service-role workers or signed resumable uploads.
create or replace function public.reject_expired_meeting_storage_write()
returns trigger language plpgsql security definer set search_path = public, storage, pg_temp as $$
begin
  if new.bucket_id in ('meeting-audio', 'meeting-exports') and
    not public.meeting_storage_content_accessible((storage.foldername(new.name))[1], (storage.foldername(new.name))[2]) then
    raise exception 'meeting_content_expired' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger meeting_storage_reject_expired_write
before insert or update on storage.objects
for each row execute function public.reject_expired_meeting_storage_write();
