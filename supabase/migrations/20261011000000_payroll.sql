-- Panalo Accounts, Phase 5: payroll.
--
-- * Dated ATO and Fair Work figures in compliance_rules: PAYG withholding
--   (Schedule 1) and study and training support loans (Schedule 8) for
--   payments from 1 July 2026, super guarantee 12%, the 2026-27 maximum
--   contribution base, and the national minimum wage from 1 July 2026.
-- * payroll_employees: pay, tax declaration, super and bank details for an
--   employee in the HR register. Bank changes need a second person.
-- * pay_items: earnings, allowances, deductions and reimbursements, each
--   saying whether it is taxed and whether it is qualifying earnings for super.
-- * Leave: types with accrual rates, a ledger of accruals, leave taken and
--   adjustments, and leave requests with approval.
-- * Pay runs: Draft -> Submitted -> Approved (posted to the ledger) -> Paid.
--   Hours come from approved timesheets (or the salary), leave from approved
--   requests; PAYG, study loan, super and leave accruals are calculated; the
--   approver can never be the preparer. Approved pay runs are final:
--   corrections go in a later pay run.
-- * Super is due to the fund within 7 business days of payday (Payday Super).
--
-- Single Touch Payroll reporting is Phase 8; until then pay runs are the
-- record and STP is lodged from the existing payroll product.
begin;

------------------------------------------------------------------------------
-- 0. Rules, permissions, approvals, numbering
------------------------------------------------------------------------------

insert into public.compliance_rules (rule_name, rule_type, effective_from, value, source, approved_by) values
  ('payg_schedule1', 'payg_withholding', '2026-07-01', '{
     "1": [[188, 0.1500, 0.1500], [371, 0.2084, 11.0185], [515, 0.1790, 0.1066], [932, 0.3227, 74.1674], [2246, 0.3200, 71.6508], [3303, 0.3900, 228.8816], [null, 0.4700, 493.1893]],
     "2": [[362, 0, 0], [538, 0.1500, 54.3462], [673, 0.2500, 108.2135], [721, 0.1700, 54.3473], [865, 0.1790, 60.8377], [1282, 0.3227, 185.1935], [2596, 0.3200, 181.7319], [3653, 0.3900, 363.4627], [null, 0.4700, 655.7704]],
     "3": [[2596, 0.3000, 0.3000], [3653, 0.3700, 181.7308], [null, 0.4500, 474.0385]],
     "5": [[362, 0, 0], [721, 0.1500, 54.3462], [865, 0.1590, 60.8365], [1282, 0.3027, 185.1923], [2596, 0.3000, 181.7308], [3653, 0.3700, 363.4615], [null, 0.4500, 655.7692]],
     "6": [[362, 0, 0], [721, 0.1500, 54.3462], [865, 0.1590, 60.8365], [908, 0.3027, 185.1923], [1135, 0.3527, 230.6135], [1282, 0.3127, 185.1923], [2596, 0.3100, 181.7308], [3653, 0.3800, 363.4615], [null, 0.4600, 655.7692]],
     "4": {"resident": 0.47, "foreign": 0.45}
   }'::jsonb,
   'ATO, Schedule 1 - Statement of formulas for calculating amounts to be withheld (NAT 1004), payments from 1 July 2026. https://www.ato.gov.au/tax-rates-and-codes/payg-withholding-schedule-1-statement-of-formulas-for-calculating-amounts-to-be-withheld',
   'Seeded; confirm with accountant'),
  ('stsl_schedule8', 'payg_withholding', '2026-07-01', '{
     "threshold_or_foreign": [[1337, 0, 0], [2494, 0.15, 200.5615], [3577, 0.17, 250.4527], [null, 0.10, 0]],
     "no_threshold": [[987, 0, 0], [2144, 0.15, 148.0615], [2727, 0.17, 190.9527], [null, 0.10, 0]]
   }'::jsonb,
   'ATO, Schedule 8 - Statement of formulas for calculating study and training support loans components, payments from 1 July 2026. https://www.ato.gov.au/tax-rates-and-codes/schedule-8-statement-of-formulas-for-calculating-study-and-training-support-loans-components',
   'Seeded; confirm with accountant'),
  ('super_guarantee_rate', 'superannuation', '2025-07-01', '0.12'::jsonb,
   'ATO, Key super rates and thresholds - Super guarantee (12% from 1 July 2025). https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/super-guarantee', 'Seeded; confirm with accountant'),
  ('super_max_contribution_base', 'superannuation', '2026-07-01', '270830'::jsonb,
   'ATO, Paying super on payday - Maximum contribution base, $270,830 a year for 2026-27, applied to qualifying earnings paid in the financial year.', 'Seeded; confirm with accountant'),
  ('super_payday_due_business_days', 'superannuation', '2026-07-01', '7'::jsonb,
   'ATO, Paying super on payday: contributions must be received by the fund within 7 business days after payday (20 for a new employee or new fund).', 'Seeded; confirm with accountant'),
  ('national_minimum_wage_hourly', 'wages', '2026-07-01', '26.44'::jsonb,
   'Fair Work Commission, Annual Wage Review 2026: national minimum wage $1,004.90 a week or $26.44 an hour from 1 July 2026. Award minimums are higher and set by the award.', 'Seeded; confirm with accountant');

insert into public.app_permissions (key, name, description, sort, area, admin_default, requires_mfa) values
  ('payroll.self', 'My pay', 'See your own payslips and leave balances, and request leave.', 245, 'Payroll', false, false);
insert into public.app_role_permissions (role_key, permission_key) values
  ('project_manager', 'payroll.self'), ('supervisor', 'payroll.self'), ('payroll_admin', 'payroll.self'), ('finance_admin', 'payroll.self'), ('director', 'payroll.self');

alter table public.approvals drop constraint approvals_kind_check;
alter table public.approvals add constraint approvals_kind_check check (kind in ('company_bank_account', 'supplier_bank', 'employee_bank'));

------------------------------------------------------------------------------
-- 1. Pay items, leave types, employees
------------------------------------------------------------------------------

create table public.pay_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9_]{2,12}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  kind text not null check (kind in ('earning', 'allowance', 'deduction', 'reimbursement')),
  taxable boolean not null default true,
  qualifying_earnings boolean not null default true,
  ordinary_hours boolean not null default false,
  rate_multiplier numeric(6,4) not null default 1 check (rate_multiplier >= 0),
  account_id uuid references public.accounts(id) on delete restrict,
  payee text,
  is_system boolean not null default false,
  active boolean not null default true,
  sort integer not null default 0,
  unique (organization_id, code)
);
insert into public.pay_items (organization_id, code, name, kind, taxable, qualifying_earnings, ordinary_hours, rate_multiplier, account_id, is_system, sort)
select o.id, c, n, k, tx, qe, oh, m, (select id from public.accounts a where a.organization_id = o.id and a.code = acc), sys, s
from public.organizations o, (values
  ('ORD', 'Ordinary hours', 'earning', true, true, true, 1.0, null, true, 10),
  ('OT150', 'Overtime at 150%', 'earning', true, false, false, 1.5, null, true, 20),
  ('OT200', 'Overtime at 200%', 'earning', true, false, false, 2.0, null, true, 30),
  ('TRAVEL', 'Travel time', 'earning', true, true, true, 1.0, null, true, 40),
  ('SALARY', 'Salary', 'earning', true, true, true, 1.0, null, true, 50),
  ('AL', 'Annual leave', 'earning', true, true, true, 1.0, null, true, 60),
  ('LL', 'Annual leave loading', 'earning', true, true, false, 1.0, null, true, 70),
  ('PL', 'Personal / carer''s leave', 'earning', true, true, true, 1.0, null, true, 80),
  ('LSL', 'Long service leave', 'earning', true, true, true, 1.0, null, true, 90),
  ('PH', 'Public holiday (not worked)', 'earning', true, true, true, 1.0, null, true, 100),
  ('BONUS', 'Bonus', 'earning', true, true, false, 1.0, null, false, 110),
  ('TOOL', 'Tool allowance', 'allowance', true, true, false, 1.0, null, false, 120),
  ('MEAL', 'Overtime meal allowance', 'allowance', true, false, false, 1.0, null, false, 130),
  ('REIMB', 'Expense reimbursement', 'reimbursement', false, false, false, 1.0, '7900', false, 140),
  ('UNION', 'Union fees', 'deduction', false, false, false, 1.0, null, false, 150),
  ('DEDUCT', 'Other deduction', 'deduction', false, false, false, 1.0, null, false, 160)
) as v(c, n, k, tx, qe, oh, m, acc, sys, s);

create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9_]{2,12}$'),
  name text not null,
  paid boolean not null default true,
  -- Hours accrued per ordinary hour worked or on paid leave (casuals accrue nothing).
  accrual_per_hour numeric(10,7) not null default 0 check (accrual_per_hour >= 0),
  pay_item_code text,
  notes text not null default '',
  active boolean not null default true,
  unique (organization_id, code)
);
insert into public.leave_types (organization_id, code, name, paid, accrual_per_hour, pay_item_code, notes)
select o.id, c, n, p, a, i, nt from public.organizations o, (values
  ('ANNUAL', 'Annual leave', true, 0.0769231, 'AL', 'NES: 4 weeks a year (5 for shift workers), accruing progressively: 4 / 52 of ordinary hours.'),
  ('PERSONAL', 'Personal / carer''s leave', true, 0.0384615, 'PL', 'NES: 10 days a year, accruing progressively: 2 / 52 of ordinary hours.'),
  ('LONGSERV', 'Long service leave', true, 0, 'LSL', 'Set by state law (NSW: 2 months after 10 years). Set the accrual rate with your accountant; leave at 0 to track balances by adjustment.'),
  ('COMPASS', 'Compassionate leave', true, 0, 'PL', 'NES: 2 days per occasion; no balance accrues.'),
  ('UNPAID', 'Unpaid leave', false, 0, null, 'Not paid; recorded for service and leave records.')
) as v(c, n, p, a, i, nt);

create table public.payroll_employees (
  employee_id uuid primary key references public.employees(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'terminated')),
  employment_basis text not null default 'full_time' check (employment_basis in ('full_time', 'part_time', 'casual')),
  pay_basis text not null default 'hourly' check (pay_basis in ('hourly', 'salary')),
  pay_frequency text not null default 'weekly' check (pay_frequency in ('weekly', 'fortnightly', 'monthly')),
  hourly_rate numeric(10,4) not null default 0 check (hourly_rate >= 0),
  annual_salary numeric(12,2) not null default 0 check (annual_salary >= 0),
  ordinary_hours_per_week numeric(5,2) not null default 38 check (ordinary_hours_per_week between 0 and 60),
  casual_loading_percent numeric(5,2) not null default 25 check (casual_loading_percent between 0 and 100),
  leave_loading_percent numeric(5,2) not null default 17.5 check (leave_loading_percent between 0 and 100),
  annual_leave_weeks numeric(3,1) not null default 4 check (annual_leave_weeks in (4, 5)),
  award text not null default '',
  classification text not null default '',
  wages_account_id uuid references public.accounts(id) on delete restrict,
  date_of_birth date,
  start_date date,
  end_date date,
  -- Tax declaration
  tfn text check (tfn is null or tfn ~ '^\d{8,9}$'),
  tfn_status text not null default 'not_provided' check (tfn_status in ('provided', 'applied', 'exempt', 'not_provided')),
  residency text not null default 'resident' check (residency in ('resident', 'foreign', 'working_holiday')),
  tax_free_threshold boolean not null default true,
  study_loan boolean not null default false,
  medicare_exemption text not null default 'none' check (medicare_exemption in ('none', 'half', 'full')),
  extra_withholding numeric(10,2) not null default 0 check (extra_withholding >= 0),
  -- Super
  super_fund_name text,
  super_fund_usi text,
  super_fund_abn text,
  super_member_number text,
  salary_sacrifice numeric(10,2) not null default 0 check (salary_sacrifice >= 0),
  -- Bank (changed only through employee_bank approvals)
  bank_account_name text,
  bank_bsb text check (bank_bsb is null or bank_bsb ~ '^\d{6}$'),
  bank_account_number text check (bank_account_number is null or bank_account_number ~ '^\d{5,10}$'),
  bank_changed_at timestamptz,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.training_profiles(id) on delete set null,
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table public.leave_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  employee_id uuid not null references public.payroll_employees(employee_id) on delete restrict,
  leave_type_id uuid not null references public.leave_types(id) on delete restrict,
  txn_date date not null,
  hours numeric(10,4) not null,
  kind text not null check (kind in ('accrual', 'taken', 'adjustment', 'opening')),
  pay_run_id uuid,
  leave_request_id uuid,
  note text not null default '',
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index leave_transactions_employee_idx on public.leave_transactions (employee_id, leave_type_id);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  employee_id uuid not null references public.payroll_employees(employee_id) on delete restrict,
  leave_type_id uuid not null references public.leave_types(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  hours numeric(7,2) not null check (hours > 0),
  reason text not null default '',
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'cancelled', 'paid')),
  requested_by uuid references public.training_profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_by uuid references public.training_profiles(id) on delete set null,
  decided_at timestamptz,
  decision_comment text,
  pay_run_id uuid,
  check (end_date >= start_date)
);
create index leave_requests_employee_idx on public.leave_requests (employee_id, status);

------------------------------------------------------------------------------
-- 2. Pay runs
------------------------------------------------------------------------------

create table public.pay_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  number text not null,
  pay_frequency text not null check (pay_frequency in ('weekly', 'fortnightly', 'monthly')),
  period_start date not null,
  period_end date not null,
  payment_date date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'paid')),
  gross numeric(14,2) not null default 0,
  payg numeric(14,2) not null default 0,
  super numeric(14,2) not null default 0,
  net numeric(14,2) not null default 0,
  calculated_at timestamptz,
  prepared_by uuid references public.training_profiles(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references public.training_profiles(id) on delete set null,
  approved_at timestamptz,
  journal_id uuid references public.journal_entries(id) on delete restrict,
  paid_at date,
  payment_journal_id uuid references public.journal_entries(id) on delete restrict,
  super_paid_at date,
  super_journal_id uuid references public.journal_entries(id) on delete restrict,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, number),
  check (period_end >= period_start)
);
alter table public.leave_transactions add constraint leave_transactions_run_fk foreign key (pay_run_id) references public.pay_runs(id) on delete cascade;
alter table public.leave_requests add constraint leave_requests_run_fk foreign key (pay_run_id) references public.pay_runs(id) on delete set null;
alter table public.leave_transactions add constraint leave_transactions_request_fk foreign key (leave_request_id) references public.leave_requests(id) on delete set null;

create table public.pay_run_employees (
  id uuid primary key default gen_random_uuid(),
  pay_run_id uuid not null references public.pay_runs(id) on delete cascade,
  employee_id uuid not null references public.payroll_employees(employee_id) on delete restrict,
  gross numeric(12,2) not null default 0,
  taxable numeric(12,2) not null default 0,
  payg numeric(12,2) not null default 0,
  stsl numeric(12,2) not null default 0,
  salary_sacrifice numeric(12,2) not null default 0,
  deductions numeric(12,2) not null default 0,
  reimbursements numeric(12,2) not null default 0,
  qualifying_earnings numeric(12,2) not null default 0,
  super_guarantee numeric(12,2) not null default 0,
  net numeric(12,2) not null default 0,
  tax_scale text,
  ordinary_hours numeric(8,2) not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  -- What the payslip shows, kept as it was when approved.
  snapshot jsonb,
  unique (pay_run_id, employee_id)
);

create table public.pay_run_lines (
  id uuid primary key default gen_random_uuid(),
  pay_run_employee_id uuid not null references public.pay_run_employees(id) on delete cascade,
  pay_item_id uuid not null references public.pay_items(id) on delete restrict,
  description text not null default '',
  hours numeric(8,2),
  rate numeric(10,4),
  amount numeric(12,2) not null,
  manual boolean not null default false,
  project_id uuid references public.projects(id) on delete set null,
  leave_request_id uuid references public.leave_requests(id) on delete set null,
  sort integer not null default 0
);
create index pay_run_lines_pre_idx on public.pay_run_lines (pay_run_employee_id);

-- Timesheet entries are paid once: the pay run that paid them is recorded,
-- and a week with paid hours can no longer be reopened.
alter table public.timesheet_entries add column pay_run_id uuid references public.pay_runs(id) on delete set null;

------------------------------------------------------------------------------
-- 3. Withholding and super calculations
------------------------------------------------------------------------------

-- Weekly earnings x as Schedule 1 and 8 define it: whole dollars plus 99 cents.
create or replace function public.payg_weekly_x(p_earnings numeric, p_frequency text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case p_frequency
    when 'weekly' then floor(p_earnings) + 0.99
    when 'fortnightly' then floor(p_earnings / 2) + 0.99
    -- Monthly: add one cent to amounts ending in 33 cents, then x 3 / 13.
    when 'monthly' then floor((p_earnings + case when (p_earnings * 100)::bigint % 100 = 33 then 0.01 else 0 end) * 3 / 13) + 0.99
  end;
$$;

-- y = ax - b from a coefficient table, rounded to the nearest dollar (50 cents up).
create or replace function public.payg_apply(p_table jsonb, p_x numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  r jsonb;
  y numeric;
begin
  for r in select * from jsonb_array_elements(p_table) loop
    if r->>0 is null or p_x < (r->>0)::numeric then
      y := (r->>1)::numeric * p_x - (r->>2)::numeric;
      return greatest(0, floor(y + 0.5));
    end if;
  end loop;
  return 0;
end;
$$;

-- Converts a weekly amount back to the pay period.
create or replace function public.payg_period_amount(p_weekly numeric, p_frequency text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case p_frequency when 'weekly' then p_weekly when 'fortnightly' then p_weekly * 2 else floor(p_weekly * 13 / 3 + 0.5) end;
$$;

-- The amount to withhold (PAYG plus study loan component) for one payment.
-- p_scale: '1', '2', '3', '5', '6', '4r' (no TFN, resident) or '4f' (no TFN, foreign).
create or replace function public.payg_withholding(p_scale text, p_earnings numeric, p_frequency text, p_date date, p_stsl boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rules jsonb := public.compliance_value('payg_schedule1', p_date);
  v_stsl_rules jsonb := public.compliance_value('stsl_schedule8', p_date);
  v_x numeric;
  v_tax numeric;
  v_stsl numeric := 0;
begin
  if v_rules is null or v_stsl_rules is null then
    raise exception 'No PAYG withholding rules are recorded for payments on %. An administrator must add the ATO schedule first.', p_date using errcode = '22023';
  end if;
  if p_earnings <= 0 then
    return jsonb_build_object('tax', 0, 'stsl', 0);
  end if;
  if p_scale in ('4r', '4f') then
    -- No TFN: a flat rate, ignoring cents in the earnings and the result. No study loan component.
    v_tax := floor(floor(p_earnings) * (v_rules->'4'->>(case when p_scale = '4r' then 'resident' else 'foreign' end))::numeric);
    return jsonb_build_object('tax', v_tax, 'stsl', 0);
  end if;
  if not v_rules ? p_scale then
    raise exception 'Unknown tax scale %.', p_scale using errcode = '22023';
  end if;
  v_x := public.payg_weekly_x(p_earnings, p_frequency);
  v_tax := public.payg_period_amount(public.payg_apply(v_rules->p_scale, v_x), p_frequency);
  if p_stsl then
    v_stsl := public.payg_period_amount(public.payg_apply(v_stsl_rules->(case when p_scale = '1' then 'no_threshold' else 'threshold_or_foreign' end), v_x), p_frequency);
  end if;
  return jsonb_build_object('tax', v_tax, 'stsl', v_stsl);
end;
$$;

-- Which scale applies to an employee on a date.
create or replace function public.payroll_tax_scale(p_emp public.payroll_employees, p_date date)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    -- No TFN (or applied more than 28 days ago): 47% resident / 45% foreign.
    when p_emp.tfn_status = 'not_provided' or (p_emp.tfn_status = 'applied' and coalesce(p_emp.start_date, p_date) < p_date - 28)
      then case when p_emp.residency = 'foreign' then '4f' else '4r' end
    when p_emp.residency = 'foreign' then '3'
    when not p_emp.tax_free_threshold then '1'
    when p_emp.medicare_exemption = 'full' then '5'
    when p_emp.medicare_exemption = 'half' then '6'
    else '2' end;
$$;

-- Financial year start (1 July) for a date.
create or replace function public.payroll_fy_start(p_date date)
returns date
language sql
immutable
set search_path = ''
as $$
  select make_date(extract(year from p_date)::int - case when extract(month from p_date) < 7 then 1 else 0 end, 7, 1);
$$;

-- Adds business days (Mon-Fri; public holidays aren't known here, so the
-- due date shown is the latest it could be only if no holiday falls inside).
create or replace function public.add_business_days(p_date date, p_days int)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  d date := p_date;
  n int := 0;
begin
  while n < p_days loop
    d := d + 1;
    if extract(isodow from d) < 6 then n := n + 1; end if;
  end loop;
  return d;
end;
$$;

------------------------------------------------------------------------------
-- 4. Employees: maintenance and bank changes
------------------------------------------------------------------------------

create or replace function public.payroll_employee_save(p_actor uuid, p_employee uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old jsonb;
  v_tfn text := nullif(regexp_replace(coalesce(p->>'tfn', ''), '\s', '', 'g'), '');
  v_wages uuid := nullif(p->>'wages_account_id', '')::uuid;
begin
  perform public.app_require(p_actor, 'payroll.sensitive');
  if not exists (select 1 from public.employees where id = p_employee and organization_id = v_org) then
    raise exception 'Employee not found.' using errcode = 'P0002';
  end if;
  if (select employment_type from public.employees where id = p_employee) = 'contractor' then
    raise exception 'Contractors are paid through bills, not payroll.' using errcode = '22023';
  end if;
  if v_tfn is not null and not public.app_valid_tfn(v_tfn) then
    raise exception 'That TFN isn''t valid. Check the digits.' using errcode = '22023';
  end if;
  if coalesce(p->>'tfn_status', '') = 'provided' and v_tfn is null and not exists (select 1 from public.payroll_employees where employee_id = p_employee and tfn is not null) then
    raise exception 'Enter the TFN, or choose another TFN status.' using errcode = '22023';
  end if;
  if v_wages is not null and not exists (select 1 from public.accounts where id = v_wages and organization_id = v_org and type in ('expense', 'cost_of_sales') and status = 'active') then
    raise exception 'Choose an expense or cost of sales account for wages.' using errcode = '22023';
  end if;
  select to_jsonb(e) - 'tfn' - 'bank_account_number' into v_old from public.payroll_employees e where employee_id = p_employee;
  insert into public.payroll_employees (employee_id, organization_id, wages_account_id)
  values (p_employee, v_org, coalesce(v_wages, (select id from public.accounts where organization_id = v_org and code = '5000')))
  on conflict (employee_id) do nothing;
  update public.payroll_employees set
    status = coalesce(nullif(p->>'status', ''), status),
    employment_basis = coalesce(nullif(p->>'employment_basis', ''), employment_basis),
    pay_basis = coalesce(nullif(p->>'pay_basis', ''), pay_basis),
    pay_frequency = coalesce(nullif(p->>'pay_frequency', ''), pay_frequency),
    hourly_rate = coalesce(nullif(p->>'hourly_rate', '')::numeric, hourly_rate),
    annual_salary = coalesce(nullif(p->>'annual_salary', '')::numeric, annual_salary),
    ordinary_hours_per_week = coalesce(nullif(p->>'ordinary_hours_per_week', '')::numeric, ordinary_hours_per_week),
    casual_loading_percent = coalesce(nullif(p->>'casual_loading_percent', '')::numeric, casual_loading_percent),
    leave_loading_percent = coalesce(nullif(p->>'leave_loading_percent', '')::numeric, leave_loading_percent),
    annual_leave_weeks = coalesce(nullif(p->>'annual_leave_weeks', '')::numeric, annual_leave_weeks),
    award = left(coalesce(p->>'award', award), 200), classification = left(coalesce(p->>'classification', classification), 120),
    wages_account_id = coalesce(v_wages, wages_account_id),
    date_of_birth = case when p ? 'date_of_birth' then nullif(p->>'date_of_birth', '')::date else date_of_birth end,
    start_date = case when p ? 'start_date' then nullif(p->>'start_date', '')::date else start_date end,
    end_date = case when p ? 'end_date' then nullif(p->>'end_date', '')::date else end_date end,
    tfn = coalesce(v_tfn, case when coalesce(p->>'tfn_status', tfn_status) = 'provided' then tfn end),
    tfn_status = coalesce(nullif(p->>'tfn_status', ''), tfn_status),
    residency = coalesce(nullif(p->>'residency', ''), residency),
    tax_free_threshold = coalesce((p->>'tax_free_threshold')::boolean, tax_free_threshold),
    study_loan = coalesce((p->>'study_loan')::boolean, study_loan),
    medicare_exemption = coalesce(nullif(p->>'medicare_exemption', ''), medicare_exemption),
    extra_withholding = coalesce(nullif(p->>'extra_withholding', '')::numeric, extra_withholding),
    super_fund_name = case when p ? 'super_fund_name' then nullif(btrim(p->>'super_fund_name'), '') else super_fund_name end,
    super_fund_usi = case when p ? 'super_fund_usi' then nullif(btrim(p->>'super_fund_usi'), '') else super_fund_usi end,
    super_fund_abn = case when p ? 'super_fund_abn' then nullif(regexp_replace(p->>'super_fund_abn', '\s', '', 'g'), '') else super_fund_abn end,
    super_member_number = case when p ? 'super_member_number' then nullif(btrim(p->>'super_member_number'), '') else super_member_number end,
    salary_sacrifice = coalesce(nullif(p->>'salary_sacrifice', '')::numeric, salary_sacrifice),
    notes = left(coalesce(p->>'notes', notes), 2000), updated_at = now(), updated_by = p_actor
  where employee_id = p_employee;
  if (select super_fund_abn from public.payroll_employees where employee_id = p_employee) is not null
     and not public.app_valid_abn((select super_fund_abn from public.payroll_employees where employee_id = p_employee)) then
    raise exception 'The super fund ABN isn''t valid.' using errcode = '22023';
  end if;
  perform public.app_audit(p_actor, case when v_old is null then 'payroll_employee_created' else 'payroll_employee_updated' end, 'payroll_employee', p_employee::text,
    v_old, (select to_jsonb(e) - 'tfn' - 'bank_account_number' - 'created_at' - 'updated_at' from public.payroll_employees e where employee_id = p_employee)
      || jsonb_build_object('tfnChanged', v_tfn is not null),
    null, (select profile_id from public.employees where id = p_employee));
end;
$$;

-- ATO TFN check digits: weights 1,4,3,7,5,8,6,9,10; the sum is divisible by 11.
create or replace function public.app_valid_tfn(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when regexp_replace(coalesce(p, ''), '\s', '', 'g') ~ '^\d{9}$' then (
      select sum(substr(d, i, 1)::int * (array[1, 4, 3, 7, 5, 8, 6, 9, 10])[i]) % 11 = 0
      from (select regexp_replace(p, '\s', '', 'g') as d) s, generate_series(1, 9) i)
    when regexp_replace(coalesce(p, ''), '\s', '', 'g') ~ '^\d{8}$' then (
      select sum(substr(d, i, 1)::int * (array[10, 7, 8, 4, 6, 3, 5, 1])[i]) % 11 = 0
      from (select regexp_replace(p, '\s', '', 'g') as d) s, generate_series(1, 8) i)
    else false end;
$$;

create or replace function public.payroll_bank_request(p_actor uuid, p_employee uuid, p_name text, p_bsb text, p_account text)
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
  perform public.app_require(p_actor, 'payroll.sensitive');
  select pe.*, e.full_name into v from public.payroll_employees pe join public.employees e on e.id = pe.employee_id
  where pe.employee_id = p_employee and pe.organization_id = public.app_org_of(p_actor);
  if not found then raise exception 'Set up the employee''s pay details first.' using errcode = 'P0002'; end if;
  if v_bsb !~ '^\d{6}$' then raise exception 'A BSB is 6 digits, like 062-000.' using errcode = '22023'; end if;
  if v_acct !~ '^\d{5,10}$' then raise exception 'An account number is 5 to 10 digits.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'Enter the account name.' using errcode = '22023'; end if;
  return public.approval_request(p_actor, 'employee_bank', 'payroll_employee', p_employee, 'Bank details for ' || v.full_name, 'payroll.approve',
    jsonb_build_object('accountName', v.bank_account_name, 'bsb', v.bank_bsb, 'accountNumber', v.bank_account_number),
    jsonb_build_object('accountName', btrim(p_name), 'bsb', v_bsb, 'accountNumber', v_acct));
end;
$$;

-- approval_decide with the employee bank branch added.
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
  -- Nobody approves a change to their own bank account.
  if v.kind = 'employee_bank' and (select profile_id from public.employees where id = v.entity_id) = p_actor then
    raise exception 'Someone else must approve a change to your own bank details.' using errcode = '42501';
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
  elsif v.kind = 'employee_bank' and p_approve then
    update public.payroll_employees set bank_account_name = nullif(v.new_value->>'accountName', ''), bank_bsb = v.new_value->>'bsb',
      bank_account_number = v.new_value->>'accountNumber', bank_changed_at = now(), updated_at = now()
    where employee_id = v.entity_id;
  end if;

  insert into public.notifications (organization_id, profile_id, kind, title, body, link)
  values (v.organization_id, v.requested_by, case when p_approve then 'approval_approved' else 'approval_rejected' end,
          case when p_approve then 'Approved: ' else 'Rejected: ' end || v.title, coalesce(btrim(p_comment), ''), 'approvals');
  perform public.app_audit(p_actor, case when p_approve then 'approval_approved' else 'approval_rejected' end, 'approval', p_approval::text,
    public.app_mask_bank(v.previous_value), public.app_mask_bank(v.new_value), jsonb_build_object('kind', v.kind, 'title', v.title, 'comment', p_comment), v.requested_by);
  return jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end);
end;
$$;

------------------------------------------------------------------------------
-- 5. Leave
------------------------------------------------------------------------------

create or replace function public.leave_balance(p_employee uuid, p_type uuid, p_as_at date default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(round(sum(hours), 2), 0) from public.leave_transactions
  where employee_id = p_employee and leave_type_id = p_type and (p_as_at is null or txn_date <= p_as_at);
$$;

-- A leave request: for yourself (My pay), or for someone else by a leave approver.
create or replace function public.leave_request_save(p_actor uuid, p_employee uuid, p_type uuid, p_start date, p_end date, p_hours numeric, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_emp uuid := p_employee;
  v_id uuid;
  v_type record;
begin
  if v_emp is null then
    select pe.employee_id into v_emp from public.payroll_employees pe join public.employees e on e.id = pe.employee_id where e.profile_id = p_actor and pe.status = 'active';
    if v_emp is null then raise exception 'You''re not set up in payroll yet.' using errcode = 'P0002'; end if;
    perform public.app_require(p_actor, 'payroll.self');
  elsif (select profile_id from public.employees where id = v_emp) is distinct from p_actor then
    perform public.app_require(p_actor, 'leave.approve');
  else
    perform public.app_require(p_actor, 'payroll.self');
  end if;
  if not exists (select 1 from public.payroll_employees where employee_id = v_emp and organization_id = v_org) then
    raise exception 'Employee not found.' using errcode = 'P0002';
  end if;
  select * into v_type from public.leave_types where id = p_type and organization_id = v_org and active;
  if not found then raise exception 'Choose a type of leave.' using errcode = '22023'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'Choose the first and last day of leave.' using errcode = '22023'; end if;
  if p_end - p_start > 366 then raise exception 'A leave request can cover at most a year.' using errcode = '22023'; end if;
  if p_hours is null or p_hours <= 0 or p_hours <> round(p_hours, 2) then raise exception 'Enter the hours of leave.' using errcode = '22023'; end if;
  if (select employment_basis from public.payroll_employees where employee_id = v_emp) = 'casual' and v_type.paid then
    raise exception 'Casual employees don''t get paid leave of this type.' using errcode = '22023';
  end if;
  insert into public.leave_requests (organization_id, employee_id, leave_type_id, start_date, end_date, hours, reason, requested_by)
  values (v_org, v_emp, p_type, p_start, p_end, p_hours, left(coalesce(p_reason, ''), 500), p_actor) returning id into v_id;
  perform public.app_notify_holders(v_org, 'leave.approve', p_actor, 'leave_requested', 'Leave to approve: ' || (select full_name from public.employees where id = v_emp),
    v_type.name || ', ' || to_char(p_start, 'DD Mon') || ' to ' || to_char(p_end, 'DD Mon') || ' (' || p_hours || ' h)', 'leave');
  perform public.app_audit(p_actor, 'leave_requested', 'leave_request', v_id::text, null,
    jsonb_build_object('type', v_type.code, 'start', p_start, 'end', p_end, 'hours', p_hours), null, (select profile_id from public.employees where id = v_emp));
  return v_id;
end;
$$;

create or replace function public.leave_request_decide(p_actor uuid, p_id uuid, p_decision text, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_profile uuid;
begin
  select * into v from public.leave_requests where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Leave request not found.' using errcode = 'P0002'; end if;
  v_profile := (select profile_id from public.employees where id = v.employee_id);
  if p_decision = 'cancelled' then
    if v.status not in ('submitted', 'approved') then raise exception 'This request can''t be cancelled now.' using errcode = '22023'; end if;
    if v_profile is distinct from p_actor then perform public.app_require(p_actor, 'leave.approve'); end if;
  elsif p_decision in ('approved', 'rejected') then
    perform public.app_require(p_actor, 'leave.approve');
    if v.status <> 'submitted' then raise exception 'Only a waiting request can be approved or declined.' using errcode = '22023'; end if;
    if v_profile = p_actor then raise exception 'Someone else must approve your own leave.' using errcode = '42501'; end if;
    if p_decision = 'rejected' and length(btrim(coalesce(p_comment, ''))) < 3 then raise exception 'Give a reason for declining it.' using errcode = '22023'; end if;
  else
    raise exception 'Unknown decision.' using errcode = '22023';
  end if;
  update public.leave_requests set status = p_decision, decided_by = p_actor, decided_at = now(), decision_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_id;
  if v_profile is not null and v_profile <> p_actor then
    insert into public.notifications (organization_id, profile_id, kind, title, body, link)
    values (v.organization_id, v_profile, 'leave_' || p_decision, 'Leave ' || replace(p_decision, 'rejected', 'declined') || ': ' || to_char(v.start_date, 'DD Mon') || ' to ' || to_char(v.end_date, 'DD Mon'),
      coalesce(btrim(p_comment), ''), 'my-pay');
  end if;
  perform public.app_audit(p_actor, 'leave_' || p_decision, 'leave_request', p_id::text, jsonb_build_object('status', v.status), jsonb_build_object('status', p_decision),
    jsonb_build_object('comment', p_comment), v_profile);
end;
$$;

-- Opening balances and corrections, with a reason.
create or replace function public.leave_adjust(p_actor uuid, p_employee uuid, p_type uuid, p_date date, p_hours numeric, p_kind text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
begin
  perform public.app_require(p_actor, 'payroll.sensitive');
  if not exists (select 1 from public.payroll_employees where employee_id = p_employee and organization_id = v_org) then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.leave_types where id = p_type and organization_id = v_org) then raise exception 'Choose a type of leave.' using errcode = '22023'; end if;
  if p_kind not in ('opening', 'adjustment') then raise exception 'Unknown adjustment.' using errcode = '22023'; end if;
  if p_hours is null or p_hours = 0 then raise exception 'Enter the hours (negative to reduce the balance).' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Say why the balance is being adjusted.' using errcode = '22023'; end if;
  insert into public.leave_transactions (organization_id, employee_id, leave_type_id, txn_date, hours, kind, note, created_by)
  values (v_org, p_employee, p_type, coalesce(p_date, (now() at time zone 'Australia/Sydney')::date), round(p_hours, 4), p_kind, left(btrim(p_note), 300), p_actor);
  perform public.app_audit(p_actor, 'leave_adjusted', 'payroll_employee', p_employee::text, null,
    jsonb_build_object('type', (select code from public.leave_types where id = p_type), 'hours', p_hours, 'kind', p_kind, 'note', p_note), null,
    (select profile_id from public.employees where id = p_employee));
end;
$$;

------------------------------------------------------------------------------
-- 6. Pay runs
------------------------------------------------------------------------------

create or replace function public.pay_run_create(p_actor uuid, p_frequency text, p_start date, p_end date, p_payment date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid;
  v_len int := p_end - p_start + 1;
begin
  perform public.app_require(p_actor, 'payroll.run');
  if p_frequency not in ('weekly', 'fortnightly', 'monthly') then raise exception 'Choose how often this pay run pays.' using errcode = '22023'; end if;
  if p_start is null or p_end is null or p_payment is null or p_end < p_start then raise exception 'Choose the pay period and payment date.' using errcode = '22023'; end if;
  if (p_frequency = 'weekly' and v_len <> 7) or (p_frequency = 'fortnightly' and v_len <> 14)
     or (p_frequency = 'monthly' and (p_end <> (date_trunc('month', p_start) + interval '1 month - 1 day')::date or extract(day from p_start) <> 1)) then
    raise exception 'A % pay period must be % long.', p_frequency, case p_frequency when 'weekly' then '7 days' when 'fortnightly' then '14 days' else 'a calendar month' end using errcode = '22023';
  end if;
  if p_payment < p_start then raise exception 'The payment date can''t be before the period starts.' using errcode = '22023'; end if;
  if exists (select 1 from public.pay_runs where organization_id = v_org and pay_frequency = p_frequency and daterange(period_start, period_end, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'A % pay run already covers part of this period.', p_frequency using errcode = '22023';
  end if;
  insert into public.pay_runs (organization_id, number, pay_frequency, period_start, period_end, payment_date, prepared_by)
  values (v_org, public.next_document_number(v_org, 'pay_run'), p_frequency, p_start, p_end, p_payment, p_actor) returning id into v_id;
  perform public.app_audit(p_actor, 'pay_run_created', 'pay_run', v_id::text, null, jsonb_build_object('frequency', p_frequency, 'start', p_start, 'end', p_end, 'payment', p_payment));
  perform public.pay_run_calculate(p_actor, v_id);
  return v_id;
end;
$$;

-- Works out (again) every employee in a draft pay run. Manual lines are kept.
create or replace function public.pay_run_calculate(p_actor uuid, p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  r record;
  e record;
  v_pre uuid;
  v_rate numeric;
  v_ord_rate numeric;
  v_periods numeric;
  v_hours numeric;
  v_item record;
  t record;
  lv record;
  v_gross numeric; v_taxable numeric; v_ded numeric; v_reimb numeric; v_qe numeric; v_ss numeric; v_sg numeric; v_ord_hours numeric;
  v_w jsonb; v_scale text; v_sg_rate numeric; v_mcb numeric; v_prior_qe numeric;
  v_warn jsonb;
  v_nmw numeric;
  v_items jsonb;
  v_pe public.payroll_employees;
  v_worked numeric;
begin
  perform public.app_require(p_actor, 'payroll.run');
  select * into r from public.pay_runs where id = p_run and organization_id = v_org for update;
  if not found then raise exception 'Pay run not found.' using errcode = 'P0002'; end if;
  if r.status <> 'draft' then raise exception 'Only a draft pay run can be recalculated.' using errcode = '22023'; end if;
  select jsonb_object_agg(code, id) into v_items from public.pay_items where organization_id = v_org;
  v_sg_rate := (public.compliance_value('super_guarantee_rate', r.payment_date))::text::numeric;
  v_mcb := (public.compliance_value('super_max_contribution_base', r.payment_date))::text::numeric;
  v_nmw := (public.compliance_value('national_minimum_wage_hourly', r.payment_date))::text::numeric;
  if v_sg_rate is null then raise exception 'No super guarantee rate is recorded for %.', r.payment_date using errcode = '22023'; end if;
  v_periods := case r.pay_frequency when 'weekly' then 52 when 'fortnightly' then 26 else 12 end;

  -- Automatic lines are rebuilt; manual lines stay.
  delete from public.pay_run_lines l using public.pay_run_employees pre where l.pay_run_employee_id = pre.id and pre.pay_run_id = p_run and not l.manual;

  for e in
    select pe.*, emp.full_name, emp.profile_id from public.payroll_employees pe join public.employees emp on emp.id = pe.employee_id
    where pe.organization_id = v_org and pe.pay_frequency = r.pay_frequency and pe.status = 'active'
      and (pe.start_date is null or pe.start_date <= r.period_end) and (pe.end_date is null or pe.end_date >= r.period_start)
  loop
    insert into public.pay_run_employees (pay_run_id, employee_id) values (p_run, e.employee_id)
    on conflict (pay_run_id, employee_id) do nothing;
    select id into v_pre from public.pay_run_employees where pay_run_id = p_run and employee_id = e.employee_id;
    v_warn := '[]'::jsonb;
    v_rate := case when e.pay_basis = 'salary' and e.ordinary_hours_per_week > 0 then round(e.annual_salary / 52 / e.ordinary_hours_per_week, 4) else e.hourly_rate end;
    v_ord_rate := case when e.employment_basis = 'casual' then round(v_rate * (1 + e.casual_loading_percent / 100), 4) else v_rate end;
    if v_rate <= 0 then v_warn := v_warn || to_jsonb('No pay rate is set.'::text); end if;
    if v_nmw is not null and v_rate > 0 and v_rate < v_nmw then
      v_warn := v_warn || to_jsonb(format('The base rate %s is below the national minimum wage (%s an hour). Check the award rate.', v_rate, v_nmw));
    end if;
    if e.residency = 'working_holiday' then
      v_warn := v_warn || to_jsonb('Working holiday makers are taxed under Schedule 15, which isn''t supported yet. Withholding was not calculated; enter it as a manual adjustment and check with the accountant.'::text);
    end if;
    if e.bank_bsb is null then v_warn := v_warn || to_jsonb('No bank account on file.'::text); end if;
    if e.super_fund_usi is null and e.super_fund_abn is null then v_warn := v_warn || to_jsonb('No super fund on file. Request the stapled fund from the ATO, or use the default fund.'::text); end if;

    -- Leave taken: approved requests starting in this period.
    for lv in
      select lr.*, lt.code as type_code, lt.paid, lt.pay_item_code, lt.name as type_name from public.leave_requests lr join public.leave_types lt on lt.id = lr.leave_type_id
      where lr.employee_id = e.employee_id and lr.status = 'approved' and lr.pay_run_id is null and lr.start_date <= r.period_end
    loop
      if lv.paid and lv.pay_item_code is not null then
        insert into public.pay_run_lines (pay_run_employee_id, pay_item_id, description, hours, rate, amount, leave_request_id, sort)
        values (v_pre, (v_items->>lv.pay_item_code)::uuid, lv.type_name || ' ' || to_char(lv.start_date, 'DD Mon') || ' to ' || to_char(lv.end_date, 'DD Mon'),
          lv.hours, v_rate, round(lv.hours * v_rate, 2), lv.id, 60);
        if lv.type_code = 'ANNUAL' and e.leave_loading_percent > 0 then
          insert into public.pay_run_lines (pay_run_employee_id, pay_item_id, description, hours, rate, amount, leave_request_id, sort)
          values (v_pre, (v_items->>'LL')::uuid, 'Leave loading ' || e.leave_loading_percent || '%', lv.hours, round(v_rate * e.leave_loading_percent / 100, 4),
            round(lv.hours * v_rate * e.leave_loading_percent / 100, 2), lv.id, 70);
        end if;
        if public.leave_balance(e.employee_id, lv.leave_type_id) < lv.hours then
          v_warn := v_warn || to_jsonb(format('%s balance is less than the %s hours being taken.', lv.type_name, lv.hours));
        end if;
      end if;
    end loop;

    if e.pay_basis = 'salary' then
      v_hours := round(e.ordinary_hours_per_week * 52 / v_periods, 2)
        - coalesce((select sum(l.hours) from public.pay_run_lines l join public.pay_items pi on pi.id = l.pay_item_id
                    where l.pay_run_employee_id = v_pre and pi.code in ('AL', 'PL', 'LSL') and not l.manual), 0);
      insert into public.pay_run_lines (pay_run_employee_id, pay_item_id, description, hours, rate, amount, sort)
      values (v_pre, (v_items->>'SALARY')::uuid, 'Salary ' || to_char(e.annual_salary, 'FM$999,999,990.00') || ' a year', greatest(v_hours, 0), v_rate,
        round(e.annual_salary / v_periods, 2)
          - coalesce((select sum(l.amount) from public.pay_run_lines l join public.pay_items pi on pi.id = l.pay_item_id
                      where l.pay_run_employee_id = v_pre and pi.code in ('AL', 'PL', 'LSL') and not l.manual), 0), 10);
    else
      -- Hourly: approved timesheet hours in the period not yet paid.
      for t in
        select te.hour_type, te.project_id, sum(te.hours) as hours from public.timesheet_entries te join public.timesheets ts on ts.id = te.timesheet_id
        where ts.profile_id = e.profile_id and ts.status = 'approved' and te.pay_run_id is null and te.work_date <= r.period_end
          and (e.start_date is null or te.work_date >= e.start_date)
        group by te.hour_type, te.project_id order by te.hour_type
      loop
        select * into v_item from public.pay_items where organization_id = v_org and code = case t.hour_type
          when 'ordinary' then 'ORD' when 'overtime_150' then 'OT150' when 'overtime_200' then 'OT200' else 'TRAVEL' end;
        insert into public.pay_run_lines (pay_run_employee_id, pay_item_id, description, hours, rate, amount, project_id, sort)
        values (v_pre, v_item.id, v_item.name || coalesce(' · ' || (select number from public.projects where id = t.project_id), ''), t.hours,
          case when v_item.ordinary_hours then v_ord_rate else round(v_rate * v_item.rate_multiplier, 4) end,
          round(t.hours * case when v_item.ordinary_hours then v_ord_rate else round(v_rate * v_item.rate_multiplier, 4) end, 2), t.project_id, v_item.sort);
      end loop;
      if exists (select 1 from public.timesheet_entries te join public.timesheets ts on ts.id = te.timesheet_id
                 where ts.profile_id = e.profile_id and ts.status <> 'approved' and te.work_date between r.period_start and r.period_end) then
        v_warn := v_warn || to_jsonb('Some timesheet hours in this period aren''t approved yet and aren''t included.'::text);
      end if;
    end if;

    -- Totals.
    select coalesce(sum(case when pi.kind in ('earning', 'allowance') then l.amount end), 0),
           coalesce(sum(case when pi.kind in ('earning', 'allowance') and pi.taxable then l.amount end), 0),
           coalesce(sum(case when pi.kind = 'deduction' then l.amount end), 0),
           coalesce(sum(case when pi.kind = 'reimbursement' then l.amount end), 0),
           coalesce(sum(case when pi.qualifying_earnings and pi.kind in ('earning', 'allowance') then l.amount end), 0),
           coalesce(sum(case when pi.ordinary_hours then l.hours end), 0),
           coalesce(sum(case when pi.kind = 'earning' and pi.code not in ('AL', 'PL', 'LSL', 'PH', 'LL') then l.hours end), 0)
    into v_gross, v_taxable, v_ded, v_reimb, v_qe, v_ord_hours, v_worked
    from public.pay_run_lines l join public.pay_items pi on pi.id = l.pay_item_id where l.pay_run_employee_id = v_pre;

    -- Salary sacrifice to super comes out before tax (and still counts as qualifying earnings).
    v_ss := least(e.salary_sacrifice, v_taxable);
    v_taxable := v_taxable - v_ss;
    select * into v_pe from public.payroll_employees where employee_id = e.employee_id;
    v_scale := public.payroll_tax_scale(v_pe, r.payment_date);
    if e.residency = 'working_holiday' then
      v_w := jsonb_build_object('tax', 0, 'stsl', 0);
    else
      v_w := public.payg_withholding(v_scale, v_taxable, r.pay_frequency, r.payment_date, e.study_loan);
    end if;

    -- Super guarantee on qualifying earnings, up to the yearly maximum contribution base.
    select coalesce(sum(x.qualifying_earnings), 0) into v_prior_qe from public.pay_run_employees x join public.pay_runs pr on pr.id = x.pay_run_id
    where x.employee_id = e.employee_id and pr.status in ('approved', 'paid') and pr.payment_date >= public.payroll_fy_start(r.payment_date) and pr.payment_date <= r.payment_date;
    v_sg := round(least(v_qe, greatest(0, coalesce(v_mcb, v_qe + v_prior_qe) - v_prior_qe)) * v_sg_rate, 2);
    -- Under 18 and working 30 hours a week or less: no super guarantee.
    if e.date_of_birth is not null and age(r.payment_date, e.date_of_birth) < interval '18 years'
       and v_worked / greatest(1, (r.period_end - r.period_start + 1) / 7.0) <= 30 then
      v_sg := 0;
    end if;

    update public.pay_run_employees set gross = v_gross, taxable = v_taxable, payg = (v_w->>'tax')::numeric + (v_w->>'stsl')::numeric + case when v_gross > 0 then e.extra_withholding else 0 end,
      stsl = (v_w->>'stsl')::numeric, salary_sacrifice = v_ss, deductions = v_ded, reimbursements = v_reimb, qualifying_earnings = v_qe, super_guarantee = v_sg,
      tax_scale = v_scale, ordinary_hours = v_ord_hours, warnings = v_warn
    where id = v_pre;
    update public.pay_run_employees set net = gross - payg - salary_sacrifice - deductions + reimbursements where id = v_pre;
    if (select net from public.pay_run_employees where id = v_pre) < 0 then
      update public.pay_run_employees set warnings = warnings || to_jsonb('Deductions are more than the pay. Net pay can''t be negative.'::text) where id = v_pre;
    end if;
  end loop;

  -- People no longer in the run (status or frequency changed) and with no manual lines drop out.
  delete from public.pay_run_employees pre where pre.pay_run_id = p_run
    and not exists (select 1 from public.payroll_employees pe where pe.employee_id = pre.employee_id and pe.pay_frequency = r.pay_frequency and pe.status = 'active')
    and not exists (select 1 from public.pay_run_lines l where l.pay_run_employee_id = pre.id);

  update public.pay_runs set gross = coalesce((select sum(gross) from public.pay_run_employees where pay_run_id = p_run), 0),
    payg = coalesce((select sum(payg) from public.pay_run_employees where pay_run_id = p_run), 0),
    super = coalesce((select sum(super_guarantee + salary_sacrifice) from public.pay_run_employees where pay_run_id = p_run), 0),
    net = coalesce((select sum(net) from public.pay_run_employees where pay_run_id = p_run), 0),
    calculated_at = now(), updated_at = now()
  where id = p_run;
end;
$$;

-- Adds a manual line (allowance, bonus, deduction, reimbursement, correction) and recalculates.
create or replace function public.pay_run_line_add(p_actor uuid, p_run uuid, p_employee uuid, p_item uuid, p_description text, p_hours numeric, p_rate numeric, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_pre uuid;
  v_id uuid;
  v_amount numeric := p_amount;
begin
  perform public.app_require(p_actor, 'payroll.run');
  if (select status from public.pay_runs where id = p_run and organization_id = v_org) is distinct from 'draft' then
    raise exception 'Lines can only be added to a draft pay run.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pay_items where id = p_item and organization_id = v_org and active) then raise exception 'Choose a pay item.' using errcode = '22023'; end if;
  if p_hours is not null and p_rate is not null then v_amount := round(p_hours * p_rate, 2); end if;
  if v_amount is null or v_amount = 0 or v_amount <> round(v_amount, 2) then raise exception 'Enter an amount, or hours and a rate.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_description, ''))) < 2 then raise exception 'Describe the line; it appears on the payslip.' using errcode = '22023'; end if;
  select id into v_pre from public.pay_run_employees where pay_run_id = p_run and employee_id = p_employee;
  if v_pre is null then
    if not exists (select 1 from public.payroll_employees where employee_id = p_employee and organization_id = v_org and status = 'active'
                   and pay_frequency = (select pay_frequency from public.pay_runs where id = p_run)) then
      raise exception 'That employee isn''t paid in this pay run.' using errcode = '22023';
    end if;
    insert into public.pay_run_employees (pay_run_id, employee_id) values (p_run, p_employee) returning id into v_pre;
  end if;
  insert into public.pay_run_lines (pay_run_employee_id, pay_item_id, description, hours, rate, amount, manual, sort)
  values (v_pre, p_item, left(btrim(p_description), 200), p_hours, p_rate, v_amount, true, 200) returning id into v_id;
  perform public.app_audit(p_actor, 'pay_run_line_added', 'pay_run', p_run::text, null,
    jsonb_build_object('employee', p_employee, 'item', (select code from public.pay_items where id = p_item), 'amount', v_amount, 'description', p_description));
  perform public.pay_run_calculate(p_actor, p_run);
  return v_id;
end;
$$;

create or replace function public.pay_run_line_remove(p_actor uuid, p_line uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
begin
  perform public.app_require(p_actor, 'payroll.run');
  select pre.pay_run_id into v_run from public.pay_run_lines l join public.pay_run_employees pre on pre.id = l.pay_run_employee_id join public.pay_runs r on r.id = pre.pay_run_id
  where l.id = p_line and l.manual and r.status = 'draft' and r.organization_id = public.app_org_of(p_actor);
  if v_run is null then raise exception 'Only manual lines on a draft pay run can be removed.' using errcode = '22023'; end if;
  delete from public.pay_run_lines where id = p_line;
  perform public.app_audit(p_actor, 'pay_run_line_removed', 'pay_run', v_run::text, jsonb_build_object('line', p_line), null);
  perform public.pay_run_calculate(p_actor, v_run);
end;
$$;

create or replace function public.pay_run_submit(p_actor uuid, p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  perform public.app_require(p_actor, 'payroll.run');
  select * into r from public.pay_runs where id = p_run and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Pay run not found.' using errcode = 'P0002'; end if;
  if r.status <> 'draft' then raise exception 'Only a draft pay run can be submitted.' using errcode = '22023'; end if;
  perform public.pay_run_calculate(p_actor, p_run);
  -- People with nothing to pay this time drop out, so nobody gets an empty payslip.
  delete from public.pay_run_employees x where x.pay_run_id = p_run and x.gross = 0 and x.reimbursements = 0
    and not exists (select 1 from public.pay_run_lines l where l.pay_run_employee_id = x.id);
  if not exists (select 1 from public.pay_run_employees where pay_run_id = p_run and gross > 0) then raise exception 'Nobody is being paid in this pay run.' using errcode = '22023'; end if;
  if exists (select 1 from public.pay_run_employees where pay_run_id = p_run and net < 0) then raise exception 'Someone''s net pay is negative. Fix their deductions first.' using errcode = '22023'; end if;
  update public.pay_runs set status = 'submitted', submitted_at = now(), prepared_by = p_actor, updated_at = now() where id = p_run;
  perform public.app_notify_holders(r.organization_id, 'payroll.approve', p_actor, 'pay_run_submitted', 'Pay run to approve: ' || r.number,
    'Paid ' || to_char(r.payment_date, 'DD Mon YYYY') || ' · net ' || to_char((select net from public.pay_runs where id = p_run), 'FM$999,999,990.00'), 'pay-runs');
  perform public.app_audit(p_actor, 'pay_run_submitted', 'pay_run', p_run::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'submitted', 'gross', (select gross from public.pay_runs where id = p_run), 'net', (select net from public.pay_runs where id = p_run)));
end;
$$;

create or replace function public.pay_run_return(p_actor uuid, p_run uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select * into r from public.pay_runs where id = p_run and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Pay run not found.' using errcode = 'P0002'; end if;
  if r.status <> 'submitted' then raise exception 'Only a submitted pay run can be sent back.' using errcode = '22023'; end if;
  if not (public.app_has(p_actor, 'payroll.approve') or r.prepared_by = p_actor) then perform public.app_require(p_actor, 'payroll.approve'); end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say what needs changing.' using errcode = '22023'; end if;
  update public.pay_runs set status = 'draft', submitted_at = null, updated_at = now() where id = p_run;
  if r.prepared_by is not null and r.prepared_by <> p_actor then
    insert into public.notifications (organization_id, profile_id, kind, title, body, link)
    values (r.organization_id, r.prepared_by, 'pay_run_returned', 'Pay run sent back: ' || r.number, btrim(p_reason), 'pay-runs');
  end if;
  perform public.app_audit(p_actor, 'pay_run_returned', 'pay_run', p_run::text, jsonb_build_object('status', 'submitted'), jsonb_build_object('status', 'draft', 'reason', btrim(p_reason)));
end;
$$;

-- Approves and posts the pay run. Second person only. After this the pay run
-- can't change: corrections go in a later pay run.
create or replace function public.pay_run_approve(p_actor uuid, p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  r record;
  v_lines jsonb;
  v_journal uuid;
  pre record;
  lt record;
  v_accrue_hours numeric;
  v_acc_super uuid; v_acc_payg uuid; v_acc_super_pay uuid; v_acc_ded uuid; v_acc_clear uuid;
begin
  perform public.app_require(p_actor, 'payroll.approve');
  select * into r from public.pay_runs where id = p_run and organization_id = v_org for update;
  if not found then raise exception 'Pay run not found.' using errcode = 'P0002'; end if;
  if r.status <> 'submitted' then raise exception 'Only a submitted pay run can be approved.' using errcode = '22023'; end if;
  if r.prepared_by = p_actor then raise exception 'Someone other than the person who prepared it must approve the pay run.' using errcode = '42501'; end if;
  if exists (select 1 from public.pay_run_employees pq join public.employees e on e.id = pq.employee_id where pq.pay_run_id = p_run and e.profile_id = p_actor) then
    raise exception 'You''re paid in this pay run, so someone else must approve it.' using errcode = '42501';
  end if;

  select id into v_acc_super from public.accounts where organization_id = v_org and code = '6100';
  select id into v_acc_payg from public.accounts where organization_id = v_org and subtype = 'payg' and status = 'active' order by code limit 1;
  select id into v_acc_super_pay from public.accounts where organization_id = v_org and subtype = 'super' and status = 'active' order by code limit 1;
  select id into v_acc_ded from public.accounts where organization_id = v_org and code = '2600';
  select id into v_acc_clear from public.accounts where organization_id = v_org and code = '2400';

  -- Wages by the employee's wages account; reimbursements by their pay item's account.
  with earn as (
    select coalesce(pe.wages_account_id, (select id from public.accounts where organization_id = v_org and code = '5000')) as acc, sum(l.amount) as amt
    from public.pay_run_lines l join public.pay_items pi on pi.id = l.pay_item_id join public.pay_run_employees x on x.id = l.pay_run_employee_id
    join public.payroll_employees pe on pe.employee_id = x.employee_id
    where x.pay_run_id = p_run and pi.kind in ('earning', 'allowance') group by 1
  ), reimb as (
    select coalesce(pi.account_id, (select id from public.accounts where organization_id = v_org and code = '7900')) as acc, sum(l.amount) as amt
    from public.pay_run_lines l join public.pay_items pi on pi.id = l.pay_item_id join public.pay_run_employees x on x.id = l.pay_run_employee_id
    where x.pay_run_id = p_run and pi.kind = 'reimbursement' group by 1
  ), lines as (
    select acc, amt, 0::numeric as cr, 'Wages ' || r.number as d from earn where amt <> 0
    union all select acc, amt, 0, 'Reimbursements ' || r.number from reimb where amt <> 0
    union all select v_acc_super, sum(super_guarantee), 0, 'Super guarantee ' || r.number from public.pay_run_employees where pay_run_id = p_run having sum(super_guarantee) <> 0
    union all select v_acc_payg, 0, sum(payg), 'PAYG withheld ' || r.number from public.pay_run_employees where pay_run_id = p_run having sum(payg) <> 0
    union all select v_acc_super_pay, 0, sum(super_guarantee + salary_sacrifice), 'Super payable ' || r.number from public.pay_run_employees where pay_run_id = p_run having sum(super_guarantee + salary_sacrifice) <> 0
    union all select v_acc_ded, 0, sum(deductions), 'Deductions ' || r.number from public.pay_run_employees where pay_run_id = p_run having sum(deductions) <> 0
    union all select v_acc_clear, 0, sum(net), 'Net pay ' || r.number from public.pay_run_employees where pay_run_id = p_run having sum(net) <> 0
  )
  select jsonb_agg(jsonb_build_object('accountId', acc, 'debit', amt, 'credit', cr, 'description', d, 'taxCodeId', null)) into v_lines from lines;
  v_journal := public.ledger_post_entry(p_actor, r.payment_date, 'Pay run ' || r.number || ' (' || to_char(r.period_start, 'DD Mon') || ' to ' || to_char(r.period_end, 'DD Mon YYYY') || ')',
    'pay_run', p_run, r.number, v_lines, 'no_tax', false);

  -- Timesheet hours, leave taken and leave accruals.
  update public.timesheet_entries te set pay_run_id = p_run
  from public.timesheets ts, public.employees e, public.pay_run_employees x
  where te.timesheet_id = ts.id and ts.profile_id = e.profile_id and x.employee_id = e.id and x.pay_run_id = p_run
    and ts.status = 'approved' and te.pay_run_id is null and te.work_date <= r.period_end
    and (select pay_basis from public.payroll_employees where employee_id = e.id) = 'hourly';
  update public.timesheets ts set payroll_locked_at = now() where exists (select 1 from public.timesheet_entries te where te.timesheet_id = ts.id and te.pay_run_id = p_run);
  insert into public.leave_transactions (organization_id, employee_id, leave_type_id, txn_date, hours, kind, pay_run_id, leave_request_id, note, created_by)
  select v_org, lr.employee_id, lr.leave_type_id, lr.start_date, -lr.hours, 'taken', p_run, lr.id, 'Taken, paid in ' || r.number, p_actor
  from public.leave_requests lr where lr.id in (select l.leave_request_id from public.pay_run_lines l join public.pay_run_employees x on x.id = l.pay_run_employee_id where x.pay_run_id = p_run);
  update public.leave_requests set status = 'paid', pay_run_id = p_run
  where id in (select l.leave_request_id from public.pay_run_lines l join public.pay_run_employees x on x.id = l.pay_run_employee_id where x.pay_run_id = p_run);
  for pre in select x.*, pe.employment_basis, pe.annual_leave_weeks from public.pay_run_employees x join public.payroll_employees pe on pe.employee_id = x.employee_id
             where x.pay_run_id = p_run and pe.employment_basis <> 'casual' and x.ordinary_hours > 0 loop
    for lt in select * from public.leave_types where organization_id = v_org and active and accrual_per_hour > 0 loop
      v_accrue_hours := round(pre.ordinary_hours * case when lt.code = 'ANNUAL' then pre.annual_leave_weeks / 52.0 else lt.accrual_per_hour end, 4);
      insert into public.leave_transactions (organization_id, employee_id, leave_type_id, txn_date, hours, kind, pay_run_id, note, created_by)
      values (v_org, pre.employee_id, lt.id, r.period_end, v_accrue_hours, 'accrual', p_run, 'Accrued in ' || r.number, p_actor);
    end loop;
  end loop;

  -- Payslip snapshots: what each person's payslip shows, fixed at approval.
  update public.pay_run_employees x set snapshot = jsonb_build_object(
    'employee', (select jsonb_build_object('name', e.full_name, 'number', e.employee_number, 'basis', pe.employment_basis, 'payBasis', pe.pay_basis,
        'annualSalary', case when pe.pay_basis = 'salary' then pe.annual_salary end, 'award', pe.award, 'classification', pe.classification,
        'fund', coalesce(pe.super_fund_name, ''), 'fundUsi', pe.super_fund_usi, 'member', pe.super_member_number,
        'bank', case when pe.bank_account_number is not null then '***' || right(pe.bank_account_number, 3) end)
      from public.employees e join public.payroll_employees pe on pe.employee_id = e.id where e.id = x.employee_id),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('code', pi.code, 'kind', pi.kind, 'name', pi.name, 'description', l.description, 'hours', l.hours, 'rate', l.rate,
        'amount', l.amount, 'payee', pi.payee) order by l.sort, pi.sort), '[]'::jsonb)
      from public.pay_run_lines l join public.pay_items pi on pi.id = l.pay_item_id where l.pay_run_employee_id = x.id),
    'leave', (select coalesce(jsonb_agg(jsonb_build_object('type', lt2.name, 'balance', public.leave_balance(x.employee_id, lt2.id, r.period_end))), '[]'::jsonb)
      from public.leave_types lt2 where lt2.organization_id = v_org and lt2.active and lt2.paid and lt2.accrual_per_hour > 0
        and exists (select 1 from public.leave_transactions t where t.employee_id = x.employee_id and t.leave_type_id = lt2.id)),
    'ytd', (select jsonb_build_object('gross', sum(y.gross), 'payg', sum(y.payg), 'super', sum(y.super_guarantee + y.salary_sacrifice), 'net', sum(y.net))
      from public.pay_run_employees y join public.pay_runs pr on pr.id = y.pay_run_id
      where y.employee_id = x.employee_id and (pr.id = p_run or pr.status in ('approved', 'paid'))
        and pr.payment_date between public.payroll_fy_start(r.payment_date) and r.payment_date))
  where x.pay_run_id = p_run;

  update public.pay_runs set status = 'approved', approved_by = p_actor, approved_at = now(), journal_id = v_journal, updated_at = now() where id = p_run;
  if r.prepared_by is not null then
    insert into public.notifications (organization_id, profile_id, kind, title, body, link)
    values (v_org, r.prepared_by, 'pay_run_approved', 'Pay run approved: ' || r.number, 'Pay the net amounts and the super, then record both.', 'pay-runs');
  end if;
  perform public.app_audit(p_actor, 'pay_run_approved', 'pay_run', p_run::text, jsonb_build_object('status', 'submitted'),
    jsonb_build_object('status', 'approved', 'gross', r.gross, 'payg', r.payg, 'super', r.super, 'net', r.net, 'journal', (select number from public.journal_entries where id = v_journal)));
end;
$$;

-- Records that the net pay left the bank: Dr Payroll clearing, Cr Bank.
create or replace function public.pay_run_record_payment(p_actor uuid, p_run uuid, p_bank uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  r record;
  v_j uuid;
begin
  if not (public.app_has(p_actor, 'payroll.run') or public.app_has(p_actor, 'bank.manage')) then perform public.app_require(p_actor, 'bank.manage'); end if;
  select * into r from public.pay_runs where id = p_run and organization_id = v_org for update;
  if not found then raise exception 'Pay run not found.' using errcode = 'P0002'; end if;
  if r.status <> 'approved' then raise exception 'Only an approved, unpaid pay run can be marked as paid.' using errcode = '22023'; end if;
  if not exists (select 1 from public.accounts where id = p_bank and organization_id = v_org and subtype = 'bank' and status = 'active') then
    raise exception 'Choose the bank account the pay came from.' using errcode = '22023';
  end if;
  v_j := public.ledger_post_entry(p_actor, coalesce(p_date, r.payment_date), 'Net pay for ' || r.number, 'pay_run_payment', p_run, r.number,
    jsonb_build_array(
      jsonb_build_object('accountId', (select id from public.accounts where organization_id = v_org and code = '2400'), 'debit', r.net, 'credit', 0, 'description', 'Net pay ' || r.number),
      jsonb_build_object('accountId', p_bank, 'debit', 0, 'credit', r.net, 'description', 'Net pay ' || r.number)), 'no_tax', false);
  update public.pay_runs set status = 'paid', paid_at = coalesce(p_date, r.payment_date), payment_journal_id = v_j, updated_at = now() where id = p_run;
  perform public.app_audit(p_actor, 'pay_run_paid', 'pay_run', p_run::text, jsonb_build_object('status', 'approved'), jsonb_build_object('status', 'paid', 'net', r.net));
end;
$$;

-- Records the super contributions for a pay run as paid: Dr Super payable, Cr Bank.
create or replace function public.pay_run_record_super(p_actor uuid, p_run uuid, p_bank uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  r record;
  v_j uuid;
begin
  if not (public.app_has(p_actor, 'payroll.run') or public.app_has(p_actor, 'bank.manage')) then perform public.app_require(p_actor, 'bank.manage'); end if;
  select * into r from public.pay_runs where id = p_run and organization_id = v_org for update;
  if not found then raise exception 'Pay run not found.' using errcode = 'P0002'; end if;
  if r.status not in ('approved', 'paid') or r.super_paid_at is not null then raise exception 'Super for this pay run is already recorded, or the run isn''t approved.' using errcode = '22023'; end if;
  if r.super = 0 then raise exception 'There is no super to pay in this pay run.' using errcode = '22023'; end if;
  if not exists (select 1 from public.accounts where id = p_bank and organization_id = v_org and subtype = 'bank' and status = 'active') then
    raise exception 'Choose the bank account the super came from.' using errcode = '22023';
  end if;
  v_j := public.ledger_post_entry(p_actor, coalesce(p_date, r.payment_date), 'Super contributions for ' || r.number, 'super_payment', p_run, r.number,
    jsonb_build_array(
      jsonb_build_object('accountId', (select id from public.accounts where organization_id = v_org and subtype = 'super' and status = 'active' order by code limit 1), 'debit', r.super, 'credit', 0, 'description', 'Super ' || r.number),
      jsonb_build_object('accountId', p_bank, 'debit', 0, 'credit', r.super, 'description', 'Super ' || r.number)), 'no_tax', false);
  update public.pay_runs set super_paid_at = coalesce(p_date, r.payment_date), super_journal_id = v_j, updated_at = now() where id = p_run;
  perform public.app_audit(p_actor, 'super_paid', 'pay_run', p_run::text, null, jsonb_build_object('super', r.super, 'paidOn', coalesce(p_date, r.payment_date),
    'dueBy', public.add_business_days(r.payment_date, coalesce((public.compliance_value('super_payday_due_business_days', r.payment_date))::text::int, 7))));
end;
$$;

create or replace function public.pay_run_delete(p_actor uuid, p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  perform public.app_require(p_actor, 'payroll.run');
  select * into r from public.pay_runs where id = p_run and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Pay run not found.' using errcode = 'P0002'; end if;
  if r.status <> 'draft' then raise exception 'Only a draft pay run can be deleted. Approved pay runs are final.' using errcode = '22023'; end if;
  delete from public.pay_runs where id = p_run;
  perform public.app_audit(p_actor, 'pay_run_deleted', 'pay_run', p_run::text, jsonb_build_object('number', r.number, 'gross', r.gross), null);
end;
$$;

------------------------------------------------------------------------------
-- 7. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['pay_items', 'leave_types', 'payroll_employees', 'leave_transactions', 'leave_requests', 'pay_runs', 'pay_run_employees', 'pay_run_lines']
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
    'payg_withholding(text, numeric, text, date, boolean)', 'payroll_tax_scale(public.payroll_employees, date)', 'leave_balance(uuid, uuid, date)',
    'payroll_employee_save(uuid, uuid, jsonb)', 'payroll_bank_request(uuid, uuid, text, text, text)', 'approval_decide(uuid, uuid, boolean, text)',
    'leave_request_save(uuid, uuid, uuid, date, date, numeric, text)', 'leave_request_decide(uuid, uuid, text, text)',
    'leave_adjust(uuid, uuid, uuid, date, numeric, text, text)',
    'pay_run_create(uuid, text, date, date, date)', 'pay_run_calculate(uuid, uuid)', 'pay_run_line_add(uuid, uuid, uuid, uuid, text, numeric, numeric, numeric)',
    'pay_run_line_remove(uuid, uuid)', 'pay_run_submit(uuid, uuid)', 'pay_run_return(uuid, uuid, text)', 'pay_run_approve(uuid, uuid)',
    'pay_run_record_payment(uuid, uuid, uuid, date)', 'pay_run_record_super(uuid, uuid, uuid, date)', 'pay_run_delete(uuid, uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
-- Pure functions are safe for anyone.
grant execute on function public.app_valid_tfn(text), public.payg_weekly_x(numeric, text), public.payg_apply(jsonb, numeric),
  public.payg_period_amount(numeric, text), public.payroll_fy_start(date), public.add_business_days(date, int) to anon, authenticated, service_role;

commit;
