-- HR can change the contract at any time while the request is open.
--
-- Before: attaching or removing a contract file was refused once the person had signed,
-- and HR had to send the item back first.
-- Now: HR can add or remove contract files whenever the item is not yet accepted. If the
-- person had already signed, the item is sent back to them to sign the new version (their
-- earlier signature stays in the audit log). People see the change when they refresh.
--
-- Also: requests that were already open when 'contractor_esign' was introduced still had the
-- old upload-only contractor agreement with nothing uploaded. Those become the signed-online
-- item, so HR can attach the agreement to them.
begin;

create or replace function public.onboarding_sign_doc_add(
  p_actor uuid, p_item uuid, p_path text, p_file_name text, p_label text, p_sha256 text, p_size bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_id uuid;
begin
  perform public.app_require(p_actor, 'hr.manage');
  select i.*, r.profile_id, r.status as request_status, d.kind into v_item
  from public.onboarding_items i
  join public.onboarding_requests r on r.id = i.request_id
  join public.hr_document_types d on d.key = i.doc_type
  where i.id = p_item for update of i;
  if not found then
    raise exception 'Document request not found.' using errcode = 'P0002';
  end if;
  if v_item.request_status <> 'open' then
    raise exception 'This onboarding request is closed.' using errcode = '22023';
  end if;
  if v_item.kind <> 'sign' then
    raise exception 'This item is not signed online.' using errcode = '22023';
  end if;
  if v_item.status not in ('pending', 'rejected', 'uploaded') then
    raise exception 'HR has accepted and filed this contract, so it can no longer be changed.' using errcode = '22023';
  end if;
  if v_item.status = 'uploaded' then
    -- Already signed and waiting for HR. A signature belongs to the contract the person saw,
    -- so a changed contract goes back to them to sign again. The old signature stays in the audit log.
    update public.onboarding_items
    set status = 'rejected', reject_reason = 'HR updated your contract. Please read it again and sign.'
    where id = p_item;
    perform public.ims_audit(p_actor, 'onboarding_contract_changed_after_signing',
      jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type), v_item.profile_id);
  end if;

  if p_path is null or p_path !~ ('^' || v_item.request_id::text || '/' || p_item::text || '/[A-Za-z0-9._-]{1,160}$') then
    raise exception 'Invalid upload path.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_label, ''))) < 2 then
    raise exception 'Name the document, for example "Employment contract".' using errcode = '22023';
  end if;
  if (select count(*) from public.onboarding_sign_documents where item_id = p_item) >= 5 then
    raise exception 'That''s the most documents for one contract. Remove one first.' using errcode = '22023';
  end if;
  insert into public.onboarding_sign_documents (item_id, path, file_name, label, sha256, size_bytes, added_by)
  values (p_item, p_path, left(coalesce(p_file_name, ''), 200), left(btrim(p_label), 80), p_sha256, p_size, p_actor)
  returning id into v_id;
  perform public.ims_audit(p_actor, 'onboarding_contract_added',
    jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type,
      'documentId', v_id, 'label', btrim(p_label), 'sha256', p_sha256), v_item.profile_id);
  return v_id;
end;
$$;

-- HR removes a contract file. The stored file is kept
-- (nothing in the HR bucket is deleted); only the link to the item is cut.
create or replace function public.onboarding_sign_doc_remove(p_actor uuid, p_doc uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc record;
begin
  perform public.app_require(p_actor, 'hr.manage');
  select d.*, i.request_id, i.status as item_status, i.doc_type, r.profile_id, r.status as request_status into v_doc
  from public.onboarding_sign_documents d
  join public.onboarding_items i on i.id = d.item_id
  join public.onboarding_requests r on r.id = i.request_id
  where d.id = p_doc for update of i;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if v_doc.request_status <> 'open' then
    raise exception 'This onboarding request is closed.' using errcode = '22023';
  end if;
  if v_doc.item_status not in ('pending', 'rejected', 'uploaded') then
    raise exception 'HR has accepted and filed this contract, so it can no longer be changed.' using errcode = '22023';
  end if;
  if v_doc.item_status = 'uploaded' then
    -- Already signed and waiting for HR. A signature belongs to the contract the person saw,
    -- so a changed contract goes back to them to sign again. The old signature stays in the audit log.
    update public.onboarding_items
    set status = 'rejected', reject_reason = 'HR updated your contract. Please read it again and sign.'
    where id = v_doc.item_id;
    perform public.ims_audit(p_actor, 'onboarding_contract_changed_after_signing',
      jsonb_build_object('requestId', v_doc.request_id, 'itemId', v_doc.item_id, 'docType', v_doc.doc_type), v_doc.profile_id);
  end if;

  delete from public.onboarding_sign_documents where id = p_doc;
  perform public.ims_audit(p_actor, 'onboarding_contract_removed',
    jsonb_build_object('requestId', v_doc.request_id, 'itemId', v_doc.item_id, 'docType', v_doc.doc_type,
      'documentId', p_doc, 'label', v_doc.label, 'sha256', v_doc.sha256), v_doc.profile_id);
  return v_doc.path;
end;
$$;


update public.onboarding_items i
set doc_type = 'contractor_esign'
from public.onboarding_requests r
where r.id = i.request_id and r.status = 'open'
  and i.doc_type = 'contractor_agreement' and i.status = 'pending'
  and i.answers is null and i.file_name is null
  and not exists (select 1 from public.onboarding_files f where f.item_id = i.id)
  and not exists (select 1 from public.onboarding_items o where o.request_id = i.request_id and o.doc_type = 'contractor_esign');

commit;
