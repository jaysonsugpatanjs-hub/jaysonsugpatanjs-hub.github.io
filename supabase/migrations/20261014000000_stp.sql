-- Panalo Accounts, Phase 8 (part 1): Single Touch Payroll Phase 2 information.
--
-- * Each pay item is mapped to its STP Phase 2 category (gross, overtime,
--   bonuses and commissions, directors' fees, paid leave by type, allowances
--   by type, deductions by type, or not reported).
-- * Employees get the STP details: family and given names, home address,
--   income type, and a cessation type when they finish. Employment basis
--   and the tax treatment code are worked out from the pay details.
-- * STP events: a pay event for each approved pay run, update events when
--   year-to-date amounts change, and a finalisation event for the year. Each
--   holds a record per employee with the year-to-date amounts by category,
--   checked against the reporting rules (errors stop it, warnings don't).
-- * Statuses follow the brief: Draft, Validated, Ready, then Submitted,
--   Accepted, Partially accepted, Rejected, Corrected, Finalised. Only the
--   first three can be reached here.
--
-- Sending to the ATO is switched off at the database: stp_settings.
-- transmission_enabled can't be true until a later migration connects an
-- approved sending service provider, after ATO product registration and
-- conformance testing. Until then, keep lodging STP from the current payroll
-- product and use these records to check it.

begin;

------------------------------------------------------------------------------
-- 1. Settings, mapping, employee details
------------------------------------------------------------------------------

create table public.stp_settings (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  bms_id uuid not null default gen_random_uuid(), -- this payroll's business management software ID
  branch text not null default '001' check (branch ~ '^\d{3}$'),
  contact_name text check (contact_name is null or length(contact_name) <= 120),
  contact_phone text check (contact_phone is null or length(contact_phone) <= 30),
  contact_email text check (contact_email is null or length(contact_email) <= 200),
  transmission_enabled boolean not null default false check (not transmission_enabled),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.training_profiles(id) on delete set null
);
insert into public.stp_settings (organization_id) select id from public.organizations on conflict do nothing;

alter table public.pay_items
  add column stp_category text not null default 'gross'
    check (stp_category in ('gross', 'overtime', 'bonus', 'directors_fees', 'paid_leave', 'allowance', 'deduction', 'not_reported')),
  add column stp_code text,
  add constraint pay_items_stp_code check (
    (stp_category = 'paid_leave' and stp_code in ('C', 'U', 'P', 'W', 'A', 'O'))
    or (stp_category = 'allowance' and stp_code in ('CD', 'AD', 'LD', 'MD', 'RD', 'TD', 'KN', 'QN', 'H1', 'ND', 'T1', 'U1', 'V1', 'G1'))
    or (stp_category = 'deduction' and stp_code in ('F', 'W', 'G', 'D'))
    or (stp_category not in ('paid_leave', 'allowance', 'deduction') and stp_code is null));

-- Defaults for the seeded items. Allowance codes H1, ND, T1, U1, V1 and G1 are
-- the descriptors of "other allowances" (OD). Check these with the accountant.
update public.pay_items set stp_category = 'gross', stp_code = null where code in ('ORD', 'TRAVEL', 'SALARY');
update public.pay_items set stp_category = 'overtime', stp_code = null where code in ('OT150', 'OT200');
update public.pay_items set stp_category = 'paid_leave', stp_code = 'O' where code in ('AL', 'LL', 'PL', 'LSL');
-- A public holiday not worked is reported as if worked (gross).
update public.pay_items set stp_category = 'gross', stp_code = null where code = 'PH';
update public.pay_items set stp_category = 'bonus', stp_code = null where code = 'BONUS';
update public.pay_items set stp_category = 'allowance', stp_code = 'TD' where code = 'TOOL';
update public.pay_items set stp_category = 'allowance', stp_code = 'MD' where code = 'MEAL';
update public.pay_items set stp_category = 'not_reported', stp_code = null where code in ('REIMB', 'DEDUCT');
update public.pay_items set stp_category = 'deduction', stp_code = 'F' where code = 'UNION';

alter table public.payroll_employees
  add column family_name text check (family_name is null or length(family_name) between 1 and 40),
  add column given_names text check (given_names is null or length(given_names) between 1 and 80),
  add column home_address jsonb not null default '{}'::jsonb,
  add column stp_income_type text not null default 'SAW' check (stp_income_type in ('SAW', 'CHP', 'IAA', 'WHM', 'SWP', 'FEI', 'JPD', 'VOL', 'LAB', 'OSP')),
  add column stp_country text check (stp_country is null or stp_country ~ '^[a-z]{2}$'),
  add column cessation_type text check (cessation_type is null or cessation_type in ('V', 'I', 'D', 'R', 'F', 'C', 'T'));

-- Names from the HR register to start with: the last word as the family name.
update public.payroll_employees pe set
  family_name = left(regexp_replace(btrim(e.full_name), '^.*\s', ''), 40),
  given_names = nullif(left(btrim(regexp_replace(btrim(e.full_name), '\s*\S+$', '')), 80), '')
from public.employees e where e.id = pe.employee_id and pe.family_name is null;

------------------------------------------------------------------------------
-- 2. Events
------------------------------------------------------------------------------

create table public.stp_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null check (kind in ('pay', 'update', 'finalisation')),
  pay_run_id uuid references public.pay_runs(id) on delete restrict,
  year_start date not null,
  as_at date not null, -- payment date for a pay event; the date of the year-to-date figures otherwise
  status text not null default 'draft' check (status in ('draft', 'validated', 'ready', 'submitted', 'accepted', 'partially_accepted', 'rejected', 'corrected', 'finalised')),
  employer jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb, -- employer-level
  totals jsonb not null default '{}'::jsonb,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  ready_by uuid references public.training_profiles(id) on delete set null,
  ready_at timestamptz,
  submitted_at timestamptz,
  submission_reference text,
  response jsonb,
  check ((kind = 'pay') = (pay_run_id is not null))
);
create unique index stp_events_pay_run on public.stp_events (pay_run_id) where kind = 'pay';
create index stp_events_org_idx on public.stp_events (organization_id, year_start, created_at desc);

create table public.stp_employee_records (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.stp_events(id) on delete cascade,
  employee_id uuid not null references public.payroll_employees(employee_id) on delete restrict,
  payee jsonb not null,  -- details as reported (the TFN is kept masked; exports read it fresh)
  ytd jsonb not null,    -- year-to-date amounts by STP category
  final boolean not null default false,
  errors jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  unique (event_id, employee_id)
);

------------------------------------------------------------------------------
-- 3. Working it out
------------------------------------------------------------------------------

-- The six-character tax treatment code: category and option, then study and
-- training support loans (S or X), Medicare levy surcharge (X: not
-- collected here), Medicare levy exemption (F, H or X), Medicare levy
-- reduction (X: not collected here).
create or replace function public.stp_tax_treatment(p public.payroll_employees, p_date date)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p.residency = 'working_holiday' then case when p.tfn_status = 'not_provided'
        or (p.tfn_status = 'applied' and coalesce(p.tfn_applied_on, p.start_date, p_date) < p_date - 28) then 'HF' else 'HR' end || 'XXXX'
    when p.tfn_status = 'not_provided' or (p.tfn_status = 'applied' and coalesce(p.tfn_applied_on, p.start_date, p_date) < p_date - 28)
      then case when p.residency = 'foreign' then 'NF' else 'NA' end || 'XXXX'
    when p.residency = 'foreign' then 'FF' || case when p.study_loan then 'S' else 'X' end || 'XXX'
    else case when p.tax_free_threshold then 'RT' else 'RN' end
      || case when p.study_loan then 'S' else 'X' end
      || 'X'
      || case p.medicare_exemption when 'full' then 'F' when 'half' then 'H' else 'X' end
      || 'X'
  end;
$$;

-- What goes in the TFN field: the TFN, or the ATO's code when there isn't one.
create or replace function public.stp_tfn_code(p public.payroll_employees, p_date date)
returns text
language sql
stable
set search_path = ''
as $$
  select case p.tfn_status
    when 'provided' then p.tfn
    when 'applied' then case when coalesce(p.tfn_applied_on, p.start_date, p_date) >= p_date - 28 then '111111111' else '000000000' end
    when 'exempt' then case when p.date_of_birth is not null and age(p_date, p.date_of_birth) < interval '18 years' then '333333333' else '444444444' end
    else '000000000' end;
$$;

-- Year-to-date amounts by STP category for one employee: approved pay runs
-- paid from the start of the year up to the date. Gross is after salary
-- sacrifice (reported separately), as STP Phase 2 asks.
create or replace function public.stp_ytd(p_org uuid, p_employee uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t record;
  v_lines jsonb;
  v_gross numeric;
begin
  select coalesce(sum(x.payg), 0) as payg, coalesce(sum(x.salary_sacrifice), 0) as ss, coalesce(sum(x.super_guarantee), 0) as sg,
         coalesce(sum(x.qualifying_earnings), 0) as ote, count(*) as pays
  into t
  from public.pay_run_employees x join public.pay_runs r on r.id = x.pay_run_id
  where r.organization_id = p_org and x.employee_id = p_employee and r.status in ('approved', 'paid') and r.payment_date between p_from and p_to;

  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_lines from (
    select pi.stp_category || coalesce(':' || pi.stp_code, '') as k, sum(l.amount) as v
    from public.pay_run_lines l
    join public.pay_run_employees x on x.id = l.pay_run_employee_id
    join public.pay_runs r on r.id = x.pay_run_id
    join public.pay_items pi on pi.id = l.pay_item_id
    where r.organization_id = p_org and x.employee_id = p_employee and r.status in ('approved', 'paid') and r.payment_date between p_from and p_to
      and pi.stp_category <> 'not_reported' and pi.kind in ('earning', 'allowance', 'deduction')
      and ((pi.kind = 'deduction') = (pi.stp_category = 'deduction'))
    group by 1
  ) s;
  v_gross := coalesce((v_lines->>'gross')::numeric, 0) - t.ss;
  return jsonb_build_object(
    'gross', v_gross,
    'overtime', coalesce((v_lines->>'overtime')::numeric, 0),
    'bonus', coalesce((v_lines->>'bonus')::numeric, 0),
    'directorsFees', coalesce((v_lines->>'directors_fees')::numeric, 0),
    'paidLeave', coalesce((select jsonb_object_agg(split_part(k, ':', 2), v) from jsonb_each_text(v_lines) e(k, v) where k like 'paid_leave:%'), '{}'::jsonb),
    'allowances', coalesce((select jsonb_object_agg(split_part(k, ':', 2), v) from jsonb_each_text(v_lines) e(k, v) where k like 'allowance:%'), '{}'::jsonb),
    'deductions', coalesce((select jsonb_object_agg(split_part(k, ':', 2), v) from jsonb_each_text(v_lines) e(k, v) where k like 'deduction:%'), '{}'::jsonb),
    'salarySacrifice', jsonb_build_object('S', t.ss),
    'payg', t.payg,
    'super', jsonb_build_object('L', t.sg, 'OTE', t.ote, 'RESC', t.ss),
    'pays', t.pays);
end;
$$;

-- Builds (or rebuilds) an event's employee records and checks them.
create or replace function public.stp_build(p_event uuid, p_employees uuid[], p_final boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ev record;
  s record;
  c record;
  p public.payroll_employees;
  e record;
  v_errs jsonb; v_warn jsonb; v_payee jsonb; v_ytd jsonb;
  v_emp_errors jsonb := '[]'::jsonb;
  v_end date;
  v_tt text;
begin
  select * into ev from public.stp_events where id = p_event for update;
  select * into s from public.stp_settings where organization_id = ev.organization_id;
  select * into c from public.company_settings where organization_id = ev.organization_id;
  v_end := ev.as_at;

  -- The employer.
  if c.abn is null or not public.app_valid_abn(c.abn) then v_emp_errors := v_emp_errors || to_jsonb('The company ABN is missing or not valid (Company settings).'::text); end if;
  if coalesce(c.legal_name, '') = '' then v_emp_errors := v_emp_errors || to_jsonb('The company legal name is missing.'::text); end if;
  if coalesce(c.business_address->>'postcode', '') = '' then v_emp_errors := v_emp_errors || to_jsonb('The company address is incomplete (Company settings).'::text); end if;
  if coalesce(s.contact_name, '') = '' or coalesce(s.contact_phone, '') = '' then
    v_emp_errors := v_emp_errors || to_jsonb('Add the STP contact person''s name and phone number (Payroll > STP > Settings).'::text);
  end if;

  delete from public.stp_employee_records where event_id = p_event;
  for p in select pe.* from public.payroll_employees pe where pe.employee_id = any(p_employees) loop
    select * into e from public.employees where id = p.employee_id;
    v_errs := '[]'::jsonb; v_warn := '[]'::jsonb;
    -- Names from the HR register until payroll enters them: the last word is the family name.
    p.family_name := coalesce(p.family_name, nullif(left(regexp_replace(btrim(e.full_name), '^.*\s', ''), 40), ''));
    p.given_names := coalesce(p.given_names, nullif(left(btrim(regexp_replace(btrim(e.full_name), '\s*\S+$', '')), 80), ''));
    v_tt := public.stp_tax_treatment(p, v_end);
    v_ytd := public.stp_ytd(ev.organization_id, p.employee_id, ev.year_start, v_end);
    v_payee := jsonb_build_object(
      'payrollId', e.employee_number, 'familyName', p.family_name, 'givenNames', p.given_names, 'dateOfBirth', p.date_of_birth,
      'address', p.home_address, 'tfn', case when public.stp_tfn_code(p, v_end) = p.tfn and p.tfn is not null then '••• ••• ' || right(p.tfn, 3) else public.stp_tfn_code(p, v_end) end,
      'tfnStatus', p.tfn_status, 'startDate', coalesce(p.start_date, e.start_date), 'endDate', p.end_date, 'cessationType', p.cessation_type,
      'employmentBasis', case p.employment_basis when 'full_time' then 'F' when 'part_time' then 'P' when 'casual' then 'C' end,
      'taxTreatment', v_tt, 'incomeType', p.stp_income_type, 'country', p.stp_country);

    if coalesce(p.family_name, '') = '' then v_errs := v_errs || to_jsonb('Family name is missing.'::text); end if;
    if p.date_of_birth is null then v_errs := v_errs || to_jsonb('Date of birth is missing.'::text); end if;
    if coalesce(p.home_address->>'street', '') = '' or coalesce(p.home_address->>'suburb', '') = '' or coalesce(p.home_address->>'state', '') = ''
       or coalesce(p.home_address->>'postcode', '') !~ '^\d{4}$' then
      v_errs := v_errs || to_jsonb('Home address is incomplete (street, suburb, state and postcode).'::text);
    end if;
    if coalesce(p.start_date, e.start_date) is null then v_errs := v_errs || to_jsonb('Start date is missing.'::text); end if;
    if p.tfn_status = 'provided' and (p.tfn is null or not public.app_valid_tfn(p.tfn)) then v_errs := v_errs || to_jsonb('The TFN isn''t valid.'::text); end if;
    if p.end_date is not null and p.end_date <= v_end and p.cessation_type is null then
      v_errs := v_errs || to_jsonb('They finished on ' || to_char(p.end_date, 'DD Mon YYYY') || ': choose the reason they left (cessation type).');
    end if;
    if p.cessation_type is not null and p.end_date is null then v_errs := v_errs || to_jsonb('A cessation type is set but there is no finish date.'::text); end if;
    if p.stp_income_type in ('IAA', 'WHM', 'FEI') and p.stp_country is null then
      v_errs := v_errs || to_jsonb(('Income type ' || p.stp_income_type || ' needs the country (two-letter code).')::text);
    end if;
    if p.residency = 'working_holiday' and p.stp_income_type <> 'WHM' then v_errs := v_errs || to_jsonb('A working holiday maker''s income type is WHM.'::text); end if;
    if p.residency <> 'working_holiday' and p.stp_income_type = 'WHM' then v_errs := v_errs || to_jsonb('Income type WHM is only for working holiday makers.'::text); end if;
    if (v_ytd->>'gross')::numeric < 0 then v_errs := v_errs || to_jsonb('Gross for the year is negative after salary sacrifice.'::text); end if;
    if p.residency = 'working_holiday' then v_warn := v_warn || to_jsonb('Tax treatment HR assumes Panalo is a registered working holiday maker employer. Use HU if not.'::text); end if;
    if p.tfn_status = 'applied' and public.stp_tfn_code(p, v_end) = '000000000' then
      v_warn := v_warn || to_jsonb('TFN applied for more than 28 days ago: reported as not quoted. Ask for the TFN.'::text);
    end if;
    if (v_ytd->>'pays')::int = 0 then v_warn := v_warn || to_jsonb('No pay this financial year.'::text); end if;
    insert into public.stp_employee_records (event_id, employee_id, payee, ytd, final, errors, warnings)
    values (p_event, p.employee_id, v_payee, v_ytd, coalesce(p_final, false), v_errs, v_warn);
  end loop;

  update public.stp_events set
    employer = jsonb_build_object('abn', c.abn, 'name', c.legal_name, 'branch', s.branch, 'bmsId', s.bms_id, 'address', c.business_address,
      'contact', jsonb_build_object('name', s.contact_name, 'phone', s.contact_phone, 'email', s.contact_email)),
    errors = v_emp_errors,
    totals = (select jsonb_build_object('payees', count(*), 'gross', coalesce(sum((r.ytd->>'gross')::numeric), 0), 'payg', coalesce(sum((r.ytd->>'payg')::numeric), 0),
        'withErrors', count(*) filter (where jsonb_array_length(r.errors) > 0)) from public.stp_employee_records r where r.event_id = p_event)
      || case when ev.kind = 'pay' then (select jsonb_build_object('runGross', gross, 'runPayg', payg) from public.pay_runs where id = ev.pay_run_id) else '{}'::jsonb end,
    status = case when jsonb_array_length(v_emp_errors) = 0
      and not exists (select 1 from public.stp_employee_records r where r.event_id = p_event and jsonb_array_length(r.errors) > 0) then 'validated' else 'draft' end,
    validated_at = now()
  where id = p_event;
end;
$$;

-- The financial year a date falls in.
create or replace function public.stp_year_start(p_org uuid, p_date date)
returns date
language sql
stable
set search_path = ''
as $$
  select make_date(extract(year from p_date)::int - case when extract(month from p_date)::int < m then 1 else 0 end, m, 1)
  from (select coalesce((select financial_year_start_month from public.company_settings where organization_id = p_org), 7) as m) x;
$$;

------------------------------------------------------------------------------
-- 4. Actions
------------------------------------------------------------------------------

create or replace function public.stp_settings_save(p_actor uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old jsonb;
begin
  perform public.app_require(p_actor, 'payroll.sensitive');
  if coalesce(p->>'branch', '001') !~ '^\d{3}$' then raise exception 'The branch number is 3 digits (usually 001).' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p->>'contact_email', '')), '') is not null and p->>'contact_email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That email address doesn''t look right.' using errcode = '22023';
  end if;
  select to_jsonb(s) - 'bms_id' into v_old from public.stp_settings s where organization_id = v_org;
  insert into public.stp_settings (organization_id) values (v_org) on conflict do nothing;
  update public.stp_settings set branch = coalesce(nullif(p->>'branch', ''), branch),
    contact_name = nullif(left(btrim(coalesce(p->>'contact_name', '')), 120), ''), contact_phone = nullif(left(btrim(coalesce(p->>'contact_phone', '')), 30), ''),
    contact_email = nullif(left(lower(btrim(coalesce(p->>'contact_email', ''))), 200), ''), updated_at = now(), updated_by = p_actor
  where organization_id = v_org;
  perform public.app_audit(p_actor, 'stp_settings_saved', 'stp_settings', v_org::text, v_old,
    (select to_jsonb(s) - 'bms_id' from public.stp_settings s where organization_id = v_org));
end;
$$;

create or replace function public.stp_pay_item_map(p_actor uuid, p_item uuid, p_category text, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'payroll.sensitive');
  select * into v from public.pay_items where id = p_item and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Pay item not found.' using errcode = 'P0002'; end if;
  if p_category <> 'not_reported' and ((v.kind = 'deduction') <> (p_category = 'deduction') or v.kind = 'reimbursement') then
    raise exception '%', case when v.kind = 'deduction' then 'A deduction is reported as a deduction, or not reported.'
      when v.kind = 'reimbursement' then 'Reimbursements aren''t reported.' else 'Earnings and allowances can''t be reported as deductions.' end using errcode = '22023';
  end if;
  begin
    update public.pay_items set stp_category = p_category, stp_code = nullif(btrim(coalesce(p_code, '')), '') where id = p_item;
  exception when check_violation then
    raise exception 'That STP category and code don''t go together.' using errcode = '22023';
  end;
  perform public.app_audit(p_actor, 'pay_item_stp_mapped', 'pay_item', p_item::text, jsonb_build_object('category', v.stp_category, 'code', v.stp_code),
    jsonb_build_object('category', p_category, 'code', p_code), jsonb_build_object('item', v.code));
end;
$$;

-- An employee's STP details (names, home address, income type, country, cessation type).
create or replace function public.payroll_employee_stp_save(p_actor uuid, p_employee uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old jsonb;
  v_addr jsonb := coalesce(p->'home_address', '{}'::jsonb);
begin
  perform public.app_require(p_actor, 'payroll.sensitive');
  if not exists (select 1 from public.payroll_employees where employee_id = p_employee and organization_id = v_org) then
    raise exception 'Set up their pay details first.' using errcode = 'P0002';
  end if;
  if (select profile_id from public.employees where id = p_employee) = p_actor then
    raise exception 'Someone else in payroll must change your own pay details.' using errcode = '42501';
  end if;
  if coalesce(v_addr->>'postcode', '') <> '' and v_addr->>'postcode' !~ '^\d{4}$' then raise exception 'A postcode is 4 digits.' using errcode = '22023'; end if;
  if coalesce(v_addr->>'state', '') <> '' and v_addr->>'state' not in ('ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA', 'OTH') then
    raise exception 'Choose the state.' using errcode = '22023';
  end if;
  select jsonb_build_object('family_name', family_name, 'given_names', given_names, 'stp_income_type', stp_income_type, 'stp_country', stp_country,
    'cessation_type', cessation_type, 'address', home_address) into v_old from public.payroll_employees where employee_id = p_employee;
  begin
    update public.payroll_employees set
      family_name = nullif(left(btrim(coalesce(p->>'family_name', '')), 40), ''),
      given_names = nullif(left(btrim(coalesce(p->>'given_names', '')), 80), ''),
      home_address = jsonb_build_object('street', left(btrim(coalesce(v_addr->>'street', '')), 120), 'street2', left(btrim(coalesce(v_addr->>'street2', '')), 120),
        'suburb', left(btrim(coalesce(v_addr->>'suburb', '')), 60), 'state', coalesce(v_addr->>'state', ''), 'postcode', coalesce(v_addr->>'postcode', '')),
      stp_income_type = coalesce(nullif(p->>'stp_income_type', ''), stp_income_type),
      stp_country = nullif(lower(btrim(coalesce(p->>'stp_country', ''))), ''),
      cessation_type = nullif(p->>'cessation_type', ''),
      updated_at = now(), updated_by = p_actor
    where employee_id = p_employee;
  exception when check_violation then
    raise exception 'Check the income type, country (two letters) and cessation type.' using errcode = '22023';
  end;
  -- The address is personal information: the audit says it changed, not what it is.
  perform public.app_audit(p_actor, 'payroll_employee_stp_saved', 'payroll_employee', p_employee::text, v_old - 'address',
    jsonb_build_object('family_name', p->>'family_name', 'given_names', p->>'given_names', 'stp_income_type', p->>'stp_income_type',
      'stp_country', p->>'stp_country', 'cessation_type', p->>'cessation_type',
      'addressChanged', (select home_address from public.payroll_employees where employee_id = p_employee) is distinct from v_old->'address'),
    null, (select profile_id from public.employees where id = p_employee));
end;
$$;

-- A pay event for an approved pay run: everyone paid in it, year to date.
create or replace function public.stp_event_pay(p_actor uuid, p_run uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  r record;
  v_id uuid;
begin
  perform public.app_require(p_actor, 'payroll.run');
  select * into r from public.pay_runs where id = p_run and organization_id = v_org for update;
  if not found then raise exception 'Pay run not found.' using errcode = 'P0002'; end if;
  if r.status not in ('approved', 'paid') then raise exception 'STP is prepared once the pay run is approved.' using errcode = '22023'; end if;
  if exists (select 1 from public.stp_events where pay_run_id = p_run) then raise exception 'This pay run already has an STP pay event.' using errcode = '22023'; end if;
  insert into public.stp_events (organization_id, kind, pay_run_id, year_start, as_at, created_by)
  values (v_org, 'pay', p_run, public.stp_year_start(v_org, r.payment_date), r.payment_date, p_actor) returning id into v_id;
  perform public.stp_build(v_id, array(select employee_id from public.pay_run_employees where pay_run_id = p_run), false);
  perform public.app_audit(p_actor, 'stp_event_created', 'stp_event', v_id::text, null, jsonb_build_object('kind', 'pay', 'payRun', r.number));
  return v_id;
end;
$$;

-- An update event: employees whose year-to-date amounts have changed since
-- they were last in a ready (or later) event. A finalisation event: everyone
-- paid in the year, marked final.
create or replace function public.stp_event_year(p_actor uuid, p_kind text, p_year_start date, p_as_at date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_end date;
  v_as_at date;
  v_emps uuid[];
  v_id uuid;
  emp uuid;
  v_last jsonb;
begin
  perform public.app_require(p_actor, 'payroll.run');
  if p_kind not in ('update', 'finalisation') then raise exception 'Unknown STP event.' using errcode = '22023'; end if;
  if p_year_start is null or p_year_start <> public.stp_year_start(v_org, p_year_start) then raise exception 'Choose the financial year.' using errcode = '22023'; end if;
  v_end := (p_year_start + interval '1 year - 1 day')::date;
  v_as_at := least(coalesce(p_as_at, v_end), v_end);
  if v_as_at < p_year_start then raise exception 'The date must be in the financial year.' using errcode = '22023'; end if;
  if exists (select 1 from public.stp_events where organization_id = v_org and year_start = p_year_start and status in ('draft', 'validated')) then
    raise exception 'Finish (mark ready or delete) the STP events still being prepared for this year first.' using errcode = '22023';
  end if;
  v_emps := array(select distinct x.employee_id from public.pay_run_employees x join public.pay_runs r on r.id = x.pay_run_id
    where r.organization_id = v_org and r.status in ('approved', 'paid') and r.payment_date between p_year_start and v_as_at);
  if p_kind = 'update' then
    -- Only the people whose figures differ from what was last made ready.
    v_emps := array(select e from unnest(v_emps) e where public.stp_ytd(v_org, e, p_year_start, v_as_at) - 'pays' is distinct from (
      select r.ytd - 'pays' from public.stp_employee_records r join public.stp_events ev on ev.id = r.event_id
      where r.employee_id = e and ev.organization_id = v_org and ev.year_start = p_year_start and ev.status not in ('draft', 'validated')
      order by ev.as_at desc, ev.created_at desc limit 1));
    if cardinality(v_emps) = 0 then raise exception 'Nobody''s year-to-date figures have changed since the last STP event.' using errcode = '22023'; end if;
  elsif cardinality(v_emps) = 0 then
    raise exception 'Nobody was paid in this financial year.' using errcode = '22023';
  elsif exists (select 1 from public.pay_runs r where r.organization_id = v_org and r.status in ('approved', 'paid') and r.payment_date between p_year_start and v_as_at
                and not exists (select 1 from public.stp_events e where e.pay_run_id = r.id and e.status not in ('draft', 'validated'))) then
    raise exception 'Some pay runs in this year have no STP pay event marked ready (%). Prepare those first.',
      (select string_agg(r.number, ', ' order by r.payment_date) from public.pay_runs r where r.organization_id = v_org and r.status in ('approved', 'paid')
        and r.payment_date between p_year_start and v_as_at and not exists (select 1 from public.stp_events e where e.pay_run_id = r.id and e.status not in ('draft', 'validated')))
      using errcode = '22023';
  end if;
  insert into public.stp_events (organization_id, kind, year_start, as_at, created_by)
  values (v_org, p_kind, p_year_start, v_as_at, p_actor) returning id into v_id;
  perform public.stp_build(v_id, v_emps, p_kind = 'finalisation');
  perform public.app_audit(p_actor, 'stp_event_created', 'stp_event', v_id::text, null,
    jsonb_build_object('kind', p_kind, 'year', to_char(p_year_start, 'YYYY'), 'payees', cardinality(v_emps)));
  return v_id;
end;
$$;

-- Checks the event again (after details are fixed).
create or replace function public.stp_event_check(p_actor uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'payroll.run');
  select * into v from public.stp_events where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'STP event not found.' using errcode = 'P0002'; end if;
  if v.status not in ('draft', 'validated') then raise exception 'Only an event being prepared can be checked again.' using errcode = '22023'; end if;
  perform public.stp_build(p_id, array(select employee_id from public.stp_employee_records where event_id = p_id),
    coalesce((select bool_or(final) from public.stp_employee_records where event_id = p_id), v.kind = 'finalisation'));
  return (select status from public.stp_events where id = p_id);
end;
$$;

-- Ready to report: checked with no errors, and confirmed by someone who
-- approves pay runs (not the person who prepared it).
create or replace function public.stp_event_ready(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_before jsonb;
begin
  perform public.app_require(p_actor, 'payroll.approve');
  select * into v from public.stp_events where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'STP event not found.' using errcode = 'P0002'; end if;
  if v.status <> 'validated' then raise exception 'Only a checked event with no errors can be marked ready.' using errcode = '22023'; end if;
  if v.created_by = p_actor then raise exception 'Someone other than the person who prepared it must mark it ready.' using errcode = '42501'; end if;
  -- Everything must still be what was checked: rebuild and compare (an
  -- exception rolls the rebuild back).
  v_before := (select jsonb_agg(jsonb_build_array(r.employee_id, r.payee, r.ytd, r.errors) order by r.employee_id) from public.stp_employee_records r where r.event_id = p_id);
  perform public.stp_build(p_id, array(select employee_id from public.stp_employee_records where event_id = p_id),
    coalesce((select bool_or(final) from public.stp_employee_records where event_id = p_id), v.kind = 'finalisation'));
  if (select jsonb_agg(jsonb_build_array(r.employee_id, r.payee, r.ytd, r.errors) order by r.employee_id) from public.stp_employee_records r where r.event_id = p_id) is distinct from v_before
     or (select status from public.stp_events where id = p_id) <> 'validated' then
    raise exception 'Pay or employee details have changed since this event was checked. Check it again.' using errcode = '22023';
  end if;
  update public.stp_events set status = 'ready', ready_by = p_actor, ready_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'stp_event_ready', 'stp_event', p_id::text, jsonb_build_object('status', 'validated'), jsonb_build_object('status', 'ready'));
end;
$$;

-- Sending is switched off until an approved sending service provider is
-- connected (see STP_ROADMAP.md). This is the one place that would send.
create or replace function public.stp_event_submit(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'payroll.approve');
  if not coalesce((select transmission_enabled from public.stp_settings where organization_id = public.app_org_of(p_actor)), false) then
    raise exception 'Sending STP to the ATO isn''t switched on in Panalo Accounts. Report this pay through your current STP payroll product; it needs ATO product registration, conformance testing and an approved sending service provider first.'
      using errcode = '22023';
  end if;
  raise exception 'STP transmission isn''t built yet.' using errcode = '22023';
end;
$$;

create or replace function public.stp_event_delete(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'payroll.run');
  select * into v from public.stp_events where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'STP event not found.' using errcode = 'P0002'; end if;
  if v.status not in ('draft', 'validated') then raise exception 'Only an event being prepared can be deleted.' using errcode = '22023'; end if;
  delete from public.stp_events where id = p_id;
  perform public.app_audit(p_actor, 'stp_event_deleted', 'stp_event', p_id::text, jsonb_build_object('kind', v.kind, 'asAt', v.as_at), null);
end;
$$;

------------------------------------------------------------------------------
-- 5. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['stp_settings', 'stp_events', 'stp_employee_records'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
  foreach f in array array[
    'stp_tax_treatment(public.payroll_employees, date)', 'stp_tfn_code(public.payroll_employees, date)', 'stp_ytd(uuid, uuid, date, date)',
    'stp_build(uuid, uuid[], boolean)', 'stp_year_start(uuid, date)', 'stp_settings_save(uuid, jsonb)', 'stp_pay_item_map(uuid, uuid, text, text)',
    'payroll_employee_stp_save(uuid, uuid, jsonb)', 'stp_event_pay(uuid, uuid)', 'stp_event_year(uuid, text, date, date)', 'stp_event_check(uuid, uuid)',
    'stp_event_ready(uuid, uuid)', 'stp_event_submit(uuid, uuid)', 'stp_event_delete(uuid, uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

commit;
