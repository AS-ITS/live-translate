-- Issue #33: new domain-matching profiles wait explicit super_admin approval.
-- Existing active disabled profiles preserved changing only default
-- future widening status constraint include pending.
alter table public.profiles alter column status set default 'pending';
alter table public.profiles drop constraint if exists profiles_status_check, add constraint profiles_status_check check (status in ('pending', 'active', 'disabled'));
