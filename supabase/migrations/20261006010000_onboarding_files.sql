-- Onboarding uploads take any number of files, each named by the person
-- ("White Card", "Forklift licence") with an optional expiry date.
--
-- * onboarding_files: one row per uploaded file. Existing single uploads are
--   copied in.
-- * New checklist item 'certificates' replaces the separate White Card and
--   Licences items for new requests (those types are retired, not deleted, so
--   open requests that use them keep working).
-- * Adding a file sends the item back to "waiting for HR"; a file can be
--   removed until HR accepts the item.
begin;

create table public.onboarding_files (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.onboarding_items(id) on delete cascade,
  path text not null unique,
  file_name text not null default '',
  label text not null check (length(btrim(label)) between 2 and 80),
  expires_on date,
  uploaded_at timestamptz not null default now()
);
create index onboarding_files_item_idx on public.onboarding_files (item_id, uploaded_at);

insert into public.onboarding_files (item_id, path, file_name, label, uploaded_at)
select i.id, i.file_path, coalesce(i.file_name, ''), coalesce(d.name, i.doc_type), coalesce(i.uploaded_at, now())
from public.onboarding_items i join public.hr_document_types d on d.key = i.doc_type
where i.file_path is not null;

insert into public.hr_document_types (key, name, guidance, required, applies_to, sensitive, sort, kind) values
  ('certificates', 'Certificates, licences and tickets',
   'Add a photo of each one: your White Card, plus any trade licences, high-risk work tickets and training certificates.',
   true, '{employee,applicant,contractor}', false, 70, 'upload')
on conflict (key) do nothing;

update public.hr_document_types set active = false where key in ('white_card', 'tickets');

update public.hr_document_types as t set guidance = v.guidance
from (values
  ('contract', 'Photos of every signed page, or one PDF.'),
  ('contractor_agreement', 'Photos of every signed page, or one PDF.'),
  ('public_liability', 'Your current certificate of currency.'),
  ('workers_comp', 'Certificate of currency, if it applies to you.')
) as v(key, guidance)
where t.key = v.key;

create or replace function public.onboarding_add_file(p_actor uuid, p_item uuid, p_path text, p_file_name text, p_label text, p_expires date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_id uuid;
begin
  select i.*, r.profile_id, r.status as request_status, d.kind into v_item
  from public.onboarding_items i
  join public.onboarding_requests r on r.id = i.request_id
  join public.hr_document_types d on d.key = i.doc_type
  where i.id = p_item for update of i;
  if not found or v_item.profile_id <> p_actor then
    raise exception 'Document request not found.' using errcode = 'P0002';
  end if;
  if v_item.request_status <> 'open' then
    raise exception 'This onboarding request is closed.' using errcode = '22023';
  end if;
  if v_item.kind <> 'upload' then
    raise exception 'Fill in this item on the portal instead of uploading a file.' using errcode = '22023';
  end if;
  if v_item.status = 'accepted' then
    raise exception 'This document has already been accepted.' using errcode = '22023';
  end if;
  if p_path is null or p_path !~ ('^' || v_item.request_id::text || '/' || p_item::text || '/[A-Za-z0-9._-]{1,160}$') then
    raise exception 'Invalid upload path.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_label, ''))) < 2 then
    raise exception 'Say what the file is, for example "White Card".' using errcode = '22023';
  end if;
  if (select count(*) from public.onboarding_files where item_id = p_item) >= 30 then
    raise exception 'That''s the most files for one item. Remove some first.' using errcode = '22023';
  end if;
  insert into public.onboarding_files (item_id, path, file_name, label, expires_on)
  values (p_item, p_path, left(coalesce(p_file_name, ''), 200), left(btrim(p_label), 80), p_expires)
  returning id into v_id;
  update public.onboarding_items
  set status = 'uploaded', file_path = p_path, file_name = left(coalesce(p_file_name, ''), 200), uploaded_at = now(),
      reviewed_by = null, reviewed_at = null, reject_reason = null
  where id = p_item;
  perform public.ims_audit(p_actor, 'onboarding_document_uploaded',
    jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type, 'label', btrim(p_label)), p_actor);
  return v_id;
end;
$$;

-- Kept for older clients: a single upload labelled with the item's name.
create or replace function public.onboarding_record_upload(p_actor uuid, p_item uuid, p_path text, p_file_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.onboarding_add_file(p_actor, p_item, p_path, p_file_name,
    coalesce((select d.name from public.onboarding_items i join public.hr_document_types d on d.key = i.doc_type where i.id = p_item), 'Document'), null);
end;
$$;

create or replace function public.onboarding_remove_file(p_actor uuid, p_file uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file record;
  v_left integer;
  v_last record;
begin
  select f.*, i.request_id, i.status as item_status, i.doc_type, r.profile_id, r.status as request_status into v_file
  from public.onboarding_files f
  join public.onboarding_items i on i.id = f.item_id
  join public.onboarding_requests r on r.id = i.request_id
  where f.id = p_file for update of i;
  if not found or v_file.profile_id <> p_actor then
    raise exception 'File not found.' using errcode = 'P0002';
  end if;
  if v_file.request_status <> 'open' then
    raise exception 'This onboarding request is closed.' using errcode = '22023';
  end if;
  if v_file.item_status = 'accepted' then
    raise exception 'HR has accepted this item, so its files can''t be removed. Contact HR.' using errcode = '22023';
  end if;
  delete from public.onboarding_files where id = p_file;
  select count(*) into v_left from public.onboarding_files where item_id = v_file.item_id;
  select path, file_name, uploaded_at into v_last from public.onboarding_files where item_id = v_file.item_id order by uploaded_at desc limit 1;
  update public.onboarding_items
  set status = case when v_left = 0 then 'pending' else status end,
      file_path = v_last.path, file_name = v_last.file_name, uploaded_at = v_last.uploaded_at
  where id = v_file.item_id;
  perform public.ims_audit(p_actor, 'onboarding_file_removed',
    jsonb_build_object('requestId', v_file.request_id, 'itemId', v_file.item_id, 'docType', v_file.doc_type, 'label', v_file.label), p_actor);
  return v_file.path;
end;
$$;

alter table public.onboarding_files enable row level security;
revoke all on table public.onboarding_files from anon, authenticated;
grant select on table public.onboarding_files to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'onboarding_add_file(uuid, uuid, text, text, text, date)', 'onboarding_remove_file(uuid, uuid)',
    'onboarding_record_upload(uuid, uuid, text, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

commit;
