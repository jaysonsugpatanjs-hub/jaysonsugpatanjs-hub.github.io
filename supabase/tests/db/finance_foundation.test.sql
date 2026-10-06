-- Behavioural tests for the Panalo Accounts foundation (Phase 1).
-- Self-contained: creates its own people (emails under @fin.test).

create temporary table fid (k text primary key, v uuid);
create or replace function pg_temp.f(p text) returns uuid language sql as $$ select v from fid where k = p $$;
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

insert into auth.users (email) values ('sysadmin@fin.test'), ('finance@fin.test'), ('director@fin.test'), ('payroll@fin.test'), ('staff@fin.test');
insert into fid select split_part(email, '@', 1), id from public.training_profiles where email like '%@fin.test';
update public.training_profiles set role = 'admin' where id = pg_temp.f('sysadmin');

-- Validators ------------------------------------------------------------------
do $$
begin
  perform pg_temp.eq(public.app_valid_abn('51 824 753 556'), true, 'ATO example ABN');
  perform pg_temp.eq(public.app_valid_abn('51 824 753 557'), false, 'bad ABN check digit');
  perform pg_temp.eq(public.app_valid_acn('000 000 019'), true, 'ASIC example ACN');
  perform pg_temp.eq(public.app_valid_acn('004 085 616'), true, 'real-format ACN');
  perform pg_temp.eq(public.app_valid_acn('004 085 617'), false, 'bad ACN check digit');
end $$;

-- Organisation, roles and permissions ------------------------------------------
do $$
begin
  perform pg_temp.eq(public.app_org_of(pg_temp.f('staff')), '00000000-0000-4000-8000-000000000001'::uuid, 'new profiles belong to Panalo');
  perform pg_temp.eq(public.app_has(pg_temp.f('sysadmin'), 'org.manage'), true, 'system admin holds finance keys');
  perform pg_temp.eq(public.app_has(pg_temp.f('sysadmin'), 'payroll.sensitive'), false, 'system admin does NOT get payroll details');
  perform pg_temp.eq(public.app_mfa_required(pg_temp.f('sysadmin')), true, 'privileged admin needs MFA');
  perform pg_temp.eq(public.app_mfa_required(pg_temp.f('staff')), false, 'ordinary staff need no MFA');

  perform pg_temp.expect_error(format('select public.app_set_profile_role(%L, %L, %L, true)', pg_temp.f('staff'), pg_temp.f('finance'), 'finance_admin'), 'Sign-in and access');
  perform pg_temp.expect_error(format('select public.app_set_profile_role(%L, %L, %L, true)', pg_temp.f('sysadmin'), pg_temp.f('sysadmin'), 'director'), 'Someone else');
  perform pg_temp.expect_error(format('select public.app_set_profile_role(%L, %L, %L, true)', pg_temp.f('sysadmin'), pg_temp.f('finance'), 'nope'), 'Unknown role');
  perform public.app_set_profile_role(pg_temp.f('sysadmin'), pg_temp.f('finance'), 'finance_admin', true);
  perform public.app_set_profile_role(pg_temp.f('sysadmin'), pg_temp.f('director'), 'director', true);
  perform public.app_set_profile_role(pg_temp.f('sysadmin'), pg_temp.f('payroll'), 'payroll_admin', true);
  perform pg_temp.eq(public.app_has(pg_temp.f('finance'), 'bank.manage'), true, 'finance admin role grants banking');
  perform pg_temp.eq(public.app_has(pg_temp.f('finance'), 'payroll.sensitive'), false, 'finance admin cannot see payroll details');
  perform pg_temp.eq(public.app_has(pg_temp.f('payroll'), 'payroll.sensitive'), true, 'payroll admin sees payroll details');
  perform pg_temp.eq(public.app_has(pg_temp.f('payroll'), 'ledger.journal'), false, 'payroll admin cannot create journals');
  -- A personal deny still beats a role.
  perform public.app_set_profile_permission(pg_temp.f('sysadmin'), pg_temp.f('finance'), 'data.export', 'deny');
  perform pg_temp.eq(public.app_has(pg_temp.f('finance'), 'data.export'), false, 'deny overrides role');
  perform public.app_set_profile_permission(pg_temp.f('sysadmin'), pg_temp.f('finance'), 'data.export', 'default');
  -- Inactive accounts hold nothing.
  update public.training_profiles set active = false where id = pg_temp.f('director');
  perform pg_temp.eq(public.app_has(pg_temp.f('director'), 'bank.manage'), false, 'inactive account holds nothing');
  update public.training_profiles set active = true where id = pg_temp.f('director');
end $$;

-- Company settings ---------------------------------------------------------------
do $$
declare
  v_audit record;
begin
  perform pg_temp.expect_error(format('select public.company_settings_save(%L, %L)', pg_temp.f('finance'), '{"abn":"51824753556"}'), 'Company settings');
  perform pg_temp.expect_error(format('select public.company_settings_save(%L, %L)', pg_temp.f('sysadmin'), '{"abn":"51824753557"}'), 'ABN is not valid');
  perform pg_temp.expect_error(format('select public.company_settings_save(%L, %L)', pg_temp.f('sysadmin'), '{"secret_field":1}'), 'Unknown setting');
  perform pg_temp.expect_error(format('select public.company_settings_save(%L, %L)', pg_temp.f('sysadmin'), '{"states":["NSW","XX"]}'), 'check');
  perform pg_temp.expect_error(format('select public.company_setup_complete(%L)', pg_temp.f('sysadmin')), 'Still needed: ABN');
  perform public.company_settings_save(pg_temp.f('sysadmin'), '{"abn":"51 824 753 556","acn":"000 000 019","email":"Accounts@Panalo.test","phone":"02 9000 0000",
    "business_address":{"street":"1 Fabrication Way","suburb":"Smithfield","state":"NSW","postcode":"2164"},"states":["NSW","QLD"],
    "payroll_contact":{"name":"Pat Payroll","email":"payroll@panalo.test"},"gst_basis":"cash","pay_frequency":"fortnightly"}'::jsonb);
  perform pg_temp.eq((select abn from public.company_settings where organization_id = public.app_org_of(pg_temp.f('sysadmin'))), '51824753556', 'ABN stored as digits');
  perform pg_temp.eq((select email from public.company_settings where organization_id = public.app_org_of(pg_temp.f('sysadmin'))), 'accounts@panalo.test', 'email lower-cased');
  select * into v_audit from public.training_audit_events where event_type = 'company_settings_saved' order by id desc limit 1;
  perform pg_temp.eq(v_audit.old_value->>'gst_basis', 'accrual', 'audit keeps the old value');
  perform pg_temp.eq(v_audit.new_value->>'gst_basis', 'cash', 'audit keeps the new value');
  perform pg_temp.eq(v_audit.entity_type, 'company_settings', 'audit names the entity');
  perform public.company_setup_complete(pg_temp.f('sysadmin'));
  perform pg_temp.eq((select setup_completed_at is not null from public.company_settings where organization_id = public.app_org_of(pg_temp.f('sysadmin'))), true, 'setup completed');

  -- Numbering only moves forward.
  perform pg_temp.expect_error(format('select public.number_sequence_save(%L, %L, %L, %s, 4)', pg_temp.f('sysadmin'), 'invoice', 'INV-', 5), 'only move forward');
  perform public.number_sequence_save(pg_temp.f('sysadmin'), 'invoice', 'inv-', 2001, 5);
  perform pg_temp.eq(public.next_document_number(public.app_org_of(pg_temp.f('sysadmin')), 'invoice'), 'INV-02001', 'first number');
  perform pg_temp.eq(public.next_document_number(public.app_org_of(pg_temp.f('sysadmin')), 'invoice'), 'INV-02002', 'next number');
end $$;

-- Company bank accounts need a second person ------------------------------------
do $$
declare
  v_acct uuid; v_appr uuid; v_second uuid;
begin
  perform pg_temp.expect_error(format('select public.company_bank_account_request(%L, %L, %L, %L, %L, null, %L, true)',
    pg_temp.f('sysadmin'), 'Main', 'Panalo Pipes', '06200', '12345678', 'operating'), 'BSB is 6 digits');
  v_acct := public.company_bank_account_request(pg_temp.f('sysadmin'), 'Main operating', 'Panalo Pipes & Structurals', '062-000', '1234 5678', null, 'operating', true);
  select approval_id into v_appr from public.company_bank_accounts where id = v_acct;
  perform pg_temp.eq((select status from public.company_bank_accounts where id = v_acct), 'pending', 'new account waits for approval');
  perform pg_temp.eq((select count(*)::int from public.notifications where kind = 'approval_requested' and profile_id = pg_temp.f('finance')), 1, 'banking holders are notified');
  perform pg_temp.eq((select count(*)::int from public.notifications where kind = 'approval_requested' and profile_id = pg_temp.f('sysadmin')), 0, 'requester is not notified');
  perform pg_temp.expect_error(format('select public.approval_decide(%L, %L, true, null)', pg_temp.f('sysadmin'), v_appr), 'Someone else');
  perform pg_temp.expect_error(format('select public.approval_decide(%L, %L, true, null)', pg_temp.f('payroll'), v_appr), 'Banking');
  perform pg_temp.expect_error(format('select public.approval_decide(%L, %L, false, %L)', pg_temp.f('director'), v_appr, ''), 'reason');
  perform public.approval_decide(pg_temp.f('director'), v_appr, true, 'Checked with the bank by phone');
  perform pg_temp.eq((select status from public.company_bank_accounts where id = v_acct), 'active', 'approved account is active');
  perform pg_temp.expect_error(format('select public.approval_decide(%L, %L, true, null)', pg_temp.f('finance'), v_appr), 'already been decided');
  perform pg_temp.eq((select count(*)::int from public.notifications where kind = 'approval_approved' and profile_id = pg_temp.f('sysadmin')), 1, 'requester told it was approved');

  -- A second invoice account replaces the first on invoices when approved.
  v_second := public.company_bank_account_request(pg_temp.f('sysadmin'), 'New operating', 'Panalo Pipes & Structurals', '063000', '87654321', null, 'operating', true);
  perform public.approval_decide(pg_temp.f('finance'), (select approval_id from public.company_bank_accounts where id = v_second), true, null);
  perform pg_temp.eq((select show_on_invoices from public.company_bank_accounts where id = v_acct), false, 'old account no longer on invoices');
  perform pg_temp.eq((select show_on_invoices from public.company_bank_accounts where id = v_second), true, 'new account on invoices');

  -- Rejected and cancelled requests never become active.
  v_second := public.company_bank_account_request(pg_temp.f('sysadmin'), 'Suspicious', 'Someone Else', '111111', '99999999', null, 'operating', false);
  perform public.approval_decide(pg_temp.f('finance'), (select approval_id from public.company_bank_accounts where id = v_second), false, 'Not our account');
  perform pg_temp.eq((select status from public.company_bank_accounts where id = v_second), 'rejected', 'rejected stays inactive');
  v_second := public.company_bank_account_request(pg_temp.f('sysadmin'), 'Typo', 'Panalo', '062000', '11112222', null, 'operating', false);
  perform public.approval_cancel(pg_temp.f('sysadmin'), (select approval_id from public.company_bank_accounts where id = v_second));
  perform pg_temp.eq((select status from public.company_bank_accounts where id = v_second), 'rejected', 'cancelled stays inactive');

  perform pg_temp.expect_error(format('select public.company_bank_account_retire(%L, %L, %L)', pg_temp.f('sysadmin'), v_acct, ''), 'reason');
  perform public.company_bank_account_retire(pg_temp.f('sysadmin'), v_acct, 'Account closed');
  perform pg_temp.eq((select status from public.company_bank_accounts where id = v_acct), 'retired', 'retired');
end $$;

-- Audit log is append-only ----------------------------------------------------------
do $$
declare
  v_id bigint := (select max(id) from public.training_audit_events);
begin
  perform pg_temp.expect_error(format('update public.training_audit_events set details = %L where id = %s', '{}', v_id), 'cannot be changed');
  perform pg_temp.expect_error(format('delete from public.training_audit_events where id = %s', v_id), 'cannot be deleted');
end $$;

-- Browser roles stay locked out -----------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['organizations', 'company_settings', 'number_sequences', 'company_bank_accounts', 'app_roles',
    'app_role_permissions', 'profile_roles', 'notifications', 'approvals', 'documents']
  loop
    perform pg_temp.eq(has_table_privilege('authenticated', 'public.' || t, 'select'), false, t || ' hidden from browsers');
    perform pg_temp.eq((select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), true, t || ' has RLS on');
  end loop;
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.company_settings_save(uuid, jsonb)', 'execute'), false, 'settings function not callable from browsers');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.approval_decide(uuid, uuid, boolean, text)', 'execute'), false, 'approval function not callable from browsers');
end $$;

select 'finance_foundation tests passed' as result;
