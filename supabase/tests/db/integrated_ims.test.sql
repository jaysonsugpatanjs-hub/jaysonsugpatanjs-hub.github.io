-- Behavioural tests for the integrated IMS migration. Each block raises on
-- failure; ON_ERROR_STOP makes the run fail.

create temporary table ids (k text primary key, v uuid);
create or replace function pg_temp.id(p text) returns uuid language sql as $$ select v from ids where k = p $$;
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

-- People: the auth trigger creates training profiles.
insert into auth.users (email, raw_user_meta_data) values
  ('admin@panalo.test', '{"full_name":"System Admin"}'),
  ('doc@panalo.test', '{"full_name":"K Moreno"}'),
  ('sup@panalo.test', '{"full_name":"D Whitford"}'),
  ('hr@panalo.test', '{"full_name":"L Grant"}'),
  ('author@panalo.test', '{"full_name":"J Sugpatan"}'),
  ('weld@panalo.test', '{"full_name":"Welding Super"}'),
  ('whs@panalo.test', '{"full_name":"WHS Adviser"}'),
  ('learner@panalo.test', '{"full_name":"Marco Reyes"}');
insert into ids select split_part(email, '@', 1), id from public.training_profiles;
update public.training_profiles set role = 'admin' where id in (pg_temp.id('admin'), pg_temp.id('doc'));
insert into public.ims_group_members (group_key, profile_id) values
  ('document_controllers', pg_temp.id('doc')),
  ('supervisors', pg_temp.id('sup')),
  ('hr_admins', pg_temp.id('hr')),
  ('welding_supervisors', pg_temp.id('weld')),
  ('whs_advisers', pg_temp.id('whs'));

-- Staff on the employee register (the learner is linked later, by email).
insert into public.employees (employee_number, full_name, email, employment_type, status, profile_id)
select 'E-' || k, k, k || '@panalo.test', 'employee', 'active', v from ids where k in ('admin', 'doc', 'sup', 'hr', 'weld', 'whs');
insert into public.employees (employee_number, full_name, email, employment_type, status, profile_id)
values ('C-3001', 'Author Contractor', 'author@panalo.test', 'contractor', 'active', pg_temp.id('author'));

-- Folder tree --------------------------------------------------------------
do $$
declare
  v_root uuid; v_q uuid; v_iso uuid; v_whs uuid; v_hr uuid; v_trn uuid; v_per uuid;
begin
  perform pg_temp.expect_error(format('select public.ims_create_folder(%L, null, %L)', pg_temp.id('sup'), 'Root'), 'system administrator');
  v_root := public.ims_create_folder(pg_temp.id('admin'), null, 'Panalo Asset File');
  perform pg_temp.expect_error(format('select public.ims_create_folder(%L, null, %L)', pg_temp.id('admin'), 'Second root'), 'already exists');
  perform public.ims_set_grant(pg_temp.id('admin'), v_root, 'document_controllers', null, 'owner');
  perform public.ims_set_grant(pg_temp.id('admin'), v_root, 'all_employees', null, 'viewer');

  v_q := public.ims_create_folder(pg_temp.id('doc'), v_root, '06. QUALITY – ISO – CC3');
  v_iso := public.ims_create_folder(pg_temp.id('doc'), v_q, 'ISO 45001');
  v_whs := public.ims_create_folder(pg_temp.id('doc'), v_iso, '07_WHS');
  v_hr := public.ims_create_folder(pg_temp.id('doc'), v_root, '08. LABOUR HIRE & HR');
  v_trn := public.ims_create_folder(pg_temp.id('doc'), v_hr, 'Training modules');
  v_per := public.ims_create_folder(pg_temp.id('doc'), v_hr, 'Personnel records');
  insert into ids values ('root', v_root), ('q', v_q), ('iso', v_iso), ('whs_folder', v_whs), ('hr_folder', v_hr), ('trn', v_trn), ('per', v_per);

  perform pg_temp.expect_error(format('select public.ims_create_folder(%L, %L, %L)', pg_temp.id('sup'), v_q, 'Nope'), 'owner access');
  perform pg_temp.expect_error(format('select public.ims_create_folder(%L, %L, %L)', pg_temp.id('doc'), v_q, 'a/b'), 'check constraint');
end $$;

-- Inheritance --------------------------------------------------------------
do $$
begin
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('whs_folder'), pg_temp.id('sup')), 1, 'supervisor inherits viewer from root');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('whs_folder'), pg_temp.id('doc')), 4, 'document controller inherits owner');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('whs_folder'), pg_temp.id('admin')), 4, 'system admin owns via root');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('root'), pg_temp.id('learner')), 0, 'unlinked login (applicant) cannot browse');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('root'), pg_temp.id('author')), 0, 'contractors are not all employees');
  update public.employees set status = 'terminated' where profile_id = pg_temp.id('whs');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('root'), pg_temp.id('whs')), 0, 'terminated staff lose all-employees access');
  update public.employees set status = 'active' where profile_id = pg_temp.id('whs');

  perform public.ims_set_grant(pg_temp.id('doc'), pg_temp.id('whs_folder'), 'supervisors', null, 'editor');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('whs_folder'), pg_temp.id('sup')), 2, 'folder grant adds to inherited access');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('iso'), pg_temp.id('sup')), 1, 'grant does not flow upwards');

  -- HR folder: owned by HR, stops inheriting, document controllers keep view.
  perform public.ims_set_grant(pg_temp.id('doc'), pg_temp.id('hr_folder'), 'hr_admins', null, 'owner');
  perform public.ims_set_inherit(pg_temp.id('doc'), pg_temp.id('hr_folder'), false);
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('hr_folder'), pg_temp.id('doc')), 4, 'copied grants keep the actor in after stopping inheritance');
  perform pg_temp.eq((select inherit_access from public.ims_folders where id = pg_temp.id('hr_folder')), false, 'inheritance flag stored');
  perform public.ims_remove_grant(pg_temp.id('hr'), (select id from public.ims_folder_grants where folder_id = pg_temp.id('hr_folder') and principal_group = 'all_employees'));
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('hr_folder'), pg_temp.id('sup')), 0, 'removing the copied all-employees grant locks the folder');

  -- Personnel records: HR only.
  perform public.ims_set_inherit(pg_temp.id('hr'), pg_temp.id('per'), false);
  perform public.ims_remove_grant(pg_temp.id('hr'), (select id from public.ims_folder_grants where folder_id = pg_temp.id('per') and principal_group = 'document_controllers'));
  perform public.ims_remove_grant(pg_temp.id('hr'), (select id from public.ims_folder_grants where folder_id = pg_temp.id('per') and principal_group = 'system_admins'));
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('per'), pg_temp.id('doc')), 0, 'document controller locked out of personnel records');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('per'), pg_temp.id('hr')), 4, 'HR keeps ownership');
  perform pg_temp.expect_error(
    format('select public.ims_remove_grant(%L, %L)', pg_temp.id('hr'),
      (select id from public.ims_folder_grants where folder_id = pg_temp.id('per') and principal_group = 'hr_admins')),
    'last owner');

  -- Training modules: approvers added, supervisors view.
  perform public.ims_set_grant(pg_temp.id('doc'), pg_temp.id('trn'), 'welding_supervisors', null, 'approver');
  perform public.ims_set_grant(pg_temp.id('doc'), pg_temp.id('trn'), 'whs_advisers', null, 'approver');
  perform public.ims_set_grant(pg_temp.id('doc'), pg_temp.id('trn'), null, pg_temp.id('author'), 'editor');
  perform pg_temp.expect_error(format('select public.ims_set_grant(%L, %L, %L, null, %L)', pg_temp.id('sup'), pg_temp.id('trn'), 'supervisors', 'owner'), 'owner access');
  perform pg_temp.expect_error(format('select public.ims_set_grant(%L, %L, %L, %L, %L)', pg_temp.id('doc'), pg_temp.id('trn'), 'supervisors', pg_temp.id('sup'), 'viewer'), 'exactly one');

  update public.training_profiles set active = false where id = pg_temp.id('weld');
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('trn'), pg_temp.id('weld')), 0, 'inactive profiles have no access');
  update public.training_profiles set active = true where id = pg_temp.id('weld');
end $$;

-- Documents and approval gates ---------------------------------------------
do $$
declare
  v_module uuid; v_version uuid; v_doc uuid; v_rev uuid; v_rev2 uuid; v_result jsonb;
begin
  insert into public.training_modules (code, slug, title) values ('PP-TRN-WLD-001', 'pp-trn-wld-001', 'Hot Work') returning id into v_module;
  insert into public.training_module_versions (module_id, revision, content_version, slide_count, storage_prefix, learner_manifest, answer_key)
  values (v_module, 'Draft Rev 1', 'wld-r1', 20, 'pp-trn-wld-001/wld-r1', '{}', '{}') returning id into v_version;

  perform pg_temp.expect_error(format('select public.ims_create_document(%L, %L, %L, %L, %L)', pg_temp.id('sup'), pg_temp.id('trn'), 'PP-TRN-WLD-001', 'Hot Work', 'Training module'), 'editor access');
  v_doc := public.ims_create_document(pg_temp.id('author'), pg_temp.id('trn'), 'pp-trn-wld-001', 'Hot Work: MIG Welding and Grinding Safety',
    'Training module', array['technical', 'whs', 'ims'], 12, null);
  perform pg_temp.eq((select doc_number from public.ims_documents where id = v_doc), 'PP-TRN-WLD-001', 'document number upper-cased');
  v_rev := public.ims_create_revision(pg_temp.id('author'), v_doc, 'Rev 1', 'Secure module rebuild', 'F01-0007');
  perform pg_temp.expect_error(format('select public.ims_create_revision(%L, %L, %L, %L)', pg_temp.id('author'), v_doc, 'Rev 1b', 'second open'), 'ims_one_open_revision');

  -- Publishing is blocked until linked and approved.
  perform pg_temp.expect_error(format('select public.training_publish_version(%L, %L)', pg_temp.id('doc'), v_version), 'Link this version');
  perform public.training_link_ims_revision(pg_temp.id('doc'), v_version, v_rev);
  perform pg_temp.eq((select training_module_id from public.ims_documents where id = v_doc), v_module, 'document now controls the module');
  perform pg_temp.expect_error(format('select public.training_publish_version(%L, %L)', pg_temp.id('doc'), v_version), 'not approved');

  perform pg_temp.expect_error(format('select public.ims_record_approval(%L, %L, %L)', pg_temp.id('weld'), v_rev, 'technical'), 'Attach the revision file');
  perform pg_temp.expect_error(format('select public.ims_attach_revision_file(%L, %L, %L)', pg_temp.id('author'), v_rev, 'elsewhere/file.pdf'), 'Invalid revision file path');
  perform public.ims_attach_revision_file(pg_temp.id('author'), v_rev, v_doc || '/' || v_rev || '/PP-TRN-WLD-001-Rev1.pptx');

  perform pg_temp.expect_error(format('select public.ims_record_approval(%L, %L, %L)', pg_temp.id('author'), v_rev, 'technical'), 'approver access');
  perform public.ims_set_grant(pg_temp.id('doc'), pg_temp.id('trn'), null, pg_temp.id('author'), 'approver');
  perform pg_temp.expect_error(format('select public.ims_record_approval(%L, %L, %L)', pg_temp.id('author'), v_rev, 'technical'), 'author cannot approve');
  perform pg_temp.expect_error(format('select public.ims_record_approval(%L, %L, %L)', pg_temp.id('sup'), v_rev, 'technical'), 'approver access');

  v_result := public.ims_record_approval(pg_temp.id('weld'), v_rev, 'technical', 'Content checked');
  perform pg_temp.eq(v_result ->> 'approved', 'false', 'one of three gates');
  perform pg_temp.expect_error(format('select public.ims_record_approval(%L, %L, %L)', pg_temp.id('whs'), v_rev, 'technical'), 'duplicate key');
  perform pg_temp.expect_error(format('select public.ims_attach_revision_file(%L, %L, %L)', pg_temp.id('author'), v_rev, v_doc || '/' || v_rev || '/other.pptx'), 'cannot change after an approval');
  perform public.ims_record_approval(pg_temp.id('whs'), v_rev, 'whs');
  v_result := public.ims_record_approval(pg_temp.id('doc'), v_rev, 'ims');
  perform pg_temp.eq(v_result ->> 'approved', 'true', 'all gates approve the revision');
  perform pg_temp.eq((select status from public.ims_document_revisions where id = v_rev), 'approved', 'revision approved');
  perform pg_temp.eq((select current_revision_id from public.ims_documents where id = v_doc), v_rev, 'document points at approved revision');
  perform pg_temp.eq((select review_due is not null from public.ims_documents where id = v_doc), true, 'review date set on approval');

  v_result := public.training_publish_version(pg_temp.id('doc'), v_version);
  perform pg_temp.eq((select published from public.training_module_versions where id = v_version), true, 'version published');
  perform pg_temp.eq((select current_version_id from public.training_modules where id = v_module), v_version, 'module current version');
  perform pg_temp.expect_error(format('select public.training_link_ims_revision(%L, %L, %L)', pg_temp.id('doc'), v_version, v_rev), 'immutable');

  -- A second revision supersedes the first on approval.
  v_rev2 := public.ims_create_revision(pg_temp.id('author'), v_doc, 'Rev 2', 'Question bank refresh', null);
  perform public.ims_attach_revision_file(pg_temp.id('author'), v_rev2, v_doc || '/' || v_rev2 || '/rev2.pptx');
  perform public.ims_record_approval(pg_temp.id('weld'), v_rev2, 'technical');
  perform public.ims_record_approval(pg_temp.id('whs'), v_rev2, 'whs');
  perform public.ims_record_approval(pg_temp.id('doc'), v_rev2, 'ims');
  perform pg_temp.eq((select status from public.ims_document_revisions where id = v_rev), 'superseded', 'previous revision superseded');

  insert into ids values ('module', v_module), ('version', v_version);
end $$;

-- Atomic training operations -----------------------------------------------
do $$
declare
  v_result jsonb; v_assignment uuid; v_emp uuid; v_position uuid; v_count integer;
begin
  insert into public.positions (code, title) values ('WELDER', 'Welder / Fabricator') returning id into v_position;
  v_emp := public.employee_save(pg_temp.id('admin'), jsonb_build_object(
    'employeeNumber', 'E-1001', 'fullName', 'Marco Reyes', 'email', 'Learner@Panalo.test', 'positionId', v_position));
  perform pg_temp.eq((select profile_id from public.employees where id = v_emp), pg_temp.id('learner'), 'employee linked to existing profile by email');
  perform pg_temp.expect_error(format('select public.employee_save(%L, %L)', pg_temp.id('sup'), '{"employeeNumber":"E-9","fullName":"x"}'), 'administrator access');

  perform pg_temp.expect_error(format('select public.training_assign(%L, %L, %L, %L, null, %L, %L, now() + interval %L, false)',
    pg_temp.id('sup'), pg_temp.id('learner'), 'learner@panalo.test', 'Marco Reyes', 'employee', pg_temp.id('version'), '14 days'), 'administrator access');
  v_result := public.training_assign(pg_temp.id('admin'), pg_temp.id('learner'), 'learner@panalo.test', 'Marco Reyes', 'E-1001',
    'employee', pg_temp.id('version'), now() + interval '14 days', true);
  v_assignment := (v_result ->> 'id')::uuid;
  perform pg_temp.eq(v_result ->> 'moduleCode', 'PP-TRN-WLD-001', 'assignment returns module');
  perform public.training_assign(pg_temp.id('admin'), pg_temp.id('learner'), 'learner@panalo.test', 'Marco Reyes', 'E-1001',
    'employee', pg_temp.id('version'), now() + interval '30 days', false);
  perform pg_temp.eq((select count(*)::integer from public.training_assignments where learner_id = pg_temp.id('learner')), 1, 're-assigning extends rather than duplicates');

  perform pg_temp.expect_error(format('select public.training_record_practical(%L, %L, null, %L, current_date, null, %L, %L)',
    pg_temp.id('admin'), v_assignment, 'D Whitford', 'competent', ''), 'passed theory');
  update public.training_assignments set status = 'theory_passed', theory_passed_at = now() where id = v_assignment;
  perform pg_temp.expect_error(format('select public.training_record_practical(%L, %L, null, %L, current_date + 5, null, %L, %L)',
    pg_temp.id('admin'), v_assignment, 'D Whitford', 'competent', ''), 'future');
  perform public.training_record_practical(pg_temp.id('admin'), v_assignment, null, 'D Whitford', current_date, null, 'competent', 'Observed two joints');

  perform public.training_revoke(pg_temp.id('admin'), v_assignment, 'Left the company');
  perform pg_temp.eq((select status from public.training_assignments where id = v_assignment), 'revoked', 'assignment revoked');

  select count(*) into v_count from public.training_audit_events
  where event_type in ('learner_invited_and_assigned', 'learner_assigned', 'practical_verification_recorded', 'assignment_revoked',
                       'module_published', 'ims_revision_approved', 'ims_access_granted', 'ims_inheritance_stopped', 'employee_created');
  if v_count < 9 then
    raise exception 'Expected audit rows for every action, found %', v_count;
  end if;
end $$;

-- A failed action leaves no audit row behind.
do $$
declare
  v_before integer; v_after integer;
begin
  select count(*) into v_before from public.training_audit_events;
  perform pg_temp.expect_error(format('select public.training_publish_version(%L, gen_random_uuid())', pg_temp.id('doc')), 'not found');
  select count(*) into v_after from public.training_audit_events;
  perform pg_temp.eq(v_after, v_before, 'no audit row for a failed action');
end $$;

-- Reference data and membership ---------------------------------------------
do $$
declare
  v_site uuid; v_pos uuid; v_lic uuid; v_emp uuid;
begin
  perform pg_temp.expect_error(format('select public.admin_set_group_member(%L, %L, %L, true)', pg_temp.id('admin'), 'all_employees', pg_temp.id('sup')), 'automatic');
  perform public.admin_set_group_member(pg_temp.id('admin'), 'supervisors', pg_temp.id('hr'), true);
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('whs_folder'), pg_temp.id('hr')), 2, 'new group member gets the group access');
  perform public.admin_set_group_member(pg_temp.id('admin'), 'supervisors', pg_temp.id('hr'), false);
  perform pg_temp.eq(public.ims_folder_level(pg_temp.id('whs_folder'), pg_temp.id('hr')), 1, 'removed member loses it');

  v_site := public.admin_save_site(pg_temp.id('admin'), '{"code":"main","name":"Main workshop"}');
  v_pos := public.admin_save_position(pg_temp.id('admin'), '{"code":"lh","title":"Leading Hand","safetyCritical":true}');
  perform public.admin_set_requirement(pg_temp.id('admin'), v_pos, pg_temp.id('module'), true, 24, false);
  perform pg_temp.eq((select refresher_months from public.position_requirements where position_id = v_pos), 24, 'requirement stored');
  perform public.admin_set_requirement(pg_temp.id('admin'), v_pos, pg_temp.id('module'), false, null, false);
  perform pg_temp.eq((select count(*)::integer from public.position_requirements where position_id = v_pos), 0, 'requirement removed');

  v_emp := public.employee_save(pg_temp.id('admin'), jsonb_build_object('employeeNumber', 'E-1003', 'fullName', 'Liam Tran', 'siteId', v_site, 'positionId', v_pos));
  v_lic := public.admin_save_licence(pg_temp.id('admin'), jsonb_build_object('employeeId', v_emp, 'licenceType', 'First aid', 'expiresOn', '2026-10-22', 'verified', true));
  perform pg_temp.eq((select verified_by from public.licences where id = v_lic), pg_temp.id('admin'), 'licence verification recorded');
  perform pg_temp.expect_error(format('select public.admin_save_licence(%L, %L)', pg_temp.id('admin'),
    jsonb_build_object('employeeId', v_emp, 'licenceType', 'Bad', 'issuedOn', '2026-05-01', 'expiresOn', '2026-01-01')), 'check constraint');
  perform public.admin_delete_licence(pg_temp.id('admin'), v_lic);
  perform pg_temp.expect_error(format('select public.admin_save_site(%L, %L)', pg_temp.id('sup'), '{"code":"X1","name":"x"}'), 'administrator access');
end $$;

-- Browser roles stay locked out ---------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['employees', 'ims_folders', 'ims_folder_grants', 'ims_documents', 'ims_document_revisions', 'practical_verifications']
  loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then
      raise exception 'Browser role can read %', t;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.ims_set_grant(uuid, uuid, text, uuid, text)', 'execute') then
    raise exception 'Browser role can execute ims_set_grant';
  end if;
  if not has_function_privilege('service_role', 'public.ims_record_approval(uuid, uuid, text, text)', 'execute') then
    raise exception 'Service role cannot execute ims_record_approval';
  end if;
end $$;

select 'integrated_ims tests passed' as result;
