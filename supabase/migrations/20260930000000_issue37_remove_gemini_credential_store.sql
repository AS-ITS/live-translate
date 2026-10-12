-- Issue #37 GSK-04: remove the retired persisted Gemini credential store.
-- This is intentionally a forward-only cleanup. It deletes only Vault secrets
-- referenced by credential rows and never moves credential values elsewhere.
delete from vault.secrets
where id in (
  select distinct vault_secret_id
  from public.gemini_credentials
  where vault_secret_id is not null
);

revoke all on function public.get_my_gemini_credential(uuid) from public, anon, authenticated, service_role;
revoke all on function public.upsert_my_gemini_credential(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_my_gemini_credential(uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_my_gemini_key(uuid) from public, anon, authenticated, service_role;

drop function public.get_my_gemini_credential(uuid);
drop function public.upsert_my_gemini_credential(uuid, text);
drop function public.delete_my_gemini_credential(uuid);
drop function public.read_my_gemini_key(uuid);

drop table public.gemini_credentials;
