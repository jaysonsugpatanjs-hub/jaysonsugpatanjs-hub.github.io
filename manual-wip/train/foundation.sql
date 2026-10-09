-- Training database for the Panalo Accounts manual: fictional people and
-- organisations only ("Demo ..." names, @training.panalo.test emails).
\set ON_ERROR_STOP on
create temporary table tp (k text primary key, v uuid);
create or replace function pg_temp.p(k text) returns uuid language sql as $$ select v from tp where tp.k = $1 $$;
create or replace function pg_temp.emp(n text) returns uuid language sql as $$ select id from public.employees where employee_number = $1 $$;

insert into auth.users (email, raw_user_meta_data) values
  ('alex.admin@training.panalo.test', '{"full_name":"Alex Admin"}'),
  ('dana.director@training.panalo.test', '{"full_name":"Dana Director"}'),
  ('fran.finance@training.panalo.test', '{"full_name":"Fran Finance"}'),
  ('pat.payroll@training.panalo.test', '{"full_name":"Pat Payroll"}'),
  ('morgan.pm@training.panalo.test', '{"full_name":"Morgan Project-Manager"}'),
  ('sam.supervisor@training.panalo.test', '{"full_name":"Sam Supervisor"}'),
  ('chris.accountant@training.panalo.test', '{"full_name":"Chris Accountant"}'),
  ('tom.welder@training.panalo.test', '{"full_name":"Tom Welder"}'),
  ('olivia.office@training.panalo.test', '{"full_name":"Olivia Office"}'),
  ('casey.rigger@training.panalo.test', '{"full_name":"Casey Rigger"}'),
  ('jamie.apprentice@training.panalo.test', '{"full_name":"Jamie Apprentice"}');
insert into tp select split_part(split_part(email, '@', 1), '.', 1), id from public.training_profiles where email like '%@training.panalo.test';
update public.training_profiles set role = 'admin' where id = pg_temp.p('alex');

-- Positions for the people register.
insert into public.positions (code, title, department, safety_critical) values
  ('DIR', 'Managing director', 'Management', false), ('FINADM', 'Finance administrator', 'Office', false),
  ('PAYADM', 'Payroll administrator', 'Office', false), ('PM', 'Project manager', 'Projects', false),
  ('SUPV', 'Workshop supervisor', 'Workshop', true), ('WELDFAB', 'Welder / fabricator', 'Workshop', true),
  ('OFFADM', 'Office administrator', 'Office', false), ('RIGG', 'Rigger / dogman', 'Site', true),
  ('APPR', 'Apprentice fabricator', 'Workshop', true), ('SYSADM', 'Systems administrator', 'Office', false),
  ('ACCT', 'External accountant', 'External', false)
on conflict do nothing;

-- Roles (granted by the system administrator; nobody grants their own).
select public.app_set_profile_role(pg_temp.p('alex'), pg_temp.p('dana'), 'director', true);
select public.app_set_profile_role(pg_temp.p('alex'), pg_temp.p('fran'), 'finance_admin', true);
select public.app_set_profile_role(pg_temp.p('alex'), pg_temp.p('pat'), 'payroll_admin', true);
select public.app_set_profile_role(pg_temp.p('alex'), pg_temp.p('morgan'), 'project_manager', true);
select public.app_set_profile_role(pg_temp.p('alex'), pg_temp.p('sam'), 'supervisor', true);
select public.app_set_profile_role(pg_temp.p('alex'), pg_temp.p('chris'), 'accountant', true);
insert into public.profile_permissions (profile_id, permission_key, granted)
select tp.v, x.perm, true from tp, unnest(array['time.submit', 'payroll.self']) x(perm) where tp.k in ('tom', 'casey', 'jamie')
union all select v, 'payroll.self', true from tp where tp.k = 'olivia';

-- People register (employees) linked to sign-ins.
insert into public.employees (employee_number, full_name, email, profile_id, start_date, position_id) values
  ('PP-001', 'Dana Director', 'dana.director@training.panalo.test', pg_temp.p('dana'), '2021-02-01', (select id from public.positions where code = 'DIR')),
  ('PP-002', 'Fran Finance', 'fran.finance@training.panalo.test', pg_temp.p('fran'), '2023-03-06', (select id from public.positions where code = 'FINADM')),
  ('PP-003', 'Pat Payroll', 'pat.payroll@training.panalo.test', pg_temp.p('pat'), '2023-05-15', (select id from public.positions where code = 'PAYADM')),
  ('PP-004', 'Morgan Project-Manager', 'morgan.pm@training.panalo.test', pg_temp.p('morgan'), '2022-08-01', (select id from public.positions where code = 'PM')),
  ('PP-005', 'Sam Supervisor', 'sam.supervisor@training.panalo.test', pg_temp.p('sam'), '2022-01-10', (select id from public.positions where code = 'SUPV')),
  ('PP-101', 'Tom Welder', 'tom.welder@training.panalo.test', pg_temp.p('tom'), '2024-07-01', (select id from public.positions where code = 'WELDFAB')),
  ('PP-102', 'Olivia Office', 'olivia.office@training.panalo.test', pg_temp.p('olivia'), '2025-02-03', (select id from public.positions where code = 'OFFADM')),
  ('PP-103', 'Casey Rigger', 'casey.rigger@training.panalo.test', pg_temp.p('casey'), '2026-07-01', (select id from public.positions where code = 'RIGG')),
  ('PP-104', 'Jamie Apprentice', 'jamie.apprentice@training.panalo.test', pg_temp.p('jamie'), '2026-02-02', (select id from public.positions where code = 'APPR')),
  ('PP-006', 'Alex Admin', 'alex.admin@training.panalo.test', pg_temp.p('alex'), '2023-01-09', (select id from public.positions where code = 'SYSADM'));
update public.employees set supervisor_id = pg_temp.emp('PP-005') where employee_number in ('PP-101', 'PP-103', 'PP-104');

-- Company settings and setup.
select public.company_settings_save(pg_temp.p('alex'), '{"trading_name":"Panalo Pipes & Structurals","abn":"40 650 463 102","acn":"650 463 102",
  "email":"accounts@training.panalo.test","phone":"03 5700 0000","website":"https://jaysonsugpatanjs-hub.github.io",
  "business_address":{"street":"1 Training Workshop Road","suburb":"Broadford","state":"VIC","postcode":"3658"},
  "states":["VIC","NSW"],"payroll_contact":{"name":"Pat Payroll","email":"pat.payroll@training.panalo.test","phone":"03 5700 0001"},
  "gst_basis":"accrual","bas_frequency":"quarterly","pay_frequency":"weekly","pay_day":"Wednesday","payment_terms_days":30,
  "workers_comp":[{"state":"VIC","insurer":"WorkSafe Victoria agent (training)","policyNumber":"TRN-0001","expiresOn":"2027-06-30"}]}'::jsonb);
select public.company_setup_complete(pg_temp.p('alex'));

-- Operating bank account: requested by the admin, approved by the director.
do $$
declare v_acct uuid; v_appr uuid;
begin
  v_acct := public.company_bank_account_request(pg_temp.p('alex'), 'Operating account', 'Panalo Pipes & Structurals Pty Ltd', '062-000', '1234 5678', '123456', 'operating', true);
  select approval_id into v_appr from public.company_bank_accounts where id = v_acct;
  perform public.approval_decide(pg_temp.p('dana'), v_appr, true, 'Checked against the bank letter (training)');
end $$;

-- Pay settings (training TFN 123 456 782 is the standard test number).
do $$
begin
  perform public.payroll_employee_save(pg_temp.p('pat'), pg_temp.emp('PP-101'), '{"employment_basis":"full_time","pay_basis":"hourly","pay_frequency":"weekly",
    "hourly_rate":"42.50","tfn":"123 456 782","tfn_status":"provided","residency":"resident","tax_free_threshold":true,"super_fund_name":"Demo Super Fund","super_fund_usi":"STA0100AU",
    "award":"Manufacturing and Associated Industries and Occupations Award 2020","classification":"C10","start_date":"2024-07-01","date_of_birth":"1990-05-14"}');
  perform public.payroll_employee_save(pg_temp.p('pat'), pg_temp.emp('PP-102'), '{"employment_basis":"full_time","pay_basis":"salary","pay_frequency":"weekly",
    "annual_salary":"72000","tfn":"123456782","tfn_status":"provided","tax_free_threshold":true,"super_fund_name":"Demo Super Fund","super_fund_usi":"STA0100AU","start_date":"2025-02-03","date_of_birth":"1995-11-02"}');
  perform public.payroll_employee_save(pg_temp.p('pat'), pg_temp.emp('PP-103'), '{"employment_basis":"casual","pay_basis":"hourly","pay_frequency":"weekly","hourly_rate":"38","tfn":"123456782","tfn_status":"provided",
    "tax_free_threshold":false,"super_fund_name":"Demo Super Fund","super_fund_usi":"STA0100AU","start_date":"2026-07-01","date_of_birth":"1998-01-20"}');
  perform public.payroll_employee_save(pg_temp.p('pat'), pg_temp.emp('PP-104'), '{"employment_basis":"full_time","pay_basis":"hourly","pay_frequency":"weekly","hourly_rate":"24.50","tfn":"123456782","tfn_status":"provided",
    "tax_free_threshold":true,"super_fund_name":"Demo Super Fund","super_fund_usi":"STA0100AU","start_date":"2026-02-02","date_of_birth":"2007-09-09"}');
  perform public.approval_decide(pg_temp.p('dana'), public.payroll_bank_request(pg_temp.p('pat'), pg_temp.emp('PP-101'), 'T Welder', '062-000', '1111 2222'), true, 'Confirmed in person (training)');
  perform public.approval_decide(pg_temp.p('dana'), public.payroll_bank_request(pg_temp.p('pat'), pg_temp.emp('PP-102'), 'O Office', '062-000', '3333 4444'), true, 'Confirmed in person (training)');
  perform public.approval_decide(pg_temp.p('dana'), public.payroll_bank_request(pg_temp.p('pat'), pg_temp.emp('PP-103'), 'C Rigger', '062-000', '5555 6666'), true, 'Confirmed in person (training)');
  perform public.approval_decide(pg_temp.p('dana'), public.payroll_bank_request(pg_temp.p('pat'), pg_temp.emp('PP-104'), 'J Apprentice', '062-000', '7777 8888'), true, 'Confirmed in person (training)');
end $$;

-- Labour rates for job costing.
update public.labour_classes set cost_rate = v.c, charge_rate = v.r from (values ('WELDER', 65, 115), ('FITTER', 62, 110), ('RIGGER', 58, 98), ('LAB', 45, 75), ('SUP', 75, 125), ('APP', 35, 60)) v(k, c, r)
where code = v.k;
select 'foundation ok';
