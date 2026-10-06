-- Onboarding: most items become short forms the person fills in on the
-- portal. Only certificates and signed contracts/agreements are uploads.
--
-- * hr_document_types.kind: 'form' or 'upload'.
-- * onboarding_items.answers: the typed answers (validated by the API against
--   supabase/functions/_shared/onboarding-forms.ts). Tax, bank and identity
--   numbers live here, so the table stays service-role only.
-- * A submitted form uses the same 'uploaded' status as a file ("waiting for
--   HR"), so review, send-back and completion work unchanged.
begin;

alter table public.hr_document_types
  add column kind text not null default 'upload' check (kind in ('form', 'upload'));

alter table public.onboarding_items
  add column answers jsonb check (answers is null or (jsonb_typeof(answers) = 'object' and length(answers::text) <= 8000)),
  add column submitted_at timestamptz;

insert into public.hr_document_types (key, name, guidance, required, applies_to, sensitive, sort, kind) values
  ('personal_details', 'Personal details', 'Date of birth, mobile number and home address.', true, '{employee,applicant,contractor}', true, 5, 'form')
on conflict (key) do nothing;

update public.hr_document_types as t set kind = 'form', guidance = v.guidance
from (values
  ('tfn_declaration', 'Answer the tax file number declaration questions online.'),
  ('super_choice', 'Your super fund''s name, USI and member number, or use Panalo''s default fund.'),
  ('right_to_work', 'Your citizenship or visa details, so HR can confirm you can work in Australia.'),
  ('photo_id', 'Your licence or passport number. Bring the original on your first day.'),
  ('bank_details', 'Account name, BSB and account number for your pay.'),
  ('emergency_contact', 'Someone we can call if something happens at work.'),
  ('fwis_ack', 'Read the Fair Work Information Statement and confirm you received it.'),
  ('casual_statement', 'Casual employees only: read the statement and confirm you received it.'),
  ('abn_details', 'ABN, business name and GST registration.')
) as v(key, guidance)
where t.key = v.key;

update public.hr_document_types as t set guidance = v.guidance
from (values
  ('white_card', 'Photo of the front and back of your White Card.'),
  ('tickets', 'Photos of trade licences and high-risk work tickets (forklift, EWP, dogging and similar).'),
  ('contract', 'The signed and dated contract or letter of offer.'),
  ('public_liability', 'Current certificate of currency.'),
  ('workers_comp', 'Certificate of currency, if it applies to you.'),
  ('contractor_agreement', 'The signed and dated agreement.')
) as v(key, guidance)
where t.key = v.key and t.kind = 'upload';

create or replace function public.onboarding_record_answers(p_actor uuid, p_item uuid, p_answers jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
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
  if v_item.kind <> 'form' then
    raise exception 'This item needs a file upload.' using errcode = '22023';
  end if;
  if v_item.status = 'accepted' then
    raise exception 'This has already been accepted.' using errcode = '22023';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'Answers are missing.' using errcode = '22023';
  end if;
  update public.onboarding_items
  set status = 'uploaded', answers = p_answers, submitted_at = now(),
      reviewed_by = null, reviewed_at = null, reject_reason = null
  where id = p_item;
  -- The answers themselves are not copied into the audit log.
  perform public.ims_audit(p_actor, 'onboarding_form_submitted',
    jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type), p_actor);
end;
$$;

create or replace function public.onboarding_record_upload(p_actor uuid, p_item uuid, p_path text, p_file_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
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
  update public.onboarding_items
  set status = 'uploaded', file_path = p_path, file_name = left(coalesce(p_file_name, ''), 200), uploaded_at = now(),
      reviewed_by = null, reviewed_at = null, reject_reason = null
  where id = p_item;
  perform public.ims_audit(p_actor, 'onboarding_document_uploaded',
    jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type), p_actor);
end;
$$;

revoke execute on function public.onboarding_record_answers(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.onboarding_record_answers(uuid, uuid, jsonb) to service_role;
revoke execute on function public.onboarding_record_upload(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.onboarding_record_upload(uuid, uuid, text, text) to service_role;

comment on column public.onboarding_items.answers is 'Typed onboarding answers (TFN, bank, ID numbers). hr.manage only, via the admin API.';

commit;
