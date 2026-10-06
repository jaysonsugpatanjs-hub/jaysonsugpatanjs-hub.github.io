-- Behavioural tests for sign-in accounts, permissions and HR onboarding.
-- Self-contained: creates its own people (emails under @access.test).

create temporary table aid (k text primary key, v uuid);
create or replace function pg_temp.a(p text) returns uuid language sql as $$ select v from aid where k = p $$;
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

insert into auth.users (email) values
  ('boss@access.test'), ('hr@access.test'), ('lead@access.test'), ('worker@access.test'), ('other@access.test'), ('applicant@access.test');
insert into aid select split_part(email, '@', 1), id from public.training_profiles where email like '%@access.test';
update public.training_profiles set role = 'admin' where id = pg_temp.a('boss');

do $$
declare
  v_hrpos uuid; v_lead uuid; v_weld uuid; v_lead_emp uuid; v_mod uuid; v_ver uuid; v_asg uuid;
begin
  insert into public.positions (code, title) values ('HRMGR', 'HR Manager') returning id into v_hrpos;
  insert into public.positions (code, title) values ('LEADHAND', 'Leading Hand') returning id into v_lead;
  insert into public.positions (code, title) values ('WELDX', 'Welder') returning id into v_weld;
  insert into aid values ('hrpos', v_hrpos), ('leadpos', v_lead), ('weldpos', v_weld);

  -- Position defaults, set by a system admin.
  perform public.app_set_position_permission(pg_temp.a('boss'), v_hrpos, 'hr.manage', true);
  perform public.app_set_position_permission(pg_temp.a('boss'), v_hrpos, 'people.view', true);
  perform public.app_set_position_permission(pg_temp.a('boss'), v_lead, 'competency.team', true);

  insert into public.employees (employee_number, full_name, email, position_id, profile_id) values
    ('X-HR', 'HR Person', 'hr@access.test', v_hrpos, pg_temp.a('hr'));
  insert into public.employees (employee_number, full_name, email, position_id, profile_id) values
    ('X-LEAD', 'Lead Hand', 'lead@access.test', v_lead, pg_temp.a('lead')) returning id into v_lead_emp;
  insert into public.employees (employee_number, full_name, email, position_id, profile_id, supervisor_id) values
    ('X-WORK', 'Worker', 'worker@access.test', v_weld, pg_temp.a('worker'), v_lead_emp);
  insert into public.employees (employee_number, full_name, email, position_id, profile_id) values
    ('X-OTHER', 'Other Worker', 'other@access.test', v_weld, pg_temp.a('other'));
  insert into public.employees (employee_number, full_name, email, employment_type, status) values
    ('A-NEW', 'New Applicant', 'applicant@access.test', 'applicant', 'applicant');

  -- Effective permissions.
  perform pg_temp.eq(public.app_has(pg_temp.a('hr'), 'hr.manage'), true, 'position grants hr.manage');
  perform pg_temp.eq(public.app_has(pg_temp.a('hr'), 'training.manage'), false, 'position does not grant training');
  perform pg_temp.eq(public.app_has(pg_temp.a('boss'), 'access.manage'), true, 'system admin holds everything');
  perform pg_temp.eq(public.app_has(pg_temp.a('worker'), 'people.view'), false, 'worker has nothing by default');
  perform public.app_set_profile_permission(pg_temp.a('boss'), pg_temp.a('worker'), 'people.view', 'allow');
  perform pg_temp.eq(public.app_has(pg_temp.a('worker'), 'people.view'), true, 'per-person allow');
  perform public.app_set_profile_permission(pg_temp.a('boss'), pg_temp.a('hr'), 'people.view', 'deny');
  perform pg_temp.eq(public.app_has(pg_temp.a('hr'), 'people.view'), false, 'per-person deny beats position');
  perform public.app_set_profile_permission(pg_temp.a('boss'), pg_temp.a('hr'), 'people.view', 'default');
  perform pg_temp.eq(public.app_has(pg_temp.a('hr'), 'people.view'), true, 'default follows position again');
  perform pg_temp.expect_error(format('select public.app_set_profile_permission(%L, %L, %L, %L)', pg_temp.a('hr'), pg_temp.a('hr'), 'training.manage', 'allow'), 'permission');
  perform pg_temp.expect_error(format('select public.app_set_profile_permission(%L, %L, %L, %L)', pg_temp.a('boss'), pg_temp.a('boss'), 'access.manage', 'deny'), 'own access');
  update public.employees set status = 'terminated' where profile_id = pg_temp.a('hr');
  perform pg_temp.eq(public.app_has(pg_temp.a('hr'), 'hr.manage'), false, 'terminated staff lose position permissions');
  update public.employees set status = 'active' where profile_id = pg_temp.a('hr');
  update public.training_profiles set active = false where id = pg_temp.a('boss');
  perform pg_temp.eq(cardinality(public.app_permissions_for(pg_temp.a('boss'))), 0, 'inactive admin holds nothing');
  update public.training_profiles set active = true where id = pg_temp.a('boss');

  -- Old admin-only functions now follow permissions.
  perform pg_temp.expect_error(format('select public.employee_save(%L, %L)', pg_temp.a('hr'), '{"employeeNumber":"Z-1","fullName":"Z"}'), 'Manage the people register');
  perform public.app_set_profile_permission(pg_temp.a('boss'), pg_temp.a('hr'), 'people.manage', 'allow');
  perform public.employee_save(pg_temp.a('hr'), '{"employeeNumber":"Z-1","fullName":"Z"}');

  -- Supervisors record practicals for their own team only.
  insert into public.training_modules (code, slug, title) values ('PP-TRN-ACC-001', 'pp-trn-acc-001', 'Access test') returning id into v_mod;
  insert into public.training_module_versions (module_id, revision, content_version, slide_count, storage_prefix, learner_manifest, answer_key, published)
  values (v_mod, 'Rev 1', 'acc-r1', 2, 'pp-trn-acc-001/acc-r1', '{}', '{}', true) returning id into v_ver;
  insert into public.training_assignments (learner_id, module_version_id, expires_at, status, theory_passed_at)
  values (pg_temp.a('worker'), v_ver, now() + interval '30 days', 'theory_passed', now()) returning id into v_asg;
  perform public.training_record_practical(pg_temp.a('lead'), v_asg, null, 'Lead Hand', current_date, null, 'competent', '');
  insert into public.training_assignments (learner_id, module_version_id, expires_at, status, theory_passed_at)
  values (pg_temp.a('other'), v_ver, now() + interval '30 days', 'theory_passed', now()) returning id into v_asg;
  perform pg_temp.expect_error(format('select public.training_record_practical(%L, %L, null, %L, current_date, null, %L, %L)',
    pg_temp.a('lead'), v_asg, 'Lead Hand', 'competent', ''), 'people you supervise');
  perform pg_temp.expect_error(format('select public.training_assign(%L, %L, %L, %L, null, %L, %L, now() + interval %L, false)',
    pg_temp.a('hr'), pg_temp.a('other'), 'other@access.test', 'Other', 'employee', v_ver, '5 days'), 'Training administration');
end $$;

-- Accounts --------------------------------------------------------------------
do $$
begin
  perform pg_temp.expect_error(format('select public.account_temp_password_issued(%L, %L, false)', pg_temp.a('hr'), pg_temp.a('worker')), 'Sign-in and access');
  perform public.app_set_profile_permission(pg_temp.a('boss'), pg_temp.a('lead'), 'training.manage', 'allow');
  perform pg_temp.expect_error(format('select public.account_temp_password_issued(%L, %L, false)', pg_temp.a('lead'), pg_temp.a('worker')), 'Sign-in and access');
  perform public.account_temp_password_issued(pg_temp.a('lead'), pg_temp.a('other'), true);
  update public.training_profiles set must_change_password = false where id = pg_temp.a('other');
  perform public.account_temp_password_issued(pg_temp.a('boss'), pg_temp.a('worker'), false);
  perform pg_temp.eq((select must_change_password from public.training_profiles where id = pg_temp.a('worker')), true, 'temporary password forces a change');
  perform public.account_password_changed(pg_temp.a('worker'));
  perform pg_temp.eq((select must_change_password from public.training_profiles where id = pg_temp.a('worker')), false, 'change clears the flag');
  perform pg_temp.eq((select password_set_at is not null from public.training_profiles where id = pg_temp.a('worker')), true, 'change time recorded');
  perform pg_temp.expect_error(format('select public.account_set_active(%L, %L, false)', pg_temp.a('boss'), pg_temp.a('boss')), 'own sign-in');
  perform public.account_set_active(pg_temp.a('boss'), pg_temp.a('other'), false);
  perform pg_temp.eq((select active from public.training_profiles where id = pg_temp.a('other')), false, 'sign-in disabled');
  perform public.account_link_employee(pg_temp.a('hr'), (select id from public.employees where employee_number = 'A-NEW'), pg_temp.a('applicant'));
  perform pg_temp.eq((select learner_type from public.training_profiles where id = pg_temp.a('applicant')), 'applicant', 'link copies register details');
  perform pg_temp.expect_error(format('select public.account_link_employee(%L, %L, %L)', pg_temp.a('boss'),
    (select id from public.employees where employee_number = 'A-NEW'), pg_temp.a('worker')), 'different sign-in');
  if exists (select 1 from public.training_audit_events where event_type like '%password%' and details::text ~* 'password"\s*:') then
    raise exception 'A password value appears in the audit log';
  end if;
end $$;

-- Onboarding ------------------------------------------------------------------
do $$
declare
  v_req uuid; v_item uuid; v_opt uuid; v_form uuid; v_file uuid; v_emp uuid; v_result jsonb;
begin
  v_emp := (select id from public.employees where employee_number = 'A-NEW');
  perform pg_temp.expect_error(format('select public.onboarding_create(%L, %L, %L, null, %L)', pg_temp.a('worker'), v_emp, '{tfn_declaration}', ''), 'HR onboarding');
  perform pg_temp.expect_error(format('select public.hr_document_type_save(%L, %L, %L, %L, true, true)', pg_temp.a('worker'), 'tickets', 'Tickets', ''), 'HR onboarding');
  perform public.hr_document_type_save(pg_temp.a('hr'), 'tickets', 'Licences and tickets', 'Combine into one PDF.', false, true);
  perform pg_temp.expect_error(format('select public.onboarding_create(%L, %L, %L, null, %L)', pg_temp.a('hr'), v_emp, '{nope}', ''), 'Unknown document');
  perform pg_temp.expect_error(format('select public.onboarding_create(%L, %L, %L, null, %L)', pg_temp.a('hr'), v_emp, '{white_card}', ''), 'Unknown document');
  perform pg_temp.expect_error(format('select public.onboarding_create(%L, %L, %L, current_date - 1, %L)', pg_temp.a('hr'), v_emp, '{tfn_declaration}', ''), 'past');
  v_req := public.onboarding_create(pg_temp.a('hr'), v_emp, '{tfn_declaration,contract,tickets}', current_date + 7, 'Welcome aboard');
  perform pg_temp.expect_error(format('select public.onboarding_create(%L, %L, %L, null, %L)', pg_temp.a('hr'), v_emp, '{photo_id}', ''), 'onboarding_one_open_per_person');
  select id into v_item from public.onboarding_items where request_id = v_req and doc_type = 'contract';
  select id into v_form from public.onboarding_items where request_id = v_req and doc_type = 'tfn_declaration';

  -- Forms take typed answers, never files; uploads never take answers.
  perform pg_temp.expect_error(format('select public.onboarding_record_upload(%L, %L, %L, %L)', pg_temp.a('applicant'), v_form, v_req || '/' || v_form || '/t.pdf', 't.pdf'), 'Fill in this item');
  perform pg_temp.expect_error(format('select public.onboarding_record_answers(%L, %L, %L)', pg_temp.a('applicant'), v_item, '{"a":"b"}'), 'needs a file');
  perform pg_temp.expect_error(format('select public.onboarding_record_answers(%L, %L, %L)', pg_temp.a('worker'), v_form, '{"a":"b"}'), 'not found');
  perform pg_temp.expect_error(format('select public.onboarding_record_answers(%L, %L, %L)', pg_temp.a('applicant'), v_form, '[1]'), 'missing');
  perform public.onboarding_record_answers(pg_temp.a('applicant'), v_form, '{"tfn_option":"I''ll provide my TFN","tfn":"123456782"}');
  perform pg_temp.eq((select status from public.onboarding_items where id = v_form), 'uploaded', 'submitted form waits for HR');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type = 'onboarding_form_submitted' and details::text like '%123456782%'), 0, 'answers stay out of the audit log');
  perform public.onboarding_review(pg_temp.a('hr'), v_form, true, null);
  perform pg_temp.expect_error(format('select public.onboarding_record_answers(%L, %L, %L)', pg_temp.a('applicant'), v_form, '{"a":"b"}'), 'already been accepted');
  select id into v_opt from public.onboarding_items where request_id = v_req and doc_type = 'tickets';
  perform pg_temp.eq((select required from public.onboarding_items where id = v_opt), false, 'optional item copied from type');

  -- Only the applicant can upload, and only to their own path.
  perform pg_temp.expect_error(format('select public.onboarding_record_upload(%L, %L, %L, %L)', pg_temp.a('worker'), v_item, v_req || '/' || v_item || '/a.pdf', 'a.pdf'), 'not found');
  perform pg_temp.expect_error(format('select public.onboarding_record_upload(%L, %L, %L, %L)', pg_temp.a('applicant'), v_item, 'elsewhere/a.pdf', 'a.pdf'), 'Invalid upload path');
  perform pg_temp.expect_error(format('select public.onboarding_review(%L, %L, true, null)', pg_temp.a('hr'), v_item), 'Only an uploaded');
  perform public.onboarding_record_upload(pg_temp.a('applicant'), v_item, v_req || '/' || v_item || '/contract-1.pdf', 'Contract.pdf');

  -- HR review: rejection needs a reason; re-upload; acceptance completes it.
  perform pg_temp.expect_error(format('select public.onboarding_review(%L, %L, false, %L)', pg_temp.a('hr'), v_item, ''), 'reason');
  perform public.onboarding_review(pg_temp.a('hr'), v_item, false, 'Page 2 is missing the signature');
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'rejected', 'rejected');
  perform public.onboarding_record_upload(pg_temp.a('applicant'), v_item, v_req || '/' || v_item || '/contract-2.pdf', 'Contract signed.pdf');
  perform pg_temp.eq((select reject_reason from public.onboarding_items where id = v_item), null::text, 're-upload clears the reason');
  v_result := public.onboarding_review(pg_temp.a('hr'), v_item, true, null);
  perform pg_temp.eq(v_result ->> 'requestComplete', 'true', 'optional items do not block completion');
  perform pg_temp.eq((select status from public.onboarding_requests where id = v_req), 'complete', 'request complete');
  perform pg_temp.expect_error(format('select public.onboarding_record_upload(%L, %L, %L, %L)', pg_temp.a('applicant'), v_opt, v_req || '/' || v_opt || '/t.pdf', 't.pdf'), 'closed');

  -- HR cannot review their own documents; cancelled requests are closed.
  v_req := public.onboarding_create(pg_temp.a('boss'), (select id from public.employees where employee_number = 'X-HR'), '{certificates}', null, '');
  select id into v_item from public.onboarding_items where request_id = v_req;
  perform public.onboarding_record_upload(pg_temp.a('hr'), v_item, v_req || '/' || v_item || '/id.jpg', 'id.jpg');
  perform pg_temp.expect_error(format('select public.onboarding_review(%L, %L, true, null)', pg_temp.a('hr'), v_item), 'your own');

  -- Several named files per item; removing the last one sends it back to "to do".
  perform pg_temp.expect_error(format('select public.onboarding_add_file(%L, %L, %L, %L, %L, null)', pg_temp.a('hr'), v_item, v_req || '/' || v_item || '/b.jpg', 'b.jpg', ''), 'Say what the file is');
  v_file := public.onboarding_add_file(pg_temp.a('hr'), v_item, v_req || '/' || v_item || '/fl.jpg', 'fl.jpg', 'Forklift licence', current_date + 300);
  perform pg_temp.eq((select count(*)::int from public.onboarding_files where item_id = v_item), 2, 'two files on the item');
  perform pg_temp.expect_error(format('select public.onboarding_remove_file(%L, %L)', pg_temp.a('worker'), v_file), 'not found');
  perform pg_temp.eq(public.onboarding_remove_file(pg_temp.a('hr'), v_file), v_req || '/' || v_item || '/fl.jpg', 'remove returns the stored path');
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'uploaded', 'one file left: still waiting for HR');
  perform public.onboarding_remove_file(pg_temp.a('hr'), (select id from public.onboarding_files where item_id = v_item));
  perform pg_temp.eq((select status from public.onboarding_items where id = v_item), 'pending', 'no files left: back to to-do');
  perform pg_temp.eq((select file_path from public.onboarding_items where id = v_item), null::text, 'item path cleared');
  perform public.onboarding_add_file(pg_temp.a('hr'), v_item, v_req || '/' || v_item || '/wc.jpg', 'wc.jpg', 'White Card', null);
  perform public.onboarding_cancel(pg_temp.a('boss'), v_req, 'Sent in error');
  perform pg_temp.expect_error(format('select public.onboarding_review(%L, %L, true, null)', pg_temp.a('boss'), v_item), 'closed');
end $$;

-- Personnel files ------------------------------------------------------------------
do $$
declare
  v_emp uuid := (select id from public.employees where employee_number = 'A-NEW');
  v_item uuid; v_doc uuid; v_again uuid;
begin
  select i.id into v_item from public.onboarding_items i join public.onboarding_requests r on r.id = i.request_id
  where r.employee_id = v_emp and i.doc_type = 'tfn_declaration' and i.status = 'accepted';
  perform pg_temp.eq((select personnel_category from public.hr_document_types where key = 'tfn_declaration'), 'tax', 'TFN files under tax');
  perform pg_temp.expect_error(format('select public.personnel_file_document(%L, %L, %L, %L, %L, %L, %L, %L, null, null)',
    pg_temp.a('worker'), v_emp, 'tax', 'TFN', 'personnel/' || v_emp || '/tax/a.pdf', 'a.pdf', 'onboarding_form', v_item), 'HR onboarding');
  perform pg_temp.expect_error(format('select public.personnel_file_document(%L, %L, %L, %L, %L, %L, %L, null, null, null)',
    pg_temp.a('hr'), v_emp, 'tax', 'Note', 'personnel/' || v_emp || '/banking/a.pdf', 'a.pdf', 'hr_upload'), 'Invalid upload path');
  perform pg_temp.expect_error(format('select public.personnel_file_document(%L, %L, %L, %L, %L, %L, %L, null, null, null)',
    pg_temp.a('hr'), v_emp, 'nope', 'Note', 'personnel/' || v_emp || '/nope/a.pdf', 'a.pdf', 'hr_upload'), 'Unknown HR folder');
  v_doc := public.personnel_file_document(pg_temp.a('hr'), v_emp, 'tax', 'Tax file number declaration', 'personnel/' || v_emp || '/tax/tfn.pdf', 'tfn.pdf', 'onboarding_form', v_item, null, null);
  v_again := public.personnel_file_document(pg_temp.a('hr'), v_emp, 'tax', 'Tax file number declaration', 'personnel/' || v_emp || '/tax/tfn-2.pdf', 'tfn-2.pdf', 'onboarding_form', v_item, null, null);
  perform pg_temp.eq(v_again, v_doc, 'filing the same form twice returns the first record');
  perform pg_temp.expect_error(format('select public.personnel_archive_document(%L, %L, %L)', pg_temp.a('hr'), v_doc, ''), 'reason');
  perform public.personnel_archive_document(pg_temp.a('hr'), v_doc, 'Superseded by new declaration');
  perform pg_temp.expect_error(format('select public.personnel_archive_document(%L, %L, %L)', pg_temp.a('hr'), v_doc, 'again'), 'already archived');
  perform pg_temp.eq((select count(*)::int from public.personnel_documents where id = v_doc), 1, 'archived, not deleted');
end $$;

-- Browser roles stay locked out -------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['personnel_documents', 'personnel_categories', 'onboarding_files', 'onboarding_items', 'onboarding_requests', 'profile_permissions', 'position_permissions', 'hr_document_types']
  loop
    if has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'Browser role can read %', t;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.account_temp_password_issued(uuid, uuid, boolean)', 'execute') then
    raise exception 'Browser role can issue passwords';
  end if;
end $$;

select 'access_onboarding tests passed' as result;
