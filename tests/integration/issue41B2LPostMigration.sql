-- Run only on isolated Local Supabase after 20261105010000; all fixtures roll back.
begin;
do $$
declare
  owner_id uuid;
  meeting_id uuid := gen_random_uuid();
  glossary_id uuid;
  share_id uuid;
  rejected boolean;
begin
  select id into owner_id from auth.users limit 1;
  if owner_id is null then raise exception 'Local v2 fixture owner required'; end if;
  insert into public.meetings
    (id, owner_user_id, name, source_language_code, target_language_code, status, lifecycle_contract_version, lifecycle_version)
  values (meeting_id, owner_id, 'B2-L metadata', 'zh-Hant', 'en', 'created', 2, 0);
  update public.meetings set name = 'B2-L updated' where id = meeting_id;
  if (select name from public.meetings where id = meeting_id) <> 'B2-L updated' then
    raise exception 'Meeting metadata update failed';
  end if;

  insert into public.glossary_entries
    (owner_user_id, source, translation, source_language_code, target_language_code)
  values (owner_id, 'B2-L source', 'B2-L target', 'zh-Hant', 'en') returning id into glossary_id;
  if (select translation from public.glossary_entries where id = glossary_id) <> 'B2-L target' then
    raise exception 'Glossary create/read failed';
  end if;
  update public.glossary_entries set translation = 'B2-L updated' where id = glossary_id;
  if (select translation from public.glossary_entries where id = glossary_id) <> 'B2-L updated' then
    raise exception 'Glossary update failed';
  end if;
  delete from public.glossary_entries where id = glossary_id;
  if exists (select 1 from public.glossary_entries where id = glossary_id) then
    raise exception 'Glossary delete failed';
  end if;

  insert into public.viewer_shares (owner_user_id, meeting_id, token_hash)
  values (owner_id, meeting_id, 'b2l-' || meeting_id) returning id into share_id;
  if not exists (select 1 from public.viewer_shares where id = share_id and revoked_at is null) then
    raise exception 'Viewer authorization metadata failed';
  end if;

  rejected := false;
  begin insert into public.subtitle_cues default values;
  exception when sqlstate 'P0043' then rejected := true; end;
  if not rejected then raise exception 'Cloud Cue insert succeeded'; end if;
  rejected := false;
  begin insert into public.meeting_events default values;
  exception when sqlstate 'P0043' then rejected := true; end;
  if not rejected then raise exception 'Cloud Event insert succeeded'; end if;
  rejected := false;
  begin
    insert into storage.objects (bucket_id, name)
    values ('meeting-audio', owner_id || '/' || meeting_id || '/recording.webm');
  exception when sqlstate 'P0043' then rejected := true; end;
  if not rejected then raise exception 'Cloud audio object insert succeeded'; end if;
  rejected := false;
  begin
    insert into storage.objects (bucket_id, name)
    values ('meeting-exports', owner_id || '/' || meeting_id || '/export.txt');
  exception when sqlstate 'P0043' then rejected := true; end;
  if not rejected then raise exception 'Cloud export object insert succeeded'; end if;
  if has_function_privilege('service_role', 'public.publish_meeting_cue_v2(uuid,uuid,jsonb)', 'EXECUTE') then
    raise exception 'Legacy Cue RPC remains executable';
  end if;
end;
$$;
rollback;
