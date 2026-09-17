-- Issue #33: new domain-matching profiles wait for explicit super_admin approval.
-- Existing active and disabled profiles are preserved by changing only the default
-- for future rows and widening the status constraint to include pending.
alter table public.profiles
  alter column status set default 'pending';


alter table public.profiles
  drop constraint if exists profiles_status_check,
  add constraint profiles_status_check check (status in ('pending', 'active', 'disabled'));
