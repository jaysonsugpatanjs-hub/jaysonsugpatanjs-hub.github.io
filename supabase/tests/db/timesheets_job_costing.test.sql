-- Behavioural tests for Phase 4: projects, timesheets and job costing. Runs
-- after the sales and purchasing tests and reuses their people, customer
-- (Hunter Refinery) and supplier (BOC Gases). Figures are worked by hand.

create or replace function pg_temp.p(p text) returns uuid language sql as $$ select id from public.training_profiles where email = p || '@fin.test' $$;
create or replace function pg_temp.acc(p text) returns uuid language sql as $$
  select id from public.accounts where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.tax(p text) returns uuid language sql as $$
  select id from public.tax_codes where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.cc(p text) returns uuid language sql as $$
  select id from public.cost_codes where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.ln(p_desc text, p_qty numeric, p_price numeric, p_acc text, p_tax text, p_project uuid, p_code text default null) returns jsonb language sql as $$
  select jsonb_build_object('description', p_desc, 'quantity', p_qty, 'unitPrice', p_price, 'accountId', pg_temp.acc(p_acc), 'taxCodeId', pg_temp.tax(p_tax),
    'projectId', p_project, 'costCodeId', pg_temp.cc(p_code)) $$;
create or replace function pg_temp.te(p_date text, p_project uuid, p_code text, p_start text, p_end text, p_break int, p_hours numeric default null, p_type text default 'ordinary') returns jsonb language sql as $$
  select jsonb_build_object('date', p_date, 'projectId', p_project, 'costCodeId', pg_temp.cc(p_code), 'start', p_start, 'end', p_end,
    'breakMinutes', p_break, 'hours', p_hours, 'hourType', p_type) $$;
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
create temporary table tj (k text primary key, v uuid);

-- Two tradespeople who may only enter their own time.
insert into auth.users (email) values ('welder1@fin.test'), ('welder2@fin.test');
insert into public.profile_permissions (profile_id, permission_key, granted)
select id, 'time.submit', true from public.training_profiles where email in ('welder1@fin.test', 'welder2@fin.test');

-- Set-up: rates, project, budget ---------------------------------------------------------------
do $$
declare v uuid;
begin
  perform pg_temp.eq(public.app_has(pg_temp.p('welder1'), 'time.submit'), true, 'worker can enter time');
  perform pg_temp.eq(public.app_has(pg_temp.p('welder1'), 'reports.view'), false, 'worker sees no reports');
  perform pg_temp.eq(public.app_has(pg_temp.p('pm'), 'time.submit'), true, 'project managers enter time too');
  perform pg_temp.eq((select count(*)::int from public.cost_codes where category = 'labour'), 5, 'labour cost codes seeded');

  perform pg_temp.expect_error(format('select public.labour_class_save(%L, %L, %L, %L, 65, 110, true)', pg_temp.p('welder1'),
    (select id from public.labour_classes where code = 'WELDER'), 'WELDER', 'Welder'), 'Projects');
  perform public.labour_class_save(pg_temp.p('pm'), (select id from public.labour_classes where code = 'WELDER'), 'WELDER', 'Welder', 65, 110, true);
  perform pg_temp.expect_error(format('select public.labour_class_save(%L, null, %L, %L, 45.555, 80, true)', pg_temp.p('pm'), 'X', 'Bad'), 'dollars and cents');

  perform pg_temp.expect_error(format('select public.project_save(%L, null, %L, null)', pg_temp.p('finance'), '{"name":"Nope"}'), 'Projects');
  -- Budget: welding 40 h / $3,000; materials $5,000; subcontract $2,000. Total $10,000 against a $20,000 contract.
  v := public.project_save(pg_temp.p('pm'), null,
    jsonb_build_object('name', 'Berth 4 pipework', 'customer_id', (select id from public.customers where name = 'Hunter Refinery Pty Ltd'),
      'contract_value', '20000', 'site', 'Kooragang Berth 4', 'manager_id', pg_temp.p('pm'), 'start_date', '2026-09-01'),
    jsonb_build_array(jsonb_build_object('costCodeId', pg_temp.cc('110'), 'hours', 40, 'amount', 3000),
                      jsonb_build_object('costCodeId', pg_temp.cc('200'), 'amount', 5000),
                      jsonb_build_object('costCodeId', pg_temp.cc('400'), 'amount', 2000)));
  insert into tj values ('job', v);
  perform pg_temp.eq((select number from public.projects where id = v), 'JOB-1001', 'project numbered');
  perform pg_temp.eq((select sum(budget_amount) from public.project_budgets where project_id = v), 10000.00, 'budget saved');
end $$;

-- Timesheets ------------------------------------------------------------------------------------
do $$
declare v_ts uuid; v_job uuid := (select v from tj where k = 'job');
begin
  -- Validation.
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, false)', pg_temp.p('welder1'), '2026-09-08', '[]'), 'starts on a Monday');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, false)', pg_temp.p('welder1'), '2026-09-07',
    jsonb_build_array(pg_temp.te('2026-09-14', v_job, '110', '07:00', '15:30', 30))), 'must be in the week');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, false)', pg_temp.p('welder1'), '2026-09-07',
    jsonb_build_array(pg_temp.te('2026-09-07', v_job, '110', '07:00', null, 30))), 'both a start and a finish');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, false)', pg_temp.p('welder1'), '2026-09-07',
    jsonb_build_array(pg_temp.te('2026-09-07', v_job, '200', null, null, 0, 8))), 'labour cost code');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, false)', pg_temp.p('welder1'), '2026-09-07',
    jsonb_build_array(pg_temp.te('2026-09-07', v_job, '110', null, null, 0, 16), pg_temp.te('2026-09-07', null, null, null, null, 0, 9))), 'more than 24 hours');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, %L, %L, %L, false)', pg_temp.p('welder1'), pg_temp.p('welder2'), '2026-09-07', '[]'), 'Approve timesheets');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, false)', pg_temp.p('staff'), '2026-09-07', '[]'), 'timesheets');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, true)', pg_temp.p('welder1'), '2026-09-07', '[]'), 'Add your hours');

  -- Mon 07:00-15:30 less 30 min = 8.0; Tue 8.0 ordinary + 2.0 at time and a half; Wed night shift 22:00-06:00 less 30 = 7.5. Total 25.5.
  v_ts := public.timesheet_save(pg_temp.p('welder1'), null, '2026-09-07', jsonb_build_array(
    pg_temp.te('2026-09-07', v_job, '110', '07:00', '15:30', 30),
    pg_temp.te('2026-09-08', v_job, '110', null, null, 0, 8),
    pg_temp.te('2026-09-08', v_job, '110', null, null, 0, 2, 'overtime_150'),
    pg_temp.te('2026-09-09', v_job, '110', '22:00', '06:00', 30)), true);
  insert into tj values ('ts1', v_ts);
  perform pg_temp.eq((select total_hours from public.timesheets where id = v_ts), 25.50, 'hours worked out from times');
  perform pg_temp.eq((select hours from public.timesheet_entries where timesheet_id = v_ts and work_date = '2026-09-09'), 7.50, 'shift past midnight');
  perform pg_temp.eq((select status from public.timesheets where id = v_ts), 'submitted', 'submitted');
  perform pg_temp.eq((select count(*)::int from public.notifications where profile_id = pg_temp.p('pm') and kind = 'timesheet_submitted'), 1, 'approver notified');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, false)', pg_temp.p('welder1'), '2026-09-07', '[]'), 'Recall it first');

  -- Approval needs someone else, with the person's labour class set.
  perform pg_temp.expect_error(format('select public.timesheet_decide(%L, %L, true, null)', pg_temp.p('welder1'), v_ts), 'Approve timesheets');
  perform pg_temp.expect_error(format('select public.timesheet_decide(%L, %L, true, null)', pg_temp.p('pm'), v_ts), 'labour class');
  perform public.labour_profile_set(pg_temp.p('pm'), pg_temp.p('welder1'), (select id from public.labour_classes where code = 'WELDER'));
  perform public.timesheet_decide(pg_temp.p('pm'), v_ts, true, 'Checked against the site diary');
  -- 23.5 ordinary hours x $65 = 1,527.50; 2 overtime hours x $97.50 = 195.00. Total 1,722.50.
  perform pg_temp.eq((select sum(cost_amount) from public.timesheet_entries where timesheet_id = v_ts), 1722.50, 'labour cost frozen on approval');
  perform pg_temp.eq((select cost_rate from public.timesheet_entries where timesheet_id = v_ts and hour_type = 'overtime_150'), 97.50, 'overtime factor');
  perform pg_temp.expect_error(format('select public.timesheet_save(%L, null, %L, %L, false)', pg_temp.p('welder1'), '2026-09-07', '[]'), 'has been approved');

  -- A rate change later doesn't alter approved costs.
  perform public.labour_class_save(pg_temp.p('pm'), (select id from public.labour_classes where code = 'WELDER'), 'WELDER', 'Welder', 70, 115, true);
  perform pg_temp.eq((select sum(cost_amount) from public.timesheet_entries where timesheet_id = v_ts), 1722.50, 'history unchanged by new rates');

  -- Reopening needs a reason, clears the costs, and re-approval uses the current rate; then back to $65 for the figures below.
  perform pg_temp.expect_error(format('select public.timesheet_reopen(%L, %L, %L)', pg_temp.p('pm'), v_ts, ''), 'reason');
  perform public.timesheet_reopen(pg_temp.p('pm'), v_ts, 'Wrong cost code on Wednesday');
  perform pg_temp.eq((select count(*)::int from public.timesheet_entries where timesheet_id = v_ts and cost_amount is not null), 0, 'costs cleared on reopen');
  perform public.labour_class_save(pg_temp.p('pm'), (select id from public.labour_classes where code = 'WELDER'), 'WELDER', 'Welder', 65, 110, true);
  perform public.timesheet_save(pg_temp.p('welder1'), null, '2026-09-07', (select jsonb_agg(jsonb_build_object('date', work_date, 'projectId', project_id,
    'costCodeId', cost_code_id, 'start', start_time, 'end', end_time, 'breakMinutes', break_minutes, 'hours', hours, 'hourType', hour_type) order by line_no)
    from public.timesheet_entries where timesheet_id = v_ts), true);
  perform public.timesheet_decide(pg_temp.p('pm'), v_ts, true, null);
  perform pg_temp.eq((select sum(cost_amount) from public.timesheet_entries where timesheet_id = v_ts), 1722.50, 're-approved');

  -- Rejection goes back to the person with a reason.
  v_ts := public.timesheet_save(pg_temp.p('welder2'), null, '2026-09-07', jsonb_build_array(pg_temp.te('2026-09-10', v_job, '110', null, null, 0, 6)), true);
  perform pg_temp.expect_error(format('select public.timesheet_decide(%L, %L, false, %L)', pg_temp.p('pm'), v_ts, ''), 'what needs fixing');
  perform public.timesheet_decide(pg_temp.p('pm'), v_ts, false, 'Thursday was rained off');
  perform pg_temp.eq((select status from public.timesheets where id = v_ts), 'rejected', 'rejected');
  perform pg_temp.eq((select count(*)::int from public.notifications where profile_id = pg_temp.p('welder2') and kind = 'timesheet_rejected'), 1, 'worker told why');
  -- A supervisor can enter a crew member's week.
  perform public.timesheet_save(pg_temp.p('pm'), pg_temp.p('welder2'), '2026-09-14', jsonb_build_array(pg_temp.te('2026-09-14', v_job, '120', null, null, 0, 8)), false);
  perform pg_temp.eq((select created_by from public.timesheets where profile_id = pg_temp.p('welder2') and week_start = '2026-09-14'), pg_temp.p('pm'), 'crew entry recorded');
  -- The project can't be closed while hours on it are still waiting.
  perform pg_temp.expect_error(format('select public.project_set_status(%L, %L, %L)', pg_temp.p('pm'), v_job, 'closed'), 'still waiting');
end $$;

-- Costs and revenue from purchasing and sales ------------------------------------------------------
do $$
declare v_job uuid := (select v from tj where k = 'job'); v_boc uuid := (select id from public.suppliers where name = 'BOC Gases'); v_id uuid; v_po uuid; v_pl uuid; v_other uuid;
begin
  -- Materials: 2 x $1,000 + GST (ex GST $2,000), then a $110 inc GST credit (ex GST -$100). Net $1,900 on cost code 200.
  v_id := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', v_boc, 'bill_date', '2026-09-11', 'supplier_reference', 'JOB-M1'),
    jsonb_build_array(pg_temp.ln('DN150 pipe', 2, 1000, '5100', 'GSTE', v_job, '200')));
  perform public.bill_approve(pg_temp.p('finance'), v_id);
  v_id := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('kind', 'credit_note', 'supplier_id', v_boc, 'bill_date', '2026-09-12', 'supplier_reference', 'JOB-C1', 'amounts_are', 'inclusive'),
    jsonb_build_array(pg_temp.ln('Returned fittings', 1, 110, '5100', 'GSTE', v_job, '200')));
  perform public.bill_approve(pg_temp.p('finance'), v_id);
  perform pg_temp.eq((select project_id from public.bill_lines where document_id = v_id), v_job, 'line tagged');
  perform pg_temp.expect_error(format('select public.bill_save(%L, null, %L, %L)', pg_temp.p('finance'),
    jsonb_build_object('supplier_id', v_boc, 'bill_date', '2026-09-11', 'supplier_reference', 'JOB-X'),
    jsonb_build_array(pg_temp.ln('x', 1, 1, '5100', 'GSTE', null, '200'))), 'choose the project');

  -- Subcontract: PO for 2 x $750 (ex GST), half billed. $750 actual, $750 committed on cost code 400.
  v_po := public.po_save(pg_temp.p('pm'), null, jsonb_build_object('supplier_id', v_boc, 'order_date', '2026-09-08'),
    jsonb_build_array(pg_temp.ln('NDT shots', 2, 750, '5300', 'GSTE', v_job, '400')));
  perform public.po_set_status(pg_temp.p('pm'), v_po, 'submitted', null);
  perform public.po_set_status(pg_temp.p('finance'), v_po, 'approved', null);
  perform public.po_set_status(pg_temp.p('finance'), v_po, 'issued', null);
  select id into v_pl from public.purchase_order_lines where document_id = v_po;
  v_id := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', v_boc, 'bill_date', '2026-09-15', 'supplier_reference', 'JOB-N1', 'purchase_order_id', v_po),
    jsonb_build_array(pg_temp.ln('NDT shots', 1, 750, '5300', 'GSTE', v_job, '400') || jsonb_build_object('poLineId', v_pl)));
  perform public.bill_approve(pg_temp.p('finance'), v_id);

  -- Revenue: progress claim of $8,000 + GST.
  v_id := public.invoice_save(pg_temp.p('finance'), null, jsonb_build_object('customer_id', (select id from public.customers where name = 'Hunter Refinery Pty Ltd'),
    'invoice_date', '2026-09-20', 'invoice_type', 'progress'), jsonb_build_array(pg_temp.ln('Progress claim 1', 1, 8000, '4300', 'GST', v_job)));
  perform public.invoice_approve(pg_temp.p('finance'), v_id);
  perform pg_temp.eq((select cost_code_id from public.invoice_lines where document_id = v_id), null::uuid, 'no cost codes on income');

  -- A closed project can't take new costs.
  v_other := public.project_save(pg_temp.p('pm'), null, '{"name":"Old job"}', null);
  perform public.project_set_status(pg_temp.p('pm'), v_other, 'closed');
  perform pg_temp.expect_error(format('select public.bill_save(%L, null, %L, %L)', pg_temp.p('finance'),
    jsonb_build_object('supplier_id', v_boc, 'bill_date', '2026-09-11', 'supplier_reference', 'JOB-Y'),
    jsonb_build_array(pg_temp.ln('x', 1, 1, '5100', 'GSTE', v_other, '200'))), 'closed');
end $$;

-- The job costing report -----------------------------------------------------------------------------
do $$
declare r jsonb; v_row jsonb; v_job uuid := (select v from tj where k = 'job'); v_sum jsonb;
begin
  r := public.report_project_costing(pg_temp.p('pm'), v_job, '2026-09-30');
  v_row := (select x from jsonb_array_elements(r->'rows') x where x->>'code' = '110');
  perform pg_temp.eq((v_row->>'actualHours')::numeric, 25.50, 'welding hours (rejected and draft weeks excluded)');
  perform pg_temp.eq((v_row->>'labourCost')::numeric, 1722.50, 'welding labour');
  perform pg_temp.eq((v_row->>'percentUsed')::numeric, 57.4, '1,722.50 of 3,000');
  v_row := (select x from jsonb_array_elements(r->'rows') x where x->>'code' = '200');
  perform pg_temp.eq((v_row->>'otherCost')::numeric, 1900.00, 'materials net of the supplier credit');
  v_row := (select x from jsonb_array_elements(r->'rows') x where x->>'code' = '400');
  perform pg_temp.eq((v_row->>'otherCost')::numeric || '/' || (v_row->>'committed')::numeric, '750.00/750.00', 'subcontract actual and committed');
  -- Totals: cost 1,722.50 + 1,900 + 750 = 4,372.50; committed 750; remaining 10,000 - 4,372.50 - 750 = 4,877.50.
  perform pg_temp.eq((r->'totals'->>'actualCost')::numeric, 4372.50, 'cost to date');
  perform pg_temp.eq((r->'totals'->>'remaining')::numeric, 4877.50, 'budget remaining after commitments');
  -- Invoiced 8,000; margin 3,627.50 (45.3%); progress 43.7%; earned 8,745.00; under-billed by 745.00.
  perform pg_temp.eq((r->'revenue'->>'invoiced')::numeric, 8000.00, 'invoiced ex GST');
  perform pg_temp.eq((r->'margin'->>'grossMargin')::numeric, 3627.50, 'margin to date');
  perform pg_temp.eq((r->'margin'->>'marginPercent')::numeric, 45.3, 'margin percent');
  perform pg_temp.eq((r->'progress'->>'percentComplete')::numeric, 43.7, 'progress on cost');
  perform pg_temp.eq((r->'progress'->>'overUnderBilling')::numeric, -745.00, 'under-billed');
  -- As at before any of it: nothing.
  r := public.report_project_costing(pg_temp.p('pm'), v_job, '2026-09-06');
  perform pg_temp.eq((r->'totals'->>'actualCost')::numeric, 0::numeric, 'nothing before the work started');

  v_sum := (select x from jsonb_array_elements(public.report_projects_summary(pg_temp.p('pm'), 'open')) x where x->>'number' = 'JOB-1001');
  perform pg_temp.eq((v_sum->>'cost')::numeric, 4372.50, 'summary agrees');
  perform pg_temp.eq(jsonb_array_length(public.report_timesheet_hours(pg_temp.p('pm'), '2026-09-01', '2026-09-30')), 4, 'approved entries for payroll');
end $$;

-- Lock-down ---------------------------------------------------------------------------------------------
do $$
begin
  perform pg_temp.eq(has_table_privilege('authenticated', 'public.timesheets', 'select'), false, 'timesheets not readable from browsers');
  perform pg_temp.eq(has_table_privilege('anon', 'public.labour_classes', 'select'), false, 'rates not readable anonymously');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.timesheet_decide(uuid, uuid, boolean, text)', 'execute'), false, 'approve not callable from browsers');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type in ('timesheet_approved', 'timesheet_reopened', 'labour_class_updated')) >= 5, true, 'audited');
end $$;

select 'timesheets_job_costing tests passed' as result;
