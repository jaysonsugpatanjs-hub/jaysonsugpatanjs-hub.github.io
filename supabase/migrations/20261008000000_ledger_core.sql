-- Panalo Accounts, Phase 2: the accounting core.
--
-- * financial_years + accounting_periods (monthly, from the company's
--   financial-year start month). Period status: open, soft_locked (only
--   ledger.reopen holders may post), closed (nobody posts). Reopening a closed
--   period needs ledger.reopen and a reason, and is audited.
-- * accounts: configurable chart, seeded from the brief (section 39).
--   System accounts used by posting rules can't be archived or retyped;
--   control accounts (receivables, payables) and current year earnings refuse
--   manual journal lines.
-- * tax_codes: Australian GST codes with BAS labels for Phase 7.
-- * journal_entries + journal_lines: double entry. One posting engine,
--   ledger_post_entry(), is the only way lines reach the ledger. It builds GST
--   lines (rounded per line to the cent, half up), refuses unbalanced entries
--   and closed periods, numbers the journal and audits it. Posted journals and
--   their lines are immutable; corrections are reversals plus replacements.
-- * Reports: trial balance, profit and loss, balance sheet, account
--   transactions, all computed in SQL numeric (no floating point).
begin;

------------------------------------------------------------------------------
-- 1. Financial years and periods
------------------------------------------------------------------------------

create table public.financial_years (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name text not null,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  check (end_date > start_date),
  unique (organization_id, start_date)
);

create table public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  financial_year_id uuid not null references public.financial_years(id) on delete restrict,
  period_no integer not null check (period_no between 1 and 12),
  start_date date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open', 'soft_locked', 'closed')),
  status_changed_by uuid references public.training_profiles(id) on delete set null,
  status_changed_at timestamptz,
  unique (financial_year_id, period_no),
  check (end_date >= start_date)
);
create index accounting_periods_dates_idx on public.accounting_periods (organization_id, start_date, end_date);

-- Creates the financial year (and its 12 monthly periods) that contains a date.
create or replace function public.ledger_ensure_year(p_org uuid, p_date date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month int := coalesce((select financial_year_start_month from public.company_settings where organization_id = p_org), 7);
  v_start date;
  v_id uuid;
begin
  v_start := make_date(extract(year from p_date)::int, v_month, 1);
  if v_start > p_date then v_start := (v_start - interval '1 year')::date; end if;
  select id into v_id from public.financial_years where organization_id = p_org and start_date = v_start;
  if v_id is not null then return v_id; end if;
  insert into public.financial_years (organization_id, name, start_date, end_date)
  values (p_org,
    case when v_month = 1 then 'FY' || extract(year from v_start)::text
         else 'FY' || extract(year from v_start)::text || '-' || right(extract(year from v_start + interval '1 year')::text, 2) end,
    v_start, (v_start + interval '1 year' - interval '1 day')::date)
  returning id into v_id;
  insert into public.accounting_periods (organization_id, financial_year_id, period_no, start_date, end_date)
  select p_org, v_id, n, (v_start + (n - 1) * interval '1 month')::date, (v_start + n * interval '1 month' - interval '1 day')::date
  from generate_series(1, 12) n;
  return v_id;
end;
$$;

select public.ledger_ensure_year('00000000-0000-4000-8000-000000000001', date '2025-07-01');
select public.ledger_ensure_year('00000000-0000-4000-8000-000000000001', date '2026-07-01');

------------------------------------------------------------------------------
-- 2. Tax codes
------------------------------------------------------------------------------

create table public.tax_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  kind text not null check (kind in ('gst_income', 'gst_expense', 'gst_capital', 'gst_free_income', 'gst_free_expense', 'export',
    'input_taxed_income', 'input_taxed_expense', 'no_gst', 'out_of_scope')),
  rate numeric(6,4) not null default 0 check (rate >= 0 and rate < 1),
  applies_to text not null check (applies_to in ('sales', 'purchases', 'both')),
  bas_labels text[] not null default '{}',
  description text not null default '',
  is_system boolean not null default false,
  active boolean not null default true,
  sort integer not null default 100,
  unique (organization_id, code)
);

insert into public.tax_codes (organization_id, code, name, kind, rate, applies_to, bas_labels, description, is_system, sort)
select '00000000-0000-4000-8000-000000000001', c, n, k, r, a, l, d, true, s from (values
  ('GST', 'GST on Income', 'gst_income', 0.10, 'sales', '{G1,1A}'::text[], 'Taxable sales: 10% GST included in G1, GST at 1A.', 10),
  ('GSTE', 'GST on Expenses', 'gst_expense', 0.10, 'purchases', '{G11,1B}'::text[], 'Non-capital purchases with GST: G11, credit at 1B.', 20),
  ('CAP', 'GST on Capital Purchases', 'gst_capital', 0.10, 'purchases', '{G10,1B}'::text[], 'Capital purchases (plant, vehicles, equipment) with GST: G10, credit at 1B.', 30),
  ('FRE', 'GST Free Income', 'gst_free_income', 0, 'sales', '{G1,G3}'::text[], 'GST-free sales: G1 and G3.', 40),
  ('EXP', 'GST Free Exports', 'export', 0, 'sales', '{G1,G2}'::text[], 'Exports: G1 and G2.', 50),
  ('FREE', 'GST Free Expenses', 'gst_free_expense', 0, 'purchases', '{G11,G14}'::text[], 'GST-free purchases: G11 and G14.', 60),
  ('ITS', 'Input Taxed Sales', 'input_taxed_income', 0, 'sales', '{G1,G4}'::text[], 'Input-taxed sales (for example interest): G1 and G4.', 70),
  ('ITP', 'Input Taxed Purchases', 'input_taxed_expense', 0, 'purchases', '{G11,G13}'::text[], 'Purchases for making input-taxed sales: G11 and G13.', 80),
  ('NG', 'No GST (BAS excluded)', 'no_gst', 0, 'both', '{}'::text[], 'Not reported on the BAS: wages, super, transfers, loans, tax payments.', 90),
  ('OOS', 'Out of Scope', 'out_of_scope', 0, 'both', '{}'::text[], 'Outside the GST system altogether.', 100)
) as v(c, n, k, r, a, l, d, s);

------------------------------------------------------------------------------
-- 3. Chart of accounts
------------------------------------------------------------------------------

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code text not null check (code ~ '^[0-9A-Z][0-9A-Z.-]{0,11}$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  type text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense', 'other_income', 'other_expense')),
  subtype text not null default 'general' check (subtype in ('general', 'bank', 'receivable', 'inventory', 'current_asset', 'fixed_asset',
    'accumulated_depreciation', 'payable', 'current_liability', 'non_current_liability', 'gst', 'payg', 'super', 'payroll',
    'share_capital', 'retained_earnings', 'current_year_earnings')),
  description text not null default '',
  default_tax_code_id uuid references public.tax_codes(id) on delete set null,
  is_system boolean not null default false,
  allow_manual boolean not null default true,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by uuid references public.training_profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create or replace function public.account_normal_side(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_type in ('asset', 'expense', 'cost_of_sales', 'other_expense') then 'debit' else 'credit' end;
$$;

insert into public.accounts (organization_id, code, name, type, subtype, is_system, allow_manual, default_tax_code_id)
select '00000000-0000-4000-8000-000000000001', c, n, t, st, sys, man,
  (select id from public.tax_codes where organization_id = '00000000-0000-4000-8000-000000000001' and code = tx)
from (values
  ('1000', 'Bank', 'asset', 'bank', true, true, null),
  ('1100', 'Accounts Receivable', 'asset', 'receivable', true, false, null),
  ('1200', 'Inventory - Steel and Materials', 'asset', 'inventory', false, true, null),
  ('1210', 'Welding Consumables', 'asset', 'inventory', false, true, null),
  ('1220', 'Project Materials', 'asset', 'inventory', false, true, null),
  ('1300', 'Work in Progress', 'asset', 'current_asset', false, true, null),
  ('1400', 'Prepayments', 'asset', 'current_asset', false, true, null),
  ('1500', 'Tools and Equipment', 'asset', 'fixed_asset', false, true, 'CAP'),
  ('1510', 'Tools and Equipment - Accumulated Depreciation', 'asset', 'accumulated_depreciation', false, true, null),
  ('1600', 'Vehicles', 'asset', 'fixed_asset', false, true, 'CAP'),
  ('1610', 'Vehicles - Accumulated Depreciation', 'asset', 'accumulated_depreciation', false, true, null),
  ('1700', 'Plant and Machinery', 'asset', 'fixed_asset', false, true, 'CAP'),
  ('1710', 'Plant and Machinery - Accumulated Depreciation', 'asset', 'accumulated_depreciation', false, true, null),
  ('1800', 'Office Equipment', 'asset', 'fixed_asset', false, true, 'CAP'),
  ('1810', 'Office Equipment - Accumulated Depreciation', 'asset', 'accumulated_depreciation', false, true, null),
  ('2000', 'Accounts Payable', 'liability', 'payable', true, false, null),
  ('2100', 'PAYG Withholding Payable', 'liability', 'payg', true, true, null),
  ('2200', 'Superannuation Payable', 'liability', 'super', true, true, null),
  ('2300', 'GST Payable/Receivable', 'liability', 'gst', true, true, null),
  ('2400', 'Payroll Clearing', 'liability', 'payroll', true, true, null),
  ('2500', 'Accrued Expenses', 'liability', 'current_liability', false, true, null),
  ('2600', 'Employee Deductions Payable', 'liability', 'payroll', true, true, null),
  ('3000', 'Share Capital', 'equity', 'share_capital', false, true, null),
  ('3100', 'Retained Earnings', 'equity', 'retained_earnings', true, true, null),
  ('3200', 'Current Year Earnings', 'equity', 'current_year_earnings', true, false, null),
  ('4000', 'Fabrication Revenue', 'revenue', 'general', false, true, 'GST'),
  ('4100', 'Welding Revenue', 'revenue', 'general', false, true, 'GST'),
  ('4200', 'Shutdown/Maintenance Revenue', 'revenue', 'general', false, true, 'GST'),
  ('4300', 'Pipework Revenue', 'revenue', 'general', false, true, 'GST'),
  ('4400', 'Site Labour Revenue', 'revenue', 'general', false, true, 'GST'),
  ('4500', 'Labour Hire Revenue', 'revenue', 'general', false, true, 'GST'),
  ('4600', 'Equipment Hire Revenue', 'revenue', 'general', false, true, 'GST'),
  ('4700', 'Materials Recharge', 'revenue', 'general', false, true, 'GST'),
  ('4800', 'Other Operating Revenue', 'revenue', 'general', false, true, 'GST'),
  ('5000', 'Direct Labour', 'cost_of_sales', 'general', true, true, 'NG'),
  ('5100', 'Direct Materials', 'cost_of_sales', 'general', false, true, 'GSTE'),
  ('5200', 'Welding Consumables', 'cost_of_sales', 'general', false, true, 'GSTE'),
  ('5300', 'Subcontractors', 'cost_of_sales', 'general', false, true, 'GSTE'),
  ('5400', 'Project Travel', 'cost_of_sales', 'general', false, true, 'GSTE'),
  ('5500', 'Equipment Hire - Projects', 'cost_of_sales', 'general', false, true, 'GSTE'),
  ('5600', 'Freight', 'cost_of_sales', 'general', false, true, 'GSTE'),
  ('5700', 'Site Costs', 'cost_of_sales', 'general', false, true, 'GSTE'),
  ('6000', 'Administration Wages', 'expense', 'general', true, true, 'NG'),
  ('6100', 'Employer Superannuation', 'expense', 'general', true, true, 'NG'),
  ('6200', 'Workers Compensation', 'expense', 'general', false, true, null),
  ('6300', 'Vehicle Expenses', 'expense', 'general', false, true, 'GSTE'),
  ('6400', 'Fuel', 'expense', 'general', false, true, 'GSTE'),
  ('6500', 'Repairs and Maintenance', 'expense', 'general', false, true, 'GSTE'),
  ('6600', 'PPE', 'expense', 'general', false, true, 'GSTE'),
  ('6700', 'Tools', 'expense', 'general', false, true, 'GSTE'),
  ('6800', 'Insurance', 'expense', 'general', false, true, null),
  ('6900', 'Rent', 'expense', 'general', false, true, 'GSTE'),
  ('7000', 'Utilities', 'expense', 'general', false, true, 'GSTE'),
  ('7100', 'Software', 'expense', 'general', false, true, 'GSTE'),
  ('7200', 'Accounting and Legal', 'expense', 'general', false, true, 'GSTE'),
  ('7300', 'Training', 'expense', 'general', false, true, 'GSTE'),
  ('7400', 'Recruitment', 'expense', 'general', false, true, 'GSTE'),
  ('7500', 'Telephone and Internet', 'expense', 'general', false, true, 'GSTE'),
  ('7600', 'Advertising', 'expense', 'general', false, true, 'GSTE'),
  ('7700', 'Bank Charges', 'expense', 'general', false, true, null),
  ('7800', 'Depreciation', 'expense', 'general', false, true, 'NG'),
  ('7850', 'ATO Interest and Penalties (non-deductible)', 'expense', 'general', false, true, 'NG'),
  ('7900', 'Miscellaneous Expenses', 'expense', 'general', false, true, null)
) as v(c, n, t, st, sys, man, tx);

------------------------------------------------------------------------------
-- 4. Journals
------------------------------------------------------------------------------

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  number text,
  entry_date date not null,
  period_id uuid references public.accounting_periods(id) on delete restrict,
  memo text not null default '' check (length(memo) <= 500),
  amounts_are text not null default 'exclusive' check (amounts_are in ('exclusive', 'inclusive', 'no_tax')),
  status text not null default 'draft' check (status in ('draft', 'posted', 'reversed')),
  source_type text not null default 'manual' check (source_type ~ '^[a-z_]{2,40}$'),
  source_id uuid,
  source_ref text,
  reverses_id uuid references public.journal_entries(id) on delete restrict,
  reversed_by_id uuid references public.journal_entries(id) on delete restrict,
  reversal_reason text,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  posted_by uuid references public.training_profiles(id) on delete set null,
  posted_at timestamptz,
  check ((status = 'draft') = (posted_at is null)),
  check (status = 'draft' or (number is not null and period_id is not null))
);
create unique index journal_entries_number_idx on public.journal_entries (organization_id, number) where number is not null;
create index journal_entries_date_idx on public.journal_entries (organization_id, status, entry_date);
create index journal_entries_source_idx on public.journal_entries (source_type, source_id);

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.journal_entries(id) on delete cascade,
  line_no integer not null check (line_no > 0),
  account_id uuid not null references public.accounts(id) on delete restrict,
  description text not null default '' check (length(description) <= 300),
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  tax_code_id uuid references public.tax_codes(id) on delete restrict,
  tax_amount numeric(14,2) not null default 0,
  entered_amount numeric(14,2),
  is_tax_line boolean not null default false,
  source_line_no integer,
  check ((debit = 0) <> (credit = 0)),
  unique (journal_id, line_no)
);
create index journal_lines_account_idx on public.journal_lines (account_id);

-- Posted journals and their lines are immutable. The only change allowed is
-- marking a posted journal as reversed (by the reversal it points to).
create or replace function public.journal_entries_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'A posted journal cannot be deleted. Reverse it instead.' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  if old.status = 'posted' and new.status = 'reversed' and new.reversed_by_id is not null
     and (new.number, new.entry_date, new.period_id, new.memo, new.amounts_are, new.source_type, new.source_id, new.posted_at, new.posted_by)
         is not distinct from (old.number, old.entry_date, old.period_id, old.memo, old.amounts_are, old.source_type, old.source_id, old.posted_at, old.posted_by) then
    return new;
  end if;
  raise exception 'A posted journal cannot be changed. Reverse it and post a replacement.' using errcode = '42501';
end;
$$;
create trigger journal_entries_guard before update or delete on public.journal_entries
  for each row execute function public.journal_entries_guard();

create or replace function public.journal_lines_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.journal_entries where id = coalesce(new.journal_id, old.journal_id);
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Lines of a posted journal cannot be changed.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger journal_lines_guard before insert or update or delete on public.journal_lines
  for each row execute function public.journal_lines_guard();

-- The database refuses to let an unbalanced journal be posted.
create or replace function public.journal_balance_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_dr numeric; v_cr numeric; v_n int;
begin
  if new.status <> 'posted' then return null; end if;
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) into v_dr, v_cr, v_n from public.journal_lines where journal_id = new.id;
  if v_n < 2 then
    raise exception 'Journal % needs at least two lines.', new.number using errcode = '23514';
  end if;
  if v_dr <> v_cr then
    raise exception 'Journal % does not balance: debits % and credits %.', new.number, v_dr, v_cr using errcode = '23514';
  end if;
  if v_dr = 0 then
    raise exception 'Journal % has no amounts.', new.number using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger journal_balance_check after insert or update on public.journal_entries
  deferrable initially deferred for each row execute function public.journal_balance_check();

------------------------------------------------------------------------------
-- 5. The posting engine
------------------------------------------------------------------------------

-- Turns entered lines into ledger lines: validates accounts and tax codes and
-- adds a GST line to the GST account for each taxed line (per-line rounding
-- to the cent, half up). Entered lines: [{accountId, description, debit,
-- credit, taxCodeId}]. Returns {lines: [...], debit, credit}.
create or replace function public.ledger_build_lines(p_org uuid, p_lines jsonb, p_amounts_are text, p_manual boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_gst_account uuid;
  l jsonb;
  v_acc record;
  v_tax_id uuid; v_tax_rate numeric; v_tax_code text; v_tax_active boolean;
  v_dr numeric; v_cr numeric; v_amount numeric; v_net numeric; v_gst numeric;
  v_side text;
  v_no int := 0;
  v_src int := 0;
  v_total_dr numeric := 0; v_total_cr numeric := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal needs at least two lines.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'A journal can have at most 200 lines.' using errcode = '22023';
  end if;
  select id into v_gst_account from public.accounts where organization_id = p_org and subtype = 'gst' and status = 'active' order by code limit 1;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_src := v_src + 1;
    begin
      v_dr := coalesce(nullif(l->>'debit', '')::numeric, 0);
      v_cr := coalesce(nullif(l->>'credit', '')::numeric, 0);
    exception when others then
      raise exception 'Line %: amounts must be numbers.', v_src using errcode = '22023';
    end;
    if v_dr < 0 or v_cr < 0 then
      raise exception 'Line %: amounts cannot be negative; use the other column.', v_src using errcode = '22023';
    end if;
    if (v_dr > 0) = (v_cr > 0) then
      raise exception 'Line %: enter either a debit or a credit.', v_src using errcode = '22023';
    end if;
    if v_dr <> round(v_dr, 2) or v_cr <> round(v_cr, 2) then
      raise exception 'Line %: amounts can have at most 2 decimal places.', v_src using errcode = '22023';
    end if;
    select * into v_acc from public.accounts where id = (l->>'accountId')::uuid and organization_id = p_org;
    if not found then
      raise exception 'Line %: choose an account.', v_src using errcode = '22023';
    end if;
    if v_acc.status <> 'active' then
      raise exception 'Line %: account % is archived.', v_src, v_acc.code using errcode = '22023';
    end if;
    if p_manual and not v_acc.allow_manual then
      raise exception 'Line %: % % is a control account and only takes entries from its own module.', v_src, v_acc.code, v_acc.name using errcode = '22023';
    end if;
    v_tax_id := null; v_tax_rate := 0; v_tax_code := null;
    if nullif(l->>'taxCodeId', '') is not null and p_amounts_are <> 'no_tax' then
      select id, rate, code, active into v_tax_id, v_tax_rate, v_tax_code, v_tax_active
      from public.tax_codes where id = (l->>'taxCodeId')::uuid and organization_id = p_org;
      if v_tax_id is null then
        raise exception 'Line %: unknown tax code.', v_src using errcode = '22023';
      end if;
      if not v_tax_active then
        raise exception 'Line %: tax code % is inactive.', v_src, v_tax_code using errcode = '22023';
      end if;
    end if;

    v_side := case when v_dr > 0 then 'debit' else 'credit' end;
    v_amount := greatest(v_dr, v_cr);
    v_gst := 0;
    if v_tax_id is not null and v_tax_rate > 0 then
      if v_gst_account is null then
        raise exception 'There is no active GST account.' using errcode = '22023';
      end if;
      v_gst := case when p_amounts_are = 'inclusive' then round(v_amount * v_tax_rate / (1 + v_tax_rate), 2) else round(v_amount * v_tax_rate, 2) end;
    end if;
    v_net := case when p_amounts_are = 'inclusive' then v_amount - v_gst else v_amount end;

    v_no := v_no + 1;
    v_out := v_out || jsonb_build_object('line_no', v_no, 'account_id', v_acc.id, 'description', left(coalesce(l->>'description', ''), 300),
      'debit', case when v_side = 'debit' then v_net else 0 end, 'credit', case when v_side = 'credit' then v_net else 0 end,
      'tax_code_id', v_tax_id, 'tax_amount', v_gst, 'entered_amount', v_amount, 'is_tax_line', false, 'source_line_no', null);
    v_total_dr := v_total_dr + case when v_side = 'debit' then v_net else 0 end;
    v_total_cr := v_total_cr + case when v_side = 'credit' then v_net else 0 end;
    if v_gst > 0 then
      v_no := v_no + 1;
      v_out := v_out || jsonb_build_object('line_no', v_no, 'account_id', v_gst_account, 'description', 'GST (' || v_tax_code || ')' || coalesce(': ' || nullif(l->>'description', ''), ''),
        'debit', case when v_side = 'debit' then v_gst else 0 end, 'credit', case when v_side = 'credit' then v_gst else 0 end,
        'tax_code_id', v_tax_id, 'tax_amount', 0, 'entered_amount', null, 'is_tax_line', true, 'source_line_no', v_no - 1);
      v_total_dr := v_total_dr + case when v_side = 'debit' then v_gst else 0 end;
      v_total_cr := v_total_cr + case when v_side = 'credit' then v_gst else 0 end;
    end if;
  end loop;
  return jsonb_build_object('lines', v_out, 'debit', v_total_dr, 'credit', v_total_cr);
end;
$$;

-- Finds the period for a date and checks it accepts postings from this person.
create or replace function public.ledger_period_for(p_actor uuid, p_org uuid, p_date date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public.accounting_periods where organization_id = p_org and p_date between start_date and end_date;
  if not found then
    raise exception 'No accounting period covers %. Add that financial year first.', to_char(p_date, 'DD Mon YYYY') using errcode = '22023';
  end if;
  if v.status = 'closed' then
    raise exception 'The period % to % is closed.', to_char(v.start_date, 'DD Mon YYYY'), to_char(v.end_date, 'DD Mon YYYY') using errcode = '22023';
  end if;
  if v.status = 'soft_locked' and not public.app_has(p_actor, 'ledger.reopen') then
    raise exception 'The period % to % is locked. Only someone who can reopen periods can post into it.', to_char(v.start_date, 'DD Mon YYYY'), to_char(v.end_date, 'DD Mon YYYY') using errcode = '22023';
  end if;
  return v.id;
end;
$$;

-- THE posting engine: the only way lines reach the ledger. Every module
-- (invoices, bills, payments, pay runs, depreciation) calls this.
create or replace function public.ledger_post_entry(p_actor uuid, p_date date, p_memo text, p_source_type text, p_source_id uuid,
  p_source_ref text, p_lines jsonb, p_amounts_are text default 'exclusive', p_manual boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_built jsonb;
  v_id uuid;
  v_period uuid;
begin
  if v_org is null then
    raise exception 'Unknown organisation.' using errcode = '42501';
  end if;
  v_period := public.ledger_period_for(p_actor, v_org, p_date);
  v_built := public.ledger_build_lines(v_org, p_lines, coalesce(p_amounts_are, 'exclusive'), p_manual);
  if (v_built->>'debit')::numeric <> (v_built->>'credit')::numeric then
    raise exception 'Debits (%) and credits (%) must be equal.', to_char((v_built->>'debit')::numeric, 'FM999,999,990.00'), to_char((v_built->>'credit')::numeric, 'FM999,999,990.00') using errcode = '22023';
  end if;
  -- Lines go in while the entry is a draft; posting it then locks both.
  insert into public.journal_entries (organization_id, number, entry_date, period_id, memo, amounts_are, status, source_type, source_id, source_ref, created_by)
  values (v_org, public.next_document_number(v_org, 'journal'), p_date, v_period, left(coalesce(p_memo, ''), 500), coalesce(p_amounts_are, 'exclusive'),
    'draft', p_source_type, p_source_id, p_source_ref, p_actor)
  returning id into v_id;
  insert into public.journal_lines (journal_id, line_no, account_id, description, debit, credit, tax_code_id, tax_amount, entered_amount, is_tax_line, source_line_no)
  select v_id, (x->>'line_no')::int, (x->>'account_id')::uuid, x->>'description', (x->>'debit')::numeric, (x->>'credit')::numeric,
    nullif(x->>'tax_code_id', '')::uuid, (x->>'tax_amount')::numeric, nullif(x->>'entered_amount', '')::numeric, (x->>'is_tax_line')::boolean, nullif(x->>'source_line_no', '')::int
  from jsonb_array_elements(v_built->'lines') x;
  update public.journal_entries set status = 'posted', posted_by = p_actor, posted_at = now() where id = v_id;
  perform public.app_audit(p_actor, 'journal_posted', 'journal', v_id::text, null,
    jsonb_build_object('number', (select number from public.journal_entries where id = v_id), 'date', p_date, 'total', (v_built->>'debit')::numeric, 'source', p_source_type, 'ref', p_source_ref));
  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 6. Manual journals: draft, post, reverse
------------------------------------------------------------------------------

create or replace function public.journal_save_draft(p_actor uuid, p_id uuid, p_date date, p_memo text, p_amounts_are text, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_built jsonb;
  v_id uuid := p_id;
  v_row record;
begin
  perform public.app_require(p_actor, 'ledger.journal');
  if p_date is null then
    raise exception 'Choose the journal date.' using errcode = '22023';
  end if;
  v_built := public.ledger_build_lines(v_org, p_lines, coalesce(p_amounts_are, 'exclusive'), true);
  if v_id is null then
    insert into public.journal_entries (organization_id, entry_date, memo, amounts_are, created_by)
    values (v_org, p_date, left(coalesce(p_memo, ''), 500), coalesce(p_amounts_are, 'exclusive'), p_actor)
    returning id into v_id;
  else
    select * into v_row from public.journal_entries where id = v_id and organization_id = v_org for update;
    if not found then
      raise exception 'Journal not found.' using errcode = 'P0002';
    end if;
    if v_row.status <> 'draft' then
      raise exception 'Only a draft can be edited. Reverse a posted journal instead.' using errcode = '22023';
    end if;
    update public.journal_entries set entry_date = p_date, memo = left(coalesce(p_memo, ''), 500), amounts_are = coalesce(p_amounts_are, 'exclusive'), updated_at = now()
    where id = v_id;
    delete from public.journal_lines where journal_id = v_id;
  end if;
  insert into public.journal_lines (journal_id, line_no, account_id, description, debit, credit, tax_code_id, tax_amount, entered_amount, is_tax_line, source_line_no)
  select v_id, (x->>'line_no')::int, (x->>'account_id')::uuid, x->>'description', (x->>'debit')::numeric, (x->>'credit')::numeric,
    nullif(x->>'tax_code_id', '')::uuid, (x->>'tax_amount')::numeric, nullif(x->>'entered_amount', '')::numeric, (x->>'is_tax_line')::boolean, nullif(x->>'source_line_no', '')::int
  from jsonb_array_elements(v_built->'lines') x;
  perform public.app_audit(p_actor, case when p_id is null then 'journal_draft_created' else 'journal_draft_saved' end, 'journal', v_id::text, null,
    jsonb_build_object('date', p_date, 'debit', (v_built->>'debit')::numeric, 'credit', (v_built->>'credit')::numeric));
  return v_id;
end;
$$;

-- Posts a draft. The journal is rebuilt from the entered lines so what is
-- posted always follows the current rules. Whoever posts needs ledger.post;
-- a draft from someone without it therefore always gets a second person.
create or replace function public.journal_post(p_actor uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_row record;
  v_lines jsonb;
  v_built jsonb;
  v_period uuid;
  v_number text;
begin
  perform public.app_require(p_actor, 'ledger.post');
  select * into v_row from public.journal_entries where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'Journal not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'draft' then
    raise exception 'This journal is already posted.' using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object('accountId', account_id, 'description', description,
           'debit', case when debit > 0 then coalesce(entered_amount, debit) else 0 end,
           'credit', case when credit > 0 then coalesce(entered_amount, credit) else 0 end, 'taxCodeId', tax_code_id) order by line_no)
    into v_lines from public.journal_lines where journal_id = p_id and not is_tax_line;
  v_period := public.ledger_period_for(p_actor, v_org, v_row.entry_date);
  v_built := public.ledger_build_lines(v_org, v_lines, v_row.amounts_are, true);
  if (v_built->>'debit')::numeric <> (v_built->>'credit')::numeric then
    raise exception 'Debits (%) and credits (%) must be equal before posting.', to_char((v_built->>'debit')::numeric, 'FM999,999,990.00'), to_char((v_built->>'credit')::numeric, 'FM999,999,990.00') using errcode = '22023';
  end if;
  delete from public.journal_lines where journal_id = p_id;
  insert into public.journal_lines (journal_id, line_no, account_id, description, debit, credit, tax_code_id, tax_amount, entered_amount, is_tax_line, source_line_no)
  select p_id, (x->>'line_no')::int, (x->>'account_id')::uuid, x->>'description', (x->>'debit')::numeric, (x->>'credit')::numeric,
    nullif(x->>'tax_code_id', '')::uuid, (x->>'tax_amount')::numeric, nullif(x->>'entered_amount', '')::numeric, (x->>'is_tax_line')::boolean, nullif(x->>'source_line_no', '')::int
  from jsonb_array_elements(v_built->'lines') x;
  v_number := public.next_document_number(v_org, 'journal');
  update public.journal_entries set status = 'posted', number = v_number, period_id = v_period, posted_by = p_actor, posted_at = now(), updated_at = now()
  where id = p_id;
  perform public.app_audit(p_actor, 'journal_posted', 'journal', p_id::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'posted', 'number', v_number, 'total', (v_built->>'debit')::numeric, 'createdBy', v_row.created_by));
  return v_number;
end;
$$;

create or replace function public.journal_delete_draft(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  select * into v_row from public.journal_entries where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then
    raise exception 'Journal not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'draft' then
    raise exception 'A posted journal cannot be deleted. Reverse it instead.' using errcode = '22023';
  end if;
  if not (public.app_has(p_actor, 'ledger.post') or (v_row.created_by = p_actor and public.app_has(p_actor, 'ledger.journal'))) then
    raise exception 'You can delete only your own drafts.' using errcode = '42501';
  end if;
  delete from public.journal_entries where id = p_id;
  perform public.app_audit(p_actor, 'journal_draft_deleted', 'journal', p_id::text, jsonb_build_object('date', v_row.entry_date, 'memo', v_row.memo), null);
end;
$$;

-- Posts the mirror image of a posted journal and marks the original reversed.
create or replace function public.journal_reverse(p_actor uuid, p_id uuid, p_date date, p_reason text)
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
  perform public.app_require(p_actor, 'ledger.post');
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

------------------------------------------------------------------------------
-- 7. Accounts, tax codes and periods: maintenance
------------------------------------------------------------------------------

create or replace function public.account_save(p_actor uuid, p_id uuid, p_code text, p_name text, p_type text, p_subtype text,
  p_description text, p_default_tax uuid, p_allow_manual boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old record;
  v_id uuid := p_id;
  v_used boolean;
begin
  perform public.app_require(p_actor, 'ledger.manage');
  if p_default_tax is not null and not exists (select 1 from public.tax_codes where id = p_default_tax and organization_id = v_org) then
    raise exception 'Unknown tax code.' using errcode = '22023';
  end if;
  if exists (select 1 from public.accounts where organization_id = v_org and code = upper(btrim(p_code)) and id is distinct from p_id) then
    raise exception 'Account code % is already used.', upper(btrim(p_code)) using errcode = '23505';
  end if;
  if p_subtype in ('retained_earnings', 'current_year_earnings', 'gst', 'receivable', 'payable')
     and (p_id is null or p_subtype is distinct from (select subtype from public.accounts where id = p_id)) then
    raise exception 'That account kind is reserved for the system accounts.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.accounts (organization_id, code, name, type, subtype, description, default_tax_code_id, allow_manual, created_by)
    values (v_org, upper(btrim(p_code)), btrim(p_name), p_type, coalesce(p_subtype, 'general'), coalesce(p_description, ''), p_default_tax, coalesce(p_allow_manual, true), p_actor)
    returning id into v_id;
    perform public.app_audit(p_actor, 'account_created', 'account', v_id::text, null,
      jsonb_build_object('code', upper(btrim(p_code)), 'name', btrim(p_name), 'type', p_type));
    return v_id;
  end if;
  select * into v_old from public.accounts where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  v_used := exists (select 1 from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id where jl.account_id = p_id and je.status <> 'draft');
  if (p_type is distinct from v_old.type or coalesce(p_subtype, 'general') is distinct from v_old.subtype) and (v_old.is_system or v_used) then
    raise exception 'The type of a system account, or an account with posted entries, cannot change.' using errcode = '22023';
  end if;
  if v_old.is_system and coalesce(p_allow_manual, true) is distinct from v_old.allow_manual then
    raise exception 'Manual posting rules of system accounts are fixed.' using errcode = '22023';
  end if;
  update public.accounts set code = upper(btrim(p_code)), name = btrim(p_name), type = p_type, subtype = coalesce(p_subtype, 'general'),
    description = coalesce(p_description, ''), default_tax_code_id = p_default_tax, allow_manual = coalesce(p_allow_manual, true), updated_at = now()
  where id = p_id;
  perform public.app_audit(p_actor, 'account_updated', 'account', p_id::text,
    jsonb_build_object('code', v_old.code, 'name', v_old.name, 'type', v_old.type, 'defaultTax', v_old.default_tax_code_id),
    jsonb_build_object('code', upper(btrim(p_code)), 'name', btrim(p_name), 'type', p_type, 'defaultTax', p_default_tax));
  return p_id;
end;
$$;

create or replace function public.account_set_status(p_actor uuid, p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_balance numeric;
begin
  perform public.app_require(p_actor, 'ledger.manage');
  select * into v from public.accounts where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  if not p_active then
    if v.is_system then
      raise exception 'System accounts cannot be archived.' using errcode = '22023';
    end if;
    select coalesce(sum(jl.debit - jl.credit), 0) into v_balance
    from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id
    where jl.account_id = p_id and je.status <> 'draft';
    if v_balance <> 0 and v.type in ('asset', 'liability', 'equity') then
      raise exception 'Move the balance out of % first (balance %).', v.code, v_balance using errcode = '22023';
    end if;
  end if;
  update public.accounts set status = case when p_active then 'active' else 'archived' end, updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, case when p_active then 'account_restored' else 'account_archived' end, 'account', p_id::text,
    jsonb_build_object('status', v.status), jsonb_build_object('status', case when p_active then 'active' else 'archived' end));
end;
$$;

create or replace function public.tax_code_save(p_actor uuid, p_id uuid, p_code text, p_name text, p_kind text, p_rate numeric,
  p_applies_to text, p_description text, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old record;
  v_id uuid := p_id;
begin
  perform public.app_require(p_actor, 'ledger.manage');
  if v_id is null then
    insert into public.tax_codes (organization_id, code, name, kind, rate, applies_to, description, active, bas_labels)
    values (v_org, upper(btrim(p_code)), btrim(p_name), p_kind, coalesce(p_rate, 0), p_applies_to, coalesce(p_description, ''), coalesce(p_active, true),
      (select bas_labels from public.tax_codes where organization_id = v_org and kind = p_kind and is_system order by sort limit 1))
    returning id into v_id;
    perform public.app_audit(p_actor, 'tax_code_created', 'tax_code', v_id::text, null, jsonb_build_object('code', upper(btrim(p_code)), 'rate', p_rate, 'kind', p_kind));
    return v_id;
  end if;
  select * into v_old from public.tax_codes where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'Tax code not found.' using errcode = 'P0002';
  end if;
  if (coalesce(p_rate, 0) is distinct from v_old.rate or p_kind is distinct from v_old.kind or upper(btrim(p_code)) is distinct from v_old.code)
     and (v_old.is_system or exists (select 1 from public.journal_lines where tax_code_id = p_id)) then
    raise exception 'The code, kind and rate of a system or used tax code are fixed. Create a new tax code instead.' using errcode = '22023';
  end if;
  update public.tax_codes set code = upper(btrim(p_code)), name = btrim(p_name), kind = p_kind, rate = coalesce(p_rate, 0), applies_to = p_applies_to,
    description = coalesce(p_description, ''), active = coalesce(p_active, true)
  where id = p_id;
  perform public.app_audit(p_actor, 'tax_code_updated', 'tax_code', p_id::text,
    jsonb_build_object('name', v_old.name, 'active', v_old.active, 'rate', v_old.rate),
    jsonb_build_object('name', btrim(p_name), 'active', coalesce(p_active, true), 'rate', coalesce(p_rate, 0)));
  return p_id;
end;
$$;

create or replace function public.period_set_status(p_actor uuid, p_period uuid, p_status text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public.accounting_periods where id = p_period and organization_id = public.app_org_of(p_actor) for update;
  if not found then
    raise exception 'Period not found.' using errcode = 'P0002';
  end if;
  if p_status not in ('open', 'soft_locked', 'closed') then
    raise exception 'Unknown period status.' using errcode = '22023';
  end if;
  if p_status = v.status then
    return;
  end if;
  if v.status = 'closed' then
    perform public.app_require(p_actor, 'ledger.reopen');
    if length(btrim(coalesce(p_reason, ''))) < 3 then
      raise exception 'Give a reason for reopening a closed period.' using errcode = '22023';
    end if;
  else
    perform public.app_require(p_actor, 'ledger.post');
  end if;
  update public.accounting_periods set status = p_status, status_changed_by = p_actor, status_changed_at = now() where id = p_period;
  perform public.app_audit(p_actor, case when v.status = 'closed' then 'period_reopened' else 'period_status_changed' end, 'accounting_period', p_period::text,
    jsonb_build_object('status', v.status), jsonb_build_object('status', p_status, 'reason', nullif(btrim(coalesce(p_reason, '')), '')),
    jsonb_build_object('start', v.start_date, 'end', v.end_date));
end;
$$;

create or replace function public.financial_year_add(p_actor uuid, p_date date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.app_require(p_actor, 'ledger.manage');
  v_id := public.ledger_ensure_year(public.app_org_of(p_actor), p_date);
  perform public.app_audit(p_actor, 'financial_year_added', 'financial_year', v_id::text, null,
    (select jsonb_build_object('name', name, 'start', start_date, 'end', end_date) from public.financial_years where id = v_id));
  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 8. Reports (posted and reversed journals both count: a reversal is its own
--    posted journal, so the pair nets to nil)
------------------------------------------------------------------------------

create or replace function public.ledger_fy_start(p_org uuid, p_date date)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select start_date from public.financial_years where organization_id = p_org and p_date between start_date and end_date),
    (select case when make_date(extract(year from p_date)::int, m, 1) > p_date then (make_date(extract(year from p_date)::int, m, 1) - interval '1 year')::date
                 else make_date(extract(year from p_date)::int, m, 1) end
     from (select coalesce((select financial_year_start_month from public.company_settings where organization_id = p_org), 7) as m) s));
$$;

-- Balance per account (debit minus credit) over a date range.
create or replace function public.ledger_balances(p_org uuid, p_from date, p_to date)
returns table (account_id uuid, debit numeric, credit numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select jl.account_id, sum(jl.debit), sum(jl.credit)
  from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id
  where je.organization_id = p_org and je.status in ('posted', 'reversed')
    and (p_from is null or je.entry_date >= p_from) and je.entry_date <= p_to
  group by jl.account_id;
$$;

create or replace function public.report_trial_balance(p_actor uuid, p_as_at date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_fy date := public.ledger_fy_start(v_org, p_as_at);
  v_prior numeric;
  v_rows jsonb;
begin
  -- Profit and loss accounts show this financial year only; earlier years
  -- have rolled into retained earnings.
  select coalesce(sum(b.credit - b.debit), 0) into v_prior
  from public.ledger_balances(v_org, null, v_fy - 1) b join public.accounts a on a.id = b.account_id
  where a.type in ('revenue', 'cost_of_sales', 'expense', 'other_income', 'other_expense');
  with bal as (
    select a.id, a.code, a.name, a.type, a.subtype,
      coalesce((select b.debit - b.credit from public.ledger_balances(v_org, case when a.type in ('asset', 'liability', 'equity') then null else v_fy end, p_as_at) b where b.account_id = a.id), 0)
      - case when a.subtype = 'retained_earnings' then v_prior else 0 end as net
    from public.accounts a where a.organization_id = v_org
  )
  select coalesce(jsonb_agg(jsonb_build_object('accountId', id, 'code', code, 'name', name, 'type', type,
           'debit', case when net > 0 then net else 0 end, 'credit', case when net < 0 then -net else 0 end) order by code), '[]'::jsonb)
    into v_rows from bal where net <> 0;
  return jsonb_build_object('asAt', p_as_at, 'financialYearStart', v_fy, 'rows', v_rows,
    'totalDebit', (select coalesce(sum((r->>'debit')::numeric), 0) from jsonb_array_elements(v_rows) r),
    'totalCredit', (select coalesce(sum((r->>'credit')::numeric), 0) from jsonb_array_elements(v_rows) r));
end;
$$;

create or replace function public.report_profit_loss(p_actor uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_rows jsonb;
  t record;
begin
  if p_from > p_to then
    raise exception 'The start date is after the end date.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('accountId', a.id, 'code', a.code, 'name', a.name, 'type', a.type,
           'amount', case when public.account_normal_side(a.type) = 'credit' then b.credit - b.debit else b.debit - b.credit end) order by a.code), '[]'::jsonb)
    into v_rows
  from public.ledger_balances(v_org, p_from, p_to) b join public.accounts a on a.id = b.account_id
  where a.type in ('revenue', 'cost_of_sales', 'expense', 'other_income', 'other_expense') and b.debit <> b.credit;
  select
    coalesce(sum((r->>'amount')::numeric) filter (where r->>'type' = 'revenue'), 0) as revenue,
    coalesce(sum((r->>'amount')::numeric) filter (where r->>'type' = 'cost_of_sales'), 0) as cos,
    coalesce(sum((r->>'amount')::numeric) filter (where r->>'type' = 'expense'), 0) as expense,
    coalesce(sum((r->>'amount')::numeric) filter (where r->>'type' = 'other_income'), 0) as other_income,
    coalesce(sum((r->>'amount')::numeric) filter (where r->>'type' = 'other_expense'), 0) as other_expense
  into t from jsonb_array_elements(v_rows) r;
  return jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_rows,
    'totals', jsonb_build_object('revenue', t.revenue, 'costOfSales', t.cos, 'grossProfit', t.revenue - t.cos,
      'expenses', t.expense, 'operatingProfit', t.revenue - t.cos - t.expense, 'otherIncome', t.other_income, 'otherExpenses', t.other_expense,
      'netProfit', t.revenue - t.cos - t.expense + t.other_income - t.other_expense,
      'grossMarginPercent', case when t.revenue = 0 then null else round((t.revenue - t.cos) / t.revenue * 100, 1) end));
end;
$$;

create or replace function public.report_balance_sheet(p_actor uuid, p_as_at date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_fy date := public.ledger_fy_start(v_org, p_as_at);
  v_rows jsonb;
  v_prior numeric; v_current numeric;
  v_assets numeric; v_liab numeric; v_equity numeric;
begin
  select coalesce(sum(b.credit - b.debit), 0) into v_prior
  from public.ledger_balances(v_org, null, v_fy - 1) b join public.accounts a on a.id = b.account_id
  where a.type in ('revenue', 'cost_of_sales', 'expense', 'other_income', 'other_expense');
  select coalesce(sum(b.credit - b.debit), 0) into v_current
  from public.ledger_balances(v_org, v_fy, p_as_at) b join public.accounts a on a.id = b.account_id
  where a.type in ('revenue', 'cost_of_sales', 'expense', 'other_income', 'other_expense');
  select coalesce(jsonb_agg(jsonb_build_object('accountId', a.id, 'code', a.code, 'name', a.name, 'type', a.type, 'subtype', a.subtype,
           'amount', case when a.type = 'asset' then b.debit - b.credit else b.credit - b.debit end) order by a.code), '[]'::jsonb)
    into v_rows
  from public.ledger_balances(v_org, null, p_as_at) b join public.accounts a on a.id = b.account_id
  where a.type in ('asset', 'liability', 'equity') and b.debit <> b.credit;
  select coalesce(sum((r->>'amount')::numeric) filter (where r->>'type' = 'asset'), 0),
         coalesce(sum((r->>'amount')::numeric) filter (where r->>'type' = 'liability'), 0),
         coalesce(sum((r->>'amount')::numeric) filter (where r->>'type' = 'equity'), 0)
    into v_assets, v_liab, v_equity from jsonb_array_elements(v_rows) r;
  return jsonb_build_object('asAt', p_as_at, 'financialYearStart', v_fy, 'rows', v_rows,
    'retainedEarningsPriorYears', v_prior, 'currentYearEarnings', v_current,
    'totals', jsonb_build_object('assets', v_assets, 'liabilities', v_liab, 'netAssets', v_assets - v_liab,
      'equity', v_equity + v_prior + v_current, 'balanced', v_assets - v_liab = v_equity + v_prior + v_current));
end;
$$;

create or replace function public.report_account_transactions(p_actor uuid, p_account uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_acc record;
  v_open numeric;
  v_open_from date;
  v_rows jsonb;
begin
  select * into v_acc from public.accounts where id = p_account and organization_id = v_org;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  v_open_from := case when v_acc.type in ('asset', 'liability', 'equity') then null else public.ledger_fy_start(v_org, p_from) end;
  select coalesce((select b.debit - b.credit from public.ledger_balances(v_org, v_open_from, p_from - 1) b where b.account_id = p_account), 0) into v_open;
  select coalesce(jsonb_agg(x order by x->>'date', x->>'number', (x->>'lineNo')::int), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('journalId', je.id, 'number', je.number, 'date', je.entry_date, 'memo', je.memo, 'source', je.source_type, 'sourceRef', je.source_ref,
      'status', je.status, 'lineNo', jl.line_no, 'description', jl.description, 'debit', jl.debit, 'credit', jl.credit,
      'taxCode', (select code from public.tax_codes where id = jl.tax_code_id)) as x
    from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id
    where jl.account_id = p_account and je.organization_id = v_org and je.status in ('posted', 'reversed') and je.entry_date between p_from and p_to
    limit 5000
  ) s;
  return jsonb_build_object('account', jsonb_build_object('id', v_acc.id, 'code', v_acc.code, 'name', v_acc.name, 'type', v_acc.type,
      'normalSide', public.account_normal_side(v_acc.type)),
    'from', p_from, 'to', p_to, 'openingBalance', v_open, 'rows', v_rows,
    'closingBalance', v_open + (select coalesce(sum((r->>'debit')::numeric - (r->>'credit')::numeric), 0) from jsonb_array_elements(v_rows) r));
end;
$$;

------------------------------------------------------------------------------
-- 9. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['financial_years', 'accounting_periods', 'tax_codes', 'accounts', 'journal_entries', 'journal_lines']
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
  foreach f in array array[
    'ledger_ensure_year(uuid, date)', 'ledger_build_lines(uuid, jsonb, text, boolean)', 'ledger_period_for(uuid, uuid, date)',
    'ledger_post_entry(uuid, date, text, text, uuid, text, jsonb, text, boolean)', 'journal_save_draft(uuid, uuid, date, text, text, jsonb)',
    'journal_post(uuid, uuid)', 'journal_delete_draft(uuid, uuid)', 'journal_reverse(uuid, uuid, date, text)',
    'account_save(uuid, uuid, text, text, text, text, text, uuid, boolean)', 'account_set_status(uuid, uuid, boolean)',
    'tax_code_save(uuid, uuid, text, text, text, numeric, text, text, boolean)', 'period_set_status(uuid, uuid, text, text)',
    'financial_year_add(uuid, date)', 'ledger_fy_start(uuid, date)', 'ledger_balances(uuid, date, date)',
    'report_trial_balance(uuid, date)', 'report_profit_loss(uuid, date, date)', 'report_balance_sheet(uuid, date)',
    'report_account_transactions(uuid, uuid, date, date)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
grant execute on function public.account_normal_side(text) to service_role;

comment on function public.ledger_post_entry is 'The one posting engine. Modules post through this; nothing else writes posted journal lines.';

commit;
