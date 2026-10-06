-- Behavioural tests for the accounting core (Phase 2). Uses the @fin.test
-- people created by finance_foundation.test.sql (finance admin, director,
-- payroll admin, system admin, staff).

create or replace function pg_temp.p(p text) returns uuid language sql as $$ select id from public.training_profiles where email = p || '@fin.test' $$;
create or replace function pg_temp.acc(p text) returns uuid language sql as $$
  select id from public.accounts where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.tax(p text) returns uuid language sql as $$
  select id from public.tax_codes where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.bal(p_code text) returns numeric language sql as $$
  select coalesce(sum(jl.debit - jl.credit), 0) from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id
  where jl.account_id = pg_temp.acc(p_code) and je.status in ('posted', 'reversed') $$;
create or replace function pg_temp.line(p_acc text, p_dr numeric, p_cr numeric, p_tax text default null, p_desc text default '') returns jsonb language sql as $$
  select jsonb_build_object('accountId', pg_temp.acc(p_acc), 'debit', p_dr, 'credit', p_cr, 'taxCodeId', pg_temp.tax(p_tax), 'description', p_desc) $$;
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
create temporary table lj (k text primary key, v uuid);

-- Seeded chart, tax codes and periods ---------------------------------------------
do $$
begin
  perform pg_temp.eq((select count(*)::int from public.accounts where organization_id = '00000000-0000-4000-8000-000000000001'), 63, 'brief chart seeded');
  perform pg_temp.eq((select count(*)::int from public.tax_codes where is_system), 10, 'GST codes seeded');
  perform pg_temp.eq((select count(*)::int from public.accounting_periods p join public.financial_years y on y.id = p.financial_year_id where y.name = 'FY2026-27'), 12, '12 periods');
  perform pg_temp.eq((select start_date from public.financial_years where name = 'FY2026-27'), date '2026-07-01', 'FY starts 1 July');
  perform pg_temp.eq((select p.end_date from public.accounting_periods p join public.financial_years y on y.id = p.financial_year_id where y.name = 'FY2026-27' and period_no = 8), date '2027-02-28', 'February period ends 28th');
  perform pg_temp.eq(public.account_normal_side('revenue'), 'credit', 'revenue is a credit account');
  perform pg_temp.eq((select allow_manual from public.accounts where id = pg_temp.acc('1100')), false, 'receivables is a control account');
end $$;

-- Posting, GST and rounding ------------------------------------------------------------
do $$
declare
  v_id uuid; v_num text;
begin
  -- Permissions.
  perform pg_temp.expect_error(format('select public.journal_save_draft(%L, null, %L, %L, %L, %L)', pg_temp.p('payroll'), '2026-08-03', 'x', 'exclusive',
    jsonb_build_array(pg_temp.line('1000', 1, 0), pg_temp.line('4000', 0, 1))), 'Create journals');

  -- J1: exclusive GST on income. Bank 1,100 Dr; revenue 1,000 Cr + GST 100 Cr.
  v_id := public.journal_save_draft(pg_temp.p('finance'), null, '2026-08-03', 'Fabrication job 2201', 'exclusive',
    jsonb_build_array(pg_temp.line('1000', 1100, 0), pg_temp.line('4000', 0, 1000, 'GST', 'Fab job')));
  perform pg_temp.eq((select count(*)::int from public.journal_lines where journal_id = v_id), 3, 'GST line added to the draft');
  perform pg_temp.eq((select status from public.journal_entries where id = v_id), 'draft', 'saved as draft');
  v_num := public.journal_post(pg_temp.p('finance'), v_id);
  perform pg_temp.eq(v_num, 'JE-000001', 'first journal number');
  perform pg_temp.eq((select credit from public.journal_lines where journal_id = v_id and is_tax_line), 100.00, 'GST 10% of 1,000');
  perform pg_temp.eq((select account_id from public.journal_lines where journal_id = v_id and is_tax_line), pg_temp.acc('2300'), 'GST to 2300');
  insert into lj values ('j1', v_id);

  -- J2: inclusive GST on expenses. 110 incl = 100 + 10 GST.
  v_id := public.journal_save_draft(pg_temp.p('finance'), null, '2026-08-05', 'Vehicle service', 'inclusive',
    jsonb_build_array(pg_temp.line('6300', 110, 0, 'GSTE'), pg_temp.line('1000', 0, 110)));
  perform public.journal_post(pg_temp.p('finance'), v_id);
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_id and account_id = pg_temp.acc('6300')), 100.00, 'inclusive net');
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_id and is_tax_line), 10.00, 'inclusive GST');

  -- J4: rounding to the cent, half up. 33.33 x 10% = 3.333 -> 3.33.
  v_id := public.journal_save_draft(pg_temp.p('finance'), null, '2026-08-06', 'Software', 'exclusive',
    jsonb_build_array(pg_temp.line('7100', 33.33, 0, 'GSTE'), pg_temp.line('1000', 0, 36.66)));
  perform public.journal_post(pg_temp.p('finance'), v_id);
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_id and is_tax_line), 3.33, 'GST rounds to 3.33');
  insert into lj values ('j4', v_id);
  perform pg_temp.eq((select x->>'tax_amount' from jsonb_array_elements(public.ledger_build_lines('00000000-0000-4000-8000-000000000001',
    jsonb_build_array(pg_temp.line('7100', 0.05, 0, 'GSTE'), pg_temp.line('1000', 0, 0.06)), 'exclusive', true)->'lines') x limit 1), '0.01', 'half a cent rounds up');

  -- J3: prior financial year (FY2025-26), GST-free.
  v_id := public.ledger_post_entry(pg_temp.p('finance'), '2026-03-10', 'Prior year sale', 'manual', null, null,
    jsonb_build_array(pg_temp.line('1000', 500, 0), pg_temp.line('4800', 0, 500, 'FRE')), 'exclusive', true);
  perform pg_temp.eq((select count(*)::int from public.journal_lines where journal_id = v_id), 2, 'GST-free adds no GST line');

  -- Refusals.
  v_id := public.journal_save_draft(pg_temp.p('finance'), null, '2026-08-07', 'Out of balance', 'exclusive',
    jsonb_build_array(pg_temp.line('1000', 10, 0), pg_temp.line('4000', 0, 9)));
  perform pg_temp.expect_error(format('select public.journal_post(%L, %L)', pg_temp.p('finance'), v_id), 'must be equal');
  perform pg_temp.expect_error(format('select public.journal_save_draft(%L, null, %L, %L, %L, %L)', pg_temp.p('finance'), '2026-08-07', 'x', 'exclusive',
    jsonb_build_array(pg_temp.line('1100', 10, 0), pg_temp.line('4000', 0, 10))), 'control account');
  perform pg_temp.expect_error(format('select public.journal_save_draft(%L, null, %L, %L, %L, %L)', pg_temp.p('finance'), '2026-08-07', 'x', 'exclusive',
    jsonb_build_array(pg_temp.line('3200', 10, 0), pg_temp.line('4000', 0, 10))), 'control account');
  perform pg_temp.expect_error(format('select public.journal_save_draft(%L, null, %L, %L, %L, %L)', pg_temp.p('finance'), '2026-08-07', 'x', 'exclusive',
    jsonb_build_array(pg_temp.line('1000', 10, 10), pg_temp.line('4000', 0, 10))), 'either a debit or a credit');
  perform pg_temp.expect_error(format('select public.journal_save_draft(%L, null, %L, %L, %L, %L)', pg_temp.p('finance'), '2026-08-07', 'x', 'exclusive',
    jsonb_build_array(pg_temp.line('1000', 10.005, 0), pg_temp.line('4000', 0, 10.005))), '2 decimal places');
  perform pg_temp.expect_error(format('select public.journal_save_draft(%L, null, %L, %L, %L, %L)', pg_temp.p('finance'), '2026-08-07', 'x', 'exclusive',
    jsonb_build_array(pg_temp.line('1000', 10, 0))), 'at least two lines');
  perform pg_temp.expect_error(format('select public.ledger_post_entry(%L, %L, %L, %L, null, null, %L)', pg_temp.p('finance'), '2030-01-01', 'x', 'manual',
    jsonb_build_array(pg_temp.line('1000', 10, 0), pg_temp.line('4000', 0, 10))), 'No accounting period');
  -- Drafts can be deleted by their author; posted journals cannot.
  perform public.journal_delete_draft(pg_temp.p('finance'), v_id);
end $$;

-- Posted journals are immutable; the database refuses unbalanced postings ------------------
do $$
declare
  v_j uuid := (select v from lj where k = 'j1');
  v_draft uuid;
begin
  set constraints all immediate;
  perform pg_temp.expect_error(format('update public.journal_entries set memo = %L where id = %L', 'changed', v_j), 'cannot be changed');
  perform pg_temp.expect_error(format('delete from public.journal_entries where id = %L', v_j), 'cannot be deleted');
  perform pg_temp.expect_error(format('update public.journal_lines set debit = 1 where journal_id = %L and debit > 0', v_j), 'cannot be changed');
  perform pg_temp.expect_error(format('insert into public.journal_lines (journal_id, line_no, account_id, debit) values (%L, 99, %L, 5)', v_j, pg_temp.acc('1000')), 'cannot be changed');
  -- A draft with unbalanced lines forced to "posted" behind the engine's back is still refused.
  insert into public.journal_entries (organization_id, entry_date, memo, created_by) values ('00000000-0000-4000-8000-000000000001', '2026-08-08', 'sneaky', pg_temp.p('finance')) returning id into v_draft;
  insert into public.journal_lines (journal_id, line_no, account_id, debit) values (v_draft, 1, pg_temp.acc('1000'), 50);
  insert into public.journal_lines (journal_id, line_no, account_id, credit) values (v_draft, 2, pg_temp.acc('4000'), 40);
  perform pg_temp.expect_error(format('update public.journal_entries set status = %L, number = %L, period_id = (select id from public.accounting_periods where %L between start_date and end_date), posted_at = now() where id = %L',
    'posted', 'JE-X', '2026-08-08', v_draft), 'does not balance');
  delete from public.journal_entries where id = v_draft;
  set constraints all deferred;
end $$;

-- Reports -------------------------------------------------------------------------------------
do $$
declare
  tb jsonb; pl jsonb; bs jsonb; tx jsonb;
begin
  tb := public.report_trial_balance(pg_temp.p('finance'), '2026-08-31');
  perform pg_temp.eq((tb->>'totalDebit')::numeric, 1586.67, 'TB debits');
  perform pg_temp.eq((tb->>'totalCredit')::numeric, 1586.67, 'TB credits equal debits');
  perform pg_temp.eq((select (r->>'credit')::numeric from jsonb_array_elements(tb->'rows') r where r->>'code' = '3100'), 500.00, 'prior-year profit rolled into retained earnings');
  perform pg_temp.eq((select count(*)::int from jsonb_array_elements(tb->'rows') r where r->>'code' = '4800'), 0, 'prior-year revenue not in this year''s TB');
  perform pg_temp.eq((select (r->>'credit')::numeric from jsonb_array_elements(tb->'rows') r where r->>'code' = '2300'), 86.67, 'GST owed 100 - 10 - 3.33');

  pl := public.report_profit_loss(pg_temp.p('finance'), '2026-07-01', '2026-08-31');
  perform pg_temp.eq((pl->'totals'->>'revenue')::numeric, 1000.00, 'P&L revenue');
  perform pg_temp.eq((pl->'totals'->>'expenses')::numeric, 133.33, 'P&L expenses');
  perform pg_temp.eq((pl->'totals'->>'netProfit')::numeric, 866.67, 'P&L net profit');
  perform pg_temp.expect_error(format('select public.report_profit_loss(%L, %L, %L)', pg_temp.p('finance'), '2026-09-01', '2026-08-01'), 'start date is after');

  bs := public.report_balance_sheet(pg_temp.p('finance'), '2026-08-31');
  perform pg_temp.eq((bs->'totals'->>'assets')::numeric, 1453.34, 'BS assets');
  perform pg_temp.eq((bs->'totals'->>'liabilities')::numeric, 86.67, 'BS liabilities');
  perform pg_temp.eq((bs->>'retainedEarningsPriorYears')::numeric, 500.00, 'BS retained earnings');
  perform pg_temp.eq((bs->>'currentYearEarnings')::numeric, 866.67, 'BS current year earnings');
  perform pg_temp.eq((bs->'totals'->>'balanced')::boolean, true, 'assets - liabilities = equity');

  tx := public.report_account_transactions(pg_temp.p('finance'), pg_temp.acc('1000'), '2026-08-01', '2026-08-31');
  perform pg_temp.eq((tx->>'openingBalance')::numeric, 500.00, 'bank opening balance carries prior year');
  perform pg_temp.eq((tx->>'closingBalance')::numeric, 1453.34, 'bank closing balance');
  perform pg_temp.eq(jsonb_array_length(tx->'rows'), 3, 'three bank lines in August');
end $$;

-- Reversal ------------------------------------------------------------------------------------
do $$
declare
  v_rev uuid;
begin
  perform pg_temp.expect_error(format('select public.journal_reverse(%L, %L, null, %L)', pg_temp.p('finance'), (select v from lj where k = 'j4'), ''), 'reason');
  v_rev := public.journal_reverse(pg_temp.p('finance'), (select v from lj where k = 'j4'), '2026-08-20', 'Wrong account');
  perform pg_temp.eq((select status from public.journal_entries where id = (select v from lj where k = 'j4')), 'reversed', 'original marked reversed');
  perform pg_temp.eq((select reverses_id from public.journal_entries where id = v_rev), (select v from lj where k = 'j4'), 'reversal links back');
  perform pg_temp.eq(pg_temp.bal('7100'), 0.00, 'reversal nets the expense to nil');
  perform pg_temp.eq(pg_temp.bal('2300'), -90.00, 'GST back to 100 - 10');
  perform pg_temp.expect_error(format('select public.journal_reverse(%L, %L, null, %L)', pg_temp.p('finance'), (select v from lj where k = 'j4'), 'again'), 'Only a posted');
  perform pg_temp.expect_error(format('select public.journal_reverse(%L, %L, null, %L)', pg_temp.p('finance'), v_rev, 'undo'), 'itself a reversal');
end $$;

-- Periods ---------------------------------------------------------------------------------------
do $$
declare
  v_may uuid := (select id from public.accounting_periods where date '2026-05-15' between start_date and end_date);
  v_lines jsonb := jsonb_build_array(pg_temp.line('1000', 5, 0), pg_temp.line('4800', 0, 5));
begin
  perform pg_temp.expect_error(format('select public.period_set_status(%L, %L, %L, null)', pg_temp.p('payroll'), v_may, 'soft_locked'), 'Approve and post');
  perform public.period_set_status(pg_temp.p('finance'), v_may, 'soft_locked', null);
  perform pg_temp.expect_error(format('select public.ledger_post_entry(%L, %L, %L, %L, null, null, %L)', pg_temp.p('finance'), '2026-05-15', 'x', 'manual', v_lines), 'is locked');
  perform public.ledger_post_entry(pg_temp.p('director'), '2026-05-15', 'Year-end adjustment', 'manual', null, null, v_lines);
  perform public.period_set_status(pg_temp.p('finance'), v_may, 'closed', null);
  perform pg_temp.expect_error(format('select public.ledger_post_entry(%L, %L, %L, %L, null, null, %L)', pg_temp.p('director'), '2026-05-15', 'x', 'manual', v_lines), 'is closed');
  perform pg_temp.expect_error(format('select public.period_set_status(%L, %L, %L, %L)', pg_temp.p('finance'), v_may, 'open', 'fix'), 'Reopen closed periods');
  perform pg_temp.expect_error(format('select public.period_set_status(%L, %L, %L, %L)', pg_temp.p('director'), v_may, 'open', ''), 'reason');
  perform public.period_set_status(pg_temp.p('director'), v_may, 'open', 'Accountant adjustment');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type = 'period_reopened'), 1, 'reopen audited');
  perform public.financial_year_add(pg_temp.p('finance'), '2027-08-01');
  perform pg_temp.eq((select count(*)::int from public.financial_years where name = 'FY2027-28'), 1, 'next year added');
end $$;

-- Accounts and tax codes ------------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  perform pg_temp.expect_error(format('select public.account_save(%L, null, %L, %L, %L, null, null, null, true)', pg_temp.p('payroll'), '4900', 'Scrap sales', 'revenue'), 'Chart of accounts');
  v_id := public.account_save(pg_temp.p('finance'), null, '4900', 'Scrap Sales', 'revenue', 'general', 'Sale of offcuts', pg_temp.tax('GST'), true);
  perform pg_temp.expect_error(format('select public.account_save(%L, null, %L, %L, %L, null, null, null, true)', pg_temp.p('finance'), '4900', 'Dup', 'revenue'), 'already used');
  perform pg_temp.expect_error(format('select public.account_save(%L, %L, %L, %L, %L, %L, null, null, false)', pg_temp.p('finance'), pg_temp.acc('1100'), '1100', 'AR', 'expense', 'general'), 'cannot change');
  perform pg_temp.expect_error(format('select public.account_save(%L, null, %L, %L, %L, %L, null, null, true)', pg_temp.p('finance'), '3300', 'Fake RE', 'equity', 'retained_earnings'), 'reserved');
  perform public.account_save(pg_temp.p('finance'), v_id, '4900', 'Scrap Metal Sales', 'revenue', 'general', '', pg_temp.tax('GST'), true);
  perform pg_temp.expect_error(format('select public.account_set_status(%L, %L, false)', pg_temp.p('finance'), pg_temp.acc('2300')), 'System accounts');
  perform pg_temp.expect_error(format('select public.account_set_status(%L, %L, false)', pg_temp.p('finance'), pg_temp.acc('1000')), 'System accounts');
  perform public.account_set_status(pg_temp.p('finance'), v_id, false);
  perform pg_temp.expect_error(format('select public.journal_save_draft(%L, null, %L, %L, %L, %L)', pg_temp.p('finance'), '2026-08-09', 'x', 'exclusive',
    jsonb_build_array(pg_temp.line('1000', 1, 0), pg_temp.line('4900', 0, 1))), 'archived');
  perform pg_temp.expect_error(format('select public.tax_code_save(%L, %L, %L, %L, %L, 0.15, %L, null, true)', pg_temp.p('finance'), pg_temp.tax('GST'), 'GST', 'GST on Income', 'gst_income', 'sales'), 'fixed');
  perform public.tax_code_save(pg_temp.p('finance'), pg_temp.tax('GST'), 'GST', 'GST on Income (10%)', 'gst_income', 0.10, 'sales', null, true);
end $$;

-- Browser roles stay locked out ----------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['financial_years', 'accounting_periods', 'tax_codes', 'accounts', 'journal_entries', 'journal_lines']
  loop
    perform pg_temp.eq(has_table_privilege('authenticated', 'public.' || t, 'select'), false, t || ' hidden from browsers');
  end loop;
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.ledger_post_entry(uuid, date, text, text, uuid, text, jsonb, text, boolean)', 'execute'), false, 'posting engine not callable from browsers');
end $$;

select 'ledger_core tests passed' as result;
