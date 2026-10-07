-- Panalo Accounts, Phase 7: BAS and TPAR.
--
-- * BAS figures for a period, worked out from the ledger: GST by tax code
--   (each code carries its BAS labels), on the accrual basis (the date of the
--   invoice or bill) or the cash basis (when payments are received or made,
--   in proportion to the document paid). PAYG withholding from pay runs (W1,
--   W2) and no-ABN withholding on bills (W4).
-- * Reconciliation of those figures to the GST and PAYG withholding accounts,
--   and a list of exceptions to check before lodging (uncoded lines, codes on
--   the wrong kind of account, GST that isn't 10%, entries straight to the
--   GST account, GST claimed from suppliers not registered for GST, drafts and
--   unapproved pay runs in the period).
-- * BAS returns: prepared, reviewed by a second person, then marked lodged
--   (with the lodgement date and reference). Lodging posts the transfer of
--   GST and PAYG to the ATO integrated client account and can soft-lock the
--   months of the period. Payments to the ATO (or refunds) are recorded
--   against it.
-- * TPAR: payments in a financial year to suppliers marked as reportable,
--   with GST and no-ABN withholding, and a record of the lodgement.
--
-- This is a preparation workpaper. Nothing is sent to the ATO.

begin;

------------------------------------------------------------------------------
-- 1. Permission, accounts
------------------------------------------------------------------------------

insert into public.app_permissions (key, name, description, sort, area, admin_default, requires_mfa) values
  ('tax.review', 'Review BAS', 'Review a BAS workpaper someone else prepared before it is lodged.', 252, 'Accounts', true, true);
insert into public.app_role_permissions (role_key, permission_key) values
  ('director', 'tax.review'), ('accountant', 'tax.review'), ('accountant', 'tax.bas'), ('super_admin', 'tax.review');

-- The ATO account the BAS transfers GST and PAYG into, and the accounts for
-- PAYG instalments (5A), fuel tax credits (7D) and BAS rounding.
insert into public.accounts (organization_id, code, name, type, subtype, is_system, allow_manual, default_tax_code_id, description)
select o.id, c, n, t, st, true, true, (select id from public.tax_codes where organization_id = o.id and code = 'NG'), d
from public.organizations o, (values
  ('2350', 'ATO Integrated Client Account', 'liability', 'current_liability', 'What the business owes the ATO (or is owed) from lodged BAS, less payments and refunds.'),
  ('1450', 'PAYG Income Tax Instalments Paid', 'asset', 'current_asset', 'PAYG instalments (BAS label 5A), offset against income tax at year end.'),
  ('4850', 'Fuel Tax Credits', 'other_income', 'general', 'Fuel tax credits claimed on the BAS (label 7D).'),
  ('7950', 'BAS Rounding', 'expense', 'general', 'Cents dropped when BAS labels are reported in whole dollars.')
) as v(c, n, t, st, d)
where exists (select 1 from public.accounts a where a.organization_id = o.id)
on conflict (organization_id, code) do nothing;

------------------------------------------------------------------------------
-- 2. Tables
------------------------------------------------------------------------------

create table public.bas_returns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  frequency text not null check (frequency in ('monthly', 'quarterly', 'annual')),
  gst_basis text not null check (gst_basis in ('accrual', 'cash')),
  gst_method text not null default 'simpler' check (gst_method in ('simpler', 'full')),
  status text not null default 'draft' check (status in ('draft', 'reviewed', 'lodged', 'settled')),
  due_date date not null,
  -- Entered by hand: PAYG instalment (5A) and fuel tax credits (7D), whole dollars.
  instalment_5a numeric(14,2) not null default 0 check (instalment_5a >= 0 and instalment_5a = trunc(instalment_5a)),
  fuel_credit_7d numeric(14,2) not null default 0 check (fuel_credit_7d >= 0 and fuel_credit_7d = trunc(fuel_credit_7d)),
  notes text not null default '' check (length(notes) <= 2000),
  figures jsonb,           -- fixed at review; what is lodged
  payable numeric(14,2),   -- label 9: positive is owed to the ATO, negative is a refund
  prepared_by uuid references public.training_profiles(id) on delete set null,
  prepared_at timestamptz not null default now(),
  reviewed_by uuid references public.training_profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_comment text,
  lodged_by uuid references public.training_profiles(id) on delete set null,
  lodged_at timestamptz,
  lodged_on date,
  lodgement_reference text check (lodgement_reference is null or length(lodgement_reference) <= 60),
  journal_id uuid references public.journal_entries(id) on delete restrict,
  locked_periods uuid[] not null default '{}',
  settled_amount numeric(14,2) not null default 0,
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create index bas_returns_org_idx on public.bas_returns (organization_id, period_start desc);

-- Payments to the ATO (positive) and refunds from it (negative) against a lodged BAS.
create table public.bas_payments (
  id uuid primary key default gen_random_uuid(),
  bas_id uuid not null references public.bas_returns(id) on delete restrict,
  payment_date date not null,
  amount numeric(14,2) not null check (amount <> 0),
  bank_account_id uuid not null references public.accounts(id) on delete restrict,
  journal_id uuid not null references public.journal_entries(id) on delete restrict,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index bas_payments_bas_idx on public.bas_payments (bas_id);

create table public.tpar_lodgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  year_start date not null,
  year_end date not null,
  lodged_on date not null,
  reference text check (reference is null or length(reference) <= 60),
  figures jsonb not null,
  lodged_by uuid references public.training_profiles(id) on delete set null,
  lodged_at timestamptz not null default now(),
  unique (organization_id, year_start)
);

------------------------------------------------------------------------------
-- 3. Figures
------------------------------------------------------------------------------

-- Sales-side tax code kinds; the rest that carry BAS labels are purchases.
create or replace function public.tax_kind_is_sale(p_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_kind in ('gst_income', 'gst_free_income', 'export', 'input_taxed_income');
$$;

-- GST-coded amounts in the ledger dated in a range, by tax code. Base is the
-- amount before GST (from the coded lines), gst from the GST lines the
-- posting engine wrote for them. Both are signed so sales and purchases are
-- positive; credit notes, refunds and reversals come out negative.
-- p_skip_documents leaves out invoice, credit note, bill and supplier credit
-- journals (the cash basis brings those in as they are paid).
create or replace function public.gst_ledger_amounts(p_org uuid, p_from date, p_to date, p_skip_documents boolean)
returns table (tax_code_id uuid, base numeric, gst numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select l.tax_code_id,
    coalesce(sum(case when not l.is_tax_line then case when public.tax_kind_is_sale(tc.kind) then l.credit - l.debit else l.debit - l.credit end end), 0),
    coalesce(sum(case when l.is_tax_line then case when public.tax_kind_is_sale(tc.kind) then l.credit - l.debit else l.debit - l.credit end end), 0)
  from public.journal_lines l
  join public.journal_entries je on je.id = l.journal_id
  join public.tax_codes tc on tc.id = l.tax_code_id
  where je.organization_id = p_org and je.status in ('posted', 'reversed') and je.entry_date between p_from and p_to
    and tc.kind not in ('no_gst', 'out_of_scope')
    and not (p_skip_documents and je.source_type in ('invoice', 'credit_note', 'bill', 'supplier_credit'))
  group by l.tax_code_id;
$$;

-- Cash basis: the share of each invoice and bill paid in the range, applied to
-- its GST-coded lines. A payment counts when it is both received and
-- allocated; a voided payment counts back out when it is voided. Bills are
-- measured against what is payable to the supplier (total less no-ABN
-- withholding). Credit notes and supplier credits only reduce what is paid.
create or replace function public.gst_cash_document_amounts(p_org uuid, p_from date, p_to date)
returns table (tax_code_id uuid, base numeric, gst numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with paid as (
    select i.journal_id, a.amount / i.total as f
    from public.receivable_allocations a join public.customer_payments p on p.id = a.payment_id join public.invoices i on i.id = a.invoice_id
    where a.organization_id = p_org and i.kind = 'invoice' and i.journal_id is not null and i.total > 0
      and greatest(p.payment_date, a.allocation_date) between p_from and p_to
    union all
    select i.journal_id, -a.amount / i.total
    from public.receivable_allocations a join public.invoices i on i.id = a.invoice_id
    where a.organization_id = p_org and a.payment_id is not null and i.kind = 'invoice' and i.journal_id is not null and i.total > 0
      and a.voided_at is not null and (a.voided_at at time zone 'Australia/Sydney')::date between p_from and p_to
    union all
    select b.journal_id, a.amount / (b.total - b.withholding)
    from public.payable_allocations a join public.supplier_payments p on p.id = a.payment_id join public.bills b on b.id = a.bill_id
    where a.organization_id = p_org and b.kind = 'bill' and b.journal_id is not null and b.total - b.withholding > 0
      and greatest(p.payment_date, a.allocation_date) between p_from and p_to
    union all
    select b.journal_id, -a.amount / (b.total - b.withholding)
    from public.payable_allocations a join public.bills b on b.id = a.bill_id
    where a.organization_id = p_org and a.payment_id is not null and b.kind = 'bill' and b.journal_id is not null and b.total - b.withholding > 0
      and a.voided_at is not null and (a.voided_at at time zone 'Australia/Sydney')::date between p_from and p_to
  ), share as (
    select journal_id, sum(f) as f from paid group by journal_id
  )
  select l.tax_code_id,
    coalesce(round(sum(case when not l.is_tax_line then (case when public.tax_kind_is_sale(tc.kind) then l.credit - l.debit else l.debit - l.credit end) * s.f end), 2), 0),
    coalesce(round(sum(case when l.is_tax_line then (case when public.tax_kind_is_sale(tc.kind) then l.credit - l.debit else l.debit - l.credit end) * s.f end), 2), 0)
  from share s
  join public.journal_lines l on l.journal_id = s.journal_id
  join public.tax_codes tc on tc.id = l.tax_code_id
  where tc.kind not in ('no_gst', 'out_of_scope')
  group by l.tax_code_id;
$$;

-- BAS label values: GST (G1 to G20, 1A, 1B), PAYG withholding (W1 to W5) and
-- the summary (8A, 8B, 9). Exact amounts in cents and the whole-dollar
-- amounts reported (cents dropped, as the ATO asks).
create or replace function public.bas_figures(p_org uuid, p_from date, p_to date, p_basis text, p_5a numeric default 0, p_7d numeric default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_codes jsonb;
  g jsonb := '{}'::jsonb;
  v_lab text;
  v_1a numeric; v_1b numeric;
  v_w1 numeric; v_w2 numeric; v_w4 numeric;
  v_payg uuid[];
  w jsonb;
  d jsonb;
  v_8a numeric; v_8b numeric;
begin
  with amounts as (
    select * from public.gst_ledger_amounts(p_org, p_from, p_to, p_basis = 'cash')
    union all
    select * from public.gst_cash_document_amounts(p_org, p_from, p_to) where p_basis = 'cash'
  ), by_code as (
    select tax_code_id, sum(base) as base, sum(gst) as gst from amounts group by tax_code_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', tc.id, 'code', tc.code, 'name', tc.name, 'kind', tc.kind, 'labels', to_jsonb(tc.bas_labels),
      'sale', public.tax_kind_is_sale(tc.kind), 'base', b.base, 'gst', b.gst, 'gross', b.base + b.gst) order by tc.sort, tc.code), '[]'::jsonb)
  into v_codes
  from by_code b join public.tax_codes tc on tc.id = b.tax_code_id
  where b.base <> 0 or b.gst <> 0;

  -- G labels are GST-inclusive totals of the codes that carry them.
  foreach v_lab in array array['G1', 'G2', 'G3', 'G4', 'G10', 'G11', 'G13', 'G14'] loop
    g := g || jsonb_build_object(v_lab, coalesce((select sum((c->>'gross')::numeric) from jsonb_array_elements(v_codes) c where c->'labels' ? v_lab), 0));
  end loop;
  v_1a := coalesce((select sum((c->>'gst')::numeric) from jsonb_array_elements(v_codes) c where c->'labels' ? '1A'), 0);
  v_1b := coalesce((select sum((c->>'gst')::numeric) from jsonb_array_elements(v_codes) c where c->'labels' ? '1B'), 0);
  -- The calculation worksheet (full reporting method).
  g := g || jsonb_build_object('G5', (g->>'G2')::numeric + (g->>'G3')::numeric + (g->>'G4')::numeric);
  g := g || jsonb_build_object('G6', (g->>'G1')::numeric - (g->>'G5')::numeric, 'G7', 0);
  g := g || jsonb_build_object('G8', (g->>'G6')::numeric);
  g := g || jsonb_build_object('G9', round((g->>'G8')::numeric / 11, 2));
  g := g || jsonb_build_object('G12', (g->>'G10')::numeric + (g->>'G11')::numeric, 'G15', 0);
  g := g || jsonb_build_object('G16', (g->>'G13')::numeric + (g->>'G14')::numeric);
  g := g || jsonb_build_object('G17', (g->>'G12')::numeric - (g->>'G16')::numeric, 'G18', 0);
  g := g || jsonb_build_object('G19', (g->>'G17')::numeric);
  g := g || jsonb_build_object('G20', round((g->>'G19')::numeric / 11, 2));
  g := g || jsonb_build_object('1A', v_1a, '1B', v_1b);

  -- PAYG withholding. W1 and W2 from pay runs paid in the period (W1 is pay
  -- subject to withholding, after salary sacrifice); W4 from no-ABN
  -- withholding posted on bills dated in the period.
  select coalesce(sum(x.taxable), 0), coalesce(sum(x.payg), 0) into v_w1, v_w2
  from public.pay_run_employees x join public.pay_runs r on r.id = x.pay_run_id
  where r.organization_id = p_org and r.status in ('approved', 'paid') and r.payment_date between p_from and p_to;
  v_payg := array(select id from public.accounts where organization_id = p_org and subtype = 'payg');
  select coalesce(sum(l.credit - l.debit), 0) into v_w4
  from public.journal_lines l join public.journal_entries je on je.id = l.journal_id
  where je.organization_id = p_org and je.status in ('posted', 'reversed') and je.entry_date between p_from and p_to
    and je.source_type in ('bill', 'supplier_credit') and l.account_id = any(v_payg);
  w := jsonb_build_object('W1', v_w1, 'W2', v_w2, 'W3', 0, 'W4', v_w4, 'W5', v_w2 + v_w4);

  -- Reported in whole dollars: cents dropped from each label.
  d := (select jsonb_object_agg(k, trunc(v::text::numeric)) from jsonb_each(g || w) as e(k, v));
  v_8a := (d->>'1A')::numeric + (d->>'W5')::numeric + trunc(coalesce(p_5a, 0));
  v_8b := (d->>'1B')::numeric + trunc(coalesce(p_7d, 0));
  d := d || jsonb_build_object('4', (d->>'W5')::numeric, '5A', trunc(coalesce(p_5a, 0)), '7D', trunc(coalesce(p_7d, 0)), '8A', v_8a, '8B', v_8b, '9', v_8a - v_8b);
  return jsonb_build_object('from', p_from, 'to', p_to, 'basis', p_basis, 'codes', v_codes, 'exact', g || w, 'labels', d);
end;
$$;

-- How the figures agree with the GST and PAYG withholding accounts.
create or replace function public.bas_reconciliation(p_org uuid, p_from date, p_to date, p_figures jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_gst uuid[] := array(select id from public.accounts where organization_id = p_org and subtype = 'gst');
  v_payg uuid[] := array(select id from public.accounts where organization_id = p_org and subtype = 'payg');
  v_gst_move numeric; v_gst_other numeric; v_accrual jsonb;
  v_payg_payrun numeric; v_payg_bills numeric; v_payg_other numeric;
begin
  -- GST account movement in the period, leaving out BAS transfers (they settle earlier periods).
  select coalesce(sum(l.credit - l.debit), 0),
         coalesce(sum(l.credit - l.debit) filter (where not l.is_tax_line), 0)
  into v_gst_move, v_gst_other
  from public.journal_lines l join public.journal_entries je on je.id = l.journal_id
  where je.organization_id = p_org and je.status in ('posted', 'reversed') and je.entry_date between p_from and p_to
    and je.source_type <> 'bas' and l.account_id = any(v_gst);
  if p_figures->>'basis' = 'cash' then
    v_accrual := public.bas_figures(p_org, p_from, p_to, 'accrual');
  end if;
  select coalesce(sum(l.credit - l.debit) filter (where je.source_type = 'pay_run'), 0),
         coalesce(sum(l.credit - l.debit) filter (where je.source_type in ('bill', 'supplier_credit')), 0),
         coalesce(sum(l.credit - l.debit) filter (where je.source_type not in ('pay_run', 'bill', 'supplier_credit')), 0)
  into v_payg_payrun, v_payg_bills, v_payg_other
  from public.journal_lines l join public.journal_entries je on je.id = l.journal_id
  where je.organization_id = p_org and je.status in ('posted', 'reversed') and je.entry_date between p_from and p_to
    and je.source_type <> 'bas' and l.account_id = any(v_payg);
  return jsonb_build_object(
    'gst', jsonb_build_object(
      'accountMovement', v_gst_move,
      'notFromTaxLines', v_gst_other,
      'expected', (p_figures->'exact'->>'1A')::numeric - (p_figures->'exact'->>'1B')::numeric,
      'accrualExpected', case when v_accrual is not null then (v_accrual->'exact'->>'1A')::numeric - (v_accrual->'exact'->>'1B')::numeric end,
      'difference', v_gst_move - coalesce((v_accrual->'exact'->>'1A')::numeric - (v_accrual->'exact'->>'1B')::numeric,
                                         (p_figures->'exact'->>'1A')::numeric - (p_figures->'exact'->>'1B')::numeric)),
    'payg', jsonb_build_object(
      'payRuns', v_payg_payrun, 'w2', (p_figures->'exact'->>'W2')::numeric, 'payRunDifference', v_payg_payrun - (p_figures->'exact'->>'W2')::numeric,
      'bills', v_payg_bills, 'w4', (p_figures->'exact'->>'W4')::numeric,
      'other', v_payg_other));
end;
$$;

-- What to check before lodging.
create or replace function public.bas_exceptions(p_org uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select l.id, l.journal_id, je.number, je.entry_date, je.source_type, je.memo, a.code as account_code, a.name as account_name, a.type as account_type,
      a.subtype, l.is_tax_line, l.debit, l.credit, tc.code as tax_code, tc.kind, tc.applies_to, tc.rate
    from public.journal_lines l
    join public.journal_entries je on je.id = l.journal_id
    join public.accounts a on a.id = l.account_id
    left join public.tax_codes tc on tc.id = l.tax_code_id
    where je.organization_id = p_org and je.status in ('posted', 'reversed') and je.entry_date between p_from and p_to and je.source_type <> 'bas'
  ), items as (
    -- Income, expense and asset purchases with no tax code: they're left off the BAS.
    select 'uncoded' as kind, 'warn' as severity, l.journal_id, l.number, l.entry_date,
      'No tax code on ' || l.account_code || ' ' || l.account_name || ': not on the BAS. Add a code (NG if it really isn''t reportable).' as message,
      l.debit - l.credit as amount
    from lines l
    where l.tax_code is null and not l.is_tax_line
      and (l.account_type in ('revenue', 'other_income', 'cost_of_sales', 'expense', 'other_expense') or l.subtype = 'fixed_asset')
      and l.source_type not in ('pay_run', 'pay_run_payment', 'super_payment')
    union all
    -- A sales code on a cost, or a purchase code on income.
    select 'wrong_side', 'warn', l.journal_id, l.number, l.entry_date,
      'Tax code ' || l.tax_code || ' is for ' || case when l.applies_to = 'sales' then 'sales' else 'purchases' end || ' but is on ' || l.account_code || ' ' || l.account_name || '.',
      l.debit - l.credit
    from lines l
    where not l.is_tax_line and l.tax_code is not null
      and ((l.applies_to = 'sales' and l.account_type in ('cost_of_sales', 'expense', 'other_expense'))
        or (l.applies_to = 'purchases' and l.account_type in ('revenue', 'other_income')))
    union all
    -- Capital and non-capital purchases at the wrong label (G10 or G11).
    select 'capital', 'info', l.journal_id, l.number, l.entry_date,
      case when l.kind = 'gst_capital' then 'Capital purchase code on ' || l.account_code || ' ' || l.account_name || ', which isn''t a fixed asset (G10 or G11?).'
           else 'Fixed asset ' || l.account_code || ' ' || l.account_name || ' coded ' || l.tax_code || ': capital purchases go at G10 (code CAP).' end,
      l.debit - l.credit
    from lines l
    where not l.is_tax_line and ((l.kind = 'gst_capital' and l.subtype <> 'fixed_asset') or (l.kind = 'gst_expense' and l.subtype = 'fixed_asset'))
    union all
    -- GST lines that aren't the code's rate of the coded amounts (beyond rounding).
    select 'gst_rate', 'warn', t.journal_id, t.number, t.entry_date,
      'GST of ' || to_char(t.gst, 'FM999,999,990.00') || ' at ' || t.tax_code || ' isn''t ' || (t.rate * 100)::int || '% of ' || to_char(t.base, 'FM999,999,990.00') || '.',
      t.gst
    from (
      select l.journal_id, l.number, l.entry_date, l.tax_code, l.rate,
        sum(case when not l.is_tax_line then abs(l.debit - l.credit) else 0 end) as base,
        sum(case when l.is_tax_line then abs(l.debit - l.credit) else 0 end) as gst,
        count(*) filter (where not l.is_tax_line) as n
      from lines l where l.rate > 0 group by l.journal_id, l.number, l.entry_date, l.tax_code, l.rate
    ) t
    where abs(t.gst - round(t.base * t.rate, 2)) > 0.01 * greatest(t.n, 1)
    union all
    -- Amounts put straight on the GST account, not by a tax code.
    select 'gst_account', 'warn', l.journal_id, l.number, l.entry_date,
      'Posted straight to the GST account (' || coalesce(nullif(l.memo, ''), l.source_type) || '): it isn''t on any BAS label, so the GST account won''t agree.',
      l.credit - l.debit
    from lines l where l.subtype = 'gst' and not l.is_tax_line
    union all
    -- GST claimed on bills from suppliers not registered for GST, or with no ABN.
    select 'supplier_gst', 'warn', b.journal_id, b.number, b.bill_date,
      'GST claimed on a bill from ' || s.name || case when s.abn is null then ', who has no ABN.' else ', who isn''t registered for GST.' end
        || ' You need a valid tax invoice to claim it.',
      b.gst
    from public.bills b join public.suppliers s on s.id = b.supplier_id
    where b.organization_id = p_org and b.status = 'approved' and b.kind = 'bill' and b.gst > 0 and b.bill_date between p_from and p_to
      and (s.abn is null or not s.gst_registered)
    union all
    -- Documents and pay runs in the period that aren't in the books yet.
    select 'draft_invoice', 'info', null, coalesce(i.number, 'Draft'), i.invoice_date,
      case when i.kind = 'credit_note' then 'Credit note' else 'Invoice' end || ' not approved yet: not on this BAS.', i.total
    from public.invoices i where i.organization_id = p_org and i.status = 'draft' and i.invoice_date between p_from and p_to
    union all
    select 'draft_bill', 'info', null, b.number, b.bill_date, 'Bill not approved yet (' || b.status || '): not on this BAS.', b.total
    from public.bills b where b.organization_id = p_org and b.status in ('draft', 'submitted') and b.bill_date between p_from and p_to
    union all
    select 'pay_run', 'warn', null, r.number, r.payment_date, 'Pay run paid in the period isn''t approved yet: not at W1 or W2.', r.gross
    from public.pay_runs r where r.organization_id = p_org and r.status in ('draft', 'submitted') and r.payment_date between p_from and p_to
    union all
    select 'bank_lines', 'info', null, null, max(t.txn_date),
      count(*) || ' bank statement line(s) in the period aren''t matched yet: there may be income or costs not in the books.', sum(t.amount)
    from public.bank_transactions t where t.organization_id = p_org and t.status = 'new' and t.txn_date between p_from and p_to
    having count(*) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'severity', severity, 'journalId', journal_id, 'number', number, 'date', entry_date,
    'message', message, 'amount', amount) order by case severity when 'warn' then 0 else 1 end, entry_date nulls last, number), '[]'::jsonb)
  from (select * from items limit 500) x;
$$;

-- When the BAS is due (self-lodgers; tax agents may have later dates).
create or replace function public.bas_due_date(p_frequency text, p_end date)
returns date
language sql
immutable
set search_path = ''
as $$
  select case p_frequency
    when 'monthly' then (date_trunc('month', p_end) + interval '1 month')::date + 20
    when 'quarterly' then case extract(month from p_end)::int
      when 12 then make_date(extract(year from p_end)::int + 1, 2, 28)
      else (date_trunc('month', p_end) + interval '1 month')::date + 27 end
    else make_date(extract(year from p_end)::int, 10, 31) end;
$$;

------------------------------------------------------------------------------
-- 4. BAS returns
------------------------------------------------------------------------------

create or replace function public.bas_create(p_actor uuid, p_start date, p_end date, p_frequency text, p_method text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_set record;
  v_id uuid;
  v_months int;
  v_fy int;
begin
  perform public.app_require(p_actor, 'tax.bas');
  select * into v_set from public.company_settings where organization_id = v_org;
  if not coalesce(v_set.gst_registered, false) and not exists (select 1 from public.pay_runs where organization_id = v_org) then
    raise exception 'The business isn''t registered for GST and has no payroll: there is no BAS to prepare.' using errcode = '22023';
  end if;
  if p_frequency not in ('monthly', 'quarterly', 'annual') then raise exception 'Choose how often the BAS is lodged.' using errcode = '22023'; end if;
  if p_start is null or p_end is null or extract(day from p_start) <> 1 or p_end <> (date_trunc('month', p_end) + interval '1 month - 1 day')::date then
    raise exception 'A BAS period runs from the first day of a month to the last day of a month.' using errcode = '22023';
  end if;
  v_months := (extract(year from p_end) * 12 + extract(month from p_end)) - (extract(year from p_start) * 12 + extract(month from p_start)) + 1;
  v_fy := coalesce(v_set.financial_year_start_month, 7);
  if (p_frequency = 'monthly' and v_months <> 1)
     or (p_frequency = 'quarterly' and (v_months <> 3 or (extract(month from p_start)::int - v_fy + 12) % 3 <> 0))
     or (p_frequency = 'annual' and (v_months <> 12 or extract(month from p_start)::int <> v_fy)) then
    raise exception 'A % BAS covers %.', p_frequency,
      case p_frequency when 'monthly' then 'one calendar month' when 'quarterly' then 'a quarter (July to September, October to December, January to March or April to June)'
        else 'the financial year' end using errcode = '22023';
  end if;
  if exists (select 1 from public.bas_returns where organization_id = v_org and daterange(period_start, period_end, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'A BAS already covers part of this period.' using errcode = '22023';
  end if;
  insert into public.bas_returns (organization_id, period_start, period_end, frequency, gst_basis, gst_method, due_date, prepared_by)
  values (v_org, p_start, p_end, p_frequency, coalesce(v_set.gst_basis, 'accrual'), case when p_method = 'full' then 'full' else 'simpler' end,
    public.bas_due_date(p_frequency, p_end), p_actor)
  returning id into v_id;
  perform public.app_audit(p_actor, 'bas_created', 'bas_return', v_id::text, null,
    jsonb_build_object('from', p_start, 'to', p_end, 'frequency', p_frequency, 'basis', coalesce(v_set.gst_basis, 'accrual')));
  return v_id;
end;
$$;

-- Hand-entered labels and notes, while the BAS is a draft.
create or replace function public.bas_save(p_actor uuid, p_id uuid, p_5a numeric, p_7d numeric, p_method text, p_notes text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'tax.bas');
  select * into v from public.bas_returns where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'BAS not found.' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'Only a draft BAS can be changed. Send it back to draft first.' using errcode = '22023'; end if;
  if coalesce(p_5a, 0) < 0 or coalesce(p_7d, 0) < 0 or coalesce(p_5a, 0) <> trunc(coalesce(p_5a, 0)) or coalesce(p_7d, 0) <> trunc(coalesce(p_7d, 0)) then
    raise exception 'Enter 5A and 7D in whole dollars.' using errcode = '22023';
  end if;
  update public.bas_returns set instalment_5a = coalesce(p_5a, 0), fuel_credit_7d = coalesce(p_7d, 0),
    gst_method = case when p_method in ('simpler', 'full') then p_method else gst_method end,
    notes = left(coalesce(p_notes, ''), 2000), updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'bas_saved', 'bas_return', p_id::text,
    jsonb_build_object('5A', v.instalment_5a, '7D', v.fuel_credit_7d, 'method', v.gst_method), jsonb_build_object('5A', coalesce(p_5a, 0), '7D', coalesce(p_7d, 0), 'method', p_method));
end;
$$;

-- A second person reviews the workpaper. The figures are fixed now: what is
-- reviewed is what is lodged.
create or replace function public.bas_review(p_actor uuid, p_id uuid, p_comment text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  f jsonb;
begin
  perform public.app_require(p_actor, 'tax.review');
  select * into v from public.bas_returns where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'BAS not found.' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'Only a draft BAS can be reviewed.' using errcode = '22023'; end if;
  if v.prepared_by = p_actor then raise exception 'Someone other than the person who prepared the BAS must review it.' using errcode = '42501'; end if;
  if exists (select 1 from public.bas_returns where organization_id = v.organization_id and period_end < v.period_start and status in ('draft', 'reviewed')) then
    raise exception 'An earlier BAS isn''t lodged yet. Lodge the BAS in order.' using errcode = '22023';
  end if;
  f := public.bas_figures(v.organization_id, v.period_start, v.period_end, v.gst_basis, v.instalment_5a, v.fuel_credit_7d);
  f := f || jsonb_build_object('reconciliation', public.bas_reconciliation(v.organization_id, v.period_start, v.period_end, f),
    'exceptions', public.bas_exceptions(v.organization_id, v.period_start, v.period_end), 'method', v.gst_method, 'fixedAt', now());
  update public.bas_returns set status = 'reviewed', figures = f, payable = (f->'labels'->>'9')::numeric, reviewed_by = p_actor, reviewed_at = now(),
    review_comment = nullif(btrim(coalesce(p_comment, '')), ''), updated_at = now() where id = p_id;
  if v.prepared_by is not null then
    insert into public.notifications (organization_id, profile_id, kind, title, body, link)
    values (v.organization_id, v.prepared_by, 'bas_reviewed', 'BAS reviewed: ' || to_char(v.period_start, 'Mon YYYY') || ' to ' || to_char(v.period_end, 'Mon YYYY'),
      coalesce(nullif(btrim(coalesce(p_comment, '')), ''), 'Ready to lodge.'), 'bas');
  end if;
  perform public.app_audit(p_actor, 'bas_reviewed', 'bas_return', p_id::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'reviewed', 'labels', f->'labels', 'comment', p_comment));
  return f;
end;
$$;

create or replace function public.bas_reopen(p_actor uuid, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'tax.bas');
  select * into v from public.bas_returns where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'BAS not found.' using errcode = 'P0002'; end if;
  if v.status <> 'reviewed' then raise exception 'Only a reviewed BAS that isn''t lodged can go back to draft.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why it goes back to draft.' using errcode = '22023'; end if;
  update public.bas_returns set status = 'draft', figures = null, payable = null, reviewed_by = null, reviewed_at = null, review_comment = null, updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'bas_reopened', 'bas_return', p_id::text, jsonb_build_object('status', 'reviewed'), jsonb_build_object('status', 'draft', 'reason', btrim(p_reason)));
end;
$$;

create or replace function public.bas_delete(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'tax.bas');
  select * into v from public.bas_returns where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'BAS not found.' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'Only a draft BAS can be deleted.' using errcode = '22023'; end if;
  delete from public.bas_returns where id = p_id;
  perform public.app_audit(p_actor, 'bas_deleted', 'bas_return', p_id::text, jsonb_build_object('from', v.period_start, 'to', v.period_end), null);
end;
$$;

-- Marks the BAS lodged (it was lodged with the ATO outside this system) and
-- posts the transfer: Dr GST and PAYG withholding by the exact amounts on the
-- BAS, Dr PAYG instalments (5A), Cr fuel tax credits (7D), Cr (or Dr) the ATO
-- integrated client account by the whole-dollar amount at 9, and the cents
-- dropped to BAS rounding. Optionally soft-locks the months of the period.
create or replace function public.bas_lodge(p_actor uuid, p_id uuid, p_lodged_on date, p_reference text, p_lock boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  f jsonb;
  v_org uuid := public.app_org_of(p_actor);
  v_gst uuid; v_payg uuid; v_ato uuid; v_inst uuid; v_ftc uuid; v_round uuid;
  v_gst_amt numeric; v_payg_amt numeric; v_9 numeric; v_round_amt numeric;
  v_lines jsonb := '[]'::jsonb;
  v_journal uuid;
  v_locked uuid[] := '{}';
  pr record;
  v_now jsonb;
begin
  perform public.app_require(p_actor, 'tax.bas');
  select * into v from public.bas_returns where id = p_id and organization_id = v_org for update;
  if not found then raise exception 'BAS not found.' using errcode = 'P0002'; end if;
  if v.status <> 'reviewed' then raise exception 'The BAS must be reviewed before it is marked lodged.' using errcode = '22023'; end if;
  if p_lodged_on is null or p_lodged_on <= v.period_end then
    raise exception 'Enter the date it was lodged with the ATO (after the period ends).' using errcode = '22023';
  end if;
  f := v.figures;
  -- If the books changed since the review, the reviewed figures are no longer right.
  v_now := public.bas_figures(v.organization_id, v.period_start, v.period_end, v.gst_basis, v.instalment_5a, v.fuel_credit_7d);
  if v_now->'exact' is distinct from f->'exact' then
    raise exception 'The books for this period changed after the BAS was reviewed. Send it back to draft and review it again.' using errcode = '22023';
  end if;

  select id into v_gst from public.accounts where organization_id = v_org and subtype = 'gst' and status = 'active' order by code limit 1;
  select id into v_payg from public.accounts where organization_id = v_org and subtype = 'payg' and status = 'active' order by code limit 1;
  select id into v_ato from public.accounts where organization_id = v_org and code = '2350';
  select id into v_inst from public.accounts where organization_id = v_org and code = '1450';
  select id into v_ftc from public.accounts where organization_id = v_org and code = '4850';
  select id into v_round from public.accounts where organization_id = v_org and code = '7950';
  if v_ato is null or v_round is null then raise exception 'The ATO integrated client account (2350) or BAS rounding account (7950) is missing.' using errcode = '22023'; end if;

  v_gst_amt := (f->'exact'->>'1A')::numeric - (f->'exact'->>'1B')::numeric;
  v_payg_amt := (f->'exact'->>'W5')::numeric;
  v_9 := (f->'labels'->>'9')::numeric;
  if v_gst_amt <> 0 then
    v_lines := v_lines || jsonb_build_object('accountId', v_gst, 'description', 'GST on BAS: 1A less 1B',
      'debit', greatest(v_gst_amt, 0), 'credit', greatest(-v_gst_amt, 0), 'taxCodeId', null);
  end if;
  if v_payg_amt <> 0 then
    v_lines := v_lines || jsonb_build_object('accountId', v_payg, 'description', 'PAYG withholding on BAS (W5)',
      'debit', greatest(v_payg_amt, 0), 'credit', greatest(-v_payg_amt, 0), 'taxCodeId', null);
  end if;
  if v.instalment_5a > 0 then
    v_lines := v_lines || jsonb_build_object('accountId', v_inst, 'description', 'PAYG instalment (5A)', 'debit', v.instalment_5a, 'credit', 0, 'taxCodeId', null);
  end if;
  if v.fuel_credit_7d > 0 then
    v_lines := v_lines || jsonb_build_object('accountId', v_ftc, 'description', 'Fuel tax credits (7D)', 'debit', 0, 'credit', v.fuel_credit_7d, 'taxCodeId', null);
  end if;
  if v_9 <> 0 then
    v_lines := v_lines || jsonb_build_object('accountId', v_ato, 'description', case when v_9 > 0 then 'Owed to the ATO (9)' else 'Refund due from the ATO (9)' end,
      'debit', greatest(-v_9, 0), 'credit', greatest(v_9, 0), 'taxCodeId', null);
  end if;
  -- Whatever is left is the cents dropped from the labels.
  v_round_amt := v_9 + v.fuel_credit_7d - v_gst_amt - v_payg_amt - v.instalment_5a;
  if v_round_amt <> 0 then
    v_lines := v_lines || jsonb_build_object('accountId', v_round, 'description', 'Cents dropped on the BAS',
      'debit', greatest(v_round_amt, 0), 'credit', greatest(-v_round_amt, 0), 'taxCodeId', null);
  end if;
  if jsonb_array_length(v_lines) > 0 then
    v_journal := public.ledger_post_entry(p_actor, v.period_end, 'BAS ' || to_char(v.period_start, 'Mon YYYY') || ' to ' || to_char(v.period_end, 'Mon YYYY')
      || coalesce(' · ' || nullif(btrim(p_reference), ''), ''), 'bas', p_id, left(coalesce(nullif(btrim(p_reference), ''), 'BAS'), 60), v_lines, 'no_tax', false);
  end if;

  if coalesce(p_lock, false) then
    for pr in select * from public.accounting_periods where organization_id = v_org and start_date >= v.period_start and end_date <= v.period_end and status = 'open' loop
      update public.accounting_periods set status = 'soft_locked', status_changed_by = p_actor, status_changed_at = now() where id = pr.id;
      v_locked := v_locked || pr.id;
    end loop;
  end if;

  update public.bas_returns set status = case when v_9 = 0 then 'settled' else 'lodged' end, lodged_by = p_actor, lodged_at = now(), lodged_on = p_lodged_on,
    lodgement_reference = nullif(btrim(coalesce(p_reference, '')), ''), journal_id = v_journal, locked_periods = v_locked, updated_at = now()
  where id = p_id;
  perform public.app_audit(p_actor, 'bas_lodged', 'bas_return', p_id::text, jsonb_build_object('status', 'reviewed'),
    jsonb_build_object('status', 'lodged', 'lodgedOn', p_lodged_on, 'reference', p_reference, 'payable', v_9, 'lockedPeriods', cardinality(v_locked)));
  return v_journal;
end;
$$;

-- A payment to the ATO (or a refund received) for a lodged BAS.
create or replace function public.bas_record_payment(p_actor uuid, p_id uuid, p_bank uuid, p_date date, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_org uuid := public.app_org_of(p_actor);
  v_ato uuid;
  v_amt numeric;
  v_journal uuid;
  v_left numeric;
begin
  if not (public.app_has(p_actor, 'tax.bas') or public.app_has(p_actor, 'bank.manage')) then perform public.app_require(p_actor, 'tax.bas'); end if;
  select * into v from public.bas_returns where id = p_id and organization_id = v_org for update;
  if not found then raise exception 'BAS not found.' using errcode = 'P0002'; end if;
  if v.status <> 'lodged' then raise exception 'Payments are recorded against a lodged BAS that isn''t settled.' using errcode = '22023'; end if;
  if not exists (select 1 from public.accounts where id = p_bank and organization_id = v_org and subtype = 'bank' and status = 'active') then
    raise exception 'Choose the bank account.' using errcode = '22023';
  end if;
  if p_date is null then raise exception 'Enter the date.' using errcode = '22023'; end if;
  v_left := abs(v.payable) - v.settled_amount;
  v_amt := coalesce(p_amount, v_left);
  if v_amt <= 0 or v_amt <> round(v_amt, 2) or v_amt > v_left then
    raise exception 'Enter an amount up to the % still %.', to_char(v_left, 'FM$999,999,990.00'), case when v.payable > 0 then 'owing' else 'to be refunded' end using errcode = '22023';
  end if;
  select id into v_ato from public.accounts where organization_id = v_org and code = '2350';
  v_journal := public.ledger_post_entry(p_actor, p_date,
    case when v.payable > 0 then 'Payment to the ATO' else 'Refund from the ATO' end || ' · BAS ' || to_char(v.period_start, 'Mon YYYY') || ' to ' || to_char(v.period_end, 'Mon YYYY'),
    'bas_payment', p_id, coalesce(v.lodgement_reference, 'BAS'),
    case when v.payable > 0 then jsonb_build_array(
      jsonb_build_object('accountId', v_ato, 'description', 'ATO integrated client account', 'debit', v_amt, 'credit', 0, 'taxCodeId', null),
      jsonb_build_object('accountId', p_bank, 'description', 'Paid to the ATO', 'debit', 0, 'credit', v_amt, 'taxCodeId', null))
    else jsonb_build_array(
      jsonb_build_object('accountId', p_bank, 'description', 'Refund from the ATO', 'debit', v_amt, 'credit', 0, 'taxCodeId', null),
      jsonb_build_object('accountId', v_ato, 'description', 'ATO integrated client account', 'debit', 0, 'credit', v_amt, 'taxCodeId', null)) end,
    'no_tax', false);
  insert into public.bas_payments (bas_id, payment_date, amount, bank_account_id, journal_id, created_by)
  values (p_id, p_date, case when v.payable > 0 then v_amt else -v_amt end, p_bank, v_journal, p_actor);
  update public.bas_returns set settled_amount = settled_amount + v_amt, status = case when settled_amount + v_amt = abs(payable) then 'settled' else status end,
    updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'bas_payment_recorded', 'bas_return', p_id::text, null,
    jsonb_build_object('amount', v_amt, 'date', p_date, 'refund', v.payable < 0));
  return v_journal;
end;
$$;

------------------------------------------------------------------------------
-- 5. TPAR
------------------------------------------------------------------------------

-- Payments made in the range to suppliers marked for the TPAR: the gross paid
-- (including GST and any no-ABN withholding), the GST in it and the tax
-- withheld, each in proportion to the bills paid. Payments not applied to a
-- bill are included in full and flagged.
create or replace function public.tpar_figures(p_org uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with alloc as (
    select b.supplier_id, a.amount, b.total, b.gst, b.withholding
    from public.payable_allocations a
    join public.supplier_payments p on p.id = a.payment_id
    join public.bills b on b.id = a.bill_id
    where p.organization_id = p_org and p.status = 'posted' and a.voided_at is null and b.kind = 'bill' and b.total - b.withholding > 0
      and p.payment_date between p_from and p_to
  ), per as (
    select supplier_id,
      round(sum(amount * total / (total - withholding)), 2) as gross,
      round(sum(amount * gst / (total - withholding)), 2) as gst,
      round(sum(amount * withholding / (total - withholding)), 2) as withheld
    from alloc group by supplier_id
  ), unapplied as (
    select p.supplier_id, sum(p.amount - coalesce((select sum(a.amount) from public.payable_allocations a where a.payment_id = p.id and a.voided_at is null), 0)) as amount
    from public.supplier_payments p
    where p.organization_id = p_org and p.status = 'posted' and p.payment_date between p_from and p_to
    group by p.supplier_id
  ), payees as (
    select s.id, s.name, s.trading_name, s.abn, s.address,
      coalesce(per.gross, 0) + coalesce(u.amount, 0) as gross, coalesce(per.gst, 0) as gst, coalesce(per.withheld, 0) as withheld,
      coalesce(u.amount, 0) as unapplied
    from public.suppliers s
    left join per on per.supplier_id = s.id
    left join unapplied u on u.supplier_id = s.id
    where s.organization_id = p_org and s.tpar_reportable and (coalesce(per.gross, 0) <> 0 or coalesce(u.amount, 0) <> 0)
  )
  select jsonb_build_object('from', p_from, 'to', p_to,
    'rows', coalesce((select jsonb_agg(jsonb_build_object('supplierId', id, 'name', name, 'tradingName', trading_name, 'abn', abn, 'address', address,
        'gross', gross, 'gst', gst, 'withheld', withheld, 'unapplied', unapplied,
        'problems', to_jsonb(array_remove(array[
          case when abn is null and withheld = 0 then 'No ABN, and no tax withheld' end,
          case when coalesce(address->>'street', '') = '' or coalesce(address->>'postcode', '') = '' then 'Address incomplete' end,
          case when unapplied > 0 then 'Payments not applied to a bill: included in full, GST unknown' end], null))) order by name) from payees), '[]'::jsonb),
    'totals', (select jsonb_build_object('gross', coalesce(sum(gross), 0), 'gst', coalesce(sum(gst), 0), 'withheld', coalesce(sum(withheld), 0), 'count', count(*)) from payees),
    -- Subcontractors not marked for the TPAR who were paid in the year: worth a second look.
    'notMarked', coalesce((select jsonb_agg(jsonb_build_object('supplierId', s.id, 'name', s.name, 'paid', x.paid) order by s.name)
       from public.suppliers s join (select supplier_id, sum(amount) as paid from public.supplier_payments
         where organization_id = p_org and status = 'posted' and payment_date between p_from and p_to group by supplier_id) x on x.supplier_id = s.id
       where s.organization_id = p_org and s.is_subcontractor and not s.tpar_reportable), '[]'::jsonb));
$$;

create or replace function public.tpar_lodge(p_actor uuid, p_year_start date, p_lodged_on date, p_reference text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_end date := (p_year_start + interval '1 year - 1 day')::date;
  v_id uuid;
  f jsonb;
begin
  perform public.app_require(p_actor, 'tax.bas');
  if p_year_start is null or extract(day from p_year_start) <> 1 then raise exception 'Choose the financial year.' using errcode = '22023'; end if;
  if p_lodged_on is null or p_lodged_on <= v_end then
    raise exception 'Enter the date it was lodged (after the year ended).' using errcode = '22023';
  end if;
  if exists (select 1 from public.tpar_lodgements where organization_id = v_org and year_start = p_year_start) then
    raise exception 'The TPAR for this year is already marked lodged.' using errcode = '22023';
  end if;
  f := public.tpar_figures(v_org, p_year_start, v_end);
  insert into public.tpar_lodgements (organization_id, year_start, year_end, lodged_on, reference, figures, lodged_by)
  values (v_org, p_year_start, v_end, p_lodged_on, nullif(btrim(coalesce(p_reference, '')), ''), f, p_actor) returning id into v_id;
  perform public.app_audit(p_actor, 'tpar_lodged', 'tpar', v_id::text, null,
    jsonb_build_object('year', to_char(p_year_start, 'YYYY') || '-' || to_char(v_end, 'YY'), 'lodgedOn', p_lodged_on, 'payees', f->'totals'->'count', 'gross', f->'totals'->'gross'));
  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 6. Guards
------------------------------------------------------------------------------

-- A BAS transfer or ATO payment journal is reversed only by un-lodging, which
-- isn't offered: corrections go on the next BAS.
create or replace function public.bas_journal_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'reversed' and old.status = 'posted' and old.source_type in ('bas', 'bas_payment') then
    raise exception 'BAS journals can''t be reversed. Correct the amounts on the next BAS.' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger journal_entries_bas_guard before update of status on public.journal_entries for each row execute function public.bas_journal_guard();

------------------------------------------------------------------------------
-- 7. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['bas_returns', 'bas_payments', 'tpar_lodgements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'gst_ledger_amounts(uuid, date, date, boolean)', 'gst_cash_document_amounts(uuid, date, date)',
    'bas_figures(uuid, date, date, text, numeric, numeric)', 'bas_reconciliation(uuid, date, date, jsonb)', 'bas_exceptions(uuid, date, date)',
    'bas_create(uuid, date, date, text, text)', 'bas_save(uuid, uuid, numeric, numeric, text, text)', 'bas_review(uuid, uuid, text)',
    'bas_reopen(uuid, uuid, text)', 'bas_delete(uuid, uuid)', 'bas_lodge(uuid, uuid, date, text, boolean)',
    'bas_record_payment(uuid, uuid, uuid, date, numeric)', 'tpar_figures(uuid, date, date)', 'tpar_lodge(uuid, date, date, text)', 'bas_journal_guard()']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- Pure helpers.
  foreach f in array array['tax_kind_is_sale(text)', 'bas_due_date(text, date)'] loop
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end;
$$;

commit;
