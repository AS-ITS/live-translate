-- New Google Workspace profiles must be approved before application access.
alter table public.profiles
  alter column status set default 'pending';

alter table public.profiles
  drop constraint if exists profiles_status_check,
  add constraint profiles_status_check check (status in ('pending', 'active', 'disabled'));
