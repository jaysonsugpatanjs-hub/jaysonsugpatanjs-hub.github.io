-- Behavioural tests for online contract signing: HR attaches the contract, the
-- applicant signs by typing or writing their name, HR reviews. Self-contained:
-- creates its own people (emails under @sign.test).

create temporary table sid (k text primary key, v uuid);
create or replace function pg_temp.s(p text) returns uuid language sql as $$ select v from sid where k = p $$;
create or replace function pg_temp.expect_error(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm !~* p_pattern then
      raise exception 'Expected error matching "%", got "%"', p_pattern, sqlerrm;
    end if;
    return;
  end;
  raise exception 'Expected error matching "%", but the statement succeeded: %', p_pattern, p_sql;
end $$;
create or replace function pg_temp.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception '% : expected %, got %', p_label, p_expected, p_actual;
  end if;
end $$;

insert into auth.users (email) values ('boss@sign.test'), ('applicant@sign.test'), ('other@sign.test');
insert into sid select split_part(email, '@', 1), id from public.training_profiles where email like '%@sign.test';
update public.training_profiles set role = 'admin' where id = pg_temp.s('boss');

insert into public.employees (employee_number, full_name, email, employment_type, status) values
  ('S-APP', 'Jose Dela Cruz', 'applicant@sign.test', 'applicant', 'applicant');
insert into public.employees (employee_number, full_name, email, profile_id) values
  ('S-OTHER', 'Other Worker', 'other@sign.test', pg_temp.s('other'));

do $$
declare
  v_emp uuid; v_req uuid; v_item uuid; v_doc uuid; v_doc2 uuid; v_res jsonb; v_hash text;
  v_sha text := repeat('a', 64);
  v_text text := 'I have read and understood this contract and I agree to be bound by it.';
begin
  v_emp := (select id from public.employees where employee_number = 'S-APP');
  perform public.account_link_employee(pg_temp.s('boss'), v_emp, pg_temp.s('applicant'));

  -- The new item exists as a sign item; the old upload-a-signed-copy one is retired.
  perform pg_temp.eq((select kind from public.hr_document_types where key = 'contract_esign'), 'sign', 'contract_esign is a sign item');
  perform pg_temp.eq((select active from public.hr_document_types where key = 'contract'), false, 'old contract upload item is retired');
  perform pg_temp.expect_error(format('select public.onboarding_create(%L, %L, %L, null, %L)', pg_temp.s('boss'), v_emp, '{contract}', ''), 'Unknown document');

  v_req := public.onboarding_create(pg_temp.s('boss'), v_emp, '{contract_esign}', null, '');
  select id into v_item from public.onboarding_items where request_id = v_req and doc_type = 'contract_esign';

  -- Nothing to sign until HR attaches the contract.
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, %L, %L, null)', pg_temp.s('applicant'), v_item, 'typed', 'Jose Dela Cruz', v_text), 'not added your contract');

  -- Only HR attaches contracts, and only to sign items, on good paths.
  perform pg_temp.expect_error(format('select public.onboarding_sign_doc_add(%L, %L, %L, %L, %L, %L, 100)', pg_temp.s('applicant'), v_item, v_req || '/' || v_item || '/c.pdf', 'c.pdf', 'Contract', v_sha), 'permission');
  perform pg_temp.expect_error(format('select public.onboarding_sign_doc_add(%L, %L, %L, %L, %L, %L, 100)', pg_temp.s('boss'), v_item, 'elsewhere/c.pdf', 'c.pdf', 'Contract', v_sha), 'Invalid upload path');
  perform pg_temp.expect_error(format('select public.onboarding_sign_doc_add(%L, %L, %L, %L, %L, %L, 100)', pg_temp.s('boss'), v_item, v_req || '/' || v_item || '/c.pdf', 'c.pdf', ' ', v_sha), 'Name the document');
  perform pg_temp.expect_error(format('select public.onboarding_sign_doc_add(%L, %L, %L, %L, %L, %L, 100)', pg_temp.s('boss'), v_item, v_req || '/' || v_item || '/c.pdf', 'c.pdf', 'Contract', 'nothex'), 'sha256');
  v_doc := public.onboarding_sign_doc_add(pg_temp.s('boss'), v_item, v_req || '/' || v_item || '/contract-1.pdf', 'Contract.pdf', 'Employment contract', v_sha, 2048);
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'pending', 'attaching the contract does not mark the item as sent');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type = 'onboarding_contract_added'), 1, 'attaching is audited');

  -- Up to five documents; removing one frees a slot and keeps the stored path.
  for i in 2..5 loop
    perform public.onboarding_sign_doc_add(pg_temp.s('boss'), v_item, v_req || '/' || v_item || '/extra-' || i || '.pdf', 'Extra.pdf', 'Schedule ' || i, v_sha, 100);
  end loop;
  perform pg_temp.expect_error(format('select public.onboarding_sign_doc_add(%L, %L, %L, %L, %L, %L, 100)', pg_temp.s('boss'), v_item, v_req || '/' || v_item || '/extra-6.pdf', 'x.pdf', 'Schedule 6', v_sha), 'most documents');
  select id into v_doc2 from public.onboarding_sign_documents where item_id = v_item and label = 'Schedule 5';
  perform pg_temp.expect_error(format('select public.onboarding_sign_doc_remove(%L, %L)', pg_temp.s('applicant'), v_doc2), 'permission');
  perform pg_temp.eq(public.onboarding_sign_doc_remove(pg_temp.s('boss'), v_doc2), v_req || '/' || v_item || '/extra-5.pdf', 'remove returns the stored path');
  delete from public.onboarding_sign_documents where item_id = v_item and id <> v_doc;
  perform pg_temp.eq((select count(*)::int from public.onboarding_sign_documents where item_id = v_item), 1, 'one contract left');

  -- Signing rules.
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, %L, %L, null)', pg_temp.s('other'), v_item, 'typed', 'Jose Dela Cruz', v_text), 'not found');
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, %L, %L, null)', pg_temp.s('applicant'), v_item, 'stamp', 'Jose Dela Cruz', v_text), 'how you want to sign');
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, %L, %L, null)', pg_temp.s('applicant'), v_item, 'typed', 'Jose', v_text), 'exactly as shown: Jose Dela Cruz');
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, %L, %L, null)', pg_temp.s('applicant'), v_item, 'typed', 'Jose Dela Cruz', ''), 'wording');
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, null, %L, null)', pg_temp.s('applicant'), v_item, 'drawn', v_text), 'handwritten signature is missing');
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, null, %L, %L)', pg_temp.s('applicant'), v_item, 'drawn', v_text, 'elsewhere/signature-1.png'), 'handwritten signature is missing');
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'pending', 'failed signing leaves the item unsigned');

  -- Typed: case and spacing don't matter; the register spelling is what is recorded.
  v_res := public.onboarding_record_signature(pg_temp.s('applicant'), v_item, 'typed', '  jose   DELA cruz ', v_text, null);
  perform pg_temp.eq(v_res->>'signedName', 'Jose Dela Cruz', 'recorded name is the register name');
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'uploaded', 'signed contract waits for HR');
  perform pg_temp.eq((select submitted_at is not null from public.onboarding_items where id = v_item), true, 'signing time recorded');
  perform pg_temp.eq((select answers->>'method' from public.onboarding_items where id = v_item), 'typed', 'method recorded');
  perform pg_temp.eq((select answers->>'typedAs' from public.onboarding_items where id = v_item), 'jose DELA cruz', 'what they typed is kept as evidence');
  perform pg_temp.eq((select answers->'documents'->0->>'sha256' from public.onboarding_items where id = v_item), v_sha, 'document fingerprint recorded with the signature');
  perform pg_temp.eq((select answers->>'statement' from public.onboarding_items where id = v_item), v_text, 'agreement wording recorded');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type = 'onboarding_contract_signed' and details::text like '%' || v_sha || '%'), 1, 'signing is audited with the fingerprint');

  -- Signed means signed: no second signature, no swapping the contract underneath it.
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, %L, %L, null)', pg_temp.s('applicant'), v_item, 'typed', 'Jose Dela Cruz', v_text), 'already signed');
  perform pg_temp.expect_error(format('select public.onboarding_sign_doc_remove(%L, %L)', pg_temp.s('boss'), v_doc), 'has been signed');
  perform pg_temp.expect_error(format('select public.onboarding_sign_doc_add(%L, %L, %L, %L, %L, %L, 100)', pg_temp.s('boss'), v_item, v_req || '/' || v_item || '/new.pdf', 'new.pdf', 'Replacement', v_sha), 'has been signed');

  -- HR sends it back (the contract needs changing); they can swap the file and the applicant re-signs by hand.
  perform public.onboarding_review(pg_temp.s('boss'), v_item, false, 'Wrong start date in the contract');
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'rejected', 'sent back');
  perform public.onboarding_sign_doc_remove(pg_temp.s('boss'), v_doc);
  v_hash := repeat('b', 64);
  perform public.onboarding_sign_doc_add(pg_temp.s('boss'), v_item, v_req || '/' || v_item || '/contract-2.pdf', 'Contract v2.pdf', 'Employment contract', v_hash, 4096);
  v_res := public.onboarding_record_signature(pg_temp.s('applicant'), v_item, 'drawn', 'ignored', v_text, v_req || '/' || v_item || '/signature-abc123.png');
  perform pg_temp.eq(v_res->>'signedName', 'Jose Dela Cruz', 'handwritten signatures record the register name');
  perform pg_temp.eq((select answers->>'method' from public.onboarding_items where id = v_item), 'drawn', 'handwritten method recorded');
  perform pg_temp.eq((select answers->>'signaturePath' from public.onboarding_items where id = v_item), v_req || '/' || v_item || '/signature-abc123.png', 'signature image path recorded');
  perform pg_temp.eq((select answers->'documents'->0->>'sha256' from public.onboarding_items where id = v_item), v_hash, 're-signing records the new fingerprint');
  perform pg_temp.eq((select reject_reason is null from public.onboarding_items where id = v_item), true, 're-signing clears the send-back reason');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type = 'onboarding_contract_signed'), 2, 'both signatures stay in the audit log');

  -- Accepted: complete, locked, and a sign item cannot be treated as a form or an upload.
  -- HR finalizes: where the signature goes, and optionally a counter-signature for Panalo. All checked before anything is accepted.
  perform pg_temp.expect_error(format('select public.onboarding_finalize_contract(%L, %L, %L, null)', pg_temp.s('applicant'), v_item, '{"page":"last","signature":{"x":0.5,"y":0.9}}'), 'permission|not allowed|required');
  perform pg_temp.expect_error(format('select public.onboarding_finalize_contract(%L, %L, %L, null)', pg_temp.s('boss'), v_item, '{}'), 'where the signature goes');
  perform pg_temp.expect_error(format('select public.onboarding_finalize_contract(%L, %L, %L, null)', pg_temp.s('boss'), v_item, '{"page":"first","signature":{"x":0.5,"y":0.9}}'), 'where the signature goes');
  perform pg_temp.expect_error(format('select public.onboarding_finalize_contract(%L, %L, %L, %L)', pg_temp.s('boss'), v_item, '{"page":2,"signature":{"x":0.5,"y":0.9}}', '{"name":"R","method":"typed","signature":{"x":0.6,"y":0.9}}'), 'counter-signature is incomplete');
  perform pg_temp.expect_error(format('select public.onboarding_finalize_contract(%L, %L, %L, %L)', pg_temp.s('boss'), v_item, '{"page":2,"signature":{"x":0.5,"y":0.9}}', '{"name":"Rene Fiestada","method":"stamp","signature":{"x":0.6,"y":0.9}}'), 'counter-signature is incomplete');
  perform pg_temp.expect_error(format('select public.onboarding_finalize_contract(%L, %L, %L, %L)', pg_temp.s('boss'), v_item, '{"page":2,"signature":{"x":0.5,"y":0.9}}', '{"name":"Rene Fiestada","method":"drawn","signature":{"x":0.6,"y":0.9}}'), 'handwritten counter-signature is missing');
  perform pg_temp.expect_error(format('select public.onboarding_finalize_contract(%L, %L, %L, %L)', pg_temp.s('boss'), v_item, '{"page":2,"signature":{"x":0.5,"y":0.9}}',
    format('{"name":"Rene Fiestada","method":"drawn","signature":{"x":0.6,"y":0.9},"imagePath":"%s/other/company-signature-x.png"}', v_req)), 'handwritten counter-signature is missing');
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'uploaded', 'refused finalizing leaves the signature waiting');

  v_res := public.onboarding_finalize_contract(pg_temp.s('boss'), v_item, '{"page":2,"signature":{"x":0.55,"y":0.9},"date":{"x":0.55,"y":0.93}}',
    format('{"name":"Rene Fiestada","position":"Managing Director","method":"drawn","signature":{"x":0.6,"y":0.9},"date":null,"imagePath":"%s/%s/company-signature-abc.png"}', v_req, v_item)::jsonb);
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'accepted', 'finalizing accepts the signature');
  perform pg_temp.eq((select finalize #>> '{placement,page}' from public.onboarding_items where id = v_item), '2', 'where HR put the signature is kept');
  perform pg_temp.eq((select finalize #>> '{company,name}' from public.onboarding_items where id = v_item), 'Rene Fiestada', 'who signed for Panalo is kept');
  perform pg_temp.eq((select finalize #>> '{company,position}' from public.onboarding_items where id = v_item), 'Managing Director', 'and their position');
  perform pg_temp.eq((select finalize ->> 'by' from public.onboarding_items where id = v_item), pg_temp.s('boss')::text, 'and which HR sign-in entered it');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type = 'onboarding_contract_finalized' and details @> '{"counterSigned": true, "companySignatory": "Rene Fiestada"}'), 1, 'finalizing is audited with the counter-signatory');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type = 'onboarding_document_accepted' and details->>'itemId' = v_item::text), 1, 'and the acceptance is audited as before');
  perform pg_temp.expect_error(format('select public.onboarding_finalize_contract(%L, %L, %L, null)', pg_temp.s('boss'), v_item, '{"page":"last","signature":{"x":0.5,"y":0.9}}'), 'closed');
  perform pg_temp.eq((v_res->>'requestComplete')::boolean, true, 'request complete once the contract is accepted');
  perform pg_temp.expect_error(format('select public.onboarding_record_signature(%L, %L, %L, %L, %L, null)', pg_temp.s('applicant'), v_item, 'typed', 'Jose Dela Cruz', v_text), 'closed');

  v_req := public.onboarding_create(pg_temp.s('boss'), (select id from public.employees where employee_number = 'S-OTHER'), '{contract_esign}', null, '');
  select id into v_item from public.onboarding_items where request_id = v_req;
  perform pg_temp.expect_error(format('select public.onboarding_record_answers(%L, %L, %L)', pg_temp.s('other'), v_item, '{"a":"b"}'), 'needs a file upload');
  perform pg_temp.expect_error(format('select public.onboarding_add_file(%L, %L, %L, %L, %L, null)', pg_temp.s('other'), v_item, v_req || '/' || v_item || '/x.pdf', 'x.pdf', 'Signed copy'), 'Fill in this item');

  -- Browser roles reach none of this directly.
  perform pg_temp.eq(has_table_privilege('authenticated', 'public.onboarding_sign_documents', 'select'), false, 'signed-in users cannot read contract files directly');
  perform pg_temp.eq(has_table_privilege('anon', 'public.onboarding_sign_documents', 'select'), false, 'anonymous cannot read contract files');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.onboarding_record_signature(uuid,uuid,text,text,text,text)', 'execute'), false, 'signing runs only through the API');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.onboarding_sign_doc_add(uuid,uuid,text,text,text,text,bigint)', 'execute'), false, 'attaching runs only through the API');
  perform pg_temp.eq(has_function_privilege('service_role', 'public.onboarding_record_signature(uuid,uuid,text,text,text,text)', 'execute'), true, 'the API can sign');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.onboarding_finalize_contract(uuid,uuid,jsonb,jsonb)', 'execute'), false, 'finalizing runs only through the API');
  perform pg_temp.eq(has_function_privilege('service_role', 'public.onboarding_finalize_contract(uuid,uuid,jsonb,jsonb)', 'execute'), true, 'the API can finalize');
  perform pg_temp.eq(has_column_privilege('authenticated', 'public.onboarding_items', 'finalize', 'select'), false, 'browsers cannot read how HR finalized');
end $$;

select 'contract_signing tests passed' as result;
