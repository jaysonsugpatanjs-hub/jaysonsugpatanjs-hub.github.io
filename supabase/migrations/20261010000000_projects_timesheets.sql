-- Panalo Accounts, Phase 4: projects, cost codes, timesheets and job costing.
--
-- * projects (numbered JOB-1001…), with a budget per cost code.
-- * cost_codes: what a cost is for (labour, materials, subcontract…).
-- * labour_classes: standard hourly cost and charge-out rates by trade, so job
--   costing doesn't expose anyone's individual pay. Each person who records
--   time has a class (labour_profiles).
-- * timesheets: one per person per week (Monday start), with entries per day,
--   project and cost code. Draft -> Submitted -> Approved (or Rejected).
--   Approval freezes each entry's cost (hours x class rate x overtime factor).
--   Approved timesheets are kept as the employer's time records; a correction
--   reopens the timesheet with a reason, which is audited.
-- * Invoice, bill, quote and purchase order lines can be tagged with a project
--   (and, for costs, a cost code). Job costing reads approved timesheets,
--   approved bills (actual), open purchase orders (committed) and approved
--   invoices (revenue).
-- * Labour costs here are management figures for job costing; wages reach the
--   general ledger through payroll (Phase 5), so nothing is posted twice.
begin;

------------------------------------------------------------------------------
-- 0. Permissions, numbering
------------------------------------------------------------------------------

insert into public.app_permissions (key, name, description, sort, area, admin_default, requires_mfa) values
  ('time.submit', 'Enter my timesheets', 'Record your own hours against projects and submit them for approval.', 205, 'Accounts', true, false);
insert into public.app_role_permissions (role_key, permission_key) values
  ('project_manager', 'time.submit'), ('supervisor', 'time.submit');

alter table public.number_sequences drop constraint number_sequences_kind_check;
alter table public.number_sequences add constraint number_sequences_kind_check
  check (kind in ('invoice', 'quote', 'purchase_order', 'credit_note', 'bill', 'journal', 'pay_run', 'project'));
insert into public.number_sequences (organization_id, kind, prefix, next_number, padding)
select id, 'project', 'JOB-', 1001, 4 from public.organizations on conflict do nothing;

------------------------------------------------------------------------------
-- 1. Cost codes, labour classes, projects, budgets
------------------------------------------------------------------------------

create table public.cost_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code text not null check (code ~ '^[0-9A-Z][0-9A-Z.-]{0,9}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  category text not null check (category in ('labour', 'materials', 'equipment', 'subcontract', 'travel', 'consumables', 'freight', 'other')),
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);
insert into public.cost_codes (organization_id, code, name, category, sort)
select o.id, c, n, k, s from public.organizations o, (values
  ('100', 'Labour - fabrication', 'labour', 10),
  ('110', 'Labour - welding', 'labour', 20),
  ('120', 'Labour - site installation', 'labour', 30),
  ('130', 'Labour - supervision', 'labour', 40),
  ('140', 'Labour - shutdown and maintenance', 'labour', 50),
  ('200', 'Materials - pipe, steel and fittings', 'materials', 60),
  ('210', 'Welding consumables and gases', 'consumables', 70),
  ('300', 'Equipment and plant hire', 'equipment', 80),
  ('400', 'Subcontractors', 'subcontract', 90),
  ('410', 'Testing and inspection (NDT)', 'subcontract', 100),
  ('500', 'Travel and accommodation', 'travel', 110),
  ('600', 'Freight and cartage', 'freight', 120),
  ('900', 'Other project costs', 'other', 130)
) as v(c, n, k, s);

create table public.labour_classes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  cost_rate numeric(10,2) not null default 0 check (cost_rate >= 0),
  charge_rate numeric(10,2) not null default 0 check (charge_rate >= 0),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);
-- Rates start at zero: Panalo sets its own (they're commercial, and the
-- loaded cost depends on award, super, workers compensation and on-costs).
insert into public.labour_classes (organization_id, code, name)
select o.id, c, n from public.organizations o, (values
  ('WELDER', 'Welder'), ('FITTER', 'Pipe fitter / fabricator'), ('RIGGER', 'Rigger / dogman'), ('LAB', 'Trades assistant / labourer'),
  ('SUP', 'Supervisor / leading hand'), ('APP', 'Apprentice')
) as v(c, n);

-- Which labour class a person's hours are costed at.
create table public.labour_profiles (
  profile_id uuid primary key references public.training_profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  labour_class_id uuid not null references public.labour_classes(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.training_profiles(id) on delete set null
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  number text not null,
  name text not null check (length(btrim(name)) between 2 and 160),
  customer_id uuid references public.customers(id) on delete restrict,
  quote_id uuid references public.quotes(id) on delete set null,
  site text not null default '',
  customer_reference text,
  manager_id uuid references public.training_profiles(id) on delete set null,
  billing_type text not null default 'fixed_price' check (billing_type in ('fixed_price', 'schedule_of_rates', 'cost_plus', 'internal')),
  contract_value numeric(14,2) not null default 0 check (contract_value >= 0),
  start_date date,
  end_date date,
  status text not null default 'active' check (status in ('tender', 'active', 'on_hold', 'completed', 'closed', 'cancelled')),
  notes text not null default '',
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, number),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index projects_status_idx on public.projects (organization_id, status);

create table public.project_budgets (
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid not null references public.cost_codes(id) on delete restrict,
  budget_hours numeric(10,2) not null default 0 check (budget_hours >= 0),
  budget_amount numeric(14,2) not null default 0 check (budget_amount >= 0),
  primary key (project_id, cost_code_id)
);

-- Job costing tags on document lines.
alter table public.quote_lines add column project_id uuid references public.projects(id) on delete restrict, add column cost_code_id uuid references public.cost_codes(id) on delete restrict;
alter table public.invoice_lines add column project_id uuid references public.projects(id) on delete restrict, add column cost_code_id uuid references public.cost_codes(id) on delete restrict;
alter table public.purchase_order_lines add column project_id uuid references public.projects(id) on delete restrict, add column cost_code_id uuid references public.cost_codes(id) on delete restrict;
alter table public.bill_lines add column project_id uuid references public.projects(id) on delete restrict, add column cost_code_id uuid references public.cost_codes(id) on delete restrict;
create index invoice_lines_project_idx on public.invoice_lines (project_id) where project_id is not null;
create index bill_lines_project_idx on public.bill_lines (project_id) where project_id is not null;
create index purchase_order_lines_project_idx on public.purchase_order_lines (project_id) where project_id is not null;

------------------------------------------------------------------------------
-- 2. Timesheets
------------------------------------------------------------------------------

create table public.timesheets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  profile_id uuid not null references public.training_profiles(id) on delete restrict,
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  total_hours numeric(6,2) not null default 0,
  submitted_at timestamptz, submitted_by uuid references public.training_profiles(id) on delete set null,
  decided_at timestamptz, decided_by uuid references public.training_profiles(id) on delete set null,
  decision_comment text,
  payroll_locked_at timestamptz,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, week_start)
);
create index timesheets_status_idx on public.timesheets (organization_id, status, week_start);

create table public.timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references public.timesheets(id) on delete cascade,
  line_no integer not null,
  work_date date not null,
  project_id uuid references public.projects(id) on delete restrict,
  cost_code_id uuid references public.cost_codes(id) on delete restrict,
  start_time time,
  end_time time,
  break_minutes integer not null default 0 check (break_minutes between 0 and 600),
  hours numeric(5,2) not null check (hours > 0 and hours <= 24),
  hour_type text not null default 'ordinary' check (hour_type in ('ordinary', 'overtime_150', 'overtime_200', 'travel')),
  notes text not null default '',
  labour_class_id uuid references public.labour_classes(id) on delete restrict,
  cost_rate numeric(10,2),
  cost_amount numeric(12,2),
  unique (timesheet_id, line_no)
);
create index timesheet_entries_project_idx on public.timesheet_entries (project_id) where project_id is not null;

create or replace function public.hour_type_factor(p_type text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'overtime_150' then 1.5 when 'overtime_200' then 2.0 else 1.0 end;
$$;

-- The Monday of the week containing a date.
create or replace function public.week_start_of(p_date date)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_date - (extract(isodow from p_date)::int - 1);
$$;

------------------------------------------------------------------------------
-- 3. Maintenance: cost codes, labour classes and people, projects
------------------------------------------------------------------------------

create or replace function public.cost_code_save(p_actor uuid, p_id uuid, p_code text, p_name text, p_category text, p_active boolean)
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
  perform public.app_require(p_actor, 'projects.manage');
  if v_id is null then
    insert into public.cost_codes (organization_id, code, name, category, sort)
    values (v_org, upper(btrim(p_code)), btrim(p_name), p_category, coalesce((select max(sort) + 10 from public.cost_codes where organization_id = v_org), 10))
    returning id into v_id;
  else
    select to_jsonb(c) into v_old from public.cost_codes c where id = p_id and organization_id = v_org for update;
    if v_old is null then raise exception 'Cost code not found.' using errcode = 'P0002'; end if;
    update public.cost_codes set code = upper(btrim(p_code)), name = btrim(p_name), category = p_category, active = coalesce(p_active, true) where id = p_id;
  end if;
  perform public.app_audit(p_actor, case when p_id is null then 'cost_code_created' else 'cost_code_updated' end, 'cost_code', v_id::text, v_old,
    (select to_jsonb(c) from public.cost_codes c where id = v_id));
  return v_id;
end;
$$;

create or replace function public.labour_class_save(p_actor uuid, p_id uuid, p_code text, p_name text, p_cost numeric, p_charge numeric, p_active boolean)
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
  perform public.app_require(p_actor, 'projects.manage');
  if p_cost is null or p_cost < 0 or p_cost <> round(p_cost, 2) or p_charge is null or p_charge < 0 or p_charge <> round(p_charge, 2) then
    raise exception 'Rates are dollars and cents per hour.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.labour_classes (organization_id, code, name, cost_rate, charge_rate) values (v_org, upper(btrim(p_code)), btrim(p_name), p_cost, p_charge)
    returning id into v_id;
  else
    select to_jsonb(c) into v_old from public.labour_classes c where id = p_id and organization_id = v_org for update;
    if v_old is null then raise exception 'Labour class not found.' using errcode = 'P0002'; end if;
    update public.labour_classes set code = upper(btrim(p_code)), name = btrim(p_name), cost_rate = p_cost, charge_rate = p_charge,
      active = coalesce(p_active, true), updated_at = now() where id = p_id;
  end if;
  perform public.app_audit(p_actor, case when p_id is null then 'labour_class_created' else 'labour_class_updated' end, 'labour_class', v_id::text, v_old,
    (select to_jsonb(c) from public.labour_classes c where id = v_id));
  return v_id;
end;
$$;

create or replace function public.labour_profile_set(p_actor uuid, p_profile uuid, p_class uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old uuid;
begin
  perform public.app_require(p_actor, 'projects.manage');
  if public.app_org_of(p_profile) is distinct from v_org then raise exception 'Person not found.' using errcode = 'P0002'; end if;
  select labour_class_id into v_old from public.labour_profiles where profile_id = p_profile;
  if p_class is null then
    delete from public.labour_profiles where profile_id = p_profile;
  else
    if not exists (select 1 from public.labour_classes where id = p_class and organization_id = v_org and active) then
      raise exception 'Choose an active labour class.' using errcode = '22023';
    end if;
    insert into public.labour_profiles (profile_id, organization_id, labour_class_id, updated_by) values (p_profile, v_org, p_class, p_actor)
    on conflict (profile_id) do update set labour_class_id = excluded.labour_class_id, updated_at = now(), updated_by = p_actor;
  end if;
  perform public.app_audit(p_actor, 'labour_class_assigned', 'labour_profile', p_profile::text, jsonb_build_object('labourClassId', v_old),
    jsonb_build_object('labourClassId', p_class), null, p_profile);
end;
$$;

create or replace function public.project_save(p_actor uuid, p_id uuid, p jsonb, p_budgets jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid := p_id;
  v_old jsonb;
  b jsonb;
  v_hours numeric; v_amount numeric;
begin
  perform public.app_require(p_actor, 'projects.manage');
  if length(btrim(coalesce(p->>'name', ''))) < 2 then
    raise exception 'Give the project a name.' using errcode = '22023';
  end if;
  if nullif(p->>'customer_id', '') is not null and not exists (select 1 from public.customers where id = (p->>'customer_id')::uuid and organization_id = v_org) then
    raise exception 'Unknown customer.' using errcode = '22023';
  end if;
  if nullif(p->>'quote_id', '') is not null and not exists (select 1 from public.quotes where id = (p->>'quote_id')::uuid and organization_id = v_org
      and customer_id is not distinct from nullif(p->>'customer_id', '')::uuid) then
    raise exception 'That quote is not for this customer.' using errcode = '22023';
  end if;
  if nullif(p->>'manager_id', '') is not null and public.app_org_of((p->>'manager_id')::uuid) is distinct from v_org then
    raise exception 'Unknown project manager.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.projects (organization_id, number, name, created_by)
    values (v_org, public.next_document_number(v_org, 'project'), btrim(p->>'name'), p_actor) returning id into v_id;
  else
    select to_jsonb(x) into v_old from public.projects x where id = p_id and organization_id = v_org for update;
    if v_old is null then raise exception 'Project not found.' using errcode = 'P0002'; end if;
  end if;
  update public.projects set name = btrim(p->>'name'), customer_id = nullif(p->>'customer_id', '')::uuid, quote_id = nullif(p->>'quote_id', '')::uuid,
    site = left(coalesce(p->>'site', ''), 300), customer_reference = nullif(btrim(coalesce(p->>'customer_reference', '')), ''),
    manager_id = nullif(p->>'manager_id', '')::uuid, billing_type = coalesce(nullif(p->>'billing_type', ''), 'fixed_price'),
    contract_value = coalesce(nullif(p->>'contract_value', '')::numeric, 0), start_date = nullif(p->>'start_date', '')::date,
    end_date = nullif(p->>'end_date', '')::date, notes = left(coalesce(p->>'notes', ''), 3000), updated_at = now()
  where id = v_id;
  if p_budgets is not null then
    delete from public.project_budgets where project_id = v_id;
    for b in select * from jsonb_array_elements(p_budgets) loop
      v_hours := coalesce(nullif(b->>'hours', '')::numeric, 0);
      v_amount := coalesce(nullif(b->>'amount', '')::numeric, 0);
      if v_hours = 0 and v_amount = 0 then continue; end if;
      if v_hours < 0 or v_amount < 0 or v_amount <> round(v_amount, 2) then
        raise exception 'Budgets must be positive amounts.' using errcode = '22023';
      end if;
      if not exists (select 1 from public.cost_codes where id = (b->>'costCodeId')::uuid and organization_id = v_org) then
        raise exception 'Unknown cost code in the budget.' using errcode = '22023';
      end if;
      insert into public.project_budgets (project_id, cost_code_id, budget_hours, budget_amount) values (v_id, (b->>'costCodeId')::uuid, v_hours, v_amount)
      on conflict (project_id, cost_code_id) do update set budget_hours = public.project_budgets.budget_hours + excluded.budget_hours,
        budget_amount = public.project_budgets.budget_amount + excluded.budget_amount;
    end loop;
  end if;
  perform public.app_audit(p_actor, case when p_id is null then 'project_created' else 'project_updated' end, 'project', v_id::text, v_old,
    (select to_jsonb(x) - 'created_at' - 'updated_at' from public.projects x where id = v_id) || jsonb_build_object('budget',
      (select coalesce(sum(budget_amount), 0) from public.project_budgets where project_id = v_id)));
  return v_id;
end;
$$;

create or replace function public.project_set_status(p_actor uuid, p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'projects.manage');
  if p_status not in ('tender', 'active', 'on_hold', 'completed', 'closed', 'cancelled') then
    raise exception 'Unknown project status.' using errcode = '22023';
  end if;
  select * into v from public.projects where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Project not found.' using errcode = 'P0002'; end if;
  if p_status = 'closed' and exists (select 1 from public.timesheets t join public.timesheet_entries e on e.timesheet_id = t.id
      where e.project_id = p_id and t.status in ('draft', 'submitted', 'rejected')) then
    raise exception 'Timesheets with hours on this project are still waiting. Approve or correct them before closing it.' using errcode = '22023';
  end if;
  update public.projects set status = p_status, updated_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'project_status_changed', 'project', p_id::text, jsonb_build_object('status', v.status), jsonb_build_object('status', p_status));
end;
$$;

------------------------------------------------------------------------------
-- 4. Timesheet workflow
------------------------------------------------------------------------------

-- Saves a week's hours for a person (yourself, or your crew if you approve
-- timesheets). Entries: [{date, projectId, costCodeId, start, end,
-- breakMinutes, hours, hourType, notes}]. With times, hours are worked out
-- (an end before the start means the shift ran past midnight).
create or replace function public.timesheet_save(p_actor uuid, p_profile uuid, p_week date, p_entries jsonb, p_submit boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_profile uuid := coalesce(p_profile, p_actor);
  v_ts record;
  v_id uuid;
  e jsonb;
  v_no int := 0;
  v_date date; v_start time; v_end time; v_break int; v_hours numeric; v_minutes numeric;
  v_project uuid; v_code uuid; v_type text;
  v_total numeric := 0;
  v_name text;
begin
  if v_profile = p_actor then
    if not (public.app_has(p_actor, 'time.submit') or public.app_has(p_actor, 'time.approve')) then
      perform public.app_require(p_actor, 'time.submit');
    end if;
  else
    perform public.app_require(p_actor, 'time.approve');
    if public.app_org_of(v_profile) is distinct from v_org or not (select active from public.training_profiles where id = v_profile) then
      raise exception 'Person not found.' using errcode = 'P0002';
    end if;
  end if;
  if p_week is null or extract(isodow from p_week) <> 1 then
    raise exception 'A timesheet week starts on a Monday.' using errcode = '22023';
  end if;
  if p_week > public.week_start_of((now() at time zone 'Australia/Sydney')::date) + 7 then
    raise exception 'Timesheets can''t be entered more than a week ahead.' using errcode = '22023';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 100 then
    raise exception 'A week can have up to 100 entries.' using errcode = '22023';
  end if;

  select * into v_ts from public.timesheets where profile_id = v_profile and week_start = p_week for update;
  if found then
    if v_ts.status = 'approved' then
      raise exception 'This week has been approved. Ask your supervisor to reopen it to make a change.' using errcode = '22023';
    end if;
    if v_ts.status = 'submitted' then
      raise exception 'This week is waiting for approval. Recall it first to make a change.' using errcode = '22023';
    end if;
    v_id := v_ts.id;
  else
    insert into public.timesheets (organization_id, profile_id, week_start, created_by) values (v_org, v_profile, p_week, p_actor) returning id into v_id;
  end if;

  delete from public.timesheet_entries where timesheet_id = v_id;
  for e in select * from jsonb_array_elements(p_entries) loop
    v_no := v_no + 1;
    begin
      v_date := (e->>'date')::date;
      v_start := nullif(e->>'start', '')::time;
      v_end := nullif(e->>'end', '')::time;
      v_break := coalesce(nullif(e->>'breakMinutes', '')::int, 0);
      v_hours := nullif(e->>'hours', '')::numeric;
    exception when others then
      raise exception 'Entry %: check the date, times and hours.', v_no using errcode = '22023';
    end;
    if v_date is null or v_date < p_week or v_date > p_week + 6 then
      raise exception 'Entry %: the date must be in the week starting %.', v_no, to_char(p_week, 'DD Mon YYYY') using errcode = '22023';
    end if;
    if (v_start is null) <> (v_end is null) then
      raise exception 'Entry %: enter both a start and a finish time, or neither.', v_no using errcode = '22023';
    end if;
    if v_break < 0 or v_break > 600 then
      raise exception 'Entry %: the break must be between 0 and 600 minutes.', v_no using errcode = '22023';
    end if;
    if v_start is not null then
      v_minutes := extract(epoch from (v_end - v_start)) / 60;
      if v_minutes <= 0 then v_minutes := v_minutes + 1440; end if;
      v_hours := round((v_minutes - v_break) / 60.0, 2);
    end if;
    if v_hours is null or v_hours <= 0 or v_hours > 24 or v_hours <> round(v_hours, 2) then
      raise exception 'Entry %: hours must be more than 0 and no more than 24.', v_no using errcode = '22023';
    end if;
    v_project := nullif(e->>'projectId', '')::uuid;
    v_code := nullif(e->>'costCodeId', '')::uuid;
    if v_project is not null and not exists (select 1 from public.projects where id = v_project and organization_id = v_org and status not in ('closed', 'cancelled')) then
      raise exception 'Entry %: that project is closed or doesn''t exist.', v_no using errcode = '22023';
    end if;
    if v_code is not null and not exists (select 1 from public.cost_codes where id = v_code and organization_id = v_org and active and category = 'labour') then
      raise exception 'Entry %: choose a labour cost code.', v_no using errcode = '22023';
    end if;
    v_type := coalesce(nullif(e->>'hourType', ''), 'ordinary');
    if v_type not in ('ordinary', 'overtime_150', 'overtime_200', 'travel') then
      raise exception 'Entry %: unknown type of hours.', v_no using errcode = '22023';
    end if;
    insert into public.timesheet_entries (timesheet_id, line_no, work_date, project_id, cost_code_id, start_time, end_time, break_minutes, hours, hour_type, notes)
    values (v_id, v_no, v_date, v_project, v_code, v_start, v_end, v_break, v_hours, v_type, left(coalesce(e->>'notes', ''), 300));
    v_total := v_total + v_hours;
  end loop;
  if exists (select 1 from public.timesheet_entries where timesheet_id = v_id group by work_date having sum(hours) > 24) then
    raise exception 'A day can''t have more than 24 hours.' using errcode = '22023';
  end if;
  update public.timesheets set total_hours = v_total, status = case when p_submit then 'submitted' else 'draft' end,
    submitted_at = case when p_submit then now() end, submitted_by = case when p_submit then p_actor end,
    decided_at = null, decided_by = null, updated_at = now()
  where id = v_id;
  if p_submit then
    if v_no = 0 then raise exception 'Add your hours before submitting.' using errcode = '22023'; end if;
    select coalesce(nullif(full_name, ''), email) into v_name from public.training_profiles where id = v_profile;
    perform public.app_notify_holders(v_org, 'time.approve', v_profile, 'timesheet_submitted', 'Timesheet to approve: ' || v_name,
      to_char(p_week, 'DD Mon') || ' week · ' || v_total || ' hours', 'timesheets/review');
  end if;
  perform public.app_audit(p_actor, case when p_submit then 'timesheet_submitted' else 'timesheet_saved' end, 'timesheet', v_id::text, null,
    jsonb_build_object('weekStart', p_week, 'hours', v_total, 'entries', v_no), null, v_profile);
  return v_id;
end;
$$;

-- Approve (freezing each entry's cost) or reject (back to the person, with a reason).
create or replace function public.timesheet_decide(p_actor uuid, p_id uuid, p_approve boolean, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_class record;
begin
  perform public.app_require(p_actor, 'time.approve');
  select * into v from public.timesheets where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Timesheet not found.' using errcode = 'P0002'; end if;
  if v.status <> 'submitted' then raise exception 'Only a submitted timesheet can be approved or rejected.' using errcode = '22023'; end if;
  if v.profile_id = p_actor then raise exception 'Someone else must approve your own timesheet.' using errcode = '42501'; end if;
  if p_approve then
    select c.* into v_class from public.labour_profiles lp join public.labour_classes c on c.id = lp.labour_class_id where lp.profile_id = v.profile_id;
    if v_class.id is null then
      raise exception 'Set % labour class (Projects, Labour rates) before approving, so the hours can be costed.',
        (select coalesce(nullif(full_name, ''), email) || '''s' from public.training_profiles where id = v.profile_id) using errcode = '22023';
    end if;
    update public.timesheet_entries set labour_class_id = v_class.id, cost_rate = round(v_class.cost_rate * public.hour_type_factor(hour_type), 2),
      cost_amount = round(hours * round(v_class.cost_rate * public.hour_type_factor(hour_type), 2), 2)
    where timesheet_id = p_id;
  elsif length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'Say what needs fixing.' using errcode = '22023';
  end if;
  update public.timesheets set status = case when p_approve then 'approved' else 'rejected' end, decided_at = now(), decided_by = p_actor,
    decision_comment = nullif(btrim(coalesce(p_comment, '')), ''), updated_at = now()
  where id = p_id;
  insert into public.notifications (organization_id, profile_id, kind, title, body, link)
  values (v.organization_id, v.profile_id, case when p_approve then 'timesheet_approved' else 'timesheet_rejected' end,
    case when p_approve then 'Timesheet approved: ' else 'Timesheet sent back: ' end || 'week of ' || to_char(v.week_start, 'DD Mon'),
    coalesce(btrim(p_comment), ''), 'timesheets');
  perform public.app_audit(p_actor, case when p_approve then 'timesheet_approved' else 'timesheet_rejected' end, 'timesheet', p_id::text,
    jsonb_build_object('status', 'submitted'), jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end, 'hours', v.total_hours,
      'cost', (select sum(cost_amount) from public.timesheet_entries where timesheet_id = p_id)), jsonb_build_object('comment', p_comment), v.profile_id);
end;
$$;

-- Recall (the person, while waiting) or reopen (an approver, after approval,
-- with a reason). Costs are cleared and worked out again on re-approval.
create or replace function public.timesheet_reopen(p_actor uuid, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public.timesheets where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Timesheet not found.' using errcode = 'P0002'; end if;
  if v.status = 'submitted' and v.profile_id = p_actor then
    null; -- recalling your own timesheet before it is decided
  else
    perform public.app_require(p_actor, 'time.approve');
    if v.status not in ('submitted', 'approved') then raise exception 'This timesheet is already open for changes.' using errcode = '22023'; end if;
    if v.profile_id = p_actor and v.status = 'approved' then raise exception 'Someone else must reopen your own approved timesheet.' using errcode = '42501'; end if;
    if v.payroll_locked_at is not null then raise exception 'These hours have been paid. Correct them in the next pay run instead.' using errcode = '22023'; end if;
    if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason for reopening it.' using errcode = '22023'; end if;
  end if;
  update public.timesheet_entries set labour_class_id = null, cost_rate = null, cost_amount = null where timesheet_id = p_id;
  update public.timesheets set status = 'draft', submitted_at = null, submitted_by = null, decided_at = null, decided_by = null,
    decision_comment = nullif(btrim(coalesce(p_reason, '')), ''), updated_at = now() where id = p_id;
  if v.profile_id <> p_actor then
    insert into public.notifications (organization_id, profile_id, kind, title, body, link)
    values (v.organization_id, v.profile_id, 'timesheet_reopened', 'Timesheet reopened: week of ' || to_char(v.week_start, 'DD Mon'), coalesce(btrim(p_reason), ''), 'timesheets');
  end if;
  perform public.app_audit(p_actor, 'timesheet_reopened', 'timesheet', p_id::text, jsonb_build_object('status', v.status), jsonb_build_object('status', 'draft'),
    jsonb_build_object('reason', p_reason), v.profile_id);
end;
$$;

------------------------------------------------------------------------------
-- 5. Job costing reports
------------------------------------------------------------------------------

-- Costing for one project, by cost code, up to a date:
--   labour    approved timesheet hours at their frozen cost
--   other     approved bills and supplier credits tagged to the project (ex GST)
--   committed approved/issued purchase order lines not yet billed (ex GST)
--   revenue   approved invoices less credit notes tagged to the project (ex GST)
-- plus progress on cost (cost to date / total budget) and over/under billing.
create or replace function public.report_project_costing(p_actor uuid, p_project uuid, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_p record;
  v_to date := coalesce(p_to, (now() at time zone 'Australia/Sydney')::date);
  v_rows jsonb;
  v_bh numeric; v_ba numeric; v_hrs numeric; v_lab numeric; v_oth numeric; v_com numeric;
  v_revenue numeric;
  v_cost numeric;
  v_pc numeric;
  v_earned numeric;
begin
  select * into v_p from public.projects where id = p_project and organization_id = v_org;
  if not found then raise exception 'Project not found.' using errcode = 'P0002'; end if;

  with labour as (
    select e.cost_code_id, sum(e.hours) as hours, sum(e.cost_amount) as cost
    from public.timesheet_entries e join public.timesheets t on t.id = e.timesheet_id
    where e.project_id = p_project and t.status = 'approved' and e.work_date <= v_to group by e.cost_code_id
  ), other as (
    select bl.cost_code_id, sum((case when b.kind = 'credit_note' then -1 else 1 end) * (bl.amount - case when b.amounts_are = 'inclusive' then bl.gst else 0 end)) as cost
    from public.bill_lines bl join public.bills b on b.id = bl.document_id
    where bl.project_id = p_project and b.status = 'approved' and b.bill_date <= v_to group by bl.cost_code_id
  ), billed as (
    select bl.po_line_id, sum(bl.quantity) as qty
    from public.bill_lines bl join public.bills b on b.id = bl.document_id
    where bl.po_line_id is not null and b.status = 'approved' and b.kind = 'bill' group by bl.po_line_id
  ), committed as (
    select pl.cost_code_id,
      sum((pl.amount - case when po.amounts_are = 'inclusive' then pl.gst else 0 end) * greatest(0, 1 - coalesce(bd.qty, 0) / pl.quantity)) as cost
    from public.purchase_order_lines pl join public.purchase_orders po on po.id = pl.document_id
    left join billed bd on bd.po_line_id = pl.id
    where pl.project_id = p_project and po.status in ('approved', 'issued', 'partially_received') and po.order_date <= v_to group by pl.cost_code_id
  ), codes as (
    select cost_code_id from public.project_budgets where project_id = p_project
    union select cost_code_id from labour union select cost_code_id from other union select cost_code_id from committed
  ), lines as (
    select c.cost_code_id, cc.code, cc.name, cc.category, cc.sort,
      coalesce(pb.budget_hours, 0) as budget_hours, coalesce(pb.budget_amount, 0) as budget_amount,
      coalesce(l.hours, 0) as hours, coalesce(l.cost, 0) as labour, round(coalesce(o.cost, 0), 2) as other, round(coalesce(cm.cost, 0), 2) as committed
    from codes c left join public.cost_codes cc on cc.id = c.cost_code_id
    left join public.project_budgets pb on pb.project_id = p_project and pb.cost_code_id is not distinct from c.cost_code_id
    left join labour l on l.cost_code_id is not distinct from c.cost_code_id
    left join other o on o.cost_code_id is not distinct from c.cost_code_id
    left join committed cm on cm.cost_code_id is not distinct from c.cost_code_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('costCodeId', cost_code_id, 'code', coalesce(code, '—'), 'name', coalesce(name, 'Not coded'),
      'category', category, 'budgetHours', budget_hours, 'budgetAmount', budget_amount, 'actualHours', hours, 'labourCost', labour, 'otherCost', other,
      'actualCost', labour + other, 'committed', committed, 'remaining', budget_amount - labour - other - committed,
      'percentUsed', case when budget_amount > 0 then round((labour + other) / budget_amount * 100, 1) end) order by sort nulls last, code), '[]'::jsonb),
    sum(budget_hours), sum(budget_amount), sum(hours), sum(labour), sum(other), sum(committed)
  into v_rows, v_bh, v_ba, v_hrs, v_lab, v_oth, v_com
  from lines;

  select coalesce(sum((case when i.kind = 'credit_note' then -1 else 1 end) * (il.amount - case when i.amounts_are = 'inclusive' then il.gst else 0 end)), 0)
  into v_revenue
  from public.invoice_lines il join public.invoices i on i.id = il.document_id
  where il.project_id = p_project and i.status = 'approved' and i.invoice_date <= v_to;

  v_cost := coalesce(v_lab, 0) + coalesce(v_oth, 0);
  -- Progress measured on cost: cost to date as a share of the total budget (capped at 100%).
  v_pc := case when coalesce(v_ba, 0) > 0 then least(1, v_cost / v_ba) end;
  v_earned := case when v_pc is not null then round(v_p.contract_value * v_pc, 2) end;
  return jsonb_build_object(
    'project', jsonb_build_object('id', v_p.id, 'number', v_p.number, 'name', v_p.name, 'status', v_p.status, 'contractValue', v_p.contract_value,
      'billingType', v_p.billing_type),
    'asAt', v_to,
    'rows', v_rows,
    'totals', jsonb_build_object('budgetHours', coalesce(v_bh, 0), 'budgetAmount', coalesce(v_ba, 0), 'actualHours', coalesce(v_hrs, 0),
      'labourCost', coalesce(v_lab, 0), 'otherCost', coalesce(v_oth, 0), 'actualCost', v_cost, 'committed', coalesce(v_com, 0),
      'remaining', coalesce(v_ba, 0) - v_cost - coalesce(v_com, 0)),
    'revenue', jsonb_build_object('contractValue', v_p.contract_value, 'invoiced', round(v_revenue, 2), 'toInvoice', v_p.contract_value - round(v_revenue, 2)),
    'margin', jsonb_build_object('invoiced', round(v_revenue, 2), 'cost', v_cost, 'grossMargin', round(v_revenue, 2) - v_cost,
      'marginPercent', case when v_revenue <> 0 then round((v_revenue - v_cost) / v_revenue * 100, 1) end,
      'budgetMargin', v_p.contract_value - coalesce(v_ba, 0),
      'budgetMarginPercent', case when v_p.contract_value > 0 then round((v_p.contract_value - coalesce(v_ba, 0)) / v_p.contract_value * 100, 1) end),
    'progress', jsonb_build_object('percentComplete', case when v_pc is not null then round(v_pc * 100, 1) end, 'earnedRevenue', v_earned,
      'overUnderBilling', case when v_earned is not null then round(v_revenue, 2) - v_earned end));
end;
$$;

-- All projects with their headline figures (for the list and the dashboard).
create or replace function public.report_projects_summary(p_actor uuid, p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_out jsonb := '[]'::jsonb;
  p record;
  r jsonb;
begin
  for p in select id from public.projects where organization_id = v_org
      and (p_status is null or status = p_status or (p_status = 'open' and status in ('tender', 'active', 'on_hold')))
      order by number desc limit 500 loop
    r := public.report_project_costing(p_actor, p.id, null);
    v_out := v_out || jsonb_build_object('id', r->'project'->'id', 'number', r->'project'->'number', 'name', r->'project'->'name',
      'status', r->'project'->'status', 'contractValue', r->'project'->'contractValue', 'budget', r->'totals'->'budgetAmount',
      'cost', r->'totals'->'actualCost', 'committed', r->'totals'->'committed', 'hours', r->'totals'->'actualHours',
      'invoiced', r->'revenue'->'invoiced', 'margin', r->'margin'->'grossMargin', 'marginPercent', r->'margin'->'marginPercent',
      'percentComplete', r->'progress'->'percentComplete', 'overUnderBilling', r->'progress'->'overUnderBilling');
  end loop;
  return v_out;
end;
$$;

-- Approved hours for a date range, for payroll and labour reports.
create or replace function public.report_timesheet_hours(p_actor uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('person', coalesce(nullif(tp.full_name, ''), tp.email), 'email', tp.email, 'weekStart', t.week_start,
    'date', e.work_date, 'project', pr.number, 'projectName', pr.name, 'costCode', cc.code, 'hourType', e.hour_type, 'hours', e.hours,
    'start', e.start_time, 'end', e.end_time, 'breakMinutes', e.break_minutes, 'notes', e.notes, 'approvedAt', t.decided_at)
    order by tp.full_name, e.work_date, e.line_no), '[]'::jsonb)
  from public.timesheets t join public.timesheet_entries e on e.timesheet_id = t.id
  join public.training_profiles tp on tp.id = t.profile_id
  left join public.projects pr on pr.id = e.project_id
  left join public.cost_codes cc on cc.id = e.cost_code_id
  where t.organization_id = public.app_org_of(p_actor) and t.status = 'approved' and e.work_date between p_from and p_to;
$$;

------------------------------------------------------------------------------
-- 6. Document lines carry project and cost code tags
------------------------------------------------------------------------------

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
  v_project uuid; v_cost_code uuid;
begin
  if p_amounts_are not in ('exclusive', 'inclusive', 'no_tax') then
    raise exception 'Choose how amounts are entered.' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 150 then
    raise exception 'A document can have at most 150 lines.' using errcode = '22023';
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
    -- Optional job costing tags (Phase 4). Cost codes only make sense on costs.
    v_project := nullif(l->>'projectId', '')::uuid;
    v_cost_code := case when p_side = 'purchases' then nullif(l->>'costCodeId', '')::uuid end;
    if v_project is not null and not exists (select 1 from public.projects where id = v_project and organization_id = p_org and status not in ('closed', 'cancelled')) then
      raise exception 'Line %: that project is closed or doesn''t exist.', v_no using errcode = '22023';
    end if;
    if v_cost_code is not null and not exists (select 1 from public.cost_codes where id = v_cost_code and organization_id = p_org and active) then
      raise exception 'Line %: unknown or inactive cost code.', v_no using errcode = '22023';
    end if;
    if v_cost_code is not null and v_project is null then
      raise exception 'Line %: choose the project the cost code belongs to.', v_no using errcode = '22023';
    end if;
    v_amount := round(v_qty * v_price * (1 - v_disc / 100), 2);
    v_gst := case when v_rate = 0 then 0 when p_amounts_are = 'inclusive' then round(v_amount * v_rate / (1 + v_rate), 2) else round(v_amount * v_rate, 2) end;
    v_sub := v_sub + case when p_amounts_are = 'inclusive' then v_amount - v_gst else v_amount end;
    v_gst_total := v_gst_total + v_gst;
    v_out := v_out || jsonb_build_object('line_no', v_no, 'description', left(btrim(l->>'description'), 500), 'quantity', v_qty,
      'unit', left(coalesce(l->>'unit', ''), 20), 'unit_price', v_price, 'discount_percent', v_disc, 'account_id', v_acc.id,
      'tax_code_id', v_tax, 'line_kind', v_kind, 'amount', v_amount, 'gst', v_gst, 'po_line_id', nullif(l->>'poLineId', ''),
      'project_id', v_project, 'cost_code_id', v_cost_code);
  end loop;
  return jsonb_build_object('lines', v_out, 'subtotal', v_sub, 'gst', v_gst_total, 'total', v_sub + v_gst_total);
end;
$$;


create or replace function public.doc_insert_lines(p_table text, p_doc uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  execute format('delete from public.%I where document_id = $1', p_table) using p_doc;
  execute format($f$insert into public.%I (document_id, line_no, description, quantity, unit, unit_price, discount_percent, account_id, tax_code_id, line_kind, amount, gst, project_id, cost_code_id)
    select $1, (x->>'line_no')::int, x->>'description', (x->>'quantity')::numeric, x->>'unit', (x->>'unit_price')::numeric, (x->>'discount_percent')::numeric,
      (x->>'account_id')::uuid, nullif(x->>'tax_code_id', '')::uuid, x->>'line_kind', (x->>'amount')::numeric, (x->>'gst')::numeric,
      nullif(x->>'project_id', '')::uuid, nullif(x->>'cost_code_id', '')::uuid
    from jsonb_array_elements($2) x$f$, p_table) using p_doc, p_lines;
end;
$$;


create or replace function public.doc_recalc(p_org uuid, p_table text, p_doc uuid, p_amounts_are text, p_side text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lines jsonb;
begin
  execute format($f$select jsonb_agg(jsonb_build_object('description', description, 'quantity', quantity, 'unit', unit, 'unitPrice', unit_price,
      'discountPercent', discount_percent, 'accountId', account_id, 'taxCodeId', tax_code_id, 'kind', line_kind, 'projectId', project_id, 'costCodeId', cost_code_id) order by line_no)
    from public.%I where document_id = $1$f$, p_table) into v_lines using p_doc;
  return public.doc_calc_lines(p_org, coalesce(v_lines, '[]'::jsonb), p_amounts_are, p_side);
end;
$$;


------------------------------------------------------------------------------
-- 7. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['cost_codes', 'labour_classes', 'labour_profiles', 'projects', 'project_budgets', 'timesheets', 'timesheet_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
  foreach f in array array[
    'cost_code_save(uuid, uuid, text, text, text, boolean)', 'labour_class_save(uuid, uuid, text, text, numeric, numeric, boolean)',
    'labour_profile_set(uuid, uuid, uuid)', 'project_save(uuid, uuid, jsonb, jsonb)', 'project_set_status(uuid, uuid, text)',
    'timesheet_save(uuid, uuid, date, jsonb, boolean)', 'timesheet_decide(uuid, uuid, boolean, text)', 'timesheet_reopen(uuid, uuid, text)',
    'report_project_costing(uuid, uuid, date)', 'report_projects_summary(uuid, text)', 'report_timesheet_hours(uuid, date, date)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

commit;
