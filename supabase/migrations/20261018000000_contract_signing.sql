-- Online contract signing.
--
-- HR uploads the employment contract (PDF) against the applicant's onboarding
-- item; the applicant reads it on the portal and signs by typing, or writing,
-- their full name. Nothing is printed, scanned or re-uploaded.
--
-- * hr_document_types.kind gains 'sign'.
-- * New checklist item 'contract_esign' replaces the "upload your signed
--   contract" item for new requests. The old 'contract' type is retired, not
--   deleted, so open requests that already use it keep working (the same way
--   White Card and Licences were retired for 'certificates').
-- * onboarding_sign_documents: the contract file(s) HR attaches, each with the
--   SHA-256 fingerprint of the exact bytes the applicant is shown. Files can be
--   changed only while the item is unsigned or sent back.
-- * The signature is kept on the item (answers + submitted_at) and the audit
--   log: who, when, how (typed or handwritten), the wording they agreed to and
--   the fingerprint of every document. When HR accepts, the admin API files one
--   signed PDF (contract pages + signature record) in the HR folder.
begin;

do $$
declare
  v_name text;
begin
  select conname into v_name from pg_constraint
  where conrelid = 'public.hr_document_types'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%';
  if v_name is not null then
    execute format('alter table public.hr_document_types drop constraint %I', v_name);
  end if;
end;
$$;
alter table public.hr_document_types
  add constraint hr_document_types_kind_check check (kind in ('form', 'upload', 'sign'));

insert into public.hr_document_types (key, name, guidance, required, applies_to, sensitive, sort, kind, personnel_category) values
  ('contract_esign', 'Employment contract',
   'HR adds your contract here. Read it, then sign online by typing or writing your full name. No printing or scanning needed.',
   true, '{employee,applicant}', false, 110, 'sign', 'employment')
on conflict (key) do nothing;

update public.hr_document_types set active = false where key = 'contract';

create table public.onboarding_sign_documents (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.onboarding_items(id) on delete cascade,
  path text not null unique,
  file_name text not null default '',
  label text not null check (length(btrim(label)) between 2 and 80),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  added_by uuid references public.training_profiles(id) on delete set null,
  added_at timestamptz not null default now()
);
create index onboarding_sign_documents_item_idx on public.onboarding_sign_documents (item_id, added_at);

alter table public.onboarding_sign_documents enable row level security;
revoke all on table public.onboarding_sign_documents from anon, authenticated;
grant select on table public.onboarding_sign_documents to service_role;

-- HR attaches a contract file to a sign item. The file is already in private
-- storage; the API has checked it is a PDF and computed its fingerprint.
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
  if v_item.status not in ('pending', 'rejected') then
    raise exception 'The contract has been signed. Send it back first if it needs to change.' using errcode = '22023';
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

-- HR removes a contract file before it is signed. The stored file is kept
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
  if v_doc.item_status not in ('pending', 'rejected') then
    raise exception 'The contract has been signed. Send it back first if it needs to change.' using errcode = '22023';
  end if;
  delete from public.onboarding_sign_documents where id = p_doc;
  perform public.ims_audit(p_actor, 'onboarding_contract_removed',
    jsonb_build_object('requestId', v_doc.request_id, 'itemId', v_doc.item_id, 'docType', v_doc.doc_type,
      'documentId', p_doc, 'label', v_doc.label, 'sha256', v_doc.sha256), v_doc.profile_id);
  return v_doc.path;
end;
$$;

-- The applicant signs. The wording they agreed to, the method, the time and the
-- fingerprint of every document are recorded in one transaction with the audit
-- event, so a signature cannot exist without its record.
--   p_method 'typed': p_name must match the applicant's name on the register
--                     (ignoring case and spacing); both are recorded.
--   p_method 'drawn': p_signature_path is the stored handwriting image; the
--                     name recorded is the one on the register.
create or replace function public.onboarding_record_signature(
  p_actor uuid, p_item uuid, p_method text, p_name text, p_statement text, p_signature_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_register_name text;
  v_signed_name text;
  v_typed text;
  v_docs jsonb;
  v_answers jsonb;
  v_norm constant text := '\s+';
begin
  select i.*, r.profile_id, r.employee_id, r.status as request_status, d.kind into v_item
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
  if v_item.kind <> 'sign' then
    raise exception 'This item is not signed online.' using errcode = '22023';
  end if;
  if v_item.status = 'accepted' then
    raise exception 'This has already been accepted.' using errcode = '22023';
  end if;
  if v_item.status = 'uploaded' then
    raise exception 'You have already signed this. HR is reviewing it.' using errcode = '22023';
  end if;
  if p_method not in ('typed', 'drawn') then
    raise exception 'Choose how you want to sign.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_statement, ''))) < 10 then
    raise exception 'The agreement wording is missing.' using errcode = '22023';
  end if;

  select jsonb_agg(jsonb_build_object('label', label, 'fileName', file_name, 'sha256', sha256) order by added_at)
  into v_docs from public.onboarding_sign_documents where item_id = p_item;
  if v_docs is null then
    raise exception 'HR has not added your contract yet.' using errcode = '22023';
  end if;

  select btrim(regexp_replace(full_name, v_norm, ' ', 'g')) into v_register_name from public.employees where id = v_item.employee_id;
  if p_method = 'typed' then
    v_typed := btrim(regexp_replace(coalesce(p_name, ''), v_norm, ' ', 'g'));
    if lower(v_typed) <> lower(v_register_name) then
      raise exception 'Type your full name exactly as shown: %', v_register_name using errcode = '22023';
    end if;
    v_signed_name := v_register_name;
  else
    v_signed_name := v_register_name;
    if p_signature_path is null or p_signature_path !~ ('^' || v_item.request_id::text || '/' || p_item::text || '/signature-[A-Za-z0-9._-]{1,120}$') then
      raise exception 'Your handwritten signature is missing.' using errcode = '22023';
    end if;
  end if;

  v_answers := jsonb_strip_nulls(jsonb_build_object(
    'method', p_method, 'signedName', v_signed_name, 'typedAs', v_typed, 'agreed', true, 'statement', btrim(p_statement),
    'signaturePath', case when p_method = 'drawn' then p_signature_path end, 'documents', v_docs));

  update public.onboarding_items
  set status = 'uploaded', answers = v_answers, submitted_at = now(),
      reviewed_by = null, reviewed_at = null, reject_reason = null
  where id = p_item;
  perform public.ims_audit(p_actor, 'onboarding_contract_signed',
    jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type,
      'method', p_method, 'signedName', v_signed_name, 'documents', v_docs), p_actor);
  return jsonb_build_object('signedName', v_signed_name, 'method', p_method);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'onboarding_sign_doc_add(uuid, uuid, text, text, text, text, bigint)',
    'onboarding_sign_doc_remove(uuid, uuid)',
    'onboarding_record_signature(uuid, uuid, text, text, text, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

comment on table public.onboarding_sign_documents is 'Contract PDFs HR attaches for online signing, with the SHA-256 of each file. Service role only.';

commit;
