-- Behavioural tests for Phase 6: banking. Named zz_ so it runs last: it reuses
-- the people (finance, director, staff) and the "New operating" company bank
-- account from the earlier tests, and works on its own ledger bank account
-- (1010) so their entries on 1000 don't affect the sums.
--
-- The statement for October 2026, opening balance $5,000.00:
--   02 Oct  +1,100.00  Hunter Refinery pays an invoice       -> receipt created from the line
--   03 Oct     -55.00  BP fuel                               -> bank rule: 6400 Fuel, GST 5.00
--   05 Oct     -15.00  Account fee        (twice that day)   -> spend money, 7700, no GST
--   06 Oct  -2,200.00  Supplier batch PB-0001                -> matched to the batch's payment
-- Closing balance 5,000 + 1,100 - 55 - 15 - 15 - 2,200 = $3,815.00.
-- The ledger also has a $300 payment on 8 Oct not yet through the bank.

create or replace function pg_temp.p(p text) returns uuid language sql as $$ select id from public.training_profiles where email = p || '@fin.test' $$;
create or replace function pg_temp.acc(p text) returns uuid language sql as $$
  select id from public.accounts where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.tax(p text) returns uuid language sql as $$
  select id from public.tax_codes where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.ln(p_desc text, p_qty numeric, p_price numeric, p_acc text, p_tax text) returns jsonb language sql as $$
  select jsonb_build_object('description', p_desc, 'quantity', p_qty, 'unitPrice', p_price, 'accountId', pg_temp.acc(p_acc), 'taxCodeId', pg_temp.tax(p_tax)) $$;
create or replace function pg_temp.txn(p_desc text, p_n int default 1) returns uuid language sql as $$
  select id from public.bank_transactions where account_id = pg_temp.acc('1010') and description = p_desc order by created_at, id offset p_n - 1 limit 1 $$;
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
create temporary table bk (k text primary key, v uuid);

-- Setup: a second bank account in the ledger, linked to the company account, with its opening balance.
insert into public.accounts (organization_id, code, name, type, subtype)
values ('00000000-0000-4000-8000-000000000001', '1010', 'Bank - Operating (test)', 'asset', 'bank');

do $$
declare v_cba uuid := (select id from public.company_bank_accounts where account_number = '87654321' and status = 'active');
begin
  perform pg_temp.expect_error(format('select public.company_bank_settings(%L, %L, %L)', pg_temp.p('staff'), v_cba, '{}'), 'Banking');
  perform pg_temp.expect_error(format('select public.company_bank_settings(%L, %L, %L)', pg_temp.p('finance'), v_cba, '{"ledger_account_id":"' || pg_temp.acc('6400') || '"}'), 'chart of accounts');
  perform pg_temp.expect_error(format('select public.company_bank_settings(%L, %L, %L)', pg_temp.p('finance'), v_cba, '{"apca_user_id":"12345"}'), '6 digits');
  perform pg_temp.expect_error(format('select public.company_bank_settings(%L, %L, %L)', pg_temp.p('finance'), v_cba, '{"aba_bank_code":"CB"}'), '3-letter');
  perform public.company_bank_settings(pg_temp.p('finance'), v_cba, jsonb_build_object('ledger_account_id', pg_temp.acc('1010'), 'apca_user_id', '301500',
    'aba_bank_code', 'cba', 'aba_user_name', 'Panalo Pipes', 'aba_balancing_record', true));
  perform pg_temp.eq((select aba_bank_code || '/' || apca_user_id from public.company_bank_accounts where id = v_cba), 'CBA/301500', 'ABA settings saved');
  insert into bk values ('cba', v_cba);

  perform public.ledger_post_entry(pg_temp.p('finance'), '2026-09-30', 'Opening balance, operating account', 'manual', null, null,
    jsonb_build_array(jsonb_build_object('accountId', pg_temp.acc('1010'), 'debit', 5000, 'credit', 0),
                      jsonb_build_object('accountId', pg_temp.acc('3000'), 'debit', 0, 'credit', 5000)), 'no_tax', true);
end $$;

-- A customer with an invoice, a supplier with approved bank details and two bills ------------------------------
do $$
declare v_c uuid; v_s uuid; v_i uuid; v_b uuid; v_b2 uuid; v_b3 uuid;
begin
  v_c := public.customer_save(pg_temp.p('finance'), null, '{"name":"Bank Test Customer Pty Ltd"}');
  v_i := public.invoice_save(pg_temp.p('finance'), null, jsonb_build_object('customer_id', v_c, 'invoice_date', '2026-09-20'),
    jsonb_build_array(pg_temp.ln('Welding, site', 1, 1000, '4100', 'GST')));
  perform public.invoice_approve(pg_temp.p('finance'), v_i);
  perform pg_temp.eq((select total from public.invoices where id = v_i), 1100.00, 'invoice total');

  v_s := public.supplier_save(pg_temp.p('finance'), null, '{"name":"Steel Supplies Co","abn":"51 824 753 556"}');
  perform public.approval_decide(pg_temp.p('director'), public.supplier_bank_request(pg_temp.p('finance'), v_s, 'Steel Supplies Co', '062-111', '2233 4455'), true, 'Called them');
  v_b := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', v_s, 'bill_date', '2026-09-25', 'supplier_reference', 'SS-9001'),
    jsonb_build_array(pg_temp.ln('Plate steel', 1, 2000, '5100', 'GSTE')));
  perform public.bill_approve(pg_temp.p('finance'), v_b);
  v_b2 := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', v_s, 'bill_date', '2026-09-26', 'supplier_reference', 'SS-9002'),
    jsonb_build_array(pg_temp.ln('Offcuts', 1, 300, '5100', 'FREE')));
  perform public.bill_approve(pg_temp.p('finance'), v_b2);
  v_b3 := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', v_s, 'bill_date', '2026-09-27', 'supplier_reference', 'SS-9003'),
    jsonb_build_array(pg_temp.ln('Bolts', 1, 100, '5100', 'FREE')));
  perform public.bill_approve(pg_temp.p('finance'), v_b3);
  insert into bk values ('cust', v_c), ('inv', v_i), ('sup', v_s), ('bill', v_b), ('bill2', v_b2), ('bill3', v_b3);

  -- The $300 bill is paid by cheque on 8 Oct: in the ledger, not yet through the bank.
  insert into bk values ('cheque', public.supplier_payment_record(pg_temp.p('finance'), v_s, '2026-10-08', pg_temp.acc('1010'), 'Chq 501', 'cheque',
    jsonb_build_array(jsonb_build_object('billId', v_b2, 'amount', 300))));
end $$;

-- Payment batch: made by finance, approved by the director, file, then paid ---------------------------------
do $$
declare v_pb uuid; v_pb2 uuid;
begin
  perform pg_temp.expect_error(format('select public.payment_batch_create(%L, %L, %L, %L, %L)', pg_temp.p('staff'), (select v from bk where k = 'cba'), '2026-10-06', 'x',
    jsonb_build_array(jsonb_build_object('billId', (select v from bk where k = 'bill')))), 'Banking');
  perform pg_temp.expect_error(format('select public.payment_batch_create(%L, %L, %L, %L, %L)', pg_temp.p('finance'), (select v from bk where k = 'cba'), '2026-10-06', 'x',
    jsonb_build_array(jsonb_build_object('billId', (select v from bk where k = 'bill'), 'amount', 2500))), 'more than what is owing');
  v_pb := public.payment_batch_create(pg_temp.p('finance'), (select v from bk where k = 'cba'), '2026-10-06', 'Suppliers Oct!',
    jsonb_build_array(jsonb_build_object('billId', (select v from bk where k = 'bill'))));
  perform pg_temp.eq((select (number, total, item_count, description)::text from public.payment_batches where id = v_pb), '(PB-0001,2200.00,1,"SUPPLIERS OC")', 'batch made');
  perform pg_temp.eq((select (bsb, account_number, lodgement_ref)::text from public.payment_batch_items where batch_id = v_pb), '(062111,22334455,SS-9001)', 'bank details copied');
  perform pg_temp.expect_error(format('select public.payment_batch_create(%L, %L, %L, %L, %L)', pg_temp.p('finance'), (select v from bk where k = 'cba'), '2026-10-06', '',
    jsonb_build_array(jsonb_build_object('billId', (select v from bk where k = 'bill')))), 'already in another batch');

  perform pg_temp.expect_error(format('select public.payment_batch_file_downloaded(%L, %L)', pg_temp.p('finance'), v_pb), 'once the batch is approved');
  perform pg_temp.expect_error(format('select public.payment_batch_approve(%L, %L)', pg_temp.p('finance'), v_pb), 'Someone other');
  perform public.payment_batch_approve(pg_temp.p('director'), v_pb);
  perform pg_temp.expect_error(format('select public.payment_batch_mark_paid(%L, %L)', pg_temp.p('finance'), v_pb), 'Download the bank file');
  perform public.payment_batch_file_downloaded(pg_temp.p('finance'), v_pb);
  perform public.payment_batch_mark_paid(pg_temp.p('finance'), v_pb);
  perform pg_temp.eq((select status from public.payment_batches where id = v_pb), 'paid', 'batch paid');
  perform pg_temp.eq(public.bill_outstanding((select v from bk where k = 'bill')), 0::numeric, 'bill paid by the batch');
  perform pg_temp.eq((select bank_account_id from public.supplier_payments where id = (select supplier_payment_id from public.payment_batch_items where batch_id = v_pb)),
    pg_temp.acc('1010'), 'paid from the linked ledger account');
  insert into bk values ('pb', v_pb);

  -- Bank details that change after a batch is made stop its approval.
  v_pb2 := public.payment_batch_create(pg_temp.p('finance'), (select v from bk where k = 'cba'), '2026-10-09', null,
    jsonb_build_array(jsonb_build_object('billId', (select v from bk where k = 'bill3'))));
  update public.suppliers set bank_account_number = '99990000' where id = (select v from bk where k = 'sup');
  perform pg_temp.expect_error(format('select public.payment_batch_approve(%L, %L)', pg_temp.p('director'), v_pb2), 'bank details changed');
  perform pg_temp.expect_error(format('select public.payment_batch_cancel(%L, %L, %L)', pg_temp.p('finance'), v_pb2, ''), 'Say why');
  perform public.payment_batch_cancel(pg_temp.p('finance'), v_pb2, 'Supplier changed banks');
  update public.suppliers set bank_account_number = '22334455' where id = (select v from bk where k = 'sup');
end $$;

-- Import: validation, duplicates within and across files, undo ----------------------------------------------
do $$
declare r jsonb;
begin
  perform pg_temp.expect_error(format('select public.bank_import(%L, %L, %L, %L, %L, null, null)', pg_temp.p('staff'), pg_temp.acc('1010'), 'oct.csv', 'csv', '[]'), 'Banking');
  perform pg_temp.expect_error(format('select public.bank_import(%L, %L, %L, %L, %L, null, null)', pg_temp.p('finance'), pg_temp.acc('6400'), 'oct.csv', 'csv',
    '[{"date":"2026-10-02","amount":"1","description":"x"}]'), 'Choose the bank account');
  perform pg_temp.expect_error(format('select public.bank_import(%L, %L, %L, %L, %L, null, null)', pg_temp.p('finance'), pg_temp.acc('1010'), 'oct.csv', 'csv',
    '[{"date":"2026-10-02","amount":"1.005","description":"x"}]'), 'dollars and cents');
  perform pg_temp.expect_error(format('select public.bank_import(%L, %L, %L, %L, %L, null, null)', pg_temp.p('finance'), pg_temp.acc('1010'), 'oct.csv', 'csv',
    '[{"date":"2026-10-02","amount":"5","description":"  "}]'), 'no description');

  r := public.bank_import(pg_temp.p('finance'), pg_temp.acc('1010'), 'oct-1.csv', 'csv', '[
    {"date":"2026-10-02","amount":"1100.00","description":"DIRECT CREDIT BANK TEST CUSTOMER","reference":"INV","balance":"6100.00"},
    {"date":"2026-10-03","amount":"-55.00","description":"BP EXPRESS 1234 FUEL","balance":"6045.00"},
    {"date":"2026-10-05","amount":"-15.00","description":"ACCOUNT FEE","balance":"6030.00"},
    {"date":"2026-10-05","amount":"-15.00","description":"ACCOUNT FEE","balance":"6015.00"}]', 6015.00, '2026-10-05');
  perform pg_temp.eq(r->>'added', '4', 'four lines added, including two identical fees');

  -- The next file overlaps: the same four lines are skipped, one is new, one is a near-duplicate.
  r := public.bank_import(pg_temp.p('finance'), pg_temp.acc('1010'), 'oct-2.ofx', 'ofx', '[
    {"date":"2026-10-03","amount":"-55.00","description":"BP EXPRESS 1234 FUEL"},
    {"date":"2026-10-05","amount":"-15.00","description":"account  fee"},
    {"date":"2026-10-05","amount":"-15.00","description":"ACCOUNT FEE"},
    {"date":"2026-10-06","amount":"-2200.00","description":"BATCH PB-0001 SUPPLIERS"},
    {"date":"2026-10-06","amount":"-2200.00","description":"BATCH PB-0001 SUPPLIERS PAYMENT"}]', 3815.00, '2026-10-08');
  perform pg_temp.eq((r->>'added', r->>'skipped')::text, '(2,3)', 'overlap skipped');

  -- A file can be undone while none of its lines is used.
  r := public.bank_import(pg_temp.p('finance'), pg_temp.acc('1010'), 'wrong-account.qif', 'qif', '[{"date":"2026-10-07","amount":"-9.99","description":"NOT OURS"}]', null, null);
  perform public.bank_import_undo(pg_temp.p('finance'), (r->>'id')::uuid);
  perform pg_temp.eq((select count(*)::int from public.bank_transactions where description = 'NOT OURS'), 0, 'undone import removed');
end $$;

-- Matching, creating, rules, excluding -----------------------------------------------------------------------
do $$
declare v_rule uuid; v_j uuid; v_line uuid;
begin
  -- Receipt from the statement line, applied to the invoice.
  perform public.bank_receive_payment(pg_temp.p('finance'), pg_temp.txn('DIRECT CREDIT BANK TEST CUSTOMER'), (select v from bk where k = 'cust'),
    jsonb_build_array(jsonb_build_object('invoiceId', (select v from bk where k = 'inv'), 'amount', 1100)));
  perform pg_temp.eq(public.invoice_outstanding((select v from bk where k = 'inv')), 0::numeric, 'invoice paid from the bank line');
  perform pg_temp.eq((select status || '/' || match_kind from public.bank_transactions where id = pg_temp.txn('DIRECT CREDIT BANK TEST CUSTOMER')), 'matched/created', 'line matched');

  -- A rule for fuel; rules can't code to control or bank accounts.
  perform pg_temp.expect_error(format('select public.bank_rule_save(%L, null, %L)', pg_temp.p('finance'),
    jsonb_build_object('name', 'Bad', 'match_text', 'BP', 'target_account_id', pg_temp.acc('1100'))), 'not a bank or control account');
  v_rule := public.bank_rule_save(pg_temp.p('finance'), null, jsonb_build_object('name', 'Fuel - BP', 'match_text', 'BP EXPRESS', 'direction', 'out',
    'target_account_id', pg_temp.acc('6400'), 'tax_code_id', pg_temp.tax('GSTE'), 'payee', 'BP'));
  v_j := public.bank_create_entry(pg_temp.p('finance'), pg_temp.txn('BP EXPRESS 1234 FUEL'), 'BP',
    jsonb_build_array(jsonb_build_object('accountId', pg_temp.acc('6400'), 'taxCodeId', pg_temp.tax('GSTE'), 'amount', 55)));
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('6400')), 50.00, 'fuel net of GST');
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('2300')), 5.00, 'GST claimed');

  -- Spend money checks.
  perform pg_temp.expect_error(format('select public.bank_create_entry(%L, %L, null, %L)', pg_temp.p('finance'), pg_temp.txn('ACCOUNT FEE'),
    jsonb_build_array(jsonb_build_object('accountId', pg_temp.acc('7700'), 'amount', 10))), 'add up to');
  perform pg_temp.expect_error(format('select public.bank_create_entry(%L, %L, null, %L)', pg_temp.p('finance'), pg_temp.txn('ACCOUNT FEE'),
    jsonb_build_array(jsonb_build_object('accountId', pg_temp.acc('2000'), 'amount', 15))), 'control account');
  perform pg_temp.expect_error(format('select public.bank_create_entry(%L, %L, null, %L)', pg_temp.p('finance'), pg_temp.txn('BP EXPRESS 1234 FUEL'),
    jsonb_build_array(jsonb_build_object('accountId', pg_temp.acc('7700'), 'amount', 55))), 'already matched');
  perform public.bank_create_entry(pg_temp.p('finance'), pg_temp.txn('ACCOUNT FEE', 1), 'Bank', jsonb_build_array(jsonb_build_object('accountId', pg_temp.acc('7700'), 'amount', 15)));
  perform public.bank_create_entry(pg_temp.p('finance'), pg_temp.txn('ACCOUNT FEE', 2), 'Bank', jsonb_build_array(jsonb_build_object('accountId', pg_temp.acc('7700'), 'amount', 15)));

  -- Unmatching an entry made from the line reverses it; then make it again.
  v_j := (select jl.journal_id from public.bank_matches m join public.journal_lines jl on jl.id = m.journal_line_id where m.bank_transaction_id = pg_temp.txn('ACCOUNT FEE', 2));
  perform public.bank_unmatch(pg_temp.p('finance'), pg_temp.txn('ACCOUNT FEE', 2));
  perform pg_temp.eq((select status from public.journal_entries where id = v_j), 'reversed', 'entry from the line reversed when unmatched');
  perform public.bank_create_entry(pg_temp.p('finance'), pg_temp.txn('ACCOUNT FEE', 2), 'Bank', jsonb_build_array(jsonb_build_object('accountId', pg_temp.acc('7700'), 'amount', 15)));

  -- The batch payment: match to the existing ledger line; the wrong amount or account is refused.
  v_line := (select jl.id from public.supplier_payments sp join public.journal_lines jl on jl.journal_id = sp.journal_id
             where sp.id = (select supplier_payment_id from public.payment_batch_items where batch_id = (select v from bk where k = 'pb')) and jl.account_id = pg_temp.acc('1010'));
  perform pg_temp.expect_error(format('select public.bank_match(%L, %L, %L)', pg_temp.p('finance'), pg_temp.txn('ACCOUNT FEE'), array[v_line]), 'already matched');
  perform pg_temp.expect_error(format('select public.bank_match(%L, %L, %L)', pg_temp.p('finance'), pg_temp.txn('BATCH PB-0001 SUPPLIERS'),
    array[(select jl.id from public.journal_lines jl join public.supplier_payments sp on sp.journal_id = jl.journal_id where sp.id = (select v from bk where k = 'cheque') and jl.account_id = pg_temp.acc('1010'))]), 'total');
  perform public.bank_match(pg_temp.p('finance'), pg_temp.txn('BATCH PB-0001 SUPPLIERS'), array[v_line]);
  perform pg_temp.expect_error(format('select public.bank_match(%L, %L, %L)', pg_temp.p('finance'), pg_temp.txn('BATCH PB-0001 SUPPLIERS PAYMENT'), array[v_line]), 'already matched');

  -- The near-duplicate is excluded with a reason.
  perform pg_temp.expect_error(format('select public.bank_exclude(%L, %L, %L)', pg_temp.p('finance'), pg_temp.txn('BATCH PB-0001 SUPPLIERS PAYMENT'), ''), 'Say why');
  perform public.bank_exclude(pg_temp.p('finance'), pg_temp.txn('BATCH PB-0001 SUPPLIERS PAYMENT'), 'Duplicate of the batch line from the CSV');

  -- A matched payment can't be voided.
  perform pg_temp.expect_error(format('select public.supplier_payment_void(%L, %L, %L)', pg_temp.p('finance'),
    (select supplier_payment_id from public.payment_batch_items where batch_id = (select v from bk where k = 'pb')), 'Wrong'), 'matched to a bank statement line');
end $$;

-- Reconciliation ---------------------------------------------------------------------------------------------
do $$
declare v_rec uuid; s jsonb;
begin
  -- Ledger 5,000 + 1,100 - 55 - 15 - 15 - 2,200 - 300 = 3,515; the $300 cheque is unpresented: 3,515 + 300 = 3,815.
  s := public.bank_reconcile_summary(pg_temp.acc('1010'), '2026-10-08');
  perform pg_temp.eq(((s->>'ledgerBalance')::numeric, (s->>'unpresented')::numeric)::text, '(3515.00,4700.00)', 'before the opening is cleared');
  perform pg_temp.expect_error(format('select public.bank_reconcile(%L, %L, %L, 3815, null, null)', pg_temp.p('finance'), pg_temp.acc('1010'), '2026-10-08'), 'Out of balance');
  perform pg_temp.expect_error(format('select public.bank_reconcile(%L, %L, %L, 3800, %L, null)', pg_temp.p('finance'), pg_temp.acc('1010'), '2026-10-08', '2026-10-01'),
    'Out of balance by .*15\.00');
  v_rec := public.bank_reconcile(pg_temp.p('finance'), pg_temp.acc('1010'), '2026-10-08', 3815, '2026-10-01', 'October statement 1');
  perform pg_temp.eq((select (ledger_balance, unpresented)::text from public.bank_reconciliations where id = v_rec), '(3515.00,-300.00)', 'reconciled with the cheque unpresented');
  perform pg_temp.eq((select count(*)::int from public.bank_transactions where reconciliation_id = v_rec), 6, 'statement lines locked in');

  -- Reconciled lines are locked; dates must move forward; only the first can clear earlier entries.
  perform pg_temp.expect_error(format('select public.bank_unmatch(%L, %L)', pg_temp.p('finance'), pg_temp.txn('ACCOUNT FEE')), 'completed reconciliation');
  perform pg_temp.expect_error(format('select public.bank_reconcile(%L, %L, %L, 3815, null, null)', pg_temp.p('finance'), pg_temp.acc('1010'), '2026-10-08'), 'later statement date');
  perform pg_temp.expect_error(format('select public.bank_reconcile(%L, %L, %L, 3815, %L, null)', pg_temp.p('finance'), pg_temp.acc('1010'), '2026-10-09', '2026-10-01'), 'first reconciliation');

  -- The cheque clears on 12 Oct: import, match, reconcile again.
  perform public.bank_import(pg_temp.p('finance'), pg_temp.acc('1010'), 'oct-3.csv', 'csv', '[{"date":"2026-10-12","amount":"-300","description":"CHEQUE 501"}]', null, null);
  perform pg_temp.expect_error(format('select public.bank_reconcile(%L, %L, %L, 3515, null, null)', pg_temp.p('finance'), pg_temp.acc('1010'), '2026-10-12'), 'aren''t matched');
  perform public.bank_match(pg_temp.p('finance'), pg_temp.txn('CHEQUE 501'),
    array[(select jl.id from public.journal_lines jl join public.supplier_payments sp on sp.journal_id = jl.journal_id where sp.id = (select v from bk where k = 'cheque') and jl.account_id = pg_temp.acc('1010'))]);
  insert into bk values ('rec2', public.bank_reconcile(pg_temp.p('finance'), pg_temp.acc('1010'), '2026-10-12', 3515, null, null));
  perform pg_temp.eq((select unpresented from public.bank_reconciliations where id = (select v from bk where k = 'rec2')), 0.00, 'nothing unpresented');

  -- Undo: latest first, with a reason.
  perform pg_temp.expect_error(format('select public.bank_reconcile_undo(%L, %L, %L)', pg_temp.p('finance'), v_rec, 'x y z'), 'later reconciliations');
  perform pg_temp.expect_error(format('select public.bank_reconcile_undo(%L, %L, %L)', pg_temp.p('finance'), (select v from bk where k = 'rec2'), ''), 'Say why');
  perform public.bank_reconcile_undo(pg_temp.p('finance'), (select v from bk where k = 'rec2'), 'Wrong statement balance keyed');
  perform pg_temp.eq((select reconciliation_id from public.bank_transactions where id = pg_temp.txn('CHEQUE 501')), null::uuid, 'line unlocked');
  perform public.bank_reconcile(pg_temp.p('finance'), pg_temp.acc('1010'), '2026-10-12', 3515, null, 'Redone');

  -- The used import can't be undone.
  perform pg_temp.expect_error(format('select public.bank_import_undo(%L, %L)', pg_temp.p('finance'), (select import_id from public.bank_transactions where id = pg_temp.txn('ACCOUNT FEE'))), 'already matched');
end $$;

-- Lock-down -------------------------------------------------------------------------------------------------
do $$
begin
  perform pg_temp.eq(has_table_privilege('authenticated', 'public.bank_transactions', 'select'), false, 'statement lines not readable from browsers');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.bank_reconcile(uuid, uuid, date, numeric, date, text)', 'execute'), false, 'reconcile not callable from browsers');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type in ('bank_reconciled', 'payment_batch_approved', 'bank_line_excluded')), 5, 'audited');
end $$;

select 'banking tests passed' as result;
