-- Behavioural tests for Phase 8: STP Phase 2 information. Uses the pay run
-- from workforce_payroll.test.sql (PR for 5 to 11 October 2026, paid 14
-- October): Tom $40/h with overtime, Olivia salaried with annual leave and a
-- study loan, Casey casual with no TFN, Jamie aged 16. Rolled back at the end.
begin;

create or replace function pg_temp.p(p text) returns uuid language sql as $$ select id from public.training_profiles where email = p || '@fin.test' $$;
create or replace function pg_temp.emp(p text) returns uuid language sql as $$ select id from public.employees where employee_number = p $$;
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
create or replace function pg_temp.rec(p_event uuid, p_emp text) returns public.stp_employee_records language sql as $$
  select * from public.stp_employee_records where event_id = p_event and employee_id = pg_temp.emp(p_emp) $$;
create temporary table st (k text primary key, v uuid);

do $$
declare v_run uuid := (select id from public.pay_runs where period_start = '2026-10-05' and pay_frequency = 'weekly');
  v_ev uuid; r public.stp_employee_records;
begin
  -- Codes worked out from the pay details.
  perform pg_temp.eq(public.stp_tax_treatment((select pe from public.payroll_employees pe where employee_id = pg_temp.emp('PAY-001')), '2026-10-14'), 'RTXXXX', 'Tom: regular, tax-free threshold');
  perform pg_temp.eq(public.stp_tax_treatment((select pe from public.payroll_employees pe where employee_id = pg_temp.emp('PAY-002')), '2026-10-14'), 'RNSXXX', 'Olivia: no threshold, study loan');
  perform pg_temp.eq(public.stp_tax_treatment((select pe from public.payroll_employees pe where employee_id = pg_temp.emp('PAY-003')), '2026-10-14'), 'NAXXXX', 'Casey: no TFN, resident');
  perform pg_temp.eq(public.stp_tfn_code((select pe from public.payroll_employees pe where employee_id = pg_temp.emp('PAY-003')), '2026-10-14'), '000000000', 'no TFN quoted');

  -- Mapping: categories and codes must go together.
  perform pg_temp.expect_error(format('select public.stp_pay_item_map(%L, %L, %L, %L)', pg_temp.p('payroll'),
    (select id from public.pay_items where code = 'TOOL'), 'allowance', 'ZZ'), 'don''t go together');
  perform pg_temp.expect_error(format('select public.stp_pay_item_map(%L, %L, %L, %L)', pg_temp.p('staff'),
    (select id from public.pay_items where code = 'TOOL'), 'allowance', 'TD'), 'Payroll');

  -- The pay event: everyone in the run, year to date.
  perform pg_temp.expect_error(format('select public.stp_event_pay(%L, %L)', pg_temp.p('staff'), v_run), 'Prepare pay runs');
  v_ev := public.stp_event_pay(pg_temp.p('payroll'), v_run);
  insert into st values ('ev', v_ev);
  perform pg_temp.expect_error(format('select public.stp_event_pay(%L, %L)', pg_temp.p('payroll'), v_run), 'already has');
  perform pg_temp.eq((select (status, (totals->>'payees')::int)::text from public.stp_events where id = v_ev), '(draft,4)', 'errors keep it in draft');
  perform pg_temp.eq((select errors::text ~ 'contact' from public.stp_events where id = v_ev), true, 'employer contact missing');
  r := pg_temp.rec(v_ev, 'PAY-001');
  perform pg_temp.eq(r.errors::text ~ 'Home address' and r.errors::text ~ 'Date of birth', true, 'Tom needs an address and date of birth');
  -- Tom: 38 h ordinary 1,520.00 gross, 2 h overtime 120.00, PAYG 343, super 182.40 on 1,520.00.
  perform pg_temp.eq((r.ytd->>'gross', r.ytd->>'overtime', r.ytd->>'payg', r.ytd->'super'->>'L', r.ytd->'super'->>'OTE')::text,
    '(1520.00,120.00,343.00,182.40,1520.00)', 'Tom year to date');
  perform pg_temp.eq(r.payee->>'tfn', '••• ••• 782', 'TFN masked in the record');
  -- Olivia: salary 1,200.00 less 100.00 sacrificed = gross 1,100.00; leave and loading 352.50 as paid leave O; union fees F 15.00.
  r := pg_temp.rec(v_ev, 'PAY-002');
  perform pg_temp.eq((r.ytd->>'gross', r.ytd->'paidLeave'->>'O', r.ytd->'deductions'->>'F', r.ytd->'salarySacrifice'->>'S', r.ytd->'super'->>'RESC', r.ytd->>'payg')::text,
    '(1100.00,352.50,15.00,100.00,100.00,463.00)', 'Olivia year to date');
  perform pg_temp.eq((r.payee->>'employmentBasis', r.payee->>'taxTreatment', r.payee->>'incomeType')::text, '(F,RNSXXX,SAW)', 'Olivia codes');
  perform pg_temp.eq(r.payee->>'familyName' || '|' || (r.payee->>'givenNames'), 'Office|Olivia', 'names from the register until entered');

  -- Fix the details, check again: validated.
  perform public.stp_settings_save(pg_temp.p('payroll'), '{"contact_name":"Pat Payroll","contact_phone":"02 4200 0000","contact_email":"payroll@fin.test"}');
  perform pg_temp.expect_error(format('select public.payroll_employee_stp_save(%L, %L, %L)', pg_temp.p('payroll'), pg_temp.emp('PAY-001'),
    '{"family_name":"Tradie","given_names":"Tom","home_address":{"street":"1 Main St","suburb":"Wollongong","state":"NSW","postcode":"25"}}'), '4 digits');
  perform public.payroll_employee_stp_save(pg_temp.p('payroll'), e, jsonb_build_object('family_name', 'Test', 'given_names', 'Person',
    'home_address', jsonb_build_object('street', '1 Main St', 'suburb', 'Wollongong', 'state', 'NSW', 'postcode', '2500'), 'stp_income_type', 'SAW'))
  from unnest(array[pg_temp.emp('PAY-001'), pg_temp.emp('PAY-002'), pg_temp.emp('PAY-003'), pg_temp.emp('PAY-004')]) e;
  update public.payroll_employees set date_of_birth = '1990-01-01' where date_of_birth is null and employee_id in (pg_temp.emp('PAY-001'), pg_temp.emp('PAY-002'), pg_temp.emp('PAY-003'));
  perform pg_temp.eq(public.stp_event_check(pg_temp.p('payroll'), v_ev), 'validated', 'no errors left');

  -- Ready: someone who approves pay runs, not the preparer. Sending stays off.
  perform pg_temp.expect_error(format('select public.stp_event_ready(%L, %L)', pg_temp.p('payroll'), v_ev), 'Approve pay runs');
  perform public.stp_event_ready(pg_temp.p('director'), v_ev);
  perform pg_temp.eq((select status from public.stp_events where id = v_ev), 'ready', 'ready');
  perform pg_temp.expect_error(format('select public.stp_event_submit(%L, %L)', pg_temp.p('director'), v_ev), 'isn''t switched on');
  perform pg_temp.expect_error('update public.stp_settings set transmission_enabled = true', 'check constraint');
  perform pg_temp.expect_error(format('select public.stp_event_delete(%L, %L)', pg_temp.p('payroll'), v_ev), 'being prepared');

  -- Update events only include people whose figures changed; finalisation includes everyone, marked final.
  perform pg_temp.expect_error(format('select public.stp_event_year(%L, %L, %L, null)', pg_temp.p('payroll'), 'update', '2026-07-01'), 'Nobody''s year-to-date');
  perform pg_temp.expect_error(format('select public.stp_event_year(%L, %L, %L, null)', pg_temp.p('payroll'), 'finalisation', '2026-08-01'), 'financial year');
  v_ev := public.stp_event_year(pg_temp.p('payroll'), 'finalisation', '2026-07-01', null);
  perform pg_temp.eq((select count(*)::int from public.stp_employee_records where event_id = v_ev and final), 4, 'everyone finalised');
  perform pg_temp.eq((select as_at from public.stp_events where id = v_ev), date '2027-06-30', 'finalisation at the year end');

  -- An employee who has finished needs the reason.
  update public.payroll_employees set end_date = '2026-10-11' where employee_id = pg_temp.emp('PAY-003');
  perform public.stp_event_check(pg_temp.p('payroll'), v_ev);
  perform pg_temp.eq((pg_temp.rec(v_ev, 'PAY-003')).errors::text ~ 'cessation type', true, 'cessation type needed');
  perform public.payroll_employee_stp_save(pg_temp.p('payroll'), pg_temp.emp('PAY-003'), '{"family_name":"Casual","given_names":"Casey","home_address":{"street":"1 Main St","suburb":"Wollongong","state":"NSW","postcode":"2500"},"cessation_type":"C"}');
  perform pg_temp.eq(public.stp_event_check(pg_temp.p('payroll'), v_ev), 'validated', 'contract cessation recorded');

  perform pg_temp.eq(has_table_privilege('authenticated', 'public.stp_employee_records', 'select'), false, 'STP records not readable from browsers');
end $$;

select 'stp tests passed' as result;
rollback;
