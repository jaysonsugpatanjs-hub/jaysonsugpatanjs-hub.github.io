-- Behavioural tests for sales and purchasing (Phase 3). Runs after the
-- ledger tests and uses the @fin.test people (finance admin, director,
-- system admin, staff). Figures are worked by hand in the comments.

create or replace function pg_temp.p(p text) returns uuid language sql as $$ select id from public.training_profiles where email = p || '@fin.test' $$;
create or replace function pg_temp.acc(p text) returns uuid language sql as $$
  select id from public.accounts where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.tax(p text) returns uuid language sql as $$
  select id from public.tax_codes where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.bal(p_code text) returns numeric language sql as $$
  select coalesce(sum(jl.debit - jl.credit), 0) from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id
  where jl.account_id = pg_temp.acc(p_code) and je.status in ('posted', 'reversed') $$;
create or replace function pg_temp.ln(p_desc text, p_qty numeric, p_price numeric, p_acc text, p_tax text default 'GST', p_disc numeric default 0) returns jsonb language sql as $$
  select jsonb_build_object('description', p_desc, 'quantity', p_qty, 'unitPrice', p_price, 'discountPercent', p_disc,
    'accountId', pg_temp.acc(p_acc), 'taxCodeId', pg_temp.tax(p_tax), 'kind', 'labour') $$;
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
create temporary table sp (k text primary key, v uuid);
create temporary table sn (k text primary key, v numeric);
insert into sn values ('ar0', pg_temp.bal('1100')), ('ap0', pg_temp.bal('2000')), ('payg0', pg_temp.bal('2100')), ('bank0', pg_temp.bal('1000'));

-- Compliance rules -------------------------------------------------------------------------
do $$
begin
  perform pg_temp.eq(public.compliance_value('no_abn_withholding_rate', '2026-09-01')::text::numeric, 0.47, 'no-ABN rate 47%');
  perform pg_temp.eq(public.compliance_value('no_abn_withholding_rate', '2020-01-01'), null::jsonb, 'no rule before it took effect');
end $$;

-- Customers -------------------------------------------------------------------------------
do $$
declare v uuid;
begin
  perform pg_temp.expect_error(format('select public.customer_save(%L, null, %L)', pg_temp.p('staff'), '{"name":"Acme"}'), 'Sales');
  perform pg_temp.expect_error(format('select public.customer_save(%L, null, %L)', pg_temp.p('finance'), '{"name":"Acme","abn":"51 824 753 557"}'), 'ABN isn''t valid');
  v := public.customer_save(pg_temp.p('finance'), null, '{"name":"Hunter Refinery Pty Ltd","abn":"51 824 753 556","email":"AP@Hunter.test","payment_terms_days":"14"}');
  insert into sp values ('cust', v);
  perform pg_temp.eq((select abn from public.customers where id = v), '51824753556', 'ABN stored without spaces');
  perform pg_temp.eq((select email from public.customers where id = v), 'ap@hunter.test', 'email lower-cased');
  v := public.customer_save(pg_temp.p('finance'), null, '{"name":"Port Kembla Works","po_required":true}');
  insert into sp values ('cust2', v);
end $$;

-- Quote -> invoice ------------------------------------------------------------------------
do $$
declare v_q uuid; v_i uuid; v_num text; v_j uuid;
begin
  -- 3 x 333.33 = 999.99 (GST 100.00) and 200 less 10% = 180.00 (GST 18.00):
  -- subtotal 1,179.99, GST 118.00, total 1,297.99.
  v_q := public.quote_save(pg_temp.p('finance'), null,
    jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'quote_date', '2026-08-03', 'expiry_date', '2026-09-03', 'title', 'Spool repairs'),
    jsonb_build_array(pg_temp.ln('Welder days', 3, 333.33, '4100'), pg_temp.ln('Flanges', 2, 100, '4700', 'GST', 10)));
  perform pg_temp.eq((select number from public.quotes where id = v_q), 'QU-1001', 'quote number');
  perform pg_temp.eq((select (subtotal, gst, total)::text from public.quotes where id = v_q), '(1179.99,118.00,1297.99)', 'quote totals');
  perform pg_temp.expect_error(format('select public.quote_set_status(%L, %L, %L)', pg_temp.p('finance'), v_q, 'accepted'), 'draft quote can''t become accepted');
  perform public.quote_set_status(pg_temp.p('finance'), v_q, 'approved');
  perform public.quote_set_status(pg_temp.p('finance'), v_q, 'sent');
  perform public.quote_set_status(pg_temp.p('finance'), v_q, 'accepted');
  perform pg_temp.expect_error(format('select public.quote_save(%L, %L, %L, %L)', pg_temp.p('finance'), v_q,
    jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'quote_date', '2026-08-03'), jsonb_build_array(pg_temp.ln('x', 1, 1, '4100'))), 'Only a draft quote');

  -- Lines can't hit control accounts or expense accounts on a sale.
  perform pg_temp.expect_error(format('select public.invoice_save(%L, null, %L, %L)', pg_temp.p('finance'),
    jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-08-10'), jsonb_build_array(pg_temp.ln('x', 1, 1, '1100'))), 'can''t be used here');
  perform pg_temp.expect_error(format('select public.invoice_save(%L, null, %L, %L)', pg_temp.p('finance'),
    jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-08-10'), jsonb_build_array(pg_temp.ln('x', 1, 1, '6300'))), 'income account');
  perform pg_temp.expect_error(format('select public.invoice_save(%L, null, %L, %L)', pg_temp.p('finance'),
    jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-08-10'), jsonb_build_array(pg_temp.ln('x', 0, 1, '4100'))), 'quantity must be more than 0');

  v_i := public.invoice_save(pg_temp.p('finance'), null,
    jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-08-10', 'quote_id', v_q, 'reference', 'PO 7781'),
    (select jsonb_agg(jsonb_build_object('description', description, 'quantity', quantity, 'unitPrice', unit_price, 'discountPercent', discount_percent,
       'accountId', account_id, 'taxCodeId', tax_code_id) order by line_no) from public.quote_lines where document_id = v_q));
  perform pg_temp.eq((select due_date from public.invoices where id = v_i), date '2026-08-24', 'due date from customer terms (14 days)');
  perform pg_temp.eq((select number from public.invoices where id = v_i), null::text, 'drafts have no number yet');
  perform pg_temp.expect_error(format('select public.invoice_approve(%L, %L)', pg_temp.p('staff'), v_i), 'Sales');
  v_num := public.invoice_approve(pg_temp.p('finance'), v_i);
  perform pg_temp.eq(v_num, 'INV-02003', 'next invoice number (sequence set to INV-, 5 digits, by the foundation tests)');
  perform pg_temp.eq((select status from public.quotes where id = v_q), 'converted', 'quote converted');
  v_j := (select journal_id from public.invoices where id = v_i);
  perform pg_temp.eq((select debit from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('1100')), 1297.99, 'Dr AR total');
  perform pg_temp.eq((select sum(credit) from public.journal_lines where journal_id = v_j and is_tax_line), 118.00, 'Cr GST 118.00');
  perform pg_temp.eq((select source_type || ':' || source_ref from public.journal_entries where id = v_j), 'invoice:INV-02003', 'journal linked to invoice');
  perform pg_temp.expect_error(format('select public.invoice_save(%L, %L, %L, %L)', pg_temp.p('finance'), v_i,
    jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-08-10'), jsonb_build_array(pg_temp.ln('x', 1, 1, '4100'))), 'Only a draft');
  perform pg_temp.expect_error(format('select public.journal_reverse(%L, %L, null, %L)', pg_temp.p('finance'), v_j, 'oops'), 'Void the invoice');
  insert into sp values ('inv1', v_i);

  -- PO number required for this customer.
  v_i := public.invoice_save(pg_temp.p('finance'), null, jsonb_build_object('customer_id', (select v from sp where k = 'cust2'), 'invoice_date', '2026-06-01'),
    jsonb_build_array(pg_temp.ln('Call-out', 1, 500, '4400')));
  perform pg_temp.expect_error(format('select public.invoice_approve(%L, %L)', pg_temp.p('finance'), v_i), 'purchase order number');

  -- Invoice 2: 550 inclusive = 500 + 50 GST. Dated June, due 30 days later (company default) = 1 July.
  v_i := public.invoice_save(pg_temp.p('finance'), null,
    jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-06-01', 'due_date', '2026-07-01', 'amounts_are', 'inclusive', 'invoice_type', 'progress'),
    jsonb_build_array(pg_temp.ln('Progress claim 1', 1, 550, '4300')));
  perform pg_temp.eq((select (subtotal, gst, total)::text from public.invoices where id = v_i), '(500.00,50.00,550.00)', 'inclusive totals');
  perform pg_temp.eq(public.invoice_approve(pg_temp.p('finance'), v_i), 'INV-02004', 'second invoice');
  insert into sp values ('inv2', v_i);
end $$;

-- Receipts, part payments, overpayments, credit notes -----------------------------------------
do $$
declare v_p uuid; v_cn uuid;
begin
  perform pg_temp.expect_error(format('select public.customer_payment_record(%L, %L, %L, 100, %L, %L, null, %L)', pg_temp.p('staff'),
    (select v from sp where k = 'cust'), '2026-08-20', pg_temp.acc('1000'), 'x', '[]'), 'Bank');
  perform pg_temp.expect_error(format('select public.customer_payment_record(%L, %L, %L, 100, %L, %L, null, %L)', pg_temp.p('finance'),
    (select v from sp where k = 'cust'), '2026-08-20', pg_temp.acc('4100'), 'x', '[]'), 'bank account');
  -- Part payment of 500 against INV-1001 -> 797.99 owing.
  v_p := public.customer_payment_record(pg_temp.p('finance'), (select v from sp where k = 'cust'), '2026-08-20', 500, pg_temp.acc('1000'), 'EFT 1', 'bank_transfer',
    jsonb_build_array(jsonb_build_object('invoiceId', (select v from sp where k = 'inv1'), 'amount', 500)));
  perform pg_temp.eq(public.invoice_outstanding((select v from sp where k = 'inv1')), 797.99, 'part payment');
  -- Can't apply more than owing.
  perform pg_temp.expect_error(format('select public.customer_payment_record(%L, %L, %L, 900, %L, %L, null, %L)', pg_temp.p('finance'),
    (select v from sp where k = 'cust'), '2026-08-21', pg_temp.acc('1000'), 'x', jsonb_build_array(jsonb_build_object('invoiceId', (select v from sp where k = 'inv1'), 'amount', 800))), 'more than what is owing');
  -- Overpayment: 1,000 received, 797.99 applied -> 202.01 unallocated credit.
  v_p := public.customer_payment_record(pg_temp.p('finance'), (select v from sp where k = 'cust'), '2026-08-25', 1000, pg_temp.acc('1000'), 'EFT 2', 'bank_transfer',
    jsonb_build_array(jsonb_build_object('invoiceId', (select v from sp where k = 'inv1'), 'amount', 797.99)));
  perform pg_temp.eq(public.invoice_outstanding((select v from sp where k = 'inv1')), 0.00, 'paid in full');
  perform pg_temp.eq(public.customer_payment_unallocated(v_p), 202.01, 'overpayment held as credit');
  insert into sp values ('pay2', v_p);

  -- Credit note 110 incl (100 + 10 GST) against INV-1002 -> 440 owing.
  v_cn := public.invoice_save(pg_temp.p('finance'), null,
    jsonb_build_object('kind', 'credit_note', 'customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-08-26', 'amounts_are', 'inclusive',
      'original_invoice_id', (select v from sp where k = 'inv2')),
    jsonb_build_array(pg_temp.ln('Rework allowance', 1, 110, '4300')));
  perform pg_temp.eq(public.invoice_approve(pg_temp.p('finance'), v_cn), 'CN-1001', 'credit note numbered separately');
  perform pg_temp.eq((select credit from public.journal_lines jl join public.invoices i on i.journal_id = jl.journal_id where i.id = v_cn and jl.account_id = pg_temp.acc('1100')), 110.00, 'credit note Cr AR');
  perform pg_temp.eq((select sum(debit) from public.journal_lines jl join public.invoices i on i.journal_id = jl.journal_id where i.id = v_cn and jl.is_tax_line), 10.00, 'credit note reduces GST');
  perform pg_temp.expect_error(format('select public.credit_note_apply(%L, %L, %L, 200, null)', pg_temp.p('finance'), v_cn, (select v from sp where k = 'inv2')), 'can''t exceed');
  perform public.credit_note_apply(pg_temp.p('finance'), v_cn, (select v from sp where k = 'inv2'), 110, null);
  perform pg_temp.eq(public.invoice_outstanding((select v from sp where k = 'inv2')), 440.00, 'credit applied');
  -- Apply 200 of the overpayment to INV-1002 -> 240 owing; 2.01 credit left.
  perform public.customer_payment_allocate(pg_temp.p('finance'), v_p, (select v from sp where k = 'inv2'), 200);
  perform pg_temp.eq(public.invoice_outstanding((select v from sp where k = 'inv2')), 240.00, 'overpayment applied');
  perform pg_temp.eq(public.customer_payment_unallocated(v_p), 2.01, 'credit left');
  insert into sp values ('cn1', v_cn);
end $$;

-- Ledger agrees with the sub-ledger; ageing and statements -------------------------------------
do $$
declare v_aged jsonb; v_row jsonb; v_st jsonb; v_i uuid;
begin
  -- AR moved by: 1,297.99 + 550 - 110 - 500 - 1,000 = 237.99 = 240 owing - 2.01 credit.
  perform pg_temp.eq(pg_temp.bal('1100') - (select v from sn where k = 'ar0'), 237.99, 'AR control account movement');
  v_aged := public.report_aged_receivables(pg_temp.p('finance'), '2026-09-15');
  perform pg_temp.eq((v_aged->'totals'->>'total')::numeric, 237.99, 'aged receivables total = AR ledger');
  v_row := (select r from jsonb_array_elements(v_aged->'rows') r where r->>'name' = 'Hunter Refinery Pty Ltd');
  -- INV-1002 due 1 July; 15 Sept is 76 days overdue -> 61-90.
  perform pg_temp.eq((v_row->>'days90')::numeric, 240.00, '61-90 bucket');
  perform pg_temp.eq((v_row->>'credits')::numeric, -2.01, 'unapplied receipt shown as credit');
  -- As at 10 Aug, only INV-1001 (current, due 24 Aug) and INV-1002 (40 days overdue) existed, nothing paid.
  v_aged := public.report_aged_receivables(pg_temp.p('finance'), '2026-08-10');
  v_row := (select r from jsonb_array_elements(v_aged->'rows') r where r->>'name' = 'Hunter Refinery Pty Ltd');
  perform pg_temp.eq((v_row->>'current')::numeric, 1297.99, 'current bucket as at 10 Aug');
  perform pg_temp.eq((v_row->>'days60')::numeric, 550.00, '31-60 bucket as at 10 Aug');

  v_st := public.report_customer_statement(pg_temp.p('finance'), (select v from sp where k = 'cust'), '2026-08-01', '2026-08-31');
  perform pg_temp.eq((v_st->>'openingBalance')::numeric, 550.00, 'statement opening balance');
  perform pg_temp.eq((v_st->>'closingBalance')::numeric, 237.99, 'statement closing balance');
  perform pg_temp.eq(jsonb_array_length(v_st->'rows'), 4, 'statement lines: invoice, 2 receipts, credit note');

  -- Voiding: blocked while money is applied; a clean invoice reverses fully.
  perform pg_temp.expect_error(format('select public.invoice_void(%L, %L, %L)', pg_temp.p('finance'), (select v from sp where k = 'inv1'), 'mistake'), 'Remove those first');
  v_i := public.invoice_save(pg_temp.p('finance'), null, jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-08-28'),
    jsonb_build_array(pg_temp.ln('Duplicate', 1, 100, '4100')));
  perform public.invoice_approve(pg_temp.p('finance'), v_i);
  perform public.invoice_void(pg_temp.p('finance'), v_i, 'Raised twice');
  perform pg_temp.eq((select status from public.invoices where id = v_i), 'void', 'voided');
  perform pg_temp.eq((select status from public.journal_entries where id = (select journal_id from public.invoices where id = v_i)), 'reversed', 'journal reversed');
  perform pg_temp.eq(pg_temp.bal('1100') - (select v from sn where k = 'ar0'), 237.99, 'void leaves AR unchanged');
  -- Voiding a receipt puts the invoices back to owing.
  perform public.customer_payment_void(pg_temp.p('finance'), (select v from sp where k = 'pay2'), 'Bounced');
  perform pg_temp.eq(public.invoice_outstanding((select v from sp where k = 'inv1')), 797.99, 'receipt void reopens invoice');
  perform pg_temp.eq(pg_temp.bal('1100') - (select v from sn where k = 'ar0'), 1237.99, 'AR after void');
  perform pg_temp.eq((public.report_aged_receivables(pg_temp.p('finance'), '2026-09-15')->'totals'->>'total')::numeric, 1237.99, 'ageing still agrees');
  -- Drafts are deleted rather than voided.
  v_i := public.invoice_save(pg_temp.p('finance'), null, jsonb_build_object('customer_id', (select v from sp where k = 'cust'), 'invoice_date', '2026-08-28'),
    jsonb_build_array(pg_temp.ln('Scratch', 1, 1, '4100')));
  perform public.invoice_void(pg_temp.p('finance'), v_i, '');
  perform pg_temp.eq((select count(*)::int from public.invoices where id = v_i), 0, 'draft deleted');
end $$;

-- Suppliers and the bank-change approval -----------------------------------------------------------
do $$
declare v uuid; v_appr uuid;
begin
  perform pg_temp.expect_error(format('select public.supplier_save(%L, null, %L)', pg_temp.p('staff'), '{"name":"X"}'), 'Purchases');
  v := public.supplier_save(pg_temp.p('finance'), null, '{"name":"BOC Gases","abn":"51 824 753 556","payment_terms_days":"30","is_subcontractor":false}');
  insert into sp values ('sup', v);
  v := public.supplier_save(pg_temp.p('finance'), null, '{"name":"Jo Bloggs Rigging","is_subcontractor":true,"gst_registered":false,"tpar_reportable":true,"insurance_expiry":"2026-12-31"}');
  insert into sp values ('noabn', v);
  perform pg_temp.expect_error(format('select public.supplier_bank_request(%L, %L, %L, %L, %L)', pg_temp.p('finance'), v, 'Jo', '06200', '12345678'), 'BSB is 6 digits');
  v_appr := public.supplier_bank_request(pg_temp.p('finance'), v, 'J Bloggs', '062-000', '1234 5678');
  perform pg_temp.eq((select bank_bsb from public.suppliers where id = v), null::text, 'bank not changed until approved');
  perform pg_temp.expect_error(format('select public.supplier_bank_request(%L, %L, %L, %L, %L)', pg_temp.p('finance'), v, 'Jo', '062000', '99999999'), 'already waiting');
  perform pg_temp.expect_error(format('select public.approval_decide(%L, %L, true, null)', pg_temp.p('finance'), v_appr), 'Someone else');
  perform public.approval_decide(pg_temp.p('director'), v_appr, true, 'Called supplier to confirm');
  perform pg_temp.eq((select bank_bsb || '/' || bank_account_number from public.suppliers where id = v), '062000/12345678', 'bank set after approval');
  -- Saving the supplier never touches bank details.
  perform public.supplier_save(pg_temp.p('finance'), v, '{"name":"Jo Bloggs Rigging","is_subcontractor":true,"bank_bsb":"111111"}');
  perform pg_temp.eq((select bank_bsb from public.suppliers where id = v), '062000', 'supplier_save ignores bank fields');
end $$;

-- Purchase orders ---------------------------------------------------------------------------------
do $$
declare v_po uuid; v_l1 uuid; v_l2 uuid;
begin
  perform public.app_set_profile_role(pg_temp.p('sysadmin'), pg_temp.p('staff'), 'project_manager', true);
  -- 10 rods x 25 = 250 + 25 GST; 2 bottles x 80 = 160 + 16 GST. Total 451.
  v_po := public.po_save(pg_temp.p('staff'), null, jsonb_build_object('supplier_id', (select v from sp where k = 'sup'), 'order_date', '2026-09-01'),
    jsonb_build_array(pg_temp.ln('Welding rods (box)', 10, 25, '5200', 'GSTE'), pg_temp.ln('Argon bottle', 2, 80, '5200', 'GSTE')));
  perform pg_temp.eq((select number || ' ' || total from public.purchase_orders where id = v_po), 'PO-1001 451.00', 'PO number and total');
  perform public.po_set_status(pg_temp.p('staff'), v_po, 'submitted', null);
  perform pg_temp.expect_error(format('select public.po_set_status(%L, %L, %L, null)', pg_temp.p('staff'), v_po, 'approved'), 'Purchases');
  perform pg_temp.expect_error(format('select public.po_receive(%L, %L, %L)', pg_temp.p('staff'), v_po, '[]'), 'issued purchase order');
  perform public.po_set_status(pg_temp.p('finance'), v_po, 'approved', null);
  perform public.po_set_status(pg_temp.p('finance'), v_po, 'issued', null);
  select id into v_l1 from public.purchase_order_lines where document_id = v_po and line_no = 1;
  select id into v_l2 from public.purchase_order_lines where document_id = v_po and line_no = 2;
  perform pg_temp.eq(public.po_receive(pg_temp.p('staff'), v_po, jsonb_build_array(jsonb_build_object('lineId', v_l1, 'quantity', 6))), 'partially_received', 'part received');
  perform pg_temp.expect_error(format('select public.po_receive(%L, %L, %L)', pg_temp.p('staff'), v_po,
    jsonb_build_array(jsonb_build_object('lineId', v_l1, 'quantity', 5))), 'more than ordered');
  perform pg_temp.eq(public.po_receive(pg_temp.p('staff'), v_po, jsonb_build_array(jsonb_build_object('lineId', v_l1, 'quantity', 4), jsonb_build_object('lineId', v_l2, 'quantity', 2))),
    'completed', 'fully received');
  insert into sp values ('po', v_po), ('pol1', v_l1);
end $$;

-- Bills, no-ABN withholding, supplier payments ---------------------------------------------------------
do $$
declare v_b uuid; v_b2 uuid; v_small uuid; v_cr uuid; v_pay uuid; v_ap numeric;
begin
  -- Bill matched to the PO: 451.00 incl GST 41.00.
  v_b := public.bill_save(pg_temp.p('finance'), null,
    jsonb_build_object('supplier_id', (select v from sp where k = 'sup'), 'bill_date', '2026-09-05', 'supplier_reference', 'BOC-5531', 'purchase_order_id', (select v from sp where k = 'po')),
    jsonb_build_array(pg_temp.ln('Welding rods (box)', 10, 25, '5200', 'GSTE') || jsonb_build_object('poLineId', (select v from sp where k = 'pol1')),
                      pg_temp.ln('Argon bottle', 2, 80, '5200', 'GSTE')));
  perform pg_temp.eq((select number || ' ' || due_date from public.bills where id = v_b), 'BILL-1001 2026-10-05', 'bill number and due date');
  perform pg_temp.eq((select po_line_id from public.bill_lines where document_id = v_b and line_no = 1), (select v from sp where k = 'pol1'), 'bill line matched to PO line');
  perform pg_temp.expect_error(format('select public.bill_save(%L, null, %L, %L)', pg_temp.p('finance'),
    jsonb_build_object('supplier_id', (select v from sp where k = 'sup'), 'bill_date', '2026-09-06', 'supplier_reference', 'boc-5531'),
    jsonb_build_array(pg_temp.ln('x', 1, 1, '5200', 'GSTE'))), 'already exists');
  -- Unapproved bills can't be paid.
  perform pg_temp.expect_error(format('select public.supplier_payment_record(%L, %L, %L, %L, %L, null, %L)', pg_temp.p('finance'), (select v from sp where k = 'sup'),
    '2026-09-10', pg_temp.acc('1000'), 'x', jsonb_build_array(jsonb_build_object('billId', v_b, 'amount', 100))), 'not approved');
  perform public.bill_submit(pg_temp.p('finance'), v_b);
  perform public.bill_approve(pg_temp.p('finance'), v_b);
  perform pg_temp.eq((select sum(debit) from public.journal_lines jl join public.bills b on b.journal_id = jl.journal_id where b.id = v_b and jl.is_tax_line), 41.00, 'GST credit claimed');
  perform pg_temp.eq(public.bill_outstanding(v_b), 451.00, 'bill owing');

  -- No-ABN subcontractor: 1,000 GST-free labour. 47% withheld = 470.00; 530.00 payable.
  v_b2 := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', (select v from sp where k = 'noabn'), 'bill_date', '2026-09-08', 'supplier_reference', 'INV 12'),
    jsonb_build_array(pg_temp.ln('Rigging, 2 days', 2, 500, '5300', 'FRE')));
  perform public.bill_approve(pg_temp.p('finance'), v_b2);
  perform pg_temp.eq((select withholding from public.bills where id = v_b2), 470.00, 'no-ABN withholding 47%');
  perform pg_temp.eq(public.bill_outstanding(v_b2), 530.00, 'net payable to supplier');
  perform pg_temp.eq(pg_temp.bal('2100') - (select v from sn where k = 'payg0'), -470.00, 'withholding owed to the ATO');
  -- Under the $75 threshold: nothing withheld.
  v_small := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('supplier_id', (select v from sp where k = 'noabn'), 'bill_date', '2026-09-08', 'supplier_reference', 'INV 13'),
    jsonb_build_array(pg_temp.ln('Shackle', 1, 60, '5300', 'FRE')));
  perform public.bill_approve(pg_temp.p('finance'), v_small);
  perform pg_temp.eq((select withholding from public.bills where id = v_small), 0.00, 'no withholding at or under $75');

  -- Supplier credit 55 incl against BILL-1001 -> 396 owing.
  v_cr := public.bill_save(pg_temp.p('finance'), null, jsonb_build_object('kind', 'credit_note', 'supplier_id', (select v from sp where k = 'sup'), 'bill_date', '2026-09-09',
    'supplier_reference', 'CR-88', 'amounts_are', 'inclusive'), jsonb_build_array(pg_temp.ln('Bottle return', 1, 55, '5200', 'GSTE')));
  perform public.bill_approve(pg_temp.p('finance'), v_cr);
  perform pg_temp.eq((select withholding from public.bills where id = v_cr), 0.00, 'no withholding on credits');
  perform public.supplier_credit_apply(pg_temp.p('finance'), v_cr, v_b, 55, null);
  perform pg_temp.eq(public.bill_outstanding(v_b), 396.00, 'supplier credit applied');

  -- Pay 396 + 300 of the 530.
  v_pay := public.supplier_payment_record(pg_temp.p('finance'), (select v from sp where k = 'sup'), '2026-09-20', pg_temp.acc('1000'), 'BOC Sept', 'bank_transfer',
    jsonb_build_array(jsonb_build_object('billId', v_b, 'amount', 396)));
  perform pg_temp.expect_error(format('select public.supplier_payment_record(%L, %L, %L, %L, %L, null, %L)', pg_temp.p('finance'), (select v from sp where k = 'noabn'),
    '2026-09-20', pg_temp.acc('1000'), 'x', jsonb_build_array(jsonb_build_object('billId', v_b2, 'amount', 531))), 'more than what is owing');
  perform public.supplier_payment_record(pg_temp.p('finance'), (select v from sp where k = 'noabn'), '2026-09-20', pg_temp.acc('1000'), 'Part', 'bank_transfer',
    jsonb_build_array(jsonb_build_object('billId', v_b2, 'amount', 300)));
  perform pg_temp.eq(public.bill_outstanding(v_b), 0.00, 'bill paid');
  perform pg_temp.eq(public.bill_outstanding(v_b2), 230.00, 'part paid');

  -- AP moved by: -(451 + 530 + 60 - 55 - 396 - 300) = -290 = 230 + 60 owing.
  v_ap := pg_temp.bal('2000') - (select v from sn where k = 'ap0');
  perform pg_temp.eq(v_ap, -290.00, 'AP control account movement');
  perform pg_temp.eq((public.report_aged_payables(pg_temp.p('finance'), '2026-09-30')->'totals'->>'total')::numeric, 290.00, 'aged payables = AP ledger');
  -- Bills with payments can't be voided; voiding the payment allows it.
  perform pg_temp.expect_error(format('select public.bill_void(%L, %L, %L)', pg_temp.p('finance'), v_b, 'x'), 'Remove those first');
  perform public.supplier_payment_void(pg_temp.p('finance'), v_pay, 'Wrong account');
  perform pg_temp.eq(public.bill_outstanding(v_b), 396.00, 'payment void reopens bill');
  perform pg_temp.eq(pg_temp.bal('1000') - (select v from sn where k = 'bank0'), 500.00 + 1000.00 - 1000.00 - 300.00, 'bank: receipts less payments after voids');
end $$;

-- Lock-down ---------------------------------------------------------------------------------------------
do $$
begin
  perform pg_temp.eq(has_table_privilege('authenticated', 'public.invoices', 'select'), false, 'invoices not readable from browsers');
  perform pg_temp.eq(has_table_privilege('anon', 'public.suppliers', 'select'), false, 'suppliers not readable anonymously');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.invoice_approve(uuid, uuid)', 'execute'), false, 'approve not callable from browsers');
  perform pg_temp.eq(has_function_privilege('service_role', 'public.ledger_reverse_entry(uuid, uuid, date, text)', 'execute'), false, 'internal reversal not exposed');
  perform pg_temp.eq((select count(*)::int from public.training_audit_events where event_type in ('invoice_approved', 'bill_approved', 'customer_payment_recorded', 'supplier_payment_recorded')) >= 10, true, 'audited');
end $$;

select 'sales_purchasing tests passed' as result;
