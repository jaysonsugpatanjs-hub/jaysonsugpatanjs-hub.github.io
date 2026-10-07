-- Panalo Accounts, Phase 8 (part 2): fixed assets.
--
-- * An asset register: number, description, category, purchase (date,
--   supplier, bill, cost before GST, GST), serial number, location,
--   custodian, project, and accounting depreciation (straight line or
--   diminishing value, useful life, residual value), with documents.
-- * Tax treatment is recorded separately (method, effective life, notes) for
--   the accountant. It is never claimed or posted from here: an accounting
--   depreciation entry is not a tax deduction.
-- * Depreciation runs a month at a time: one journal per month, Dr the
--   category's depreciation expense, Cr its accumulated depreciation. The
--   latest run can be undone.
-- * Disposal: depreciation for the part month, then the asset leaves the
--   books. Proceeds (with GST on a taxable sale) are credited to proceeds on
--   sale, the book value is expensed, so the gain or loss shows in the P&L.
-- * The register is reconciled to the asset and accumulated depreciation
--   accounts.
--
-- Creating an asset doesn't post anything: its cost is already in the ledger
-- from the bill (or the opening balances) that bought it.

begin;

------------------------------------------------------------------------------
-- 1. Permission, accounts, numbering
------------------------------------------------------------------------------

insert into public.app_permissions (key, name, description, sort, area, admin_default, requires_mfa) values
  ('assets.manage', 'Fixed assets', 'Keep the asset register, run depreciation and record disposals.', 236, 'Accounts', true, true);
insert into public.app_role_permissions (role_key, permission_key) values
  ('super_admin', 'assets.manage'), ('director', 'assets.manage'), ('finance_admin', 'assets.manage');

insert into public.accounts (organization_id, code, name, type, subtype, is_system, allow_manual, default_tax_code_id, description)
select o.id, c, n, t, 'general', true, true, (select id from public.tax_codes where organization_id = o.id and code = tx), d
from public.organizations o, (values
  ('4950', 'Proceeds from Sale of Assets', 'other_income', 'GST', 'What fixed assets were sold for (before GST).'),
  ('7810', 'Book Value of Assets Disposed', 'other_expense', 'NG', 'Cost less accumulated depreciation of assets sold or written off.')
) as v(c, n, t, tx, d)
where exists (select 1 from public.accounts a where a.organization_id = o.id)
on conflict (organization_id, code) do nothing;

alter table public.number_sequences drop constraint number_sequences_kind_check;
alter table public.number_sequences add constraint number_sequences_kind_check
  check (kind in ('invoice', 'quote', 'purchase_order', 'credit_note', 'bill', 'journal', 'pay_run', 'project', 'payment_batch', 'asset'));
insert into public.number_sequences (organization_id, kind, prefix, next_number, padding)
select id, 'asset', 'FA-', 1, 4 from public.organizations on conflict do nothing;

------------------------------------------------------------------------------
-- 2. Tables
------------------------------------------------------------------------------

create table public.asset_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name text not null check (length(btrim(name)) between 2 and 80),
  asset_account_id uuid not null references public.accounts(id) on delete restrict,
  accumulated_account_id uuid not null references public.accounts(id) on delete restrict,
  expense_account_id uuid not null references public.accounts(id) on delete restrict,
  method text not null default 'straight_line' check (method in ('straight_line', 'diminishing_value', 'none')),
  useful_life_months integer check (useful_life_months is null or useful_life_months between 1 and 1200),
  tax_effective_life_years numeric(5,2),
  active boolean not null default true,
  unique (organization_id, name)
);

-- Defaults from the chart's asset accounts. Lives are accounting estimates to
-- confirm with the accountant (tax effective lives are the ATO's, separate).
insert into public.asset_categories (organization_id, name, asset_account_id, accumulated_account_id, expense_account_id, method, useful_life_months)
select o.id, n, (select id from public.accounts where organization_id = o.id and code = a), (select id from public.accounts where organization_id = o.id and code = ad),
  (select id from public.accounts where organization_id = o.id and code = '7800'), m, l
from public.organizations o, (values
  ('Tools and equipment', '1500', '1510', 'straight_line', 60),
  ('Vehicles', '1600', '1610', 'diminishing_value', 96),
  ('Plant and machinery', '1700', '1710', 'straight_line', 120),
  ('Office equipment', '1800', '1810', 'straight_line', 36)
) as v(n, a, ad, m, l)
where exists (select 1 from public.accounts where organization_id = o.id and code = a)
  and exists (select 1 from public.accounts where organization_id = o.id and code = ad)
  and exists (select 1 from public.accounts where organization_id = o.id and code = '7800')
on conflict do nothing;

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  number text not null,
  name text not null check (length(btrim(name)) between 2 and 160),
  description text not null default '' check (length(description) <= 2000),
  category_id uuid not null references public.asset_categories(id) on delete restrict,
  purchase_date date not null,
  in_service_date date not null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  bill_id uuid references public.bills(id) on delete set null,
  cost numeric(14,2) not null check (cost > 0),           -- before GST
  gst numeric(14,2) not null default 0 check (gst >= 0),
  serial_number text check (serial_number is null or length(serial_number) <= 80),
  location text check (location is null or length(location) <= 120),
  custodian_id uuid references public.employees(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  -- Accounting depreciation.
  method text not null check (method in ('straight_line', 'diminishing_value', 'none')),
  useful_life_months integer check (useful_life_months is null or useful_life_months between 1 and 1200),
  residual_value numeric(14,2) not null default 0 check (residual_value >= 0),
  opening_accumulated numeric(14,2) not null default 0 check (opening_accumulated >= 0), -- depreciation before it came into this register
  opening_date date,                                                                    -- the date the opening figure is at
  -- Tax treatment, for the accountant: recorded, not posted or claimed here.
  tax_method text check (tax_method is null or tax_method in ('prime_cost', 'diminishing_value', 'instant_write_off', 'small_business_pool', 'not_depreciable')),
  tax_effective_life_years numeric(5,2) check (tax_effective_life_years is null or tax_effective_life_years > 0),
  tax_notes text not null default '' check (length(tax_notes) <= 1000),
  status text not null default 'active' check (status in ('active', 'disposed')),
  disposal_date date,
  disposal_proceeds numeric(14,2),
  disposal_gst numeric(14,2),
  disposal_reason text,
  disposal_journal_id uuid references public.journal_entries(id) on delete restrict,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, number),
  check (in_service_date >= purchase_date),
  check (residual_value < cost),
  check (opening_accumulated <= cost - residual_value),
  check (method = 'none' or useful_life_months is not null),
  check ((status = 'disposed') = (disposal_date is not null))
);
create index assets_org_idx on public.assets (organization_id, status, category_id);

create table public.asset_depreciation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  period_end date not null, -- the last day of a month
  journal_id uuid references public.journal_entries(id) on delete restrict,
  total numeric(14,2) not null default 0,
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  reversed_by uuid references public.training_profiles(id) on delete set null,
  reversed_at timestamptz,
  reverse_reason text
);
create unique index asset_depreciation_runs_month on public.asset_depreciation_runs (organization_id, period_end) where status = 'posted';

create table public.asset_depreciation (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete restrict,
  run_id uuid references public.asset_depreciation_runs(id) on delete cascade, -- null: in a disposal journal
  period_start date not null,
  period_end date not null,
  amount numeric(14,2) not null check (amount >= 0),
  journal_id uuid references public.journal_entries(id) on delete restrict
);
create index asset_depreciation_asset_idx on public.asset_depreciation (asset_id, period_end);

------------------------------------------------------------------------------
-- 3. Depreciation
------------------------------------------------------------------------------

-- Accumulated depreciation of an asset up to and including a date.
create or replace function public.asset_accumulated(p_asset uuid, p_as_at date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select a.opening_accumulated + coalesce((select sum(d.amount) from public.asset_depreciation d
    left join public.asset_depreciation_runs r on r.id = d.run_id
    where d.asset_id = a.id and d.period_end <= p_as_at and (d.run_id is null or r.status = 'posted')), 0)
  from public.assets a where a.id = p_asset;
$$;

-- Depreciation for one asset over a span (whole months or part of one):
-- straight line on cost less residual over the useful life; diminishing value
-- at 200% of the straight-line rate on the book value at the start; never
-- below the residual value. Part months by days.
create or replace function public.asset_depreciation_for(p_asset uuid, p_from date, p_to date)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v_start date;
  v_book numeric;
  v_left numeric;
  v_months numeric := 0;
  m date;
  v_days int; v_in int;
  v_amt numeric := 0;
  v_monthly numeric;
begin
  select * into a from public.assets where id = p_asset;
  if a.method = 'none' or a.useful_life_months is null then return 0; end if;
  v_start := greatest(p_from, a.in_service_date, coalesce(a.opening_date + 1, a.in_service_date));
  if v_start > p_to then return 0; end if;
  v_book := a.cost - public.asset_accumulated(p_asset, v_start - 1);
  v_left := v_book - a.residual_value;
  if v_left <= 0 then return 0; end if;
  -- Month by month (part months by days).
  m := date_trunc('month', v_start)::date;
  while m <= p_to loop
    v_days := extract(day from (m + interval '1 month - 1 day'))::int;
    v_in := (least(p_to, (m + interval '1 month - 1 day')::date) - greatest(v_start, m) + 1);
    if v_in > 0 then
      if a.method = 'straight_line' then
        v_monthly := (a.cost - a.residual_value) / a.useful_life_months;
      else
        v_monthly := (v_book - v_amt) * (2.0 / a.useful_life_months);
      end if;
      v_amt := v_amt + v_monthly * v_in / v_days;
    end if;
    m := (m + interval '1 month')::date;
  end loop;
  return round(least(v_amt, v_left), 2);
end;
$$;

-- Runs depreciation for the month ending p_period_end: each active asset from
-- the day after its last depreciation (catching up any missed months) to the
-- month end. One journal, by category.
create or replace function public.asset_depreciation_run(p_actor uuid, p_period_end date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_last date;
  v_run uuid;
  a record;
  v_from date;
  v_amt numeric;
  v_lines jsonb := '[]'::jsonb;
  c record;
  v_journal uuid;
  v_total numeric;
  -- Depreciation isn't reported on the BAS: coded NG so the BAS checks don't flag it.
  v_ng uuid := (select id from public.tax_codes where organization_id = public.app_org_of(p_actor) and kind = 'no_gst' and active order by is_system desc, sort limit 1);
begin
  perform public.app_require(p_actor, 'assets.manage');
  if p_period_end is null or p_period_end <> (date_trunc('month', p_period_end) + interval '1 month - 1 day')::date then
    raise exception 'Depreciation runs to the last day of a month.' using errcode = '22023';
  end if;
  perform 1 from public.company_settings where organization_id = v_org for update; -- one run at a time
  select max(period_end) into v_last from public.asset_depreciation_runs where organization_id = v_org and status = 'posted';
  if v_last is not null and p_period_end <= v_last then
    raise exception 'Depreciation has already been run to %.', to_char(v_last, 'DD Mon YYYY') using errcode = '22023';
  end if;
  if v_last is not null and p_period_end > (date_trunc('month', v_last + 1) + interval '1 month - 1 day')::date then
    raise exception 'Run depreciation month by month: the next one is to %.', to_char((date_trunc('month', v_last + 1) + interval '1 month - 1 day')::date, 'DD Mon YYYY')
      using errcode = '22023';
  end if;
  insert into public.asset_depreciation_runs (organization_id, period_end, created_by) values (v_org, p_period_end, p_actor) returning id into v_run;
  for a in select * from public.assets where organization_id = v_org and status = 'active' and method <> 'none' and in_service_date <= p_period_end loop
    v_from := coalesce((select max(d.period_end) + 1 from public.asset_depreciation d left join public.asset_depreciation_runs r on r.id = d.run_id
      where d.asset_id = a.id and (d.run_id is null or r.status = 'posted')), greatest(a.in_service_date, coalesce(a.opening_date + 1, a.in_service_date)));
    v_amt := public.asset_depreciation_for(a.id, v_from, p_period_end);
    if v_amt > 0 then
      insert into public.asset_depreciation (asset_id, run_id, period_start, period_end, amount) values (a.id, v_run, v_from, p_period_end, v_amt);
    end if;
  end loop;
  for c in select ac.expense_account_id, ac.accumulated_account_id, ac.name, sum(d.amount) as amt
           from public.asset_depreciation d join public.assets x on x.id = d.asset_id join public.asset_categories ac on ac.id = x.category_id
           where d.run_id = v_run group by 1, 2, 3 loop
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('accountId', c.expense_account_id, 'description', 'Depreciation: ' || c.name, 'debit', c.amt, 'credit', 0, 'taxCodeId', v_ng),
      jsonb_build_object('accountId', c.accumulated_account_id, 'description', 'Depreciation: ' || c.name, 'debit', 0, 'credit', c.amt, 'taxCodeId', null));
  end loop;
  v_total := coalesce((select sum(amount) from public.asset_depreciation where run_id = v_run), 0);
  if v_total > 0 then
    v_journal := public.ledger_post_entry(p_actor, p_period_end, 'Depreciation to ' || to_char(p_period_end, 'DD Mon YYYY'), 'depreciation', v_run,
      to_char(p_period_end, 'Mon YYYY'), v_lines, 'exclusive', false);
    update public.asset_depreciation set journal_id = v_journal where run_id = v_run;
  end if;
  update public.asset_depreciation_runs set journal_id = v_journal, total = v_total where id = v_run;
  perform public.app_audit(p_actor, 'depreciation_run', 'asset_depreciation_run', v_run::text, null,
    jsonb_build_object('to', p_period_end, 'total', v_total, 'assets', (select count(*) from public.asset_depreciation where run_id = v_run)));
  return v_run;
end;
$$;

-- Undoes the latest run (its journal is reversed on its own date).
create or replace function public.asset_depreciation_undo(p_actor uuid, p_run uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'assets.manage');
  select * into v from public.asset_depreciation_runs where id = p_run and organization_id = public.app_org_of(p_actor) for update;
  if not found or v.status <> 'posted' then raise exception 'Depreciation run not found.' using errcode = 'P0002'; end if;
  if exists (select 1 from public.asset_depreciation_runs where organization_id = v.organization_id and status = 'posted' and period_end > v.period_end) then
    raise exception 'Only the latest depreciation run can be undone.' using errcode = '22023';
  end if;
  if exists (select 1 from public.asset_depreciation d join public.assets a on a.id = d.asset_id where d.run_id = p_run and a.status = 'disposed') then
    raise exception 'An asset in this run has since been disposed of. Depreciation for it can''t be undone.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why it is undone.' using errcode = '22023'; end if;
  if v.journal_id is not null then
    perform set_config('app.depreciation_undo', 'on', true);
    perform public.ledger_reverse_entry(p_actor, v.journal_id, null, btrim(p_reason));
    perform set_config('app.depreciation_undo', '', true);
  end if;
  update public.asset_depreciation_runs set status = 'reversed', reversed_by = p_actor, reversed_at = now(), reverse_reason = btrim(p_reason) where id = p_run;
  perform public.app_audit(p_actor, 'depreciation_undone', 'asset_depreciation_run', p_run::text, jsonb_build_object('to', v.period_end, 'total', v.total),
    jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

------------------------------------------------------------------------------
-- 4. Register
------------------------------------------------------------------------------

create or replace function public.asset_save(p_actor uuid, p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old record;
  v_cat record;
  v_id uuid := p_id;
  v_depr boolean := false;
begin
  perform public.app_require(p_actor, 'assets.manage');
  select * into v_cat from public.asset_categories where id = nullif(p->>'category_id', '')::uuid and organization_id = v_org and active;
  if not found then raise exception 'Choose the asset category.' using errcode = '22023'; end if;
  if nullif(p->>'supplier_id', '') is not null and not exists (select 1 from public.suppliers where id = (p->>'supplier_id')::uuid and organization_id = v_org) then
    raise exception 'Supplier not found.' using errcode = '22023';
  end if;
  if nullif(p->>'bill_id', '') is not null and not exists (select 1 from public.bills where id = (p->>'bill_id')::uuid and organization_id = v_org and status = 'approved') then
    raise exception 'Bill not found.' using errcode = '22023';
  end if;
  if nullif(p->>'custodian_id', '') is not null and not exists (select 1 from public.employees where id = (p->>'custodian_id')::uuid) then
    raise exception 'Custodian not found.' using errcode = '22023';
  end if;
  if nullif(p->>'project_id', '') is not null and not exists (select 1 from public.projects where id = (p->>'project_id')::uuid and organization_id = v_org) then
    raise exception 'Project not found.' using errcode = '22023';
  end if;
  if p_id is not null then
    select * into v_old from public.assets where id = p_id and organization_id = v_org for update;
    if not found then raise exception 'Asset not found.' using errcode = 'P0002'; end if;
    if v_old.status = 'disposed' then raise exception 'A disposed asset can''t be changed.' using errcode = '22023'; end if;
    v_depr := exists (select 1 from public.asset_depreciation d left join public.asset_depreciation_runs r on r.id = d.run_id
      where d.asset_id = p_id and (d.run_id is null or r.status = 'posted'));
    -- Once depreciated, what the depreciation was worked out from stays put.
    if v_depr and (nullif(p->>'cost', '')::numeric is distinct from v_old.cost
       or coalesce(nullif(p->>'in_service_date', ''), nullif(p->>'purchase_date', ''))::date is distinct from v_old.in_service_date
       or coalesce(nullif(p->>'opening_accumulated', '')::numeric, 0) is distinct from v_old.opening_accumulated or nullif(p->>'category_id', '')::uuid is distinct from v_old.category_id) then
      raise exception 'This asset has been depreciated: its cost, category, in-service date and opening depreciation can''t change. Undo the depreciation runs first.' using errcode = '22023';
    end if;
  end if;
  begin
    if p_id is null then
      insert into public.assets (organization_id, number, name, description, category_id, purchase_date, in_service_date, supplier_id, bill_id, cost, gst,
        serial_number, location, custodian_id, project_id, method, useful_life_months, residual_value, opening_accumulated, opening_date,
        tax_method, tax_effective_life_years, tax_notes, created_by)
      values (v_org, public.next_document_number(v_org, 'asset'), btrim(p->>'name'), left(coalesce(p->>'description', ''), 2000), v_cat.id,
        (p->>'purchase_date')::date, coalesce(nullif(p->>'in_service_date', '')::date, (p->>'purchase_date')::date),
        nullif(p->>'supplier_id', '')::uuid, nullif(p->>'bill_id', '')::uuid, (p->>'cost')::numeric, coalesce(nullif(p->>'gst', '')::numeric, 0),
        nullif(btrim(coalesce(p->>'serial_number', '')), ''), nullif(btrim(coalesce(p->>'location', '')), ''), nullif(p->>'custodian_id', '')::uuid, nullif(p->>'project_id', '')::uuid,
        coalesce(nullif(p->>'method', ''), v_cat.method), coalesce(nullif(p->>'useful_life_months', '')::int, v_cat.useful_life_months),
        coalesce(nullif(p->>'residual_value', '')::numeric, 0), coalesce(nullif(p->>'opening_accumulated', '')::numeric, 0), nullif(p->>'opening_date', '')::date,
        nullif(p->>'tax_method', ''), coalesce(nullif(p->>'tax_effective_life_years', '')::numeric, v_cat.tax_effective_life_years), left(coalesce(p->>'tax_notes', ''), 1000), p_actor)
      returning id into v_id;
    else
      update public.assets set name = btrim(p->>'name'), description = left(coalesce(p->>'description', ''), 2000), category_id = v_cat.id,
        purchase_date = (p->>'purchase_date')::date, in_service_date = coalesce(nullif(p->>'in_service_date', '')::date, (p->>'purchase_date')::date),
        supplier_id = nullif(p->>'supplier_id', '')::uuid, bill_id = nullif(p->>'bill_id', '')::uuid, cost = (p->>'cost')::numeric, gst = coalesce(nullif(p->>'gst', '')::numeric, 0),
        serial_number = nullif(btrim(coalesce(p->>'serial_number', '')), ''), location = nullif(btrim(coalesce(p->>'location', '')), ''),
        custodian_id = nullif(p->>'custodian_id', '')::uuid, project_id = nullif(p->>'project_id', '')::uuid,
        method = coalesce(nullif(p->>'method', ''), v_cat.method), useful_life_months = coalesce(nullif(p->>'useful_life_months', '')::int, v_cat.useful_life_months),
        residual_value = coalesce(nullif(p->>'residual_value', '')::numeric, 0), opening_accumulated = coalesce(nullif(p->>'opening_accumulated', '')::numeric, 0),
        opening_date = nullif(p->>'opening_date', '')::date, tax_method = nullif(p->>'tax_method', ''),
        tax_effective_life_years = nullif(p->>'tax_effective_life_years', '')::numeric, tax_notes = left(coalesce(p->>'tax_notes', ''), 1000), updated_at = now()
      where id = p_id;
    end if;
  exception
    when check_violation then raise exception 'Check the asset: cost above the residual value, in service on or after purchase, a useful life to depreciate, opening depreciation no more than cost less residual.' using errcode = '22023';
    when not_null_violation or invalid_text_representation or invalid_datetime_format then raise exception 'Enter the name, purchase date and cost.' using errcode = '22023';
  end;
  perform public.app_audit(p_actor, case when p_id is null then 'asset_created' else 'asset_updated' end, 'asset', v_id::text,
    case when p_id is null then null else to_jsonb(v_old) - 'created_at' - 'updated_at' end,
    (select to_jsonb(a) - 'created_at' - 'updated_at' from public.assets a where id = v_id));
  return v_id;
end;
$$;

-- Categories: which accounts an asset uses and its default depreciation.
create or replace function public.asset_category_save(p_actor uuid, p_id uuid, p jsonb)
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
  perform public.app_require(p_actor, 'assets.manage');
  if not exists (select 1 from public.accounts where id = nullif(p->>'asset_account_id', '')::uuid and organization_id = v_org and subtype = 'fixed_asset' and status = 'active') then
    raise exception 'Choose a fixed asset account for the cost.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.accounts where id = nullif(p->>'accumulated_account_id', '')::uuid and organization_id = v_org and subtype = 'accumulated_depreciation' and status = 'active') then
    raise exception 'Choose an accumulated depreciation account.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.accounts where id = nullif(p->>'expense_account_id', '')::uuid and organization_id = v_org and type in ('expense', 'other_expense', 'cost_of_sales') and status = 'active') then
    raise exception 'Choose the depreciation expense account.' using errcode = '22023';
  end if;
  if p_id is not null then
    select to_jsonb(c) into v_old from public.asset_categories c where id = p_id and organization_id = v_org for update;
    if v_old is null then raise exception 'Category not found.' using errcode = 'P0002'; end if;
    if exists (select 1 from public.assets where category_id = p_id) and (v_old->>'asset_account_id' is distinct from p->>'asset_account_id'
       or v_old->>'accumulated_account_id' is distinct from p->>'accumulated_account_id') then
      raise exception 'Assets use this category: its accounts can''t change.' using errcode = '22023';
    end if;
  end if;
  begin
    if p_id is null then
      insert into public.asset_categories (organization_id, name, asset_account_id, accumulated_account_id, expense_account_id, method, useful_life_months, tax_effective_life_years)
      values (v_org, btrim(p->>'name'), (p->>'asset_account_id')::uuid, (p->>'accumulated_account_id')::uuid, (p->>'expense_account_id')::uuid,
        coalesce(nullif(p->>'method', ''), 'straight_line'), nullif(p->>'useful_life_months', '')::int, nullif(p->>'tax_effective_life_years', '')::numeric)
      returning id into v_id;
    else
      update public.asset_categories set name = btrim(p->>'name'), asset_account_id = (p->>'asset_account_id')::uuid, accumulated_account_id = (p->>'accumulated_account_id')::uuid,
        expense_account_id = (p->>'expense_account_id')::uuid, method = coalesce(nullif(p->>'method', ''), 'straight_line'),
        useful_life_months = nullif(p->>'useful_life_months', '')::int, tax_effective_life_years = nullif(p->>'tax_effective_life_years', '')::numeric,
        active = coalesce((p->>'active')::boolean, active)
      where id = p_id;
    end if;
  exception
    when unique_violation then raise exception 'There is already a category with that name.' using errcode = '22023';
    when check_violation or not_null_violation then raise exception 'Give the category a name and a useful life of 1 to 1,200 months.' using errcode = '22023';
  end;
  perform public.app_audit(p_actor, case when p_id is null then 'asset_category_created' else 'asset_category_updated' end, 'asset_category', v_id::text, v_old,
    (select to_jsonb(c) from public.asset_categories c where id = v_id));
  return v_id;
end;
$$;

-- Sold or written off. Depreciation for the part month to the disposal date,
-- then: Dr accumulated depreciation, Cr asset at cost, Dr book value of assets
-- disposed; proceeds Dr the account received into, Cr proceeds from sale of
-- assets with the tax code (GST on a taxable sale goes to the BAS).
create or replace function public.asset_dispose(p_actor uuid, p_id uuid, p_date date, p_proceeds numeric, p_tax_code uuid, p_received_into uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  a record;
  c record;
  v_from date;
  v_part numeric;
  v_acc numeric;
  v_book numeric;
  v_proc uuid; v_bv uuid;
  v_rate numeric := 0;
  v_gst numeric := 0;
  v_lines jsonb;
  v_journal uuid;
  v_ng uuid := (select id from public.tax_codes where organization_id = public.app_org_of(p_actor) and kind = 'no_gst' and active order by is_system desc, sort limit 1);
begin
  perform public.app_require(p_actor, 'assets.manage');
  select * into a from public.assets where id = p_id and organization_id = v_org for update;
  if not found then raise exception 'Asset not found.' using errcode = 'P0002'; end if;
  if a.status <> 'active' then raise exception 'This asset has already been disposed of.' using errcode = '22023'; end if;
  if p_date is null or p_date < a.in_service_date then raise exception 'Enter the disposal date (after it went into service).' using errcode = '22023'; end if;
  if exists (select 1 from public.asset_depreciation d join public.asset_depreciation_runs r on r.id = d.run_id
             where d.asset_id = p_id and r.status = 'posted' and d.period_end >= p_date) then
    raise exception 'Depreciation has already been run past this date. Undo the later runs, or use a later date.' using errcode = '22023';
  end if;
  if coalesce(p_proceeds, 0) < 0 or coalesce(p_proceeds, 0) <> round(coalesce(p_proceeds, 0), 2) then raise exception 'Enter the proceeds before GST (0 if written off).' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why: sold, traded in, scrapped, stolen.' using errcode = '22023'; end if;
  select * into c from public.asset_categories where id = a.category_id;
  select id into v_proc from public.accounts where organization_id = v_org and code = '4950' and is_system;
  select id into v_bv from public.accounts where organization_id = v_org and code = '7810' and is_system;
  if v_proc is null or v_bv is null then raise exception 'The disposal accounts (4950 and 7810) are missing.' using errcode = '22023'; end if;
  if coalesce(p_proceeds, 0) > 0 then
    if not exists (select 1 from public.accounts where id = p_received_into and organization_id = v_org and status = 'active' and type in ('asset', 'liability')) then
      raise exception 'Choose where the proceeds went (a bank account, or a clearing account if invoiced).' using errcode = '22023';
    end if;
    select rate into v_rate from public.tax_codes where id = p_tax_code and organization_id = v_org and active and applies_to in ('sales', 'both');
    if not found then raise exception 'Choose the tax code for the sale (GST for a taxable sale).' using errcode = '22023'; end if;
    v_gst := round(p_proceeds * v_rate, 2);
  end if;

  -- Depreciation for the part of the period up to the disposal date.
  v_from := coalesce((select max(d.period_end) + 1 from public.asset_depreciation d left join public.asset_depreciation_runs r on r.id = d.run_id
    where d.asset_id = p_id and (d.run_id is null or r.status = 'posted')), greatest(a.in_service_date, coalesce(a.opening_date + 1, a.in_service_date)));
  v_part := case when a.method = 'none' then 0 else public.asset_depreciation_for(p_id, v_from, p_date) end;
  v_acc := public.asset_accumulated(p_id, p_date) + v_part;
  v_book := a.cost - v_acc;

  v_lines := jsonb_build_array(
    jsonb_build_object('accountId', c.accumulated_account_id, 'description', a.number || ' accumulated depreciation', 'debit', v_acc, 'credit', 0, 'taxCodeId', null),
    jsonb_build_object('accountId', c.asset_account_id, 'description', a.number || ' at cost', 'debit', 0, 'credit', a.cost, 'taxCodeId', v_ng));
  if v_part > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('accountId', c.expense_account_id, 'description', a.number || ' depreciation to disposal', 'debit', v_part, 'credit', 0, 'taxCodeId', v_ng),
      jsonb_build_object('accountId', c.accumulated_account_id, 'description', a.number || ' depreciation to disposal', 'debit', 0, 'credit', v_part, 'taxCodeId', null));
  end if;
  if v_book > 0 then
    v_lines := v_lines || jsonb_build_object('accountId', v_bv, 'description', a.number || ' book value', 'debit', v_book, 'credit', 0, 'taxCodeId', v_ng);
  end if;
  if coalesce(p_proceeds, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('accountId', p_received_into, 'description', a.number || ' proceeds', 'debit', p_proceeds + v_gst, 'credit', 0, 'taxCodeId', null),
      jsonb_build_object('accountId', v_proc, 'description', a.number || ' ' || a.name, 'debit', 0, 'credit', p_proceeds, 'taxCodeId', p_tax_code));
  end if;
  v_journal := public.ledger_post_entry(p_actor, p_date, 'Disposal of ' || a.number || ' ' || a.name, 'asset_disposal', p_id, a.number, v_lines, 'exclusive', false);
  if v_part > 0 then
    insert into public.asset_depreciation (asset_id, run_id, period_start, period_end, amount, journal_id) values (p_id, null, v_from, p_date, v_part, v_journal);
  end if;
  update public.assets set status = 'disposed', disposal_date = p_date, disposal_proceeds = coalesce(p_proceeds, 0), disposal_gst = v_gst,
    disposal_reason = btrim(p_reason), disposal_journal_id = v_journal, updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'asset_disposed', 'asset', p_id::text, jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'disposed', 'date', p_date, 'proceeds', coalesce(p_proceeds, 0), 'bookValue', v_book, 'gainLoss', coalesce(p_proceeds, 0) - v_book, 'reason', btrim(p_reason)));
  return v_journal;
end;
$$;

-- An account's balance (debits less credits) at a date.
create or replace function public.account_balance_at(p_account uuid, p_as_at date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.journal_lines l join public.journal_entries je on je.id = l.journal_id
  where l.account_id = p_account and je.status in ('posted', 'reversed') and je.entry_date <= p_as_at;
$$;

-- The register against the ledger, by category, at a date.
create or replace function public.asset_reconciliation(p_org uuid, p_as_at date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('categoryId', c.id, 'category', c.name,
    'registerCost', r.cost, 'ledgerCost', public.account_balance_at(c.asset_account_id, p_as_at),
    'registerAccumulated', r.acc, 'ledgerAccumulated', -public.account_balance_at(c.accumulated_account_id, p_as_at),
    'assetAccount', (select code || ' ' || name from public.accounts where id = c.asset_account_id),
    'accumulatedAccount', (select code || ' ' || name from public.accounts where id = c.accumulated_account_id)) order by c.name), '[]'::jsonb)
  from public.asset_categories c
  left join lateral (
    select coalesce(sum(a.cost), 0) as cost, coalesce(sum(public.asset_accumulated(a.id, p_as_at)), 0) as acc
    from public.assets a where a.category_id = c.id and a.purchase_date <= p_as_at and (a.disposal_date is null or a.disposal_date > p_as_at)
  ) r on true
  where c.organization_id = p_org;
$$;


------------------------------------------------------------------------------
-- 5. Asset documents
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
  elsif p_entity_type = 'asset' then
    perform public.app_require(p_actor, 'assets.manage');
  else
    raise exception 'Attachments are not available here.' using errcode = '22023';
  end if;
  v_ok := case p_entity_type
    when 'bill' then exists (select 1 from public.bills where id = p_entity_id and organization_id = v_org)
    when 'purchase_order' then exists (select 1 from public.purchase_orders where id = p_entity_id and organization_id = v_org)
    when 'supplier' then exists (select 1 from public.suppliers where id = p_entity_id and organization_id = v_org)
    when 'invoice' then exists (select 1 from public.invoices where id = p_entity_id and organization_id = v_org)
    when 'quote' then exists (select 1 from public.quotes where id = p_entity_id and organization_id = v_org)
    when 'customer' then exists (select 1 from public.customers where id = p_entity_id and organization_id = v_org)
    when 'asset' then exists (select 1 from public.assets where id = p_entity_id and organization_id = v_org) end;
  if not v_ok then
    raise exception 'Record not found.' using errcode = 'P0002';
  end if;
  if p_path is null or p_path !~ ('^org/' || v_org::text || '/' || p_entity_type || '/' || p_entity_id::text || '/[A-Za-z0-9._-]{1,140}$') then
    raise exception 'Invalid upload path.' using errcode = '22023';
  end if;
  if p_content_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
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
  perform public.app_require(p_actor, case when v.entity_type in ('invoice', 'quote', 'customer') then 'sales.manage'
    when v.entity_type = 'asset' then 'assets.manage' else 'purchases.manage' end);
  update public.documents set archived_at = now() where id = p_document and archived_at is null;
  perform public.app_audit(p_actor, 'document_archived', v.entity_type, v.entity_id, jsonb_build_object('document', p_document), null);
end;
$$;

------------------------------------------------------------------------------
-- 6. Guards and lock down
------------------------------------------------------------------------------

-- Depreciation and disposal journals are undone only through the register.
create or replace function public.asset_journal_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'reversed' and old.status = 'posted' and old.source_type = 'asset_disposal' then
    raise exception 'Disposal journals can''t be reversed.' using errcode = '22023';
  end if;
  if new.status = 'reversed' and old.status = 'posted' and old.source_type = 'depreciation'
     and exists (select 1 from public.asset_depreciation_runs r where r.journal_id = old.id and r.status = 'posted')
     and coalesce(current_setting('app.depreciation_undo', true), '') <> 'on' then
    raise exception 'Undo depreciation from Fixed assets, not by reversing its journal.' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger journal_entries_asset_guard before update of status on public.journal_entries for each row execute function public.asset_journal_guard();

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['asset_categories', 'assets', 'asset_depreciation_runs', 'asset_depreciation'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
  foreach f in array array['asset_accumulated(uuid, date)', 'asset_depreciation_for(uuid, date, date)', 'asset_depreciation_run(uuid, date)',
    'asset_depreciation_undo(uuid, uuid, text)', 'asset_save(uuid, uuid, jsonb)', 'asset_dispose(uuid, uuid, date, numeric, uuid, uuid, text)',
    'asset_reconciliation(uuid, date)', 'account_balance_at(uuid, date)', 'asset_journal_guard()', 'asset_category_save(uuid, uuid, jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

commit;
