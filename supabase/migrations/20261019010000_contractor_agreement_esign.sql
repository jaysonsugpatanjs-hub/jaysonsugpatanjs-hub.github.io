-- Contractor agreement: HR attaches it, the contractor signs it online.
--
-- Until now a contractor's "Signed contractor agreement" was an upload-only
-- item, so HR had no way to give the contractor Panalo's agreement. The online
-- signing flow built for the employment contract (HR attaches a PDF, the person
-- reads, downloads, fills in a copy and signs, HR finalizes) works for any 'sign'
-- item, so this adds a contractor version of it.
--
-- The old upload item is retired, not deleted, so requests that already use it
-- keep working. New requests for contractors offer the new item.
begin;

insert into public.hr_document_types (key, name, guidance, required, applies_to, sensitive, sort, kind, personnel_category) values
  ('contractor_esign', 'Contractor agreement',
   'HR adds your contractor agreement here. Read it, then sign online by typing or writing your full name. No printing or scanning needed.',
   true, '{contractor}', false, 150, 'sign', 'employment')
on conflict (key) do nothing;

update public.hr_document_types set active = false where key = 'contractor_agreement';

commit;
