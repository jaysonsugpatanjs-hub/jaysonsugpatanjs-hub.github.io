-- Panalo Accounts, Phase 3: sales and purchasing.
--
-- * compliance_rules: dated, sourced statutory values (brief section 12).
--   First rule: withholding where a supplier quotes no ABN (47%).
-- * customers, suppliers. Supplier bank details change only through a
--   second-person approval (purchases.bank).
-- * quotes -> invoices (and credit notes, kind = 'credit_note'); purchase
--   orders (with goods receipts) -> bills (and supplier credit notes).
-- * Approving an invoice or bill posts it through ledger_post_entry, with
--   source_type/source_id linking the journal back. Voiding reverses it.
-- * Receipts and supplier payments post bank <-> control account, and are
--   allocated to documents. Outstanding = total - live allocations.
-- * Reports: aged receivables / payables, customer statements.
begin;

------------------------------------------------------------------------------
-- 0. Compliance rules, permissions, approvals, reversal helper
------------------------------------------------------------------------------

create table public.compliance_rules (
  id uuid primary key default gen_random_uuid(),
  rule_name text not null check (rule_name ~ '^[a-z][a-z0-9_]{2,60}$'),
  rule_type text not null,
  effective_from date not null,
  effective_to date,
  value jsonb not null,
  source text not null,
  version text not null default '1',
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_name, effective_from)
);
insert into public.compliance_rules (rule_name, rule_type, effective_from, value, source, approved_by) values
  ('no_abn_withholding_rate', 'payg_withholding', '2024-07-01', '0.47'::jsonb,
   'ATO: PAYG withholding where an ABN is not quoted (top marginal rate plus Medicare levy). https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/pay-as-you-go-payg-withholding', 'Seeded; confirm with accountant'),
  ('no_abn_withholding_threshold', 'payg_withholding', '2024-07-01', '75'::jsonb,
   'ATO: no withholding where the payment is $75 or less excluding GST.', 'Seeded; confirm with accountant');

create or replace function public.compliance_value(p_rule text, p_date date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select value from public.compliance_rules
  where rule_name = p_rule and effective_from <= p_date and (effective_to is null or effective_to >= p_date)
  order by effective_from desc limit 1;
$$;

insert into public.app_permissions (key, name, description, sort, area, admin_default, requires_mfa) values
  ('purchases.raise', 'Raise purchase orders', 'Create purchase orders and record goods received; someone with Purchases approves them.', 165, 'Accounts', true, false);
insert into public.app_role_permissions (role_key, permission_key) values ('project_manager', 'purchases.raise'), ('finance_admin', 'purchases.raise'), ('super_admin', 'purchases.raise');

alter table public.approvals drop constraint approvals_kind_check;
alter table public.approvals add constraint approvals_kind_check check (kind in ('company_bank_account', 'supplier_bank'));

-- Internal: posts the mirror image of a posted journal (used by modules and
-- by journal_reverse). No permission check here; callers check.
create or replace function public.ledger_reverse_entry(p_actor uuid, p_id uuid, p_date date, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_row record;
  v_new uuid;
  v_period uuid;
  v_date date;
begin
  select * into v_row from public.journal_entries where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'Journal not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'Only a posted journal can be reversed.' using errcode = '22023';
  end if;
  if v_row.reverses_id is not null then
    raise exception 'This journal is itself a reversal.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for the reversal.' using errcode = '22023';
  end if;
  v_date := coalesce(p_date, v_row.entry_date);
  v_period := public.ledger_period_for(p_actor, v_org, v_date);
  insert into public.journal_entries (organization_id, number, entry_date, period_id, memo, amounts_are, status, source_type, source_id, source_ref,
    reverses_id, reversal_reason, created_by)
  values (v_org, public.next_document_number(v_org, 'journal'), v_date, v_period, left('Reversal of ' || v_row.number || ': ' || btrim(p_reason), 500),
    v_row.amounts_are, 'draft', v_row.source_type, v_row.source_id, v_row.source_ref, p_id, btrim(p_reason), p_actor)
  returning id into v_new;
  insert into public.journal_lines (journal_id, line_no, account_id, description, debit, credit, tax_code_id, tax_amount, entered_amount, is_tax_line, source_line_no)
  select v_new, line_no, account_id, description, credit, debit, tax_code_id, -tax_amount, entered_amount, is_tax_line, source_line_no
  from public.journal_lines where journal_id = p_id;
  update public.journal_entries set status = 'posted', posted_by = p_actor, posted_at = now() where id = v_new;
  update public.journal_entries set status = 'reversed', reversed_by_id = v_new where id = p_id;
  perform public.app_audit(p_actor, 'journal_reversed', 'journal', p_id::text, jsonb_build_object('status', 'posted'),
    jsonb_build_object('status', 'reversed', 'reversal', (select number from public.journal_entries where id = v_new), 'reason', btrim(p_reason)));
  return v_new;
end;
$$;

create or replace function public.journal_reverse(p_actor uuid, p_id uuid, p_date date, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text := (select replace(source_type, '_', ' ') from public.journal_entries where id = p_id);
begin
  perform public.app_require(p_actor, 'ledger.post');
  if v_source is distinct from 'manual' and v_source is not null then
    raise exception 'This journal was posted by a %. Void the % itself instead, so the two stay in step.', v_source, v_source using errcode = '22023';
  end if;
  return public.ledger_reverse_entry(p_actor, p_id, p_date, p_reason);
end;
$$;

------------------------------------------------------------------------------
-- 1. Customers and suppliers
------------------------------------------------------------------------------

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name text not null check (length(btrim(name)) between 2 and 160),
  trading_name text,
  abn text check (abn is null or public.app_valid_abn(abn)),
  contact_name text,
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text,
  billing_address jsonb not null default '{}'::jsonb,
  site_address jsonb not null default '{}'::jsonb,
  payment_terms_days integer check (payment_terms_days is null or payment_terms_days between 0 and 180),
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit >= 0),
  default_revenue_account_id uuid references public.accounts(id) on delete set null,
  default_tax_code_id uuid references public.tax_codes(id) on delete set null,
  po_required boolean not null default false,
  notes text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_org_name_idx on public.customers (organization_id, lower(name));

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name text not null check (length(btrim(name)) between 2 and 160),
  trading_name text,
  abn text check (abn is null or public.app_valid_abn(abn)),
  withholding_exempt boolean not null default false,
  gst_registered boolean not null default true,
  contact_name text,
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text,
  address jsonb not null default '{}'::jsonb,
  payment_terms_days integer check (payment_terms_days is null or payment_terms_days between 0 and 180),
  default_expense_account_id uuid references public.accounts(id) on delete set null,
  default_tax_code_id uuid references public.tax_codes(id) on delete set null,
  trade_type text,
  is_subcontractor boolean not null default false,
  tpar_reportable boolean not null default false,
  insurance_expiry date,
  licence_expiry date,
  bank_account_name text,
  bank_bsb text check (bank_bsb is null or bank_bsb ~ '^\d{6}$'),
  bank_account_number text check (bank_account_number is null or bank_account_number ~ '^\d{5,10}$'),
  bank_changed_at timestamptz,
  notes text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index suppliers_org_name_idx on public.suppliers (organization_id, lower(name));

------------------------------------------------------------------------------
-- 2. Document line calculation (shared by quotes, invoices, POs and bills)
------------------------------------------------------------------------------

-- Validates lines and works out each line's amount and GST with the same
-- per-line, half-up rounding as the posting engine, so a posted document
-- always balances. Lines: [{description, quantity, unit, unitPrice,
-- discountPercent, accountId, taxCodeId, kind}].
create or replace function public.doc_calc_lines(p_org uuid, p_lines jsonb, p_amounts_are text, p_side text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l jsonb;
  v_out jsonb := '[]'::jsonb;
  v_no int := 0;
  v_qty numeric; v_price numeric; v_disc numeric; v_amount numeric; v_gst numeric; v_rate numeric;
  v_acc record;
  v_tax uuid;
  v_sub numeric := 0; v_gst_total numeric := 0;
  v_kind text;
  v_applies text;
begin
  if p_amounts_are not in ('exclusive', 'inclusive', 'no_tax') then
    raise exception 'Choose how amounts are entered.' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 300 then
    raise exception 'A document can have at most 300 lines.' using errcode = '22023';
  end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    begin
      v_qty := coalesce(nullif(l->>'quantity', '')::numeric, 1);
      v_price := coalesce(nullif(l->>'unitPrice', '')::numeric, 0);
      v_disc := coalesce(nullif(l->>'discountPercent', '')::numeric, 0);
    exception when others then
      raise exception 'Line %: quantity, price and discount must be numbers.', v_no using errcode = '22023';
    end;
    if v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception 'Line %: quantity must be more than 0, with up to 3 decimals.', v_no using errcode = '22023';
    end if;
    if v_price < 0 or v_price <> round(v_price, 4) then
      raise exception 'Line %: unit price can''t be negative and has up to 4 decimals.', v_no using errcode = '22023';
    end if;
    if v_disc < 0 or v_disc > 100 then
      raise exception 'Line %: discount is between 0 and 100%%.', v_no using errcode = '22023';
    end if;
    if length(btrim(coalesce(l->>'description', ''))) = 0 then
      raise exception 'Line %: add a description.', v_no using errcode = '22023';
    end if;
    select * into v_acc from public.accounts where id = nullif(l->>'accountId', '')::uuid and organization_id = p_org;
    if v_acc.id is null then
      raise exception 'Line %: choose an account.', v_no using errcode = '22023';
    end if;
    if v_acc.status <> 'active' or not v_acc.allow_manual then
      raise exception 'Line %: account % can''t be used here.', v_no, v_acc.code using errcode = '22023';
    end if;
    if p_side = 'sales' and v_acc.type not in ('revenue', 'other_income', 'liability') then
      raise exception 'Line %: use an income account for sales (% is %).', v_no, v_acc.code, v_acc.type using errcode = '22023';
    end if;
    if p_side = 'purchases' and v_acc.type in ('revenue', 'other_income', 'equity') then
      raise exception 'Line %: use an expense, cost or asset account for purchases.', v_no using errcode = '22023';
    end if;
    v_tax := nullif(l->>'taxCodeId', '')::uuid;
    v_rate := 0;
    if v_tax is not null and p_amounts_are <> 'no_tax' then
      select rate, applies_to into v_rate, v_applies from public.tax_codes where id = v_tax and organization_id = p_org and active;
      if not found then
        raise exception 'Line %: unknown or inactive tax code.', v_no using errcode = '22023';
      end if;
      -- A purchase code on a sale (or the reverse) would land in the wrong BAS label.
      if v_applies not in ('both', p_side) then
        raise exception 'Line %: that tax code is for %, not %.', v_no, v_applies, p_side using errcode = '22023';
      end if;
    elsif p_amounts_are = 'no_tax' then
      v_tax := null;
    end if;
    v_kind := coalesce(nullif(l->>'kind', ''), 'other');
    if v_kind not in ('labour', 'materials', 'equipment', 'subcontract', 'travel', 'consumables', 'freight', 'other') then
      v_kind := 'other';
    end if;
    v_amount := round(v_qty * v_price * (1 - v_disc / 100), 2);
    v_gst := case when v_rate = 0 then 0 when p_amounts_are = 'inclusive' then round(v_amount * v_rate / (1 + v_rate), 2) else round(v_amount * v_rate, 2) end;
    v_sub := v_sub + case when p_amounts_are = 'inclusive' then v_amount - v_gst else v_amount end;
    v_gst_total := v_gst_total + v_gst;
    v_out := v_out || jsonb_build_object('line_no', v_no, 'description', left(btrim(l->>'description'), 500), 'quantity', v_qty,
      'unit', left(coalesce(l->>'unit', ''), 20), 'unit_price', v_price, 'discount_percent', v_disc, 'account_id', v_acc.id,
      'tax_code_id', v_tax, 'line_kind', v_kind, 'amount', v_amount, 'gst', v_gst, 'po_line_id', nullif(l->>'poLineId', ''));
  end loop;
  return jsonb_build_object('lines', v_out, 'subtotal', v_sub, 'gst', v_gst_total, 'total', v_sub + v_gst_total);
end;
$$;

------------------------------------------------------------------------------
-- 3. Tables: quotes, invoices, purchase orders, bills
------------------------------------------------------------------------------

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  number text not null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  quote_date date not null,
  expiry_date date,
  title text not null default '',
  scope text not null default '' check (length(scope) <= 5000),
  reference text,
  terms text not null default '',
  amounts_are text not null default 'exclusive' check (amounts_are in ('exclusive', 'inclusive', 'no_tax')),
  subtotal numeric(14,2) not null default 0, gst numeric(14,2) not null default 0, total numeric(14,2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent', 'accepted', 'declined', 'converted', 'cancelled')),
  approved_by uuid references public.training_profiles(id) on delete set null, approved_at timestamptz,
  sent_at timestamptz, decided_at timestamptz,
  converted_invoice_id uuid,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, number)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null default 'invoice' check (kind in ('invoice', 'credit_note')),
  number text,
  customer_id uuid not null references public.customers(id) on delete restrict,
  invoice_date date not null,
  due_date date not null,
  reference text,
  invoice_type text not null default 'standard' check (invoice_type in ('standard', 'progress', 'deposit', 'final', 'variation', 'materials', 'labour')),
  quote_id uuid references public.quotes(id) on delete set null,
  original_invoice_id uuid references public.invoices(id) on delete set null,
  amounts_are text not null default 'exclusive' check (amounts_are in ('exclusive', 'inclusive', 'no_tax')),
  subtotal numeric(14,2) not null default 0, gst numeric(14,2) not null default 0, total numeric(14,2) not null default 0 check (total >= 0),
  notes text not null default '',
  terms text not null default '',
  status text not null default 'draft' check (status in ('draft', 'approved', 'void')),
  journal_id uuid references public.journal_entries(id) on delete restrict,
  void_journal_id uuid references public.journal_entries(id) on delete restrict,
  void_reason text,
  approved_by uuid references public.training_profiles(id) on delete set null, approved_at timestamptz,
  sent_at timestamptz,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (status = 'draft' or number is not null)
);
create unique index invoices_number_idx on public.invoices (organization_id, kind, number) where number is not null;
create index invoices_customer_idx on public.invoices (customer_id, status);
alter table public.quotes add constraint quotes_converted_fk foreign key (converted_invoice_id) references public.invoices(id) on delete set null;

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  number text not null,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  order_date date not null,
  expected_date date,
  reference text,
  delivery_address text not null default '',
  notes text not null default '',
  amounts_are text not null default 'exclusive' check (amounts_are in ('exclusive', 'inclusive', 'no_tax')),
  subtotal numeric(14,2) not null default 0, gst numeric(14,2) not null default 0, total numeric(14,2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'issued', 'partially_received', 'completed', 'cancelled')),
  requested_by uuid references public.training_profiles(id) on delete set null,
  approved_by uuid references public.training_profiles(id) on delete set null, approved_at timestamptz,
  issued_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, number)
);

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null default 'bill' check (kind in ('bill', 'credit_note')),
  number text not null,
  supplier_reference text,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  bill_date date not null,
  due_date date not null,
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  amounts_are text not null default 'exclusive' check (amounts_are in ('exclusive', 'inclusive', 'no_tax')),
  subtotal numeric(14,2) not null default 0, gst numeric(14,2) not null default 0, total numeric(14,2) not null default 0 check (total >= 0),
  withholding numeric(14,2) not null default 0 check (withholding >= 0),
  notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'void')),
  journal_id uuid references public.journal_entries(id) on delete restrict,
  void_journal_id uuid references public.journal_entries(id) on delete restrict,
  void_reason text,
  approved_by uuid references public.training_profiles(id) on delete set null, approved_at timestamptz,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, number)
);
create index bills_supplier_idx on public.bills (supplier_id, status);

-- Line tables share one shape.
do $$
declare
  t text; parent text;
begin
  foreach t in array array['quote_lines:quotes', 'invoice_lines:invoices', 'purchase_order_lines:purchase_orders', 'bill_lines:bills'] loop
    parent := split_part(t, ':', 2);
    execute format($f$
      create table public.%I (
        id uuid primary key default gen_random_uuid(),
        document_id uuid not null references public.%I(id) on delete cascade,
        line_no integer not null check (line_no > 0),
        description text not null,
        quantity numeric(14,3) not null check (quantity > 0),
        unit text not null default '',
        unit_price numeric(14,4) not null check (unit_price >= 0),
        discount_percent numeric(5,2) not null default 0 check (discount_percent between 0 and 100),
        account_id uuid not null references public.accounts(id) on delete restrict,
        tax_code_id uuid references public.tax_codes(id) on delete restrict,
        line_kind text not null default 'other',
        amount numeric(14,2) not null,
        gst numeric(14,2) not null default 0,
        unique (document_id, line_no))$f$, split_part(t, ':', 1), parent);
  end loop;
end;
$$;
alter table public.purchase_order_lines add column received_quantity numeric(14,3) not null default 0 check (received_quantity >= 0);
alter table public.bill_lines add column po_line_id uuid references public.purchase_order_lines(id) on delete set null;

------------------------------------------------------------------------------
-- 4. Payments and allocations
------------------------------------------------------------------------------

create table public.customer_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  bank_account_id uuid not null references public.accounts(id) on delete restrict,
  reference text not null default '',
  method text not null default 'bank_transfer' check (method in ('bank_transfer', 'card', 'cheque', 'cash', 'other')),
  status text not null default 'posted' check (status in ('posted', 'void')),
  journal_id uuid references public.journal_entries(id) on delete restrict,
  void_journal_id uuid references public.journal_entries(id) on delete restrict,
  void_reason text,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  bank_account_id uuid not null references public.accounts(id) on delete restrict,
  reference text not null default '',
  method text not null default 'bank_transfer' check (method in ('bank_transfer', 'card', 'cheque', 'cash', 'other')),
  status text not null default 'posted' check (status in ('posted', 'void')),
  journal_id uuid references public.journal_entries(id) on delete restrict,
  void_journal_id uuid references public.journal_entries(id) on delete restrict,
  void_reason text,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.receivable_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  payment_id uuid references public.customer_payments(id) on delete restrict,
  credit_note_id uuid references public.invoices(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  allocation_date date not null,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  check ((payment_id is null) <> (credit_note_id is null))
);
create index receivable_allocations_invoice_idx on public.receivable_allocations (invoice_id) where voided_at is null;

create table public.payable_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  bill_id uuid not null references public.bills(id) on delete restrict,
  payment_id uuid references public.supplier_payments(id) on delete restrict,
  credit_note_id uuid references public.bills(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  allocation_date date not null,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  check ((payment_id is null) <> (credit_note_id is null))
);
create index payable_allocations_bill_idx on public.payable_allocations (bill_id) where voided_at is null;

-- Outstanding amounts. For an invoice: total minus live allocations against
-- it. For a credit note or payment: amount minus what it has been allocated to.
create or replace function public.invoice_outstanding(p_id uuid, p_as_at date default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select i.total - case when i.kind = 'invoice'
      then coalesce((select sum(a.amount) from public.receivable_allocations a where a.invoice_id = i.id and a.voided_at is null and (p_as_at is null or a.allocation_date <= p_as_at)), 0)
      else coalesce((select sum(a.amount) from public.receivable_allocations a where a.credit_note_id = i.id and a.voided_at is null and (p_as_at is null or a.allocation_date <= p_as_at)), 0) end
  from public.invoices i where i.id = p_id;
$$;

create or replace function public.bill_outstanding(p_id uuid, p_as_at date default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select b.total - b.withholding - case when b.kind = 'bill'
      then coalesce((select sum(a.amount) from public.payable_allocations a where a.bill_id = b.id and a.voided_at is null and (p_as_at is null or a.allocation_date <= p_as_at)), 0)
      else coalesce((select sum(a.amount) from public.payable_allocations a where a.credit_note_id = b.id and a.voided_at is null and (p_as_at is null or a.allocation_date <= p_as_at)), 0) end
  from public.bills b where b.id = p_id;
$$;

-- Balances of every approved document in one pass (for lists in the app).
create or replace function public.invoice_balances(p_org uuid)
returns table (id uuid, owing numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.total - coalesce(sum(a.amount), 0)
  from public.invoices i
  left join public.receivable_allocations a on a.voided_at is null and ((i.kind = 'invoice' and a.invoice_id = i.id) or (i.kind = 'credit_note' and a.credit_note_id = i.id))
  where i.organization_id = p_org and i.status = 'approved'
  group by i.id, i.total;
$$;

create or replace function public.bill_balances(p_org uuid)
returns table (id uuid, owing numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.total - b.withholding - coalesce(sum(a.amount), 0)
  from public.bills b
  left join public.payable_allocations a on a.voided_at is null and ((b.kind = 'bill' and a.bill_id = b.id) or (b.kind = 'credit_note' and a.credit_note_id = b.id))
  where b.organization_id = p_org and b.status = 'approved'
  group by b.id, b.total, b.withholding;
$$;

create or replace function public.customer_payment_unallocated(p_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select p.amount - coalesce((select sum(amount) from public.receivable_allocations where payment_id = p.id and voided_at is null), 0)
  from public.customer_payments p where p.id = p_id;
$$;

create or replace function public.supplier_payment_unallocated(p_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select p.amount - coalesce((select sum(amount) from public.payable_allocations where payment_id = p.id and voided_at is null), 0)
  from public.supplier_payments p where p.id = p_id;
$$;

------------------------------------------------------------------------------
-- 5. Customers and suppliers: maintenance
------------------------------------------------------------------------------

create or replace function public.customer_save(p_actor uuid, p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid := p_id;
  v_old jsonb;
begin
  perform public.app_require(p_actor, 'sales.manage');
  if nullif(p->>'abn', '') is not null and not public.app_valid_abn(p->>'abn') then
    raise exception 'That ABN isn''t valid. Check the 11 digits.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.customers (organization_id, name, created_by) values (v_org, btrim(p->>'name'), p_actor) returning id into v_id;
  else
    select to_jsonb(c) into v_old from public.customers c where id = p_id and organization_id = v_org for update;
    if v_old is null then
      raise exception 'Customer not found.' using errcode = 'P0002';
    end if;
  end if;
  update public.customers set
    name = btrim(p->>'name'), trading_name = nullif(btrim(coalesce(p->>'trading_name', '')), ''),
    abn = nullif(regexp_replace(coalesce(p->>'abn', ''), '\s', '', 'g'), ''),
    contact_name = nullif(btrim(coalesce(p->>'contact_name', '')), ''), email = nullif(lower(btrim(coalesce(p->>'email', ''))), ''),
    phone = nullif(btrim(coalesce(p->>'phone', '')), ''),
    billing_address = coalesce(p->'billing_address', '{}'::jsonb), site_address = coalesce(p->'site_address', '{}'::jsonb),
    payment_terms_days = nullif(p->>'payment_terms_days', '')::int, credit_limit = nullif(p->>'credit_limit', '')::numeric,
    default_revenue_account_id = nullif(p->>'default_revenue_account_id', '')::uuid, default_tax_code_id = nullif(p->>'default_tax_code_id', '')::uuid,
    po_required = coalesce((p->>'po_required')::boolean, false), notes = left(coalesce(p->>'notes', ''), 2000),
    status = coalesce(nullif(p->>'status', ''), 'active'), updated_at = now()
  where id = v_id;
  perform public.app_audit(p_actor, case when p_id is null then 'customer_created' else 'customer_updated' end, 'customer', v_id::text,
    v_old, (select to_jsonb(c) - 'created_at' - 'updated_at' from public.customers c where id = v_id));
  return v_id;
end;
$$;

-- Supplier details. Bank details are NOT set here: see supplier_bank_request.
create or replace function public.supplier_save(p_actor uuid, p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid := p_id;
  v_old jsonb;
begin
  perform public.app_require(p_actor, 'purchases.manage');
  if nullif(p->>'abn', '') is not null and not public.app_valid_abn(p->>'abn') then
    raise exception 'That ABN isn''t valid. Check the 11 digits.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.suppliers (organization_id, name, created_by) values (v_org, btrim(p->>'name'), p_actor) returning id into v_id;
  else
    select to_jsonb(s) into v_old from public.suppliers s where id = p_id and organization_id = v_org for update;
    if v_old is null then
      raise exception 'Supplier not found.' using errcode = 'P0002';
    end if;
  end if;
  update public.suppliers set
    name = btrim(p->>'name'), trading_name = nullif(btrim(coalesce(p->>'trading_name', '')), ''),
    abn = nullif(regexp_replace(coalesce(p->>'abn', ''), '\s', '', 'g'), ''),
    withholding_exempt = coalesce((p->>'withholding_exempt')::boolean, false), gst_registered = coalesce((p->>'gst_registered')::boolean, true),
    contact_name = nullif(btrim(coalesce(p->>'contact_name', '')), ''), email = nullif(lower(btrim(coalesce(p->>'email', ''))), ''),
    phone = nullif(btrim(coalesce(p->>'phone', '')), ''), address = coalesce(p->'address', '{}'::jsonb),
    payment_terms_days = nullif(p->>'payment_terms_days', '')::int,
    default_expense_account_id = nullif(p->>'default_expense_account_id', '')::uuid, default_tax_code_id = nullif(p->>'default_tax_code_id', '')::uuid,
    trade_type = nullif(btrim(coalesce(p->>'trade_type', '')), ''), is_subcontractor = coalesce((p->>'is_subcontractor')::boolean, false),
    tpar_reportable = coalesce((p->>'tpar_reportable')::boolean, false),
    insurance_expiry = nullif(p->>'insurance_expiry', '')::date, licence_expiry = nullif(p->>'licence_expiry', '')::date,
    notes = left(coalesce(p->>'notes', ''), 2000), status = coalesce(nullif(p->>'status', ''), 'active'), updated_at = now()
  where id = v_id;
  perform public.app_audit(p_actor, case when p_id is null then 'supplier_created' else 'supplier_updated' end, 'supplier', v_id::text,
    v_old - 'bank_account_number', (select to_jsonb(s) - 'created_at' - 'updated_at' - 'bank_account_number' from public.suppliers s where id = v_id));
  return v_id;
end;
$$;

-- Supplier bank details change only after a second person approves.
create or replace function public.supplier_bank_request(p_actor uuid, p_supplier uuid, p_name text, p_bsb text, p_account text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_bsb text := regexp_replace(coalesce(p_bsb, ''), '[\s-]', '', 'g');
  v_acct text := regexp_replace(coalesce(p_account, ''), '[\s-]', '', 'g');
begin
  perform public.app_require(p_actor, 'purchases.manage');
  select * into v from public.suppliers where id = p_supplier and organization_id = public.app_org_of(p_actor);
  if not found then
    raise exception 'Supplier not found.' using errcode = 'P0002';
  end if;
  if v_bsb !~ '^\d{6}$' then
    raise exception 'A BSB is 6 digits, like 062-000.' using errcode = '22023';
  end if;
  if v_acct !~ '^\d{5,10}$' then
    raise exception 'An account number is 5 to 10 digits.' using errcode = '22023';
  end if;
  if exists (select 1 from public.approvals where kind = 'supplier_bank' and entity_id = p_supplier and status = 'pending') then
    raise exception 'A bank change for this supplier is already waiting for approval.' using errcode = '22023';
  end if;
  return public.approval_request(p_actor, 'supplier_bank', 'supplier', p_supplier,
    'Bank details for supplier ' || v.name, 'purchases.bank',
    jsonb_build_object('accountName', v.bank_account_name, 'bsb', v.bank_bsb, 'accountNumber', v.bank_account_number),
    jsonb_build_object('accountName', btrim(coalesce(p_name, '')), 'bsb', v_bsb, 'accountNumber', v_acct));
end;
$$;

create or replace function public.approval_decide(p_actor uuid, p_approval uuid, p_approve boolean, p_comment text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public.approvals where id = p_approval for update;
  if not found or v.organization_id <> public.app_org_of(p_actor) then
    raise exception 'Approval not found.' using errcode = 'P0002';
  end if;
  if v.status <> 'pending' then
    raise exception 'This has already been decided.' using errcode = '22023';
  end if;
  if v.requested_by = p_actor then
    raise exception 'Someone else must approve a change you requested.' using errcode = '42501';
  end if;
  perform public.app_require(p_actor, v.required_permission);
  if not p_approve and length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'Give a reason for rejecting it.' using errcode = '22023';
  end if;

  update public.approvals
  set status = case when p_approve then 'approved' else 'rejected' end, decided_by = p_actor, decided_at = now(), comment = nullif(btrim(coalesce(p_comment, '')), '')
  where id = p_approval;

  if v.kind = 'company_bank_account' then
    if p_approve then
      if (select show_on_invoices from public.company_bank_accounts where id = v.entity_id) then
        update public.company_bank_accounts set show_on_invoices = false
        where organization_id = v.organization_id and status = 'active' and show_on_invoices;
      end if;
      update public.company_bank_accounts set status = 'active', activated_at = now() where id = v.entity_id and status = 'pending';
    else
      update public.company_bank_accounts set status = 'rejected' where id = v.entity_id and status = 'pending';
    end if;
  elsif v.kind = 'supplier_bank' and p_approve then
    update public.suppliers set bank_account_name = nullif(v.new_value->>'accountName', ''), bank_bsb = v.new_value->>'bsb',
      bank_account_number = v.new_value->>'accountNumber', bank_changed_at = now(), updated_at = now()
    where id = v.entity_id;
  end if;

  insert into public.notifications (organization_id, profile_id, kind, title, body, link)
  values (v.organization_id, v.requested_by, case when p_approve then 'approval_approved' else 'approval_rejected' end,
          case when p_approve then 'Approved: ' else 'Rejected: ' end || v.title, coalesce(btrim(p_comment), ''), 'approvals');
  perform public.app_audit(p_actor, case when p_approve then 'approval_approved' else 'approval_rejected' end, 'approval', p_approval::text,
    v.previous_value, v.new_value, jsonb_build_object('kind', v.kind, 'title', v.title, 'comment', p_comment), v.requested_by);
  return jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end);
end;
$$;

------------------------------------------------------------------------------
-- 6. Quotes
------------------------------------------------------------------------------

create or replace function public.doc_insert_lines(p_table text, p_doc uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  execute format('delete from public.%I where document_id = $1', p_table) using p_doc;
  execute format($f$insert into public.%I (document_id, line_no, description, quantity, unit, unit_price, discount_percent, account_id, tax_code_id, line_kind, amount, gst)
    select $1, (x->>'line_no')::int, x->>'description', (x->>'quantity')::numeric, x->>'unit', (x->>'unit_price')::numeric, (x->>'discount_percent')::numeric,
      (x->>'account_id')::uuid, nullif(x->>'tax_code_id', '')::uuid, x->>'line_kind', (x->>'amount')::numeric, (x->>'gst')::numeric
    from jsonb_array_elements($2) x$f$, p_table) using p_doc, p_lines;
end;
$$;

create or replace function public.quote_save(p_actor uuid, p_id uuid, p jsonb, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_calc jsonb;
  v_id uuid := p_id;
  v_status text;
begin
  perform public.app_require(p_actor, 'sales.manage');
  if not exists (select 1 from public.customers where id = (p->>'customer_id')::uuid and organization_id = v_org and status = 'active') then
    raise exception 'Choose an active customer.' using errcode = '22023';
  end if;
  v_calc := public.doc_calc_lines(v_org, p_lines, coalesce(p->>'amounts_are', 'exclusive'), 'sales');
  if v_id is null then
    insert into public.quotes (organization_id, number, customer_id, quote_date, created_by)
    values (v_org, public.next_document_number(v_org, 'quote'), (p->>'customer_id')::uuid, (p->>'quote_date')::date, p_actor) returning id into v_id;
  else
    select status into v_status from public.quotes where id = p_id and organization_id = v_org for update;
    if v_status is null then raise exception 'Quote not found.' using errcode = 'P0002'; end if;
    if v_status <> 'draft' then raise exception 'Only a draft quote can be edited.' using errcode = '22023'; end if;
  end if;
  update public.quotes set customer_id = (p->>'customer_id')::uuid, quote_date = (p->>'quote_date')::date, expiry_date = nullif(p->>'expiry_date', '')::date,
    title = left(coalesce(p->>'title', ''), 200), scope = left(coalesce(p->>'scope', ''), 5000), reference = nullif(p->>'reference', ''),
    terms = left(coalesce(p->>'terms', ''), 3000), amounts_are = coalesce(p->>'amounts_are', 'exclusive'),
    subtotal = (v_calc->>'subtotal')::numeric, gst = (v_calc->>'gst')::numeric, total = (v_calc->>'total')::numeric, updated_at = now()
  where id = v_id;
  perform public.doc_insert_lines('quote_lines', v_id, v_calc->'lines');
  perform public.app_audit(p_actor, case when p_id is null then 'quote_created' else 'quote_saved' end, 'quote', v_id::text, null,
    jsonb_build_object('total', (v_calc->>'total')::numeric));
  return v_id;
end;
$$;

create or replace function public.quote_set_status(p_actor uuid, p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'sales.manage');
  select * into v from public.quotes where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Quote not found.' using errcode = 'P0002'; end if;
  if not ((v.status = 'draft' and p_status in ('approved', 'cancelled'))
       or (v.status = 'approved' and p_status in ('sent', 'accepted', 'declined', 'cancelled', 'draft'))
       or (v.status = 'sent' and p_status in ('accepted', 'declined', 'cancelled'))
       or (v.status in ('accepted', 'declined') and p_status = 'sent')) then
    raise exception 'A % quote can''t become %.', v.status, p_status using errcode = '22023';
  end if;
  update public.quotes set status = p_status,
    approved_by = case when p_status = 'approved' then p_actor when p_status = 'draft' then null else approved_by end,
    approved_at = case when p_status = 'approved' then now() when p_status = 'draft' then null else approved_at end,
    sent_at = case when p_status = 'sent' then now() else sent_at end,
    decided_at = case when p_status in ('accepted', 'declined') then now() else decided_at end, updated_at = now()
  where id = p_id;
  perform public.app_audit(p_actor, 'quote_status_changed', 'quote', p_id::text, jsonb_build_object('status', v.status), jsonb_build_object('status', p_status));
end;
$$;

------------------------------------------------------------------------------
-- 7. Invoices and credit notes
------------------------------------------------------------------------------

create or replace function public.invoice_save(p_actor uuid, p_id uuid, p jsonb, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_calc jsonb;
  v_id uuid := p_id;
  v_status text;
  v_cust record;
  v_terms int;
begin
  perform public.app_require(p_actor, 'sales.manage');
  select * into v_cust from public.customers where id = (p->>'customer_id')::uuid and organization_id = v_org and status = 'active';
  if not found then
    raise exception 'Choose an active customer.' using errcode = '22023';
  end if;
  v_calc := public.doc_calc_lines(v_org, p_lines, coalesce(p->>'amounts_are', 'exclusive'), 'sales');
  v_terms := coalesce(v_cust.payment_terms_days, (select payment_terms_days from public.company_settings where organization_id = v_org), 30);
  if v_id is null then
    insert into public.invoices (organization_id, kind, customer_id, invoice_date, due_date, created_by)
    values (v_org, coalesce(nullif(p->>'kind', ''), 'invoice'), v_cust.id, (p->>'invoice_date')::date, (p->>'invoice_date')::date, p_actor) returning id into v_id;
  else
    select status into v_status from public.invoices where id = p_id and organization_id = v_org for update;
    if v_status is null then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
    if v_status <> 'draft' then raise exception 'Only a draft can be edited. Void it or issue a credit note instead.' using errcode = '22023'; end if;
  end if;
  update public.invoices set customer_id = v_cust.id, invoice_date = (p->>'invoice_date')::date,
    due_date = coalesce(nullif(p->>'due_date', '')::date, (p->>'invoice_date')::date + v_terms),
    reference = nullif(btrim(coalesce(p->>'reference', '')), ''), invoice_type = coalesce(nullif(p->>'invoice_type', ''), 'standard'),
    quote_id = nullif(p->>'quote_id', '')::uuid, original_invoice_id = nullif(p->>'original_invoice_id', '')::uuid,
    amounts_are = coalesce(p->>'amounts_are', 'exclusive'), notes = left(coalesce(p->>'notes', ''), 3000), terms = left(coalesce(p->>'terms', ''), 3000),
    subtotal = (v_calc->>'subtotal')::numeric, gst = (v_calc->>'gst')::numeric, total = (v_calc->>'total')::numeric, updated_at = now()
  where id = v_id;
  perform public.doc_insert_lines('invoice_lines', v_id, v_calc->'lines');
  perform public.app_audit(p_actor, case when p_id is null then 'invoice_created' else 'invoice_saved' end, 'invoice', v_id::text, null,
    jsonb_build_object('total', (v_calc->>'total')::numeric, 'kind', coalesce(nullif(p->>'kind', ''), 'invoice')));
  return v_id;
end;
$$;

-- Approves and posts: Dr Accounts Receivable, Cr income and GST (credit notes
-- the other way). The invoice is then fixed; corrections are a void or a credit note.
create or replace function public.invoice_approve(p_actor uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v record;
  v_ar uuid;
  v_lines jsonb;
  v_number text;
  v_journal uuid;
  v_credit boolean;
begin
  perform public.app_require(p_actor, 'sales.manage');
  select * into v from public.invoices where id = p_id and organization_id = v_org for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'This has already been approved.' using errcode = '22023'; end if;
  if v.total <= 0 then raise exception 'The total must be more than zero.' using errcode = '22023'; end if;
  if (select abn from public.company_settings where organization_id = v_org) is null then
    raise exception 'Add Panalo''s ABN in Company settings first: a tax invoice must show it.' using errcode = '22023';
  end if;
  if (select po_required from public.customers where id = v.customer_id) and v.kind = 'invoice' and v.reference is null then
    raise exception 'This customer needs their purchase order number on every invoice.' using errcode = '22023';
  end if;
  select id into v_ar from public.accounts where organization_id = v_org and subtype = 'receivable' and status = 'active' order by code limit 1;
  v_credit := v.kind = 'credit_note';
  v_number := public.next_document_number(v_org, case when v_credit then 'credit_note' else 'invoice' end);
  select jsonb_agg(jsonb_build_object('accountId', account_id, 'description', left(description, 300),
           'debit', case when v_credit then amount else 0 end, 'credit', case when v_credit then 0 else amount end, 'taxCodeId', tax_code_id) order by line_no)
    into v_lines from public.invoice_lines where document_id = p_id;
  v_lines := v_lines || jsonb_build_object('accountId', v_ar, 'description', (select name from public.customers where id = v.customer_id),
    'debit', case when v_credit then 0 else v.total end, 'credit', case when v_credit then v.total else 0 end, 'taxCodeId', null);
  v_journal := public.ledger_post_entry(p_actor, v.invoice_date, (case when v_credit then 'Credit note ' else 'Invoice ' end) || v_number,
    case when v_credit then 'credit_note' else 'invoice' end, p_id, v_number, v_lines, v.amounts_are, false);
  update public.invoices set status = 'approved', number = v_number, journal_id = v_journal, approved_by = p_actor, approved_at = now(), updated_at = now()
  where id = p_id;
  if v.quote_id is not null then
    update public.quotes set status = 'converted', converted_invoice_id = p_id, updated_at = now() where id = v.quote_id and status <> 'converted';
  end if;
  perform public.app_audit(p_actor, 'invoice_approved', 'invoice', p_id::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'approved', 'number', v_number, 'total', v.total, 'kind', v.kind));
  return v_number;
end;
$$;

create or replace function public.invoice_void(p_actor uuid, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_rev uuid;
begin
  perform public.app_require(p_actor, 'sales.manage');
  select * into v from public.invoices where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if v.status = 'draft' then
    delete from public.invoices where id = p_id;
    perform public.app_audit(p_actor, 'invoice_draft_deleted', 'invoice', p_id::text, jsonb_build_object('total', v.total), null);
    return;
  end if;
  if v.status <> 'approved' then raise exception 'This is already void.' using errcode = '22023'; end if;
  if exists (select 1 from public.receivable_allocations where (invoice_id = p_id or credit_note_id = p_id) and voided_at is null) then
    raise exception 'Payments or credits are applied to it. Remove those first.' using errcode = '22023';
  end if;
  v_rev := public.ledger_reverse_entry(p_actor, v.journal_id, null, coalesce(nullif(btrim(p_reason), ''), 'Voided'));
  update public.invoices set status = 'void', void_journal_id = v_rev, void_reason = btrim(p_reason), updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'invoice_voided', 'invoice', p_id::text, jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'void', 'reason', btrim(p_reason), 'number', v.number));
end;
$$;

create or replace function public.invoice_mark_sent(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'sales.manage');
  update public.invoices set sent_at = coalesce(sent_at, now()), updated_at = now()
  where id = p_id and organization_id = public.app_org_of(p_actor) and status = 'approved';
  if not found then raise exception 'Only an approved invoice can be marked as sent.' using errcode = '22023'; end if;
  perform public.app_audit(p_actor, 'invoice_sent', 'invoice', p_id::text, null, null);
end;
$$;

-- Applies an approved credit note to an approved invoice of the same customer.
create or replace function public.credit_note_apply(p_actor uuid, p_credit uuid, p_invoice uuid, p_amount numeric, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record; i record;
begin
  perform public.app_require(p_actor, 'sales.manage');
  select * into c from public.invoices where id = p_credit and organization_id = public.app_org_of(p_actor) and kind = 'credit_note' for update;
  select * into i from public.invoices where id = p_invoice and organization_id = public.app_org_of(p_actor) and kind = 'invoice' for update;
  if c.id is null or i.id is null or c.status <> 'approved' or i.status <> 'approved' or c.customer_id <> i.customer_id then
    raise exception 'Choose an approved credit note and invoice for the same customer.' using errcode = '22023';
  end if;
  if p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > public.invoice_outstanding(p_credit) or p_amount > public.invoice_outstanding(p_invoice) then
    raise exception 'The amount can''t exceed what is left on the credit note or the invoice.' using errcode = '22023';
  end if;
  insert into public.receivable_allocations (organization_id, invoice_id, credit_note_id, amount, allocation_date, created_by)
  values (c.organization_id, p_invoice, p_credit, p_amount, coalesce(p_date, greatest(c.invoice_date, i.invoice_date)), p_actor);
  perform public.app_audit(p_actor, 'credit_note_applied', 'invoice', p_invoice::text, null, jsonb_build_object('creditNote', c.number, 'amount', p_amount));
end;
$$;

------------------------------------------------------------------------------
-- 8. Customer payments (receipts)
------------------------------------------------------------------------------

create or replace function public.customer_payment_record(p_actor uuid, p_customer uuid, p_date date, p_amount numeric, p_bank uuid,
  p_reference text, p_method text, p_allocations jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_cust record;
  v_bank record;
  v_ar uuid;
  v_id uuid;
  v_journal uuid;
  a jsonb;
  v_inv record;
  v_total numeric := 0;
  v_amt numeric;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v_cust from public.customers where id = p_customer and organization_id = v_org;
  if not found then raise exception 'Customer not found.' using errcode = 'P0002'; end if;
  select * into v_bank from public.accounts where id = p_bank and organization_id = v_org and subtype = 'bank' and status = 'active';
  if not found then raise exception 'Choose the bank account the money went into.' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter the amount received.' using errcode = '22023';
  end if;
  select id into v_ar from public.accounts where organization_id = v_org and subtype = 'receivable' and status = 'active' order by code limit 1;
  insert into public.customer_payments (organization_id, customer_id, payment_date, amount, bank_account_id, reference, method, created_by)
  values (v_org, p_customer, p_date, p_amount, p_bank, left(coalesce(p_reference, ''), 120), coalesce(p_method, 'bank_transfer'), p_actor)
  returning id into v_id;
  for a in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    v_amt := (a->>'amount')::numeric;
    if v_amt is null or v_amt = 0 then continue; end if;
    select * into v_inv from public.invoices where id = (a->>'invoiceId')::uuid and organization_id = v_org and kind = 'invoice' for update;
    if v_inv.id is null or v_inv.status <> 'approved' or v_inv.customer_id <> p_customer then
      raise exception 'Payments can only be applied to this customer''s approved invoices.' using errcode = '22023';
    end if;
    if v_amt < 0 or v_amt <> round(v_amt, 2) or v_amt > public.invoice_outstanding(v_inv.id) then
      raise exception 'Invoice %: the amount applied is more than what is owing.', v_inv.number using errcode = '22023';
    end if;
    v_total := v_total + v_amt;
    insert into public.receivable_allocations (organization_id, invoice_id, payment_id, amount, allocation_date, created_by)
    values (v_org, v_inv.id, v_id, v_amt, p_date, p_actor);
  end loop;
  if v_total > p_amount then
    raise exception 'You applied % but only % was received.', v_total, p_amount using errcode = '22023';
  end if;
  v_journal := public.ledger_post_entry(p_actor, p_date, 'Receipt from ' || v_cust.name || coalesce(' · ' || nullif(btrim(p_reference), ''), ''),
    'customer_payment', v_id, nullif(btrim(coalesce(p_reference, '')), ''),
    jsonb_build_array(
      jsonb_build_object('accountId', p_bank, 'debit', p_amount, 'credit', 0, 'description', 'Receipt: ' || v_cust.name),
      jsonb_build_object('accountId', v_ar, 'debit', 0, 'credit', p_amount, 'description', v_cust.name)), 'no_tax', false);
  update public.customer_payments set journal_id = v_journal where id = v_id;
  perform public.app_audit(p_actor, 'customer_payment_recorded', 'customer_payment', v_id::text, null,
    jsonb_build_object('customer', v_cust.name, 'amount', p_amount, 'applied', v_total));
  return v_id;
end;
$$;

-- Applies an existing receipt's unallocated money to invoices.
create or replace function public.customer_payment_allocate(p_actor uuid, p_payment uuid, p_invoice uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record; i record;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into p from public.customer_payments where id = p_payment and organization_id = public.app_org_of(p_actor) for update;
  select * into i from public.invoices where id = p_invoice and organization_id = public.app_org_of(p_actor) and kind = 'invoice' for update;
  if p.id is null or i.id is null or p.status <> 'posted' or i.status <> 'approved' or p.customer_id <> i.customer_id then
    raise exception 'Choose a receipt and an approved invoice for the same customer.' using errcode = '22023';
  end if;
  if p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > public.customer_payment_unallocated(p_payment) or p_amount > public.invoice_outstanding(p_invoice) then
    raise exception 'The amount can''t exceed what is left on the receipt or the invoice.' using errcode = '22023';
  end if;
  insert into public.receivable_allocations (organization_id, invoice_id, payment_id, amount, allocation_date, created_by)
  values (p.organization_id, p_invoice, p_payment, p_amount, greatest(p.payment_date, i.invoice_date), p_actor);
  perform public.app_audit(p_actor, 'customer_payment_allocated', 'invoice', p_invoice::text, null, jsonb_build_object('payment', p_payment, 'amount', p_amount));
end;
$$;

create or replace function public.customer_payment_void(p_actor uuid, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record; v_rev uuid;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.customer_payments where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Receipt not found.' using errcode = 'P0002'; end if;
  if v.status <> 'posted' then raise exception 'This receipt is already void.' using errcode = '22023'; end if;
  v_rev := public.ledger_reverse_entry(p_actor, v.journal_id, null, coalesce(nullif(btrim(p_reason), ''), 'Receipt voided'));
  update public.receivable_allocations set voided_at = now() where payment_id = p_id and voided_at is null;
  update public.customer_payments set status = 'void', void_journal_id = v_rev, void_reason = btrim(p_reason) where id = p_id;
  perform public.app_audit(p_actor, 'customer_payment_voided', 'customer_payment', p_id::text, jsonb_build_object('amount', v.amount), jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

------------------------------------------------------------------------------
-- 9. Purchase orders
------------------------------------------------------------------------------

create or replace function public.po_save(p_actor uuid, p_id uuid, p jsonb, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_calc jsonb;
  v_id uuid := p_id;
  v_row record;
begin
  if not (public.app_has(p_actor, 'purchases.raise') or public.app_has(p_actor, 'purchases.manage')) then
    perform public.app_require(p_actor, 'purchases.raise');
  end if;
  if not exists (select 1 from public.suppliers where id = (p->>'supplier_id')::uuid and organization_id = v_org and status = 'active') then
    raise exception 'Choose an active supplier.' using errcode = '22023';
  end if;
  v_calc := public.doc_calc_lines(v_org, p_lines, coalesce(p->>'amounts_are', 'exclusive'), 'purchases');
  if v_id is null then
    insert into public.purchase_orders (organization_id, number, supplier_id, order_date, requested_by)
    values (v_org, public.next_document_number(v_org, 'purchase_order'), (p->>'supplier_id')::uuid, (p->>'order_date')::date, p_actor) returning id into v_id;
  else
    select * into v_row from public.purchase_orders where id = p_id and organization_id = v_org for update;
    if not found then raise exception 'Purchase order not found.' using errcode = 'P0002'; end if;
    if v_row.status <> 'draft' then raise exception 'Only a draft purchase order can be edited.' using errcode = '22023'; end if;
  end if;
  update public.purchase_orders set supplier_id = (p->>'supplier_id')::uuid, order_date = (p->>'order_date')::date, expected_date = nullif(p->>'expected_date', '')::date,
    reference = nullif(btrim(coalesce(p->>'reference', '')), ''), delivery_address = left(coalesce(p->>'delivery_address', ''), 500),
    notes = left(coalesce(p->>'notes', ''), 3000), amounts_are = coalesce(p->>'amounts_are', 'exclusive'),
    subtotal = (v_calc->>'subtotal')::numeric, gst = (v_calc->>'gst')::numeric, total = (v_calc->>'total')::numeric, updated_at = now()
  where id = v_id;
  perform public.doc_insert_lines('purchase_order_lines', v_id, v_calc->'lines');
  perform public.app_audit(p_actor, case when p_id is null then 'purchase_order_created' else 'purchase_order_saved' end, 'purchase_order', v_id::text, null,
    jsonb_build_object('total', (v_calc->>'total')::numeric));
  return v_id;
end;
$$;

-- submit (raiser), approve / back to draft / cancel (purchases.manage; never
-- your own unless you hold purchases.manage yourself), issue (sent to supplier).
create or replace function public.po_set_status(p_actor uuid, p_id uuid, p_status text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public.purchase_orders where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Purchase order not found.' using errcode = 'P0002'; end if;
  if p_status = 'submitted' then
    if v.status <> 'draft' then raise exception 'Only a draft can be submitted.' using errcode = '22023'; end if;
    if not (public.app_has(p_actor, 'purchases.raise') or public.app_has(p_actor, 'purchases.manage')) then
      perform public.app_require(p_actor, 'purchases.raise');
    end if;
  elsif p_status in ('approved', 'draft') then
    perform public.app_require(p_actor, 'purchases.manage');
    if v.status <> 'submitted' then raise exception 'Only a submitted purchase order can be approved or sent back.' using errcode = '22023'; end if;
  elsif p_status = 'issued' then
    perform public.app_require(p_actor, 'purchases.manage');
    if v.status <> 'approved' then raise exception 'Approve the purchase order before issuing it.' using errcode = '22023'; end if;
  elsif p_status = 'cancelled' then
    perform public.app_require(p_actor, 'purchases.manage');
    if v.status in ('completed', 'cancelled') then raise exception 'This purchase order is already closed.' using errcode = '22023'; end if;
    if exists (select 1 from public.bills where purchase_order_id = p_id and status <> 'void') then
      raise exception 'Bills are matched to this purchase order.' using errcode = '22023';
    end if;
  elsif p_status = 'completed' then
    perform public.app_require(p_actor, 'purchases.manage');
    if v.status not in ('issued', 'partially_received') then raise exception 'Only an issued purchase order can be closed.' using errcode = '22023'; end if;
  else
    raise exception 'Unknown purchase order status.' using errcode = '22023';
  end if;
  update public.purchase_orders set status = p_status,
    approved_by = case when p_status = 'approved' then p_actor else approved_by end,
    approved_at = case when p_status = 'approved' then now() else approved_at end,
    issued_at = case when p_status = 'issued' then now() else issued_at end, updated_at = now()
  where id = p_id;
  perform public.app_audit(p_actor, 'purchase_order_status_changed', 'purchase_order', p_id::text, jsonb_build_object('status', v.status),
    jsonb_build_object('status', p_status, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
end;
$$;

-- Records goods received: [{lineId, quantity}]. Moves the PO to partially
-- received or completed. (Three-way matching: PO, receipt, bill.)
create or replace function public.po_receive(p_actor uuid, p_id uuid, p_lines jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record; l jsonb; v_line record; v_qty numeric; v_status text;
begin
  if not (public.app_has(p_actor, 'purchases.raise') or public.app_has(p_actor, 'purchases.manage')) then
    perform public.app_require(p_actor, 'purchases.raise');
  end if;
  select * into v from public.purchase_orders where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Purchase order not found.' using errcode = 'P0002'; end if;
  if v.status not in ('issued', 'partially_received') then raise exception 'Goods can be received only on an issued purchase order.' using errcode = '22023'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_qty := coalesce(nullif(l->>'quantity', '')::numeric, 0);
    if v_qty = 0 then continue; end if;
    select * into v_line from public.purchase_order_lines where id = (l->>'lineId')::uuid and document_id = p_id for update;
    if not found then raise exception 'Unknown purchase order line.' using errcode = '22023'; end if;
    if v_qty < 0 or v_line.received_quantity + v_qty > v_line.quantity then
      raise exception 'Line %: can''t receive more than ordered (% of %).', v_line.line_no, v_line.received_quantity + v_qty, v_line.quantity using errcode = '22023';
    end if;
    update public.purchase_order_lines set received_quantity = received_quantity + v_qty where id = v_line.id;
  end loop;
  v_status := case when not exists (select 1 from public.purchase_order_lines where document_id = p_id and received_quantity < quantity) then 'completed'
                   when exists (select 1 from public.purchase_order_lines where document_id = p_id and received_quantity > 0) then 'partially_received'
                   else v.status end;
  update public.purchase_orders set status = v_status, updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'goods_received', 'purchase_order', p_id::text, jsonb_build_object('status', v.status), jsonb_build_object('status', v_status, 'lines', p_lines));
  return v_status;
end;
$$;

------------------------------------------------------------------------------
-- 10. Bills and supplier credit notes
------------------------------------------------------------------------------

create or replace function public.bill_save(p_actor uuid, p_id uuid, p jsonb, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_calc jsonb;
  v_id uuid := p_id;
  v_status text;
  v_sup record;
  v_terms int;
  v_po uuid := nullif(p->>'purchase_order_id', '')::uuid;
begin
  perform public.app_require(p_actor, 'purchases.manage');
  select * into v_sup from public.suppliers where id = (p->>'supplier_id')::uuid and organization_id = v_org and status = 'active';
  if not found then raise exception 'Choose an active supplier.' using errcode = '22023'; end if;
  if v_po is not null and not exists (select 1 from public.purchase_orders where id = v_po and supplier_id = v_sup.id and status in ('approved', 'issued', 'partially_received', 'completed')) then
    raise exception 'The purchase order must be approved and for this supplier.' using errcode = '22023';
  end if;
  v_calc := public.doc_calc_lines(v_org, p_lines, coalesce(p->>'amounts_are', 'exclusive'), 'purchases');
  v_terms := coalesce(v_sup.payment_terms_days, 30);
  if v_id is null then
    insert into public.bills (organization_id, kind, number, supplier_id, bill_date, due_date, created_by)
    values (v_org, coalesce(nullif(p->>'kind', ''), 'bill'), public.next_document_number(v_org, 'bill'), v_sup.id, (p->>'bill_date')::date, (p->>'bill_date')::date, p_actor)
    returning id into v_id;
  else
    select status into v_status from public.bills where id = p_id and organization_id = v_org for update;
    if v_status is null then raise exception 'Bill not found.' using errcode = 'P0002'; end if;
    if v_status not in ('draft', 'submitted') then raise exception 'An approved bill can''t be edited. Void it instead.' using errcode = '22023'; end if;
  end if;
  if exists (select 1 from public.bills where supplier_id = v_sup.id and id <> v_id and status <> 'void'
             and lower(supplier_reference) = lower(nullif(btrim(coalesce(p->>'supplier_reference', '')), ''))) then
    raise exception 'A bill with supplier reference % already exists for this supplier.', btrim(p->>'supplier_reference') using errcode = '22023';
  end if;
  update public.bills set supplier_id = v_sup.id, bill_date = (p->>'bill_date')::date,
    due_date = coalesce(nullif(p->>'due_date', '')::date, (p->>'bill_date')::date + v_terms),
    supplier_reference = nullif(btrim(coalesce(p->>'supplier_reference', '')), ''), purchase_order_id = v_po,
    amounts_are = coalesce(p->>'amounts_are', 'exclusive'), notes = left(coalesce(p->>'notes', ''), 3000), status = 'draft',
    subtotal = (v_calc->>'subtotal')::numeric, gst = (v_calc->>'gst')::numeric, total = (v_calc->>'total')::numeric, updated_at = now()
  where id = v_id;
  perform public.doc_insert_lines('bill_lines', v_id, v_calc->'lines');
  update public.bill_lines bl set po_line_id = (x->>'po_line_id')::uuid
  from jsonb_array_elements(v_calc->'lines') x where bl.document_id = v_id and bl.line_no = (x->>'line_no')::int and nullif(x->>'po_line_id', '') is not null;
  perform public.app_audit(p_actor, case when p_id is null then 'bill_created' else 'bill_saved' end, 'bill', v_id::text, null,
    jsonb_build_object('total', (v_calc->>'total')::numeric, 'kind', coalesce(nullif(p->>'kind', ''), 'bill')));
  return v_id;
end;
$$;

create or replace function public.bill_submit(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'purchases.manage');
  update public.bills set status = 'submitted', updated_at = now() where id = p_id and organization_id = public.app_org_of(p_actor) and status = 'draft';
  if not found then raise exception 'Only a draft bill can be sent for review.' using errcode = '22023'; end if;
  perform public.app_audit(p_actor, 'bill_submitted', 'bill', p_id::text, jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'submitted'));
end;
$$;

-- Approves and posts: Dr expense/asset lines and GST, Cr Accounts Payable (and
-- Cr PAYG withholding where the supplier quoted no ABN). Credit notes reverse.
create or replace function public.bill_approve(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v record; v_sup record;
  v_ap uuid; v_payg uuid;
  v_lines jsonb;
  v_journal uuid;
  v_credit boolean;
  v_rate numeric; v_threshold numeric;
  v_wh numeric := 0;
begin
  perform public.app_require(p_actor, 'purchases.manage');
  select * into v from public.bills where id = p_id and organization_id = v_org for update;
  if not found then raise exception 'Bill not found.' using errcode = 'P0002'; end if;
  if v.status not in ('draft', 'submitted') then raise exception 'This bill is already approved or void.' using errcode = '22023'; end if;
  if v.total <= 0 then raise exception 'The total must be more than zero.' using errcode = '22023'; end if;
  select * into v_sup from public.suppliers where id = v.supplier_id;
  v_credit := v.kind = 'credit_note';
  -- No ABN quoted: withhold at the top rate unless exempt or under the threshold (ex GST).
  if not v_credit and v_sup.abn is null and not v_sup.withholding_exempt then
    v_rate := (public.compliance_value('no_abn_withholding_rate', v.bill_date))::text::numeric;
    v_threshold := coalesce((public.compliance_value('no_abn_withholding_threshold', v.bill_date))::text::numeric, 0);
    if v.subtotal > v_threshold then
      v_wh := round(v.total * v_rate, 2);
    end if;
  end if;
  select id into v_ap from public.accounts where organization_id = v_org and subtype = 'payable' and status = 'active' order by code limit 1;
  select id into v_payg from public.accounts where organization_id = v_org and subtype = 'payg' and status = 'active' order by code limit 1;
  select jsonb_agg(jsonb_build_object('accountId', account_id, 'description', left(description, 300),
           'debit', case when v_credit then 0 else amount end, 'credit', case when v_credit then amount else 0 end, 'taxCodeId', tax_code_id) order by line_no)
    into v_lines from public.bill_lines where document_id = p_id;
  v_lines := v_lines || jsonb_build_object('accountId', v_ap, 'description', v_sup.name,
    'debit', case when v_credit then v.total else 0 end, 'credit', case when v_credit then 0 else v.total - v_wh end, 'taxCodeId', null);
  if v_wh > 0 then
    v_lines := v_lines || jsonb_build_object('accountId', v_payg, 'description', 'No-ABN withholding: ' || v_sup.name, 'debit', 0, 'credit', v_wh, 'taxCodeId', null);
  end if;
  v_journal := public.ledger_post_entry(p_actor, v.bill_date,
    (case when v_credit then 'Supplier credit ' else 'Bill ' end) || v.number || coalesce(' · ' || v.supplier_reference, '') || ' · ' || v_sup.name,
    case when v_credit then 'supplier_credit' else 'bill' end, p_id, coalesce(v.supplier_reference, v.number), v_lines, v.amounts_are, false);
  update public.bills set status = 'approved', withholding = v_wh, journal_id = v_journal, approved_by = p_actor, approved_at = now(), updated_at = now()
  where id = p_id;
  perform public.app_audit(p_actor, 'bill_approved', 'bill', p_id::text, jsonb_build_object('status', v.status),
    jsonb_build_object('status', 'approved', 'number', v.number, 'total', v.total, 'withholding', v_wh, 'kind', v.kind));
end;
$$;

create or replace function public.bill_void(p_actor uuid, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record; v_rev uuid;
begin
  perform public.app_require(p_actor, 'purchases.manage');
  select * into v from public.bills where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Bill not found.' using errcode = 'P0002'; end if;
  if v.status in ('draft', 'submitted') then
    delete from public.bills where id = p_id;
    perform public.app_audit(p_actor, 'bill_draft_deleted', 'bill', p_id::text, jsonb_build_object('total', v.total), null);
    return;
  end if;
  if v.status <> 'approved' then raise exception 'This bill is already void.' using errcode = '22023'; end if;
  if exists (select 1 from public.payable_allocations where (bill_id = p_id or credit_note_id = p_id) and voided_at is null) then
    raise exception 'Payments or credits are applied to it. Remove those first.' using errcode = '22023';
  end if;
  v_rev := public.ledger_reverse_entry(p_actor, v.journal_id, null, coalesce(nullif(btrim(p_reason), ''), 'Voided'));
  update public.bills set status = 'void', void_journal_id = v_rev, void_reason = btrim(p_reason), updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'bill_voided', 'bill', p_id::text, jsonb_build_object('status', 'approved'), jsonb_build_object('status', 'void', 'reason', btrim(p_reason)));
end;
$$;

create or replace function public.supplier_credit_apply(p_actor uuid, p_credit uuid, p_bill uuid, p_amount numeric, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record; b record;
begin
  perform public.app_require(p_actor, 'purchases.manage');
  select * into c from public.bills where id = p_credit and organization_id = public.app_org_of(p_actor) and kind = 'credit_note' for update;
  select * into b from public.bills where id = p_bill and organization_id = public.app_org_of(p_actor) and kind = 'bill' for update;
  if c.id is null or b.id is null or c.status <> 'approved' or b.status <> 'approved' or c.supplier_id <> b.supplier_id then
    raise exception 'Choose an approved supplier credit and bill for the same supplier.' using errcode = '22023';
  end if;
  if p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > public.bill_outstanding(p_credit) or p_amount > public.bill_outstanding(p_bill) then
    raise exception 'The amount can''t exceed what is left on the credit or the bill.' using errcode = '22023';
  end if;
  insert into public.payable_allocations (organization_id, bill_id, credit_note_id, amount, allocation_date, created_by)
  values (c.organization_id, p_bill, p_credit, p_amount, coalesce(p_date, greatest(c.bill_date, b.bill_date)), p_actor);
  perform public.app_audit(p_actor, 'supplier_credit_applied', 'bill', p_bill::text, null, jsonb_build_object('credit', c.number, 'amount', p_amount));
end;
$$;

------------------------------------------------------------------------------
-- 11. Supplier payments
------------------------------------------------------------------------------

-- Pays approved bills only (unapproved bills can't be selected).
create or replace function public.supplier_payment_record(p_actor uuid, p_supplier uuid, p_date date, p_bank uuid, p_reference text, p_method text, p_allocations jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_sup record; v_bank record;
  v_ap uuid; v_id uuid; v_journal uuid;
  a jsonb; v_bill record; v_amt numeric; v_total numeric := 0;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v_sup from public.suppliers where id = p_supplier and organization_id = v_org;
  if not found then raise exception 'Supplier not found.' using errcode = 'P0002'; end if;
  select * into v_bank from public.accounts where id = p_bank and organization_id = v_org and subtype = 'bank' and status = 'active';
  if not found then raise exception 'Choose the bank account the money came from.' using errcode = '22023'; end if;
  for a in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    v_amt := coalesce(nullif(a->>'amount', '')::numeric, 0);
    if v_amt > 0 then v_total := v_total + v_amt; end if;
  end loop;
  if v_total <= 0 then raise exception 'Choose the bills to pay and the amounts.' using errcode = '22023'; end if;
  select id into v_ap from public.accounts where organization_id = v_org and subtype = 'payable' and status = 'active' order by code limit 1;
  insert into public.supplier_payments (organization_id, supplier_id, payment_date, amount, bank_account_id, reference, method, created_by)
  values (v_org, p_supplier, p_date, v_total, p_bank, left(coalesce(p_reference, ''), 120), coalesce(p_method, 'bank_transfer'), p_actor) returning id into v_id;
  for a in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    v_amt := coalesce(nullif(a->>'amount', '')::numeric, 0);
    if v_amt = 0 then continue; end if;
    select * into v_bill from public.bills where id = (a->>'billId')::uuid and organization_id = v_org and kind = 'bill' for update;
    if v_bill.id is null or v_bill.supplier_id <> p_supplier then
      raise exception 'Payments can only be applied to this supplier''s bills.' using errcode = '22023';
    end if;
    if v_bill.status <> 'approved' then
      raise exception 'Bill % is not approved, so it can''t be paid.', v_bill.number using errcode = '22023';
    end if;
    if v_amt < 0 or v_amt <> round(v_amt, 2) or v_amt > public.bill_outstanding(v_bill.id) then
      raise exception 'Bill %: the amount is more than what is owing.', v_bill.number using errcode = '22023';
    end if;
    insert into public.payable_allocations (organization_id, bill_id, payment_id, amount, allocation_date, created_by)
    values (v_org, v_bill.id, v_id, v_amt, p_date, p_actor);
  end loop;
  v_journal := public.ledger_post_entry(p_actor, p_date, 'Payment to ' || v_sup.name || coalesce(' · ' || nullif(btrim(p_reference), ''), ''),
    'supplier_payment', v_id, nullif(btrim(coalesce(p_reference, '')), ''),
    jsonb_build_array(
      jsonb_build_object('accountId', v_ap, 'debit', v_total, 'credit', 0, 'description', v_sup.name),
      jsonb_build_object('accountId', p_bank, 'debit', 0, 'credit', v_total, 'description', 'Payment: ' || v_sup.name)), 'no_tax', false);
  update public.supplier_payments set journal_id = v_journal where id = v_id;
  perform public.app_audit(p_actor, 'supplier_payment_recorded', 'supplier_payment', v_id::text, null, jsonb_build_object('supplier', v_sup.name, 'amount', v_total));
  return v_id;
end;
$$;

create or replace function public.supplier_payment_void(p_actor uuid, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record; v_rev uuid;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.supplier_payments where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Payment not found.' using errcode = 'P0002'; end if;
  if v.status <> 'posted' then raise exception 'This payment is already void.' using errcode = '22023'; end if;
  v_rev := public.ledger_reverse_entry(p_actor, v.journal_id, null, coalesce(nullif(btrim(p_reason), ''), 'Payment voided'));
  update public.payable_allocations set voided_at = now() where payment_id = p_id and voided_at is null;
  update public.supplier_payments set status = 'void', void_journal_id = v_rev, void_reason = btrim(p_reason) where id = p_id;
  perform public.app_audit(p_actor, 'supplier_payment_voided', 'supplier_payment', p_id::text, jsonb_build_object('amount', v.amount), jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

------------------------------------------------------------------------------
-- 12. Reports: ageing and statements
------------------------------------------------------------------------------

-- Aged receivables as at a date, bucketed by days past due:
-- current, 1-30, 31-60, 61-90, 90+. Credit notes and unapplied receipts
-- reduce the customer's total (shown as "credits").
create or replace function public.report_aged_receivables(p_actor uuid, p_as_at date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_rows jsonb;
begin
  with docs as (
    select i.customer_id, i.id, i.number, i.kind, i.invoice_date, i.due_date, public.invoice_outstanding(i.id, p_as_at) as owing
    from public.invoices i
    where i.organization_id = v_org and i.status = 'approved' and i.invoice_date <= p_as_at
  ), inv as (
    select customer_id,
      sum(owing) filter (where kind = 'invoice' and p_as_at <= due_date) as cur,
      sum(owing) filter (where kind = 'invoice' and p_as_at - due_date between 1 and 30) as d30,
      sum(owing) filter (where kind = 'invoice' and p_as_at - due_date between 31 and 60) as d60,
      sum(owing) filter (where kind = 'invoice' and p_as_at - due_date between 61 and 90) as d90,
      sum(owing) filter (where kind = 'invoice' and p_as_at - due_date > 90) as d90p,
      sum(owing) filter (where kind = 'credit_note') as credits
    from docs group by customer_id
  ), unapplied as (
    select p.customer_id, sum(p.amount - coalesce((select sum(a.amount) from public.receivable_allocations a where a.payment_id = p.id and a.voided_at is null and a.allocation_date <= p_as_at), 0)) as amt
    from public.customer_payments p where p.organization_id = v_org and p.status = 'posted' and p.payment_date <= p_as_at group by p.customer_id
  )
  select coalesce(jsonb_agg(r order by r->>'name'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('customerId', c.id, 'name', c.name,
      'current', coalesce(i.cur, 0), 'days30', coalesce(i.d30, 0), 'days60', coalesce(i.d60, 0), 'days90', coalesce(i.d90, 0), 'over90', coalesce(i.d90p, 0),
      'credits', -(coalesce(i.credits, 0) + coalesce(u.amt, 0)),
      'total', coalesce(i.cur, 0) + coalesce(i.d30, 0) + coalesce(i.d60, 0) + coalesce(i.d90, 0) + coalesce(i.d90p, 0) - coalesce(i.credits, 0) - coalesce(u.amt, 0)) as r
    from public.customers c
    left join inv i on i.customer_id = c.id left join unapplied u on u.customer_id = c.id
    where c.organization_id = v_org and (coalesce(i.cur, 0) + coalesce(i.d30, 0) + coalesce(i.d60, 0) + coalesce(i.d90, 0) + coalesce(i.d90p, 0) + coalesce(i.credits, 0) + coalesce(u.amt, 0)) <> 0
  ) s;
  return jsonb_build_object('asAt', p_as_at, 'rows', v_rows, 'totals', (
    select jsonb_build_object('current', coalesce(sum((r->>'current')::numeric), 0), 'days30', coalesce(sum((r->>'days30')::numeric), 0),
      'days60', coalesce(sum((r->>'days60')::numeric), 0), 'days90', coalesce(sum((r->>'days90')::numeric), 0), 'over90', coalesce(sum((r->>'over90')::numeric), 0),
      'credits', coalesce(sum((r->>'credits')::numeric), 0), 'total', coalesce(sum((r->>'total')::numeric), 0)) from jsonb_array_elements(v_rows) r));
end;
$$;

create or replace function public.report_aged_payables(p_actor uuid, p_as_at date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_rows jsonb;
begin
  with docs as (
    select b.supplier_id, b.kind, b.due_date, public.bill_outstanding(b.id, p_as_at) as owing
    from public.bills b where b.organization_id = v_org and b.status = 'approved' and b.bill_date <= p_as_at
  ), agg as (
    select supplier_id,
      sum(owing) filter (where kind = 'bill' and p_as_at <= due_date) as cur,
      sum(owing) filter (where kind = 'bill' and p_as_at - due_date between 1 and 30) as d30,
      sum(owing) filter (where kind = 'bill' and p_as_at - due_date between 31 and 60) as d60,
      sum(owing) filter (where kind = 'bill' and p_as_at - due_date between 61 and 90) as d90,
      sum(owing) filter (where kind = 'bill' and p_as_at - due_date > 90) as d90p,
      sum(owing) filter (where kind = 'credit_note') as credits
    from docs group by supplier_id
  )
  select coalesce(jsonb_agg(r order by r->>'name'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('supplierId', s.id, 'name', s.name,
      'current', coalesce(a.cur, 0), 'days30', coalesce(a.d30, 0), 'days60', coalesce(a.d60, 0), 'days90', coalesce(a.d90, 0), 'over90', coalesce(a.d90p, 0),
      'credits', -coalesce(a.credits, 0),
      'total', coalesce(a.cur, 0) + coalesce(a.d30, 0) + coalesce(a.d60, 0) + coalesce(a.d90, 0) + coalesce(a.d90p, 0) - coalesce(a.credits, 0)) as r
    from public.suppliers s join agg a on a.supplier_id = s.id
    where s.organization_id = v_org and (coalesce(a.cur, 0) + coalesce(a.d30, 0) + coalesce(a.d60, 0) + coalesce(a.d90, 0) + coalesce(a.d90p, 0) + coalesce(a.credits, 0)) <> 0
  ) q;
  return jsonb_build_object('asAt', p_as_at, 'rows', v_rows, 'totals', (
    select jsonb_build_object('current', coalesce(sum((r->>'current')::numeric), 0), 'days30', coalesce(sum((r->>'days30')::numeric), 0),
      'days60', coalesce(sum((r->>'days60')::numeric), 0), 'days90', coalesce(sum((r->>'days90')::numeric), 0), 'over90', coalesce(sum((r->>'over90')::numeric), 0),
      'credits', coalesce(sum((r->>'credits')::numeric), 0), 'total', coalesce(sum((r->>'total')::numeric), 0)) from jsonb_array_elements(v_rows) r));
end;
$$;

-- Customer statement: opening balance, then invoices, credit notes and
-- receipts in the range, with a running balance; plus the open invoices.
create or replace function public.report_customer_statement(p_actor uuid, p_customer uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_c record;
  v_open numeric;
  v_rows jsonb;
begin
  select * into v_c from public.customers where id = p_customer and organization_id = v_org;
  if not found then raise exception 'Customer not found.' using errcode = 'P0002'; end if;
  with tx as (
    select i.invoice_date as d, i.number as ref, case when i.kind = 'invoice' then 'Invoice' else 'Credit note' end as what,
      case when i.kind = 'invoice' then i.total else -i.total end as amt, i.due_date as due
    from public.invoices i where i.customer_id = p_customer and i.status = 'approved'
    union all
    select p.payment_date, coalesce(nullif(p.reference, ''), 'Receipt'), 'Payment received', -p.amount, null
    from public.customer_payments p where p.customer_id = p_customer and p.status = 'posted'
  )
  select coalesce(sum(amt), 0) into v_open from tx where d < p_from;
  with tx as (
    select i.invoice_date as d, i.number as ref, case when i.kind = 'invoice' then 'Invoice' else 'Credit note' end as what,
      case when i.kind = 'invoice' then i.total else -i.total end as amt, i.due_date as due
    from public.invoices i where i.customer_id = p_customer and i.status = 'approved'
    union all
    select p.payment_date, coalesce(nullif(p.reference, ''), 'Receipt'), 'Payment received', -p.amount, null
    from public.customer_payments p where p.customer_id = p_customer and p.status = 'posted'
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'reference', ref, 'type', what, 'amount', amt, 'dueDate', due) order by d, ref), '[]'::jsonb)
    into v_rows from tx where d between p_from and p_to;
  return jsonb_build_object('customer', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'abn', v_c.abn, 'email', v_c.email, 'address', v_c.billing_address),
    'from', p_from, 'to', p_to, 'openingBalance', v_open, 'rows', v_rows,
    'closingBalance', v_open + (select coalesce(sum((r->>'amount')::numeric), 0) from jsonb_array_elements(v_rows) r),
    'openInvoices', (select coalesce(jsonb_agg(jsonb_build_object('number', number, 'date', invoice_date, 'dueDate', due_date, 'total', total,
        'owing', public.invoice_outstanding(id, p_to)) order by due_date), '[]'::jsonb)
      from public.invoices where customer_id = p_customer and status = 'approved' and kind = 'invoice' and invoice_date <= p_to and public.invoice_outstanding(id, p_to) > 0));
end;
$$;

------------------------------------------------------------------------------
-- 12b. Attachments (supplier invoices, remittances, signed POs)
------------------------------------------------------------------------------

create or replace function public.finance_attach_document(p_actor uuid, p_entity_type text, p_entity_id uuid, p_path text, p_file_name text,
  p_content_type text, p_size bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid;
  v_ok boolean;
begin
  if p_entity_type in ('bill', 'purchase_order', 'supplier') then
    if not (public.app_has(p_actor, 'purchases.manage') or (p_entity_type = 'purchase_order' and public.app_has(p_actor, 'purchases.raise'))) then
      perform public.app_require(p_actor, 'purchases.manage');
    end if;
  elsif p_entity_type in ('invoice', 'quote', 'customer') then
    perform public.app_require(p_actor, 'sales.manage');
  else
    raise exception 'Attachments are not available here.' using errcode = '22023';
  end if;
  v_ok := case p_entity_type
    when 'bill' then exists (select 1 from public.bills where id = p_entity_id and organization_id = v_org)
    when 'purchase_order' then exists (select 1 from public.purchase_orders where id = p_entity_id and organization_id = v_org)
    when 'supplier' then exists (select 1 from public.suppliers where id = p_entity_id and organization_id = v_org)
    when 'invoice' then exists (select 1 from public.invoices where id = p_entity_id and organization_id = v_org)
    when 'quote' then exists (select 1 from public.quotes where id = p_entity_id and organization_id = v_org)
    when 'customer' then exists (select 1 from public.customers where id = p_entity_id and organization_id = v_org) end;
  if not v_ok then
    raise exception 'Record not found.' using errcode = 'P0002';
  end if;
  if p_path is null or p_path !~ ('^org/' || v_org::text || '/' || p_entity_type || '/' || p_entity_id::text || '/[A-Za-z0-9._-]{1,140}$') then
    raise exception 'Invalid upload path.' using errcode = '22023';
  end if;
  if p_content_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic') then
    raise exception 'Attach a PDF or a photo.' using errcode = '22023';
  end if;
  insert into public.documents (organization_id, entity_type, entity_id, category, title, path, file_name, content_type, size_bytes, uploaded_by)
  values (v_org, p_entity_type, p_entity_id::text, 'attachment', left(coalesce(nullif(btrim(p_file_name), ''), 'Attachment'), 160), p_path,
    left(coalesce(p_file_name, ''), 200), p_content_type, greatest(p_size, 1), p_actor)
  returning id into v_id;
  perform public.app_audit(p_actor, 'document_attached', p_entity_type, p_entity_id::text, null, jsonb_build_object('document', v_id, 'fileName', p_file_name));
  return v_id;
end;
$$;

create or replace function public.finance_archive_document(p_actor uuid, p_document uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public.documents where id = p_document and organization_id = public.app_org_of(p_actor) and category = 'attachment' for update;
  if not found then raise exception 'Attachment not found.' using errcode = 'P0002'; end if;
  perform public.app_require(p_actor, case when v.entity_type in ('invoice', 'quote', 'customer') then 'sales.manage' else 'purchases.manage' end);
  update public.documents set archived_at = now() where id = p_document and archived_at is null;
  perform public.app_audit(p_actor, 'document_archived', v.entity_type, v.entity_id, jsonb_build_object('document', p_document), null);
end;
$$;

------------------------------------------------------------------------------
-- 13. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['compliance_rules', 'customers', 'suppliers', 'quotes', 'quote_lines', 'invoices', 'invoice_lines', 'purchase_orders',
    'purchase_order_lines', 'bills', 'bill_lines', 'customer_payments', 'supplier_payments', 'receivable_allocations', 'payable_allocations']
  loop
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
  -- Internal helpers: callable only from other security-definer functions.
  foreach f in array array['ledger_reverse_entry(uuid, uuid, date, text)', 'doc_insert_lines(text, uuid, jsonb)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'compliance_value(text, date)', 'journal_reverse(uuid, uuid, date, text)', 'approval_decide(uuid, uuid, boolean, text)',
    'doc_calc_lines(uuid, jsonb, text, text)', 'invoice_outstanding(uuid, date)', 'bill_outstanding(uuid, date)',
    'customer_payment_unallocated(uuid)', 'supplier_payment_unallocated(uuid)', 'invoice_balances(uuid)', 'bill_balances(uuid)',
    'customer_save(uuid, uuid, jsonb)', 'supplier_save(uuid, uuid, jsonb)', 'supplier_bank_request(uuid, uuid, text, text, text)',
    'quote_save(uuid, uuid, jsonb, jsonb)', 'quote_set_status(uuid, uuid, text)',
    'invoice_save(uuid, uuid, jsonb, jsonb)', 'invoice_approve(uuid, uuid)', 'invoice_void(uuid, uuid, text)', 'invoice_mark_sent(uuid, uuid)',
    'credit_note_apply(uuid, uuid, uuid, numeric, date)',
    'customer_payment_record(uuid, uuid, date, numeric, uuid, text, text, jsonb)', 'customer_payment_allocate(uuid, uuid, uuid, numeric)',
    'customer_payment_void(uuid, uuid, text)',
    'po_save(uuid, uuid, jsonb, jsonb)', 'po_set_status(uuid, uuid, text, text)', 'po_receive(uuid, uuid, jsonb)',
    'bill_save(uuid, uuid, jsonb, jsonb)', 'bill_submit(uuid, uuid)', 'bill_approve(uuid, uuid)', 'bill_void(uuid, uuid, text)',
    'supplier_credit_apply(uuid, uuid, uuid, numeric, date)',
    'supplier_payment_record(uuid, uuid, date, uuid, text, text, jsonb)', 'supplier_payment_void(uuid, uuid, text)',
    'report_aged_receivables(uuid, date)', 'report_aged_payables(uuid, date)', 'report_customer_statement(uuid, uuid, date, date)',
    'finance_attach_document(uuid, text, uuid, text, text, text, bigint)', 'finance_archive_document(uuid, uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

commit;
