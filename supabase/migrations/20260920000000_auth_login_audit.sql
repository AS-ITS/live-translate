-- Record application-level login outcomes in the existing server-only audit log.
alter table public.audit_logs drop constraint if exists audit_logs_action_check;
alter table public.audit_logs
  add constraint audit_logs_action_check check (action in ('member_invited', 'member_removed', 'user_approved', 'user_enabled', 'user_disabled', 'asset_transfer', 'auth_login'));
