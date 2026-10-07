-- Behavioural tests for Phase 7: BAS and TPAR. Runs last and works in the
-- quarter January to March 2027, which no earlier test touches.
--
-- The quarter, all amounts GST-exclusive unless noted:
--   15 Jan  Invoice I1   10,000.00 + GST 1,000.00 (GST)        -> total 11,000.00
--   10 Feb  Invoice I2    2,000.00 GST-free (FRE)
--   05 Mar  Credit note  (1,000.00) + GST (100.00) against I1
--   01 Feb  Receipt       5,500.00 against I1 (half of it)
--   20 Jan  Bill B1       3,000.00 + GST 300.00 (GSTE)         -> paid in full 10 Mar
--   15 Feb  Bill B2       5,000.00 + GST 500.00 (CAP), unpaid
--   01 Mar  Bill B3       1,000.00 GST-free, supplier quotes no ABN: 470.00 withheld; half the 530.00 payable paid
--   10 Mar  Pay run: Olivia's salary 1,500.00, 100.00 salary sacrificed, PAYG 439.00
--   20 Mar  Journal: vehicle costs 200.50 + GST 20.05 (GSTE)
--   25 Mar  Journal: 5.00 straight to the GST account; 50.00 repairs with no tax code
--
-- Accrual basis:
--   G1  = 9,900 (GST: 9,000 + 900) + 2,000 (FRE) = 11,900;  G3 = 2,000;  1A = 900.00
--   G10 = 5,500;  G11 = 3,520.55 (GSTE: 3,200.50 + 320.05) + 1,000 (FREE) = 4,520.55;  G14 = 1,000;  1B = 820.05
--   W1  = 1,400 (after salary sacrifice);  W2 = 439;  W4 = 470;  W5 = 909
--   5A  = 1,200 and 7D = 35 entered.  8A = 900 + 909 + 1,200 = 3,009;  8B = 820 + 35 = 855;  9 = 2,154
-- Cash basis: half of I1 (G1 5,500, 1A 500), B1 in full, half of B3, the journal; B2 and I2 unpaid.

-- Everything here is rolled back at the end, so the API tests that follow see
-- the same data as before (the pay run below would change leave balances).
begin;

create or replace function pg_temp.p(p text) returns uuid language sql as $$ select id from public.training_profiles where email = p || '@fin.test' $$;
create or replace function pg_temp.acc(p text) returns uuid language sql as $$
  select id from public.accounts where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.tax(p text) returns uuid language sql as $$
  select id from public.tax_codes where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.ln(p_desc text, p_qty numeric, p_price numeric, p_acc text, p_tax text) returns jsonb language sql as $$
  select jsonb_build_object('description', p_desc, 'quantity', p_qty, 'unitPrice', p_price, 'accountId', pg_temp.acc(p_acc), 'taxCodeId', pg_temp.tax(p_tax)) $$;
create or replace function pg_temp.jl(p_acc text, p_dr numeric, p_cr numeric, p_tax text default null) returns jsonb language sql as $$
  select jsonb_build_object('accountId', pg_temp.acc(p_acc), 'debit', p_dr, 'credit', p_cr, 'taxCodeId', pg_temp.tax(p_tax), 'description', 'test') $$;
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
create or replace function pg_temp.lab(f jsonb, l text) returns numeric language sql as $$ select (f->'labels'->>l)::numeric $$;
create or replace function pg_temp.ex(f jsonb, l text) returns numeric language sql as $$ select (f->'exact'->>l)::numeric $$;
create temporary table bt (k text primary key, v uuid);

-- The quarter's transactions ---------------------------------------------------------------------------------
do $$
declare v_c uuid; v_s uuid; v_n uuid; v_i uuid; v_cn uuid; v_b uuid; v_run uuid; v_j uuid;
begin
  v_c := public.customer_save(pg_temp.p('finance'), null, '{"name":"BAS Test Customer","abn":"83 914 571 673"}');
  v_s := public.supplier_save(pg_temp.p('finance'), null, '{"name":"BAS Test Supplies","abn":"53 004 085 616","gst_registered":true,"is_subcontractor":true,"tpar_reportable":true,
    "address":{"street":"1 Steel St","suburb":"Wollongong","state":"NSW","postcode":"2500"}}');
  v_n := public.supplier_save(pg_temp.p('finance'), null, '{"name":"Smith Labour","gst_registered":false,"is_subcontractor":true,"tpar_reportable":true}');
  insert into bt values ('cust', v_c), ('sup', v_s), ('noabn', v_n);

  v_i := public.invoice_save(pg_temp.p('finance'), null, jsonb_build_object('customer_id', v_c, 'invoice_date', '2027-01-15'),
    jsonb_build_array(pg_temp.ln('Fabrication', 1, 10000, '4000', 'GST')));
  perform public.invoice_approve(pg_temp.p('finance'), v_i);
  insert into bt values ('i1', v_i);
  v_i := public.invoice_save(pg_temp.p('finance'), null, jsonb_build_object('customer_id', v_c, 'invoice_date', '2027-02-10'),
    jsonb_build_array(pg_temp.ln('Export crate work', 1, 2000, '4000', 'FRE')));
  perform public.invoice_approve(pg_temp.p('finance'), v_i);
  v_cn := public.invoice_save(pg_temp.p('finance'), null, jsonb_build_object('kind', 'credit_note', 'customer_id', v_c, 'invoice_date', '2027-03-05',
    'original_invoice_id', (select v from bt where k = 'i1')), jsonb_build_array(pg_temp.ln('Rework allowance', 1, 1000, '4000', 'GST')));
  perform public.invoice_approve(pg_temp.p('finance'), v_cn);
  perform public.customer_payment_record(pg_temp.p('finance'), v_c, '2027-02-01', 5500, pg_temp.acc('1000'), 'EFT', 'bank_transfer',
    jsonb_build_array(jsonb_build_object('invoiceId', (select v from bt where k = 'i1'), 'amount', 5500)));

  v_b := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', v_s, 'bill_date', '2027-01-20', 'supplier_reference', 'BT-1'),
    jsonb_build_array(pg_temp.ln('Steel', 1, 3000, '5100', 'GSTE')));
  perform public.bill_submit(pg_temp.p('finance'), v_b);
  perform public.bill_approve(pg_temp.p('finance'), v_b);
  insert into bt values ('b1', v_b);
  v_b := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', v_s, 'bill_date', '2027-02-15', 'supplier_reference', 'BT-2'),
    jsonb_build_array(pg_temp.ln('Pipe bender', 1, 5000, '1700', 'CAP')));
  perform public.bill_submit(pg_temp.p('finance'), v_b);
  perform public.bill_approve(pg_temp.p('finance'), v_b);
  v_b := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', v_n, 'bill_date', '2027-03-01', 'supplier_reference', 'SL-1'),
    jsonb_build_array(pg_temp.ln('Labour', 1, 1000, '6500', 'FREE')));
  perform public.bill_submit(pg_temp.p('finance'), v_b);
  perform public.bill_approve(pg_temp.p('finance'), v_b);
  perform pg_temp.eq((select withholding from public.bills where id = v_b), 470.00, 'no-ABN withholding on B3');
  insert into bt values ('b3', v_b);
  perform public.supplier_payment_record(pg_temp.p('finance'), v_s, '2027-03-10', pg_temp.acc('1000'), 'BT-1', 'bank_transfer',
    jsonb_build_array(jsonb_build_object('billId', (select v from bt where k = 'b1'), 'amount', 3300)));
  perform public.supplier_payment_record(pg_temp.p('finance'), v_n, '2027-03-12', pg_temp.acc('1000'), 'SL-1', 'bank_transfer',
    jsonb_build_array(jsonb_build_object('billId', (select v from bt where k = 'b3'), 'amount', 265)));

  -- Payroll: the weekly run for 1 to 7 March, paid 10 March. Only Olivia (salaried) has pay.
  v_run := public.pay_run_create(pg_temp.p('payroll'), 'weekly', '2027-03-01', '2027-03-07', '2027-03-10');
  perform public.pay_run_submit(pg_temp.p('payroll'), v_run);
  perform public.pay_run_approve(pg_temp.p('director'), v_run);
  perform pg_temp.eq((select (sum(taxable), sum(payg))::text from public.pay_run_employees where pay_run_id = v_run), '(1400.00,439.00)', 'pay run W1 and W2');

  perform public.ledger_post_entry(pg_temp.p('finance'), '2027-03-20', 'Vehicle costs', 'manual', null, null,
    jsonb_build_array(pg_temp.jl('6300', 200.50, 0, 'GSTE'), pg_temp.jl('1000', 0, 220.55)), 'exclusive', true);
  perform public.ledger_post_entry(pg_temp.p('finance'), '2027-03-25', 'GST correction and repairs', 'manual', null, null,
    jsonb_build_array(pg_temp.jl('2300', 5, 0), pg_temp.jl('6500', 50, 0), pg_temp.jl('1000', 0, 55)), 'exclusive', true);
end $$;

-- Figures, reconciliation, exceptions ----------------------------------------------------------------------------
do $$
declare f jsonb; c jsonb; r jsonb; x jsonb;
begin
  f := public.bas_figures('00000000-0000-4000-8000-000000000001', '2027-01-01', '2027-03-31', 'accrual', 1200, 35);
  perform pg_temp.eq((pg_temp.ex(f, 'G1'), pg_temp.ex(f, 'G3'), pg_temp.ex(f, '1A'))::text, '(11900.00,2000.00,900.00)', 'accrual sales: G1, G3, 1A');
  perform pg_temp.eq((pg_temp.ex(f, 'G10'), pg_temp.ex(f, 'G11'), pg_temp.ex(f, 'G14'), pg_temp.ex(f, '1B'))::text, '(5500.00,4520.55,1000.00,820.05)', 'accrual purchases');
  perform pg_temp.eq((pg_temp.ex(f, 'W1'), pg_temp.ex(f, 'W2'), pg_temp.ex(f, 'W4'), pg_temp.ex(f, 'W5'))::text, '(1400.00,439.00,470.00,909.00)', 'PAYG withholding');
  perform pg_temp.eq((pg_temp.ex(f, 'G9'), pg_temp.ex(f, 'G20'))::text, '(900.00,820.05)', 'worksheet G9 and G20 agree with 1A and 1B');
  perform pg_temp.eq((pg_temp.lab(f, 'G11'), pg_temp.lab(f, '1B'))::text, '(4520,820)', 'labels in whole dollars, cents dropped');
  perform pg_temp.eq((pg_temp.lab(f, '8A'), pg_temp.lab(f, '8B'), pg_temp.lab(f, '9'))::text, '(3009,855,2154)', 'summary 8A, 8B, 9');
  -- By tax code: the credit note nets off the invoice.
  select c2 into c from jsonb_array_elements(f->'codes') c2 where c2->>'code' = 'GST';
  perform pg_temp.eq((c->>'base', c->>'gst', c->>'gross')::text, '(9000.00,900.00,9900.00)', 'GST code after the credit note');

  f := public.bas_figures('00000000-0000-4000-8000-000000000001', '2027-01-01', '2027-03-31', 'cash');
  perform pg_temp.eq((pg_temp.ex(f, 'G1'), pg_temp.ex(f, '1A'), pg_temp.ex(f, 'G10'), pg_temp.ex(f, 'G11'), pg_temp.ex(f, '1B'))::text,
    '(5500.00,500.00,0,4020.55,320.05)', 'cash basis: only what was paid');

  f := public.bas_figures('00000000-0000-4000-8000-000000000001', '2027-01-01', '2027-03-31', 'accrual');
  r := public.bas_reconciliation('00000000-0000-4000-8000-000000000001', '2027-01-01', '2027-03-31', f);
  perform pg_temp.eq((r->'gst'->>'accountMovement', r->'gst'->>'expected', r->'gst'->>'difference', r->'gst'->>'notFromTaxLines')::text,
    '(74.95,79.95,-5.00,-5.00)', 'GST account agrees but for the direct posting');
  perform pg_temp.eq((r->'payg'->>'payRunDifference', r->'payg'->>'bills')::text, '(0.00,470.00)', 'PAYG account agrees with W2 and W4');

  x := public.bas_exceptions('00000000-0000-4000-8000-000000000001', '2027-01-01', '2027-03-31');
  perform pg_temp.eq((select count(*)::int from jsonb_array_elements(x) e where e->>'kind' = 'gst_account'), 1, 'direct GST posting flagged');
  perform pg_temp.eq((select count(*)::int from jsonb_array_elements(x) e where e->>'kind' = 'uncoded' and e->>'message' ~ '6500'), 1, 'uncoded repairs flagged');
  perform pg_temp.eq((select count(*)::int from jsonb_array_elements(x) e where e->>'kind' = 'gst_rate'), 0, 'GST is 10% everywhere');

  perform pg_temp.eq(public.bas_due_date('quarterly', '2027-03-31'), date '2027-04-28', 'Q3 due 28 April');
  perform pg_temp.eq(public.bas_due_date('quarterly', '2026-12-31'), date '2027-02-28', 'Q2 due 28 February');
  perform pg_temp.eq(public.bas_due_date('monthly', '2027-01-31'), date '2027-02-21', 'monthly due the 21st');
end $$;

-- Prepare, review, lodge, pay ------------------------------------------------------------------------------------
do $$
declare v_bas uuid; f jsonb; v_j uuid; v_chg uuid; v_basis text;
begin
  -- The BAS takes the company's GST basis when made: accrual for this one.
  select gst_basis into v_basis from public.company_settings where organization_id = '00000000-0000-4000-8000-000000000001';
  update public.company_settings set gst_basis = 'accrual' where organization_id = '00000000-0000-4000-8000-000000000001';
  perform pg_temp.expect_error(format('select public.bas_create(%L, %L, %L, %L, %L)', pg_temp.p('staff'), '2027-01-01', '2027-03-31', 'quarterly', 'simpler'), 'BAS');
  perform pg_temp.expect_error(format('select public.bas_create(%L, %L, %L, %L, %L)', pg_temp.p('finance'), '2027-02-01', '2027-04-30', 'quarterly', 'simpler'), 'quarter');
  v_bas := public.bas_create(pg_temp.p('finance'), '2027-01-01', '2027-03-31', 'quarterly', 'simpler');
  insert into bt values ('bas', v_bas);
  perform pg_temp.expect_error(format('select public.bas_create(%L, %L, %L, %L, %L)', pg_temp.p('finance'), '2027-03-01', '2027-03-31', 'monthly', 'simpler'), 'already covers');
  perform pg_temp.eq((select due_date from public.bas_returns where id = v_bas), date '2027-04-28', 'due date');
  perform pg_temp.expect_error(format('select public.bas_save(%L, %L, 12.5, 0, null, null)', pg_temp.p('finance'), v_bas), 'whole dollars');
  perform public.bas_save(pg_temp.p('finance'), v_bas, 1200, 35, 'full', 'Instalment from the ATO notice');

  -- A second person reviews it; that fixes the figures.
  perform pg_temp.expect_error(format('select public.bas_review(%L, %L, null)', pg_temp.p('finance'), v_bas), 'Review BAS');
  perform pg_temp.expect_error(format('select public.bas_lodge(%L, %L, %L, null, false)', pg_temp.p('finance'), v_bas, '2027-04-20'), 'must be reviewed');
  f := public.bas_review(pg_temp.p('director'), v_bas, 'Checked against the bank');
  perform pg_temp.eq((select (status, payable)::text from public.bas_returns where id = v_bas), '(reviewed,2154.00)', 'reviewed');
  perform pg_temp.expect_error(format('select public.bas_save(%L, %L, 0, 0, null, null)', pg_temp.p('finance'), v_bas), 'Only a draft');

  -- The books change after the review: it can't be lodged until they agree again.
  v_chg := public.ledger_post_entry(pg_temp.p('finance'), '2027-03-28', 'Late fuel', 'manual', null, null,
    jsonb_build_array(pg_temp.jl('6400', 10, 0, 'GSTE'), pg_temp.jl('1000', 0, 11)), 'exclusive', true);
  perform pg_temp.expect_error(format('select public.bas_lodge(%L, %L, %L, %L, true)', pg_temp.p('finance'), v_bas, '2027-04-20', 'X'), 'changed after the BAS was reviewed');
  perform public.ledger_reverse_entry(pg_temp.p('finance'), v_chg, '2027-03-28', 'Belongs in April');
  perform pg_temp.expect_error(format('select public.bas_lodge(%L, %L, %L, null, false)', pg_temp.p('finance'), v_bas, '2027-03-30'), 'after the period');

  v_j := public.bas_lodge(pg_temp.p('finance'), v_bas, '2027-04-20', '4001234567', true);
  -- Dr GST 79.95, Dr PAYG 909.00, Dr instalments 1,200.00; Cr fuel tax credits 35.00, Cr ATO 2,154.00; rounding Dr 0.05.
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('2300')), 79.95, 'GST cleared by the exact amount');
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('2100')), 909.00, 'PAYG cleared by W5');
  perform pg_temp.eq((select credit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('2350')), 2154.00, 'owed to the ATO');
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('7950')), 0.05, 'cents dropped');
  perform pg_temp.eq((select count(*)::int from public.accounting_periods where start_date between '2027-01-01' and '2027-03-31' and status = 'soft_locked'), 3, 'the quarter is soft-locked');
  perform pg_temp.expect_error(format('select public.ledger_post_entry(%L, %L, %L, %L, null, null, %L, %L, true)', pg_temp.p('finance'), '2027-02-10', 'late', 'manual',
    jsonb_build_array(pg_temp.jl('6400', 10, 0, 'GSTE'), pg_temp.jl('1000', 0, 11)), 'exclusive'), 'is locked');
  perform pg_temp.expect_error(format('select public.ledger_reverse_entry(%L, %L, %L, %L)', pg_temp.p('finance'), v_j, '2027-04-21', 'Wrong amount'), 'BAS journals can''t be reversed');

  -- Paying the ATO.
  perform public.bas_record_payment(pg_temp.p('finance'), v_bas, pg_temp.acc('1000'), '2027-04-25', 2000);
  perform pg_temp.expect_error(format('select public.bas_record_payment(%L, %L, %L, %L, 154.01)', pg_temp.p('finance'), v_bas, pg_temp.acc('1000'), '2027-04-26'), 'up to');
  perform public.bas_record_payment(pg_temp.p('finance'), v_bas, pg_temp.acc('1000'), '2027-04-26', null);
  perform pg_temp.eq((select (status, settled_amount)::text from public.bas_returns where id = v_bas), '(settled,2154.00)', 'settled');
  perform pg_temp.eq((select coalesce(sum(credit - debit), 0) from public.journal_lines where account_id = pg_temp.acc('2350')), 0::numeric, 'ATO account back to nil');
  update public.company_settings set gst_basis = v_basis where organization_id = '00000000-0000-4000-8000-000000000001';
end $$;

-- TPAR -----------------------------------------------------------------------------------------------------------
do $$
declare f jsonb; r jsonb;
begin
  f := public.tpar_figures('00000000-0000-4000-8000-000000000001', '2026-07-01', '2027-06-30');
  select x into r from jsonb_array_elements(f->'rows') x where x->>'name' = 'BAS Test Supplies';
  perform pg_temp.eq((r->>'gross', r->>'gst', r->>'withheld')::text, '(3300.00,300.00,0.00)', 'TPAR: paid in full, GST inclusive');
  -- 265.00 paid of 530.00 payable: half the bill, 500.00 gross including the 235.00 withheld.
  select x into r from jsonb_array_elements(f->'rows') x where x->>'name' = 'Smith Labour';
  perform pg_temp.eq((r->>'gross', r->>'gst', r->>'withheld')::text, '(500.00,0.00,235.00)', 'TPAR: no-ABN payee, withholding grossed up');
  perform pg_temp.eq(r->'problems' ? 'Address incomplete', true, 'TPAR: missing address flagged');
  perform pg_temp.expect_error(format('select public.tpar_lodge(%L, %L, %L, null)', pg_temp.p('staff'), '2026-07-01', '2027-08-20'), 'BAS');
  perform pg_temp.expect_error(format('select public.tpar_lodge(%L, %L, %L, null)', pg_temp.p('finance'), '2026-07-01', '2027-06-30'), 'after the year ended');
end $$;

-- Lock-down ------------------------------------------------------------------------------------------------------
do $$
begin
  perform pg_temp.eq(has_table_privilege('authenticated', 'public.bas_returns', 'select'), false, 'BAS not readable from browsers');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.bas_lodge(uuid, uuid, date, text, boolean)', 'execute'), false, 'lodge not callable from browsers');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type in ('bas_created', 'bas_reviewed', 'bas_lodged', 'bas_payment_recorded')), 5, 'audited');
end $$;

select 'bas tests passed' as result;
rollback;
