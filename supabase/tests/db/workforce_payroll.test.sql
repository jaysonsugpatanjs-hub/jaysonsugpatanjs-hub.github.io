-- Behavioural tests for Phase 5: payroll. Runs after the timesheet tests and
-- reuses their people (pm, payroll admin, director, finance). Withholding is
-- checked against the ATO's worked examples for Schedule 1 (from 1 July 2026)
-- and every pay figure is worked out by hand in the comments.

create or replace function pg_temp.p(p text) returns uuid language sql as $$ select id from public.training_profiles where email = p || '@fin.test' $$;
create or replace function pg_temp.acc(p text) returns uuid language sql as $$
  select id from public.accounts where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.item(p text) returns uuid language sql as $$
  select id from public.pay_items where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.lt(p text) returns uuid language sql as $$
  select id from public.leave_types where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.emp(p text) returns uuid language sql as $$ select id from public.employees where employee_number = p $$;
create or replace function pg_temp.w(p_scale text, p_e numeric, p_f text, p_stsl boolean default false) returns jsonb language sql as $$
  select public.payg_withholding(p_scale, p_e, p_f, '2026-08-01', p_stsl) $$;
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
create temporary table pk (k text primary key, v uuid);

-- Withholding: the ATO's worked examples and edge cases ----------------------------------------------------
do $$
begin
  -- Schedule 1 example: weekly $1,333.45, scale 2: x = 1,333.99; 0.3200x - 181.7319 = 245.14 -> $245.
  perform pg_temp.eq((pg_temp.w('2', 1333.45, 'weekly')->>'tax')::numeric, 245::numeric, 'ATO example: weekly scale 2');
  -- Fortnightly $1,299.30, scale 5: weekly 649.99 -> $43 -> $86 a fortnight.
  perform pg_temp.eq((pg_temp.w('5', 1299.30, 'fortnightly')->>'tax')::numeric, 86::numeric, 'ATO example: fortnightly scale 5');
  -- Monthly $5,400.33 (33 cents: add one cent), scale 2: x = 1,246.99 -> $217 a week -> 217 x 13 / 3 = 940.33 -> $940.
  perform pg_temp.eq((pg_temp.w('2', 5400.33, 'monthly')->>'tax')::numeric, 940::numeric, 'ATO example: monthly scale 2');
  -- Under the tax-free threshold: nothing withheld.
  perform pg_temp.eq((pg_temp.w('2', 300, 'weekly')->>'tax')::numeric, 0::numeric, 'below the threshold');
  -- No TFN, resident: 47% of whole dollars, cents ignored: 1,000.75 -> 1,000 x 0.47 = $470.
  perform pg_temp.eq((pg_temp.w('4r', 1000.75, 'weekly')->>'tax')::numeric, 470::numeric, 'no TFN 47%');
  perform pg_temp.eq((pg_temp.w('4f', 1000.75, 'weekly')->>'tax')::numeric, 450::numeric, 'no TFN, foreign 45%');
  -- Study loan, scale 2, weekly $2,000: x = 2,000.99; tax 0.32x - 181.7319 = 458.58 -> 459; STSL 0.15x - 200.5615 = 99.59 -> 100.
  perform pg_temp.eq(pg_temp.w('2', 2000, 'weekly', true), '{"tax": 459, "stsl": 100}'::jsonb, 'Schedule 8 component');
  perform pg_temp.eq((pg_temp.w('2', 1300, 'weekly', true)->>'stsl')::numeric, 0::numeric, 'no study loan component under the threshold');
  -- Rules are dated: nothing before 1 July 2026.
  perform pg_temp.expect_error($q$select public.payg_withholding('2', 1000, 'weekly', '2026-06-30', false)$q$, 'No PAYG withholding rules');
  -- TFN check digits (ATO example 123 456 782).
  perform pg_temp.eq(public.app_valid_tfn('123 456 782'), true, 'valid TFN');
  perform pg_temp.eq(public.app_valid_tfn('123 456 789'), false, 'bad TFN');
  perform pg_temp.eq(public.add_business_days('2026-10-14', 7), date '2026-10-23', 'super due 7 business days after payday');
end $$;

-- People: an hourly tradesperson, a salaried office worker, a casual without a TFN, a junior ------------------
insert into auth.users (email) values ('tradie@fin.test'), ('office@fin.test');
insert into public.profile_permissions (profile_id, permission_key, granted)
select id, k, true from public.training_profiles, unnest(array['time.submit', 'payroll.self']) k where email = 'tradie@fin.test'
union all select id, 'payroll.self', true from public.training_profiles where email = 'office@fin.test';
insert into public.employees (employee_number, full_name, email, profile_id, start_date) values
  ('PAY-001', 'Tom Tradie', 'tradie@fin.test', pg_temp.p('tradie'), '2026-07-01'),
  ('PAY-002', 'Olivia Office', 'office@fin.test', pg_temp.p('office'), '2026-07-01'),
  ('PAY-003', 'Casey Casual', null, null, '2026-07-01'),
  ('PAY-004', 'Jamie Junior', null, null, '2026-07-01');

do $$
begin
  -- Only people with payroll details access can set pay, tax and bank details.
  perform pg_temp.expect_error(format('select public.payroll_employee_save(%L, %L, %L)', pg_temp.p('sysadmin'), pg_temp.emp('PAY-001'), '{"hourly_rate":"40"}'), 'Payroll');
  perform pg_temp.expect_error(format('select public.payroll_employee_save(%L, %L, %L)', pg_temp.p('payroll'), pg_temp.emp('PAY-001'), '{"tfn":"123456789","tfn_status":"provided"}'), 'TFN isn''t valid');
  -- Tom: full-time, $40/h, weekly, scale 2.
  perform public.payroll_employee_save(pg_temp.p('payroll'), pg_temp.emp('PAY-001'), '{"employment_basis":"full_time","pay_basis":"hourly","pay_frequency":"weekly",
    "hourly_rate":"40","tfn":"123 456 782","tfn_status":"provided","residency":"resident","tax_free_threshold":true,"super_fund_name":"AustralianSuper","super_fund_usi":"STA0100AU",
    "award":"Manufacturing and Associated Industries and Occupations Award 2020","classification":"C10","start_date":"2026-07-01"}');
  perform pg_temp.eq((select tfn from public.payroll_employees where employee_id = pg_temp.emp('PAY-001')), '123456782', 'TFN stored without spaces');
  perform pg_temp.eq((select new_value ? 'tfn' from public.training_audit_events where event_type = 'payroll_employee_created' order by id desc limit 1), false, 'TFN never in the audit log');
  -- Olivia: salaried $78,000, weekly, no tax-free threshold, study loan, $100 a week salary sacrifice.
  perform public.payroll_employee_save(pg_temp.p('payroll'), pg_temp.emp('PAY-002'), '{"employment_basis":"full_time","pay_basis":"salary","pay_frequency":"weekly",
    "annual_salary":"78000","tfn":"123456782","tfn_status":"provided","tax_free_threshold":false,"study_loan":true,"salary_sacrifice":"100","super_fund_usi":"STA0100AU"}');
  update public.payroll_employees set wages_account_id = pg_temp.acc('6000') where employee_id = pg_temp.emp('PAY-002');
  -- Casey: casual $30/h + 25% loading, no TFN given.
  perform public.payroll_employee_save(pg_temp.p('payroll'), pg_temp.emp('PAY-003'), '{"employment_basis":"casual","pay_basis":"hourly","pay_frequency":"weekly","hourly_rate":"30","tfn_status":"not_provided"}');
  -- Jamie: 16 years old, part-time, $25/h (below the adult national minimum wage: flagged to check the junior award rate).
  perform public.payroll_employee_save(pg_temp.p('payroll'), pg_temp.emp('PAY-004'), '{"employment_basis":"part_time","pay_basis":"hourly","pay_frequency":"weekly","hourly_rate":"25","tfn":"123456782","tfn_status":"provided","date_of_birth":"2010-03-01"}');

  -- Bank details: requested by payroll, approved by a second person with "Approve pay runs", never by the employee.
  insert into pk values ('bank', public.payroll_bank_request(pg_temp.p('payroll'), pg_temp.emp('PAY-001'), 'T Tradie', '062-000', '1234 5678'));
  perform pg_temp.eq((select bank_bsb from public.payroll_employees where employee_id = pg_temp.emp('PAY-001')), null::text, 'bank not changed before approval');
  perform pg_temp.expect_error(format('select public.approval_decide(%L, %L, true, null)', pg_temp.p('payroll'), (select v from pk where k = 'bank')), 'Someone else');
  perform public.approval_decide(pg_temp.p('director'), (select v from pk where k = 'bank'), true, 'Confirmed with Tom in person');
  perform pg_temp.eq((select bank_bsb || '/' || bank_account_number from public.payroll_employees where employee_id = pg_temp.emp('PAY-001')), '062000/12345678', 'bank set after approval');
end $$;

-- Hours and leave for the week of 5 October 2026 -------------------------------------------------------------
do $$
declare v_ts uuid; v_lr uuid;
begin
  -- Tom: Mon-Thu 8 h, Fri 6 h (38 ordinary) and 2 h overtime at 150% on Wednesday. Approved by the project manager.
  perform public.labour_profile_set(pg_temp.p('pm'), pg_temp.p('tradie'), (select id from public.labour_classes where code = 'WELDER'));
  v_ts := public.timesheet_save(pg_temp.p('tradie'), null, '2026-10-05', jsonb_build_array(
    jsonb_build_object('date', '2026-10-05', 'start', '07:00', 'end', '15:30', 'breakMinutes', 30),
    jsonb_build_object('date', '2026-10-06', 'start', '07:00', 'end', '15:30', 'breakMinutes', 30),
    jsonb_build_object('date', '2026-10-07', 'start', '07:00', 'end', '15:30', 'breakMinutes', 30),
    jsonb_build_object('date', '2026-10-07', 'start', '15:30', 'end', '17:30', 'breakMinutes', 0, 'hourType', 'overtime_150'),
    jsonb_build_object('date', '2026-10-08', 'start', '07:00', 'end', '15:30', 'breakMinutes', 30),
    jsonb_build_object('date', '2026-10-09', 'start', '07:00', 'end', '13:30', 'breakMinutes', 30)), true);
  perform public.timesheet_decide(pg_temp.p('pm'), v_ts, true, null);
  insert into pk values ('ts', v_ts);

  -- Olivia: 40 h opening annual leave balance; 7.6 h annual leave on Friday 9 October.
  perform pg_temp.expect_error(format('select public.leave_adjust(%L, %L, %L, %L, 40, %L, %L)', pg_temp.p('payroll'), pg_temp.emp('PAY-002'), pg_temp.lt('ANNUAL'), '2026-07-01', 'opening', ''), 'Say why');
  perform public.leave_adjust(pg_temp.p('payroll'), pg_temp.emp('PAY-002'), pg_temp.lt('ANNUAL'), '2026-07-01', 40, 'opening', 'Balance from the previous payroll system');
  v_lr := public.leave_request_save(pg_temp.p('office'), null, pg_temp.lt('ANNUAL'), '2026-10-09', '2026-10-09', 7.6, 'Long weekend');
  perform pg_temp.expect_error(format('select public.leave_request_decide(%L, %L, %L, null)', pg_temp.p('office'), v_lr, 'approved'), 'Approve leave');
  perform public.leave_request_decide(pg_temp.p('payroll'), v_lr, 'approved', null);
  -- Casuals don't take paid annual leave.
  perform pg_temp.expect_error(format('select public.leave_request_save(%L, %L, %L, %L, %L, 8, %L)', pg_temp.p('payroll'), pg_temp.emp('PAY-003'), pg_temp.lt('ANNUAL'), '2026-10-09', '2026-10-09', ''), 'Casual');
end $$;

-- The pay run ------------------------------------------------------------------------------------------------
do $$
declare v_run uuid; x record; v_j uuid;
begin
  perform pg_temp.expect_error(format('select public.pay_run_create(%L, %L, %L, %L, %L)', pg_temp.p('staff'), 'weekly', '2026-10-05', '2026-10-11', '2026-10-14'), 'Prepare pay runs');
  perform pg_temp.expect_error(format('select public.pay_run_create(%L, %L, %L, %L, %L)', pg_temp.p('payroll'), 'weekly', '2026-10-05', '2026-10-12', '2026-10-14'), '7 days');
  v_run := public.pay_run_create(pg_temp.p('payroll'), 'weekly', '2026-10-05', '2026-10-11', '2026-10-14');
  insert into pk values ('run', v_run);
  perform pg_temp.expect_error(format('select public.pay_run_create(%L, %L, %L, %L, %L)', pg_temp.p('payroll'), 'weekly', '2026-10-08', '2026-10-14', '2026-10-16'), 'already covers');
  -- Casey worked 10 h; Jamie 20 h; Olivia's union fees $15.
  perform public.pay_run_line_add(pg_temp.p('payroll'), v_run, pg_temp.emp('PAY-003'), pg_temp.item('ORD'), 'Ordinary hours incl. 25% casual loading', 10, 37.50, null);
  perform public.pay_run_line_add(pg_temp.p('payroll'), v_run, pg_temp.emp('PAY-004'), pg_temp.item('ORD'), 'Ordinary hours', 20, 25, null);
  perform public.pay_run_line_add(pg_temp.p('payroll'), v_run, pg_temp.emp('PAY-002'), pg_temp.item('UNION'), 'Union fees (AMWU)', null, null, 15);

  -- Tom: 38 x $40 = 1,520.00 + 2 x $60 = 120.00 -> gross 1,640.00. Scale 2: x = 1,640.99; 0.32x - 181.7319 = 343.38 -> $343.
  -- Super 12% of qualifying earnings 1,520.00 (overtime excluded) = 182.40. Net 1,297.00.
  select * into x from public.pay_run_employees where pay_run_id = v_run and employee_id = pg_temp.emp('PAY-001');
  perform pg_temp.eq((x.gross, x.payg, x.qualifying_earnings, x.super_guarantee, x.net, x.tax_scale)::text, '(1640.00,343.00,1520.00,182.40,1297.00,2)', 'Tom''s pay');
  -- Olivia: $1,500 a week; rate 1,500 / 38 = 39.4737. Leave 7.6 h = 300.00, loading 17.5% = 52.50, salary for the rest 1,200.00. Gross 1,552.50.
  -- Taxable after $100 salary sacrifice 1,452.50; scale 1: x = 1,452.99; 0.32x - 71.6508 = 393.31 -> 393; STSL 0.15x - 148.0615 = 69.89 -> 70. PAYG 463.
  -- Super 12% of 1,552.50 = 186.30 (+ $100 sacrificed). Net 1,552.50 - 463 - 100 - 15 = 974.50.
  select * into x from public.pay_run_employees where pay_run_id = v_run and employee_id = pg_temp.emp('PAY-002');
  perform pg_temp.eq((x.gross, x.taxable, x.payg, x.stsl, x.super_guarantee, x.salary_sacrifice, x.deductions, x.net, x.tax_scale)::text,
    '(1552.50,1452.50,463.00,70.00,186.30,100.00,15.00,974.50,1)', 'Olivia''s pay');
  -- Casey: 375.00, no TFN: 375 x 47% = 176.25 -> $176. Super 45.00. Net 199.00.
  select * into x from public.pay_run_employees where pay_run_id = v_run and employee_id = pg_temp.emp('PAY-003');
  perform pg_temp.eq((x.gross, x.payg, x.super_guarantee, x.net, x.tax_scale)::text, '(375.00,176.00,45.00,199.00,4r)', 'Casey''s pay');
  -- Jamie: 500.00; scale 2: x = 500.99; 0.15x - 54.3462 = 20.80 -> $21. Under 18 and under 30 hours: no super guarantee. Net 479.00.
  select * into x from public.pay_run_employees where pay_run_id = v_run and employee_id = pg_temp.emp('PAY-004');
  perform pg_temp.eq((x.gross, x.payg, x.super_guarantee, x.net)::text, '(500.00,21.00,0.00,479.00)', 'Jamie''s pay');
  perform pg_temp.eq(x.warnings::text ~ 'national minimum wage', true, 'rate below the national minimum flagged');

  -- Totals: gross 4,067.50; PAYG 1,003; super 513.70 (413.70 SG + 100 sacrificed); net 2,949.50.
  perform pg_temp.eq((select (gross, payg, super, net)::text from public.pay_runs where id = v_run), '(4067.50,1003.00,513.70,2949.50)', 'pay run totals');

  -- Preparer can't approve; payroll admin can't approve at all; the director approves.
  perform pg_temp.expect_error(format('select public.pay_run_approve(%L, %L)', pg_temp.p('director'), v_run), 'Only a submitted');
  perform public.pay_run_submit(pg_temp.p('payroll'), v_run);
  -- While it waits for approval: no second weekly run, its hours can't be reopened, its leave can't be cancelled.
  perform pg_temp.expect_error(format('select public.pay_run_create(%L, %L, %L, %L, %L)', pg_temp.p('payroll'), 'weekly', '2026-10-12', '2026-10-18', '2026-10-21'), 'open weekly pay run');
  perform pg_temp.eq((select count(*)::int from public.timesheet_entries where pay_run_id = v_run), 6, 'hours claimed by the run when calculated');
  perform pg_temp.expect_error(format('select public.timesheet_reopen(%L, %L, %L)', pg_temp.p('pm'), (select v from pk where k = 'ts'), 'fix'), 'have been paid');
  perform pg_temp.expect_error(format('select public.leave_request_decide(%L, %L, %L, null)', pg_temp.p('office'),
    (select id from public.leave_requests where employee_id = pg_temp.emp('PAY-002')), 'cancelled'), 'waiting for approval');
  perform pg_temp.expect_error(format('select public.pay_run_line_add(%L, %L, %L, %L, %L, null, null, 50)', pg_temp.p('payroll'), v_run, pg_temp.emp('PAY-001'), pg_temp.item('BONUS'), 'Late bonus'), 'draft');
  perform pg_temp.expect_error(format('select public.pay_run_approve(%L, %L)', pg_temp.p('payroll'), v_run), 'Approve pay runs');
  perform public.pay_run_approve(pg_temp.p('director'), v_run);

  -- Ledger: Dr wages 4,067.50 (5000: 2,515.00; 6000: 1,552.50), Dr super expense 413.70;
  -- Cr PAYG 1,003.00, super payable 513.70, deductions 15.00, payroll clearing 2,949.50.
  v_j := (select journal_id from public.pay_runs where id = v_run);
  perform pg_temp.eq((select sum(debit) from public.journal_lines where journal_id = v_j), 4481.20, 'journal debits');
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('6000')), 1552.50, 'office wages to 6000');
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('5000')), 2515.00, 'trade wages to 5000');
  perform pg_temp.eq((select credit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('2100')), 1003.00, 'PAYG withheld');
  perform pg_temp.eq((select credit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('2200')), 513.70, 'super payable');
  perform pg_temp.eq((select credit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('2400')), 2949.50, 'net pay owed');

  -- Leave: Olivia 40 - 7.6 + 38 x 4/52 (2.9231) = 35.3231; personal 38 x 0.0384615 = 1.4615. Casuals accrue nothing.
  perform pg_temp.eq(public.leave_balance(pg_temp.emp('PAY-002'), pg_temp.lt('ANNUAL')), 35.32, 'annual leave after taking and accruing');
  perform pg_temp.eq(public.leave_balance(pg_temp.emp('PAY-001'), pg_temp.lt('PERSONAL')), 1.46, 'personal leave accrued');
  perform pg_temp.eq(public.leave_balance(pg_temp.emp('PAY-003'), pg_temp.lt('ANNUAL')), 0::numeric, 'casuals accrue no leave');
  perform pg_temp.eq((select status from public.leave_requests where employee_id = pg_temp.emp('PAY-002')), 'paid', 'leave request paid');

  -- Paid hours are final: the timesheet can't be reopened, the pay run can't be deleted.
  perform pg_temp.eq((select count(*)::int from public.timesheet_entries where pay_run_id = v_run), 6, 'timesheet hours marked paid');
  perform pg_temp.expect_error(format('select public.timesheet_reopen(%L, %L, %L)', pg_temp.p('pm'), (select v from pk where k = 'ts'), 'fix'), 'have been paid');
  perform pg_temp.expect_error(format('select public.pay_run_delete(%L, %L)', pg_temp.p('payroll'), v_run), 'Approved pay runs are final');

  -- Payslip snapshot with year to date and leave.
  select * into x from public.pay_run_employees where pay_run_id = v_run and employee_id = pg_temp.emp('PAY-002');
  perform pg_temp.eq((x.snapshot->'ytd'->>'gross')::numeric, 1552.50, 'year to date on the payslip');
  perform pg_temp.eq((x.snapshot->'employee'->>'annualSalary')::numeric, 78000.00, 'annual salary on the payslip');
  perform pg_temp.eq(jsonb_array_length(x.snapshot->'lines'), 4, 'payslip lines: salary, leave, loading, union fees');

  -- Paying: net pay and super leave the bank.
  perform pg_temp.expect_error(format('select public.pay_run_record_payment(%L, %L, %L, null)', pg_temp.p('staff'), v_run, pg_temp.acc('1000')), 'Bank');
  perform public.pay_run_record_payment(pg_temp.p('finance'), v_run, pg_temp.acc('1000'), '2026-10-14');
  perform public.pay_run_record_super(pg_temp.p('finance'), v_run, pg_temp.acc('1000'), '2026-10-16');
  perform pg_temp.eq((select status from public.pay_runs where id = v_run), 'paid', 'pay run paid');
  perform pg_temp.expect_error(format('select public.pay_run_record_super(%L, %L, %L, null)', pg_temp.p('finance'), v_run, pg_temp.acc('1000')), 'already recorded');
end $$;

-- Review fixes, rolled back so the API tests start from the paid pay run ------------------------------------
do $$
declare v_run uuid; v_lr uuid; x record;
begin
  begin
    -- Someone who records leave for another person can't approve it.
    v_lr := public.leave_request_save(pg_temp.p('payroll'), pg_temp.emp('PAY-001'), pg_temp.lt('PERSONAL'), '2026-10-13', '2026-10-13', 7.6, 'Phoned in sick');
    perform pg_temp.expect_error(format('select public.leave_request_decide(%L, %L, %L, null)', pg_temp.p('payroll'), v_lr, 'approved'), 'You recorded this leave');
    -- Unpaid leave comes off a salary.
    v_lr := public.leave_request_save(pg_temp.p('office'), null, pg_temp.lt('UNPAID'), '2026-10-16', '2026-10-16', 7.6, 'Moving house');
    perform public.leave_request_decide(pg_temp.p('payroll'), v_lr, 'approved', null);
    v_run := public.pay_run_create(pg_temp.p('payroll'), 'weekly', '2026-10-12', '2026-10-18', '2026-10-21');
    select * into x from public.pay_run_employees where pay_run_id = v_run and employee_id = pg_temp.emp('PAY-002');
    -- 1,500.00 - 7.6 x 39.4737 (300.00) = 1,200.00.
    perform pg_temp.eq(x.gross, 1200.00, 'salary less unpaid leave');
    perform pg_temp.eq((select pay_run_id from public.leave_requests where id = v_lr), v_run, 'leave claimed by the run');
    -- Working holiday makers need their Schedule 15 amount before the run can go for approval.
    update public.payroll_employees set residency = 'working_holiday' where employee_id = pg_temp.emp('PAY-003');
    perform public.pay_run_line_add(pg_temp.p('payroll'), v_run, pg_temp.emp('PAY-003'), pg_temp.item('ORD'), 'Ordinary hours', 10, 37.50, null);
    perform pg_temp.expect_error(format('select public.pay_run_submit(%L, %L)', pg_temp.p('payroll'), v_run), 'working holiday');
    update public.payroll_employees set residency = 'resident' where employee_id = pg_temp.emp('PAY-003');
    -- Anyone who changed the lines can't approve it.
    insert into public.profile_permissions (profile_id, permission_key, granted) values (pg_temp.p('director'), 'payroll.run', true)
    on conflict do nothing;
    perform public.pay_run_line_add(pg_temp.p('director'), v_run, pg_temp.emp('PAY-001'), pg_temp.item('BONUS'), 'Safety bonus', null, null, 100);
    perform public.pay_run_submit(pg_temp.p('payroll'), v_run);
    perform pg_temp.expect_error(format('select public.pay_run_approve(%L, %L)', pg_temp.p('director'), v_run), 'people who prepared');
    -- Nobody changes their own pay details.
    insert into public.employees (employee_number, full_name, email, profile_id) values ('PAY-099', 'Pat Payroll', null, pg_temp.p('payroll'));
    perform pg_temp.expect_error(format('select public.payroll_employee_save(%L, %L, %L)', pg_temp.p('payroll'), pg_temp.emp('PAY-099'), '{"hourly_rate":"90"}'), 'your own pay details');
    raise exception 'ROLLBACK_OK';
  exception when others then
    if sqlerrm <> 'ROLLBACK_OK' then raise; end if;
  end;
end $$;

-- Onboarding answers for the API test of "Fill in from onboarding" (the TFN and account number stay on the server).
with r as (insert into public.onboarding_requests (employee_id, profile_id, status) values (pg_temp.emp('PAY-001'), pg_temp.p('tradie'), 'complete') returning id)
insert into public.onboarding_items (request_id, doc_type, required, status, reviewed_at, answers)
select r.id, d, true, 'accepted', now(), a::jsonb from r, (values
  ('tfn_declaration', '{"tfn":"123 456 782","residency":"Australian resident for tax purposes","tax_free_threshold":"Yes","study_loan":"No","pay_basis":"Full-time"}'),
  ('bank_details', '{"account_name":"Tom Tradie","bsb":"062-000","account_number":"87654321"}')) v(d, a);

-- Lock-down -------------------------------------------------------------------------------------------------
do $$
begin
  perform pg_temp.eq(has_table_privilege('authenticated', 'public.payroll_employees', 'select'), false, 'payroll details not readable from browsers');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.pay_run_approve(uuid, uuid)', 'execute'), false, 'approve not callable from browsers');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type in ('pay_run_approved', 'pay_run_paid', 'super_paid')), 3, 'audited');
end $$;

select 'workforce_payroll tests passed' as result;
