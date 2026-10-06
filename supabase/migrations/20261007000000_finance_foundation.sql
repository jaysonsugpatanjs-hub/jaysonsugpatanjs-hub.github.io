-- Panalo Accounts, Phase 1: the foundation every finance module stands on.
--
-- * organizations: Panalo is organisation 1; existing people tables gain
--   organization_id (default Panalo) so later Panalo companies stay separate.
-- * company_settings, number_sequences, company_bank_accounts: the company
--   setup wizard. ABN and ACN are check-digit validated in the database.
-- * Finance permission keys and role bundles (Super admin, Director, Finance
--   admin, Payroll admin, Project manager, Supervisor, Accountant). Roles add
--   to position defaults; per-person allow/deny still wins. requires_mfa marks
--   keys whose holders must use MFA in Panalo Accounts. payroll.sensitive is
--   not part of the automatic system-administrator set (separation of duties).
-- * approvals + notifications: a reusable four-eyes approval engine. First use:
--   adding a company bank account (payment-redirection control).
-- * documents: shared private document store (first use: company logo).
-- * Audit log: entity, record, old and new values; rows can no longer be
--   changed or deleted.
begin;

------------------------------------------------------------------------------
-- 1. Organisations
------------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 160),
  created_at timestamptz not null default now()
);
insert into public.organizations (id, name) values ('00000000-0000-4000-8000-000000000001', 'Panalo Pipes & Structurals Pty Ltd');

do $$
declare
  t text;
begin
  foreach t in array array['training_profiles', 'employees', 'positions', 'sites', 'personnel_documents', 'onboarding_requests']
  loop
    execute format('alter table public.%I add column organization_id uuid not null default %L references public.organizations(id)',
      t, '00000000-0000-4000-8000-000000000001');
  end loop;
end;
$$;

create or replace function public.app_org_of(p_profile uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select organization_id from public.training_profiles where id = p_profile;
$$;

------------------------------------------------------------------------------
-- 2. ABN and ACN validation (ATO / ASIC check-digit rules)
------------------------------------------------------------------------------

create or replace function public.app_valid_abn(p_abn text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(p_abn, ''), '\s', '', 'g');
  w int[] := array[10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  s int := 0;
begin
  if d !~ '^\d{11}$' then return false; end if;
  for i in 1..11 loop
    s := s + (substr(d, i, 1)::int - case when i = 1 then 1 else 0 end) * w[i];
  end loop;
  return s % 89 = 0;
end;
$$;

create or replace function public.app_valid_acn(p_acn text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(p_acn, ''), '\s', '', 'g');
  s int := 0;
begin
  if d !~ '^\d{9}$' then return false; end if;
  for i in 1..8 loop
    s := s + substr(d, i, 1)::int * (9 - i);
  end loop;
  return (10 - s % 10) % 10 = substr(d, 9, 1)::int;
end;
$$;

------------------------------------------------------------------------------
-- 3. Company settings, numbering, bank accounts
------------------------------------------------------------------------------

create table public.company_settings (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  legal_name text not null check (length(btrim(legal_name)) between 2 and 160),
  trading_name text check (trading_name is null or length(trading_name) <= 160),
  abn text check (abn is null or public.app_valid_abn(abn)),
  acn text check (acn is null or public.app_valid_acn(acn)),
  business_address jsonb not null default '{}'::jsonb,
  postal_address jsonb not null default '{}'::jsonb,
  phone text check (phone is null or length(phone) <= 30),
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  website text check (website is null or length(website) <= 200),
  logo_document_id uuid,
  gst_registered boolean not null default true,
  gst_basis text not null default 'accrual' check (gst_basis in ('accrual', 'cash')),
  bas_frequency text not null default 'quarterly' check (bas_frequency in ('monthly', 'quarterly', 'annual')),
  accounting_basis text not null default 'accrual' check (accounting_basis in ('accrual', 'cash')),
  financial_year_start_month integer not null default 7 check (financial_year_start_month between 1 and 12),
  timezone text not null default 'Australia/Sydney' check (timezone like 'Australia/%'),
  currency text not null default 'AUD' check (currency = 'AUD'),
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 120),
  pay_frequency text not null default 'weekly' check (pay_frequency in ('weekly', 'fortnightly', 'monthly')),
  pay_day text not null default 'Thursday' check (pay_day in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday')),
  states text[] not null default '{}' check (states <@ array['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']::text[]),
  super_clearing_house text check (super_clearing_house is null or length(super_clearing_house) <= 120),
  stp_mode text not null default 'export' check (stp_mode = 'export'),
  workers_comp jsonb not null default '[]'::jsonb check (jsonb_typeof(workers_comp) = 'array'),
  payroll_contact jsonb not null default '{}'::jsonb,
  setup_completed_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.training_profiles(id) on delete set null
);
insert into public.company_settings (organization_id, legal_name, trading_name)
values ('00000000-0000-4000-8000-000000000001', 'Panalo Pipes & Structurals Pty Ltd', 'Panalo Pipes');

create table public.number_sequences (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null check (kind in ('invoice', 'quote', 'purchase_order', 'credit_note', 'bill', 'journal', 'pay_run')),
  prefix text not null check (prefix ~ '^[A-Z0-9-]{0,10}$'),
  next_number bigint not null check (next_number > 0),
  padding integer not null default 4 check (padding between 1 and 10),
  primary key (organization_id, kind)
);
insert into public.number_sequences (organization_id, kind, prefix, next_number, padding) values
  ('00000000-0000-4000-8000-000000000001', 'invoice', 'INV-', 1001, 4),
  ('00000000-0000-4000-8000-000000000001', 'quote', 'QU-', 1001, 4),
  ('00000000-0000-4000-8000-000000000001', 'purchase_order', 'PO-', 1001, 4),
  ('00000000-0000-4000-8000-000000000001', 'credit_note', 'CN-', 1001, 4),
  ('00000000-0000-4000-8000-000000000001', 'bill', 'BILL-', 1001, 4),
  ('00000000-0000-4000-8000-000000000001', 'journal', 'JE-', 1, 6),
  ('00000000-0000-4000-8000-000000000001', 'pay_run', 'PR-', 1, 5);

-- Hands out the next number atomically (used from Phase 2).
create or replace function public.next_document_number(p_org uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  update public.number_sequences set next_number = next_number + 1
  where organization_id = p_org and kind = p_kind
  returning prefix, next_number - 1 as n, padding into v;
  if not found then
    raise exception 'No numbering set up for %.', p_kind using errcode = 'P0002';
  end if;
  return v.prefix || lpad(v.n::text, v.padding, '0');
end;
$$;

create table public.company_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  nickname text not null check (length(btrim(nickname)) between 2 and 60),
  account_name text not null check (length(btrim(account_name)) between 2 and 120),
  bsb text not null check (bsb ~ '^\d{6}$'),
  account_number text not null check (account_number ~ '^\d{5,10}$'),
  apca_user_id text check (apca_user_id is null or apca_user_id ~ '^\d{6}$'),
  purpose text not null default 'operating' check (purpose in ('operating', 'payroll', 'receipts', 'tax', 'other')),
  show_on_invoices boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'retired')),
  approval_id uuid,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz
);
create unique index company_bank_one_invoice_account on public.company_bank_accounts (organization_id) where show_on_invoices and status = 'active';

------------------------------------------------------------------------------
-- 4. Permissions and roles
------------------------------------------------------------------------------

alter table public.app_permissions
  add column area text not null default 'Portal',
  add column admin_default boolean not null default true,
  add column requires_mfa boolean not null default false;

update public.app_permissions set requires_mfa = true where key = 'access.manage';

insert into public.app_permissions (key, name, description, sort, area, admin_default, requires_mfa) values
  ('org.manage', 'Company settings', 'Edit company details, tax settings, numbering and integrations; request bank account changes.', 100, 'Accounts', true, true),
  ('ledger.manage', 'Chart of accounts and tax codes', 'Create and edit accounts, tax codes and posting rules.', 110, 'Accounts', true, true),
  ('ledger.journal', 'Create journals', 'Prepare manual and adjusting journals.', 120, 'Accounts', true, true),
  ('ledger.post', 'Approve and post journals', 'Approve and post journals to the general ledger.', 130, 'Accounts', true, true),
  ('ledger.reopen', 'Reopen closed periods', 'Reopen a closed accounting period. Every reopen is logged.', 140, 'Accounts', true, true),
  ('sales.manage', 'Sales', 'Customers, quotes, invoices, credit notes and receipts.', 150, 'Accounts', true, true),
  ('purchases.manage', 'Purchases', 'Suppliers, purchase orders, bills and supplier payments.', 160, 'Accounts', true, true),
  ('purchases.bank', 'Approve supplier bank changes', 'Approve changes to supplier bank details.', 170, 'Accounts', true, true),
  ('bank.manage', 'Banking', 'Bank accounts, payments, imports and reconciliation; approve company bank accounts.', 180, 'Accounts', true, true),
  ('projects.manage', 'Projects and job costing', 'Projects, budgets, cost codes and job costing.', 190, 'Accounts', true, false),
  ('time.approve', 'Approve timesheets', 'Approve timesheets for the people and projects you manage.', 200, 'Accounts', true, false),
  ('leave.approve', 'Approve leave', 'Approve leave requests for the people you manage.', 210, 'Accounts', true, false),
  ('payroll.sensitive', 'Payroll: pay, tax and bank details', 'See and edit employees'' pay rates, TFNs, bank and super details. Not given to system administrators automatically.', 220, 'Payroll', false, true),
  ('payroll.run', 'Prepare pay runs', 'Prepare and calculate pay runs.', 230, 'Payroll', true, true),
  ('payroll.approve', 'Approve pay runs', 'Approve and finalise pay runs.', 240, 'Payroll', true, true),
  ('tax.bas', 'BAS and tax reporting', 'Prepare BAS workpapers and tax reports.', 250, 'Accounts', true, true),
  ('reports.view', 'Financial reports', 'View financial reports and dashboards.', 260, 'Accounts', true, false),
  ('audit.view', 'Audit log', 'View the audit log.', 270, 'Accounts', true, true),
  ('data.export', 'Export data', 'Export reports and records. Every export is logged.', 280, 'Accounts', true, true);

create table public.app_roles (
  key text primary key check (key ~ '^[a-z][a-z_]{1,39}$'),
  name text not null,
  description text not null default '',
  sort integer not null default 100
);
insert into public.app_roles (key, name, description, sort) values
  ('super_admin', 'Super admin', 'System configuration, users and every finance area except payroll details.', 10),
  ('director', 'Director / owner', 'Reports, approvals and management dashboards.', 20),
  ('finance_admin', 'Finance admin', 'Invoices, bills, payments, bank reconciliation, journals, customers, suppliers and reports.', 30),
  ('payroll_admin', 'Payroll admin', 'Employee pay data, pay runs, leave, PAYG, super and payroll reports.', 40),
  ('project_manager', 'Project manager', 'Assigned projects, timesheets, labour and costs. No private payroll details.', 50),
  ('supervisor', 'Supervisor', 'Approves their team''s timesheets and leave.', 60),
  ('accountant', 'Accountant / auditor', 'Reads the ledger, reports and audit log; prepares adjusting journals.', 70);

create table public.app_role_permissions (
  role_key text not null references public.app_roles(key) on delete cascade,
  permission_key text not null references public.app_permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);
insert into public.app_role_permissions (role_key, permission_key)
select r, p from (values
  ('super_admin', '{org.manage,access.manage,ledger.manage,ledger.journal,ledger.post,ledger.reopen,sales.manage,purchases.manage,purchases.bank,bank.manage,projects.manage,time.approve,tax.bas,reports.view,audit.view,data.export}'::text[]),
  ('director', '{ledger.post,ledger.reopen,sales.manage,purchases.manage,purchases.bank,bank.manage,payroll.approve,tax.bas,reports.view,audit.view,data.export}'::text[]),
  ('finance_admin', '{ledger.manage,ledger.journal,ledger.post,sales.manage,purchases.manage,bank.manage,tax.bas,reports.view,audit.view,data.export}'::text[]),
  ('payroll_admin', '{payroll.sensitive,payroll.run,leave.approve,time.approve,people.view,reports.view,audit.view,data.export}'::text[]),
  ('project_manager', '{projects.manage,time.approve,reports.view}'::text[]),
  ('supervisor', '{time.approve,leave.approve,competency.team}'::text[]),
  ('accountant', '{ledger.journal,reports.view,audit.view,data.export}'::text[])
) as v(r, ps), unnest(ps) as p;

create table public.profile_roles (
  profile_id uuid not null references public.training_profiles(id) on delete cascade,
  role_key text not null references public.app_roles(key) on delete cascade,
  granted_by uuid references public.training_profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (profile_id, role_key)
);

-- Effective permissions: position defaults and assigned roles, plus per-person
-- "allow", minus per-person "deny". Inactive accounts hold nothing. System
-- administrators hold every key marked admin_default (not payroll.sensitive).
create or replace function public.app_permissions_for(p_profile uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select id, role, active from public.training_profiles where id = p_profile
  ), base as (
    select pp.permission_key as key
    from public.employees e
    join public.position_permissions pp on pp.position_id = e.position_id
    where e.profile_id = p_profile and e.status in ('active', 'on_leave', 'applicant')
    union
    select rp.permission_key
    from public.profile_roles pr join public.app_role_permissions rp on rp.role_key = pr.role_key
    where pr.profile_id = p_profile
    union
    select key from public.app_permissions
    where admin_default and exists (select 1 from me where role = 'admin')
  )
  select case
    when not exists (select 1 from me where active) then '{}'::text[]
    else coalesce((
      select array_agg(distinct k order by k) from (
        select key as k from base
        where key not in (select permission_key from public.profile_permissions where profile_id = p_profile and not granted)
        union
        select permission_key from public.profile_permissions where profile_id = p_profile and granted
      ) x), '{}'::text[])
  end;
$$;

create or replace function public.app_mfa_required(p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_permissions where requires_mfa and key = any (public.app_permissions_for(p_profile)));
$$;

------------------------------------------------------------------------------
-- 5. Audit log: richer and append-only
------------------------------------------------------------------------------

alter table public.training_audit_events
  add column organization_id uuid default '00000000-0000-4000-8000-000000000001' references public.organizations(id),
  add column entity_type text,
  add column entity_id text,
  add column old_value jsonb,
  add column new_value jsonb;
create index training_audit_events_entity_idx on public.training_audit_events (entity_type, entity_id, created_at desc);
create index training_audit_events_created_idx on public.training_audit_events (created_at desc);

-- Audit rows cannot be edited or deleted. The only change allowed is the
-- database clearing a reference when the referenced row is removed.
create or replace function public.audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Audit records cannot be deleted.' using errcode = '42501';
  end if;
  if (new.event_type, new.details, new.created_at, new.entity_type, new.entity_id, new.old_value, new.new_value, new.organization_id)
     is distinct from (old.event_type, old.details, old.created_at, old.entity_type, old.entity_id, old.old_value, old.new_value, old.organization_id)
     or (new.actor_user_id is not null and new.actor_user_id is distinct from old.actor_user_id)
     or (new.subject_user_id is not null and new.subject_user_id is distinct from old.subject_user_id)
     or (new.assignment_id is not null and new.assignment_id is distinct from old.assignment_id) then
    raise exception 'Audit records cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger training_audit_events_append_only
  before update or delete on public.training_audit_events
  for each row execute function public.audit_append_only();

create or replace function public.app_audit(p_actor uuid, p_event text, p_entity_type text, p_entity_id text,
  p_old jsonb, p_new jsonb, p_details jsonb default '{}'::jsonb, p_subject uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.training_audit_events (actor_user_id, subject_user_id, event_type, details, organization_id, entity_type, entity_id, old_value, new_value)
  values (p_actor, p_subject, p_event, coalesce(p_details, '{}'::jsonb), coalesce(public.app_org_of(p_actor), '00000000-0000-4000-8000-000000000001'),
          p_entity_type, p_entity_id, p_old, p_new);
$$;

------------------------------------------------------------------------------
-- 6. Notifications and the approval engine
------------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  profile_id uuid not null references public.training_profiles(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_inbox_idx on public.notifications (profile_id, read_at, created_at desc);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null check (kind in ('company_bank_account')),
  entity_type text not null,
  entity_id uuid not null,
  title text not null,
  required_permission text not null references public.app_permissions(key),
  requested_by uuid not null references public.training_profiles(id) on delete restrict,
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references public.training_profiles(id) on delete restrict,
  decided_at timestamptz,
  comment text,
  previous_value jsonb,
  new_value jsonb,
  check ((status = 'pending') = (decided_at is null)),
  check (decided_by is null or decided_by <> requested_by)
);
create index approvals_pending_idx on public.approvals (organization_id, status, requested_at desc);

-- Tells everyone in the organisation who holds a permission (except one person).
create or replace function public.app_notify_holders(p_org uuid, p_perm text, p_except uuid, p_kind text, p_title text, p_body text, p_link text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  p record;
begin
  for p in select id from public.training_profiles where organization_id = p_org and active and id is distinct from p_except loop
    if public.app_has(p.id, p_perm) then
      insert into public.notifications (organization_id, profile_id, kind, title, body, link) values (p_org, p.id, p_kind, p_title, p_body, p_link);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.approval_request(p_actor uuid, p_kind text, p_entity_type text, p_entity_id uuid,
  p_title text, p_permission text, p_previous jsonb, p_new jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid;
begin
  insert into public.approvals (organization_id, kind, entity_type, entity_id, title, required_permission, requested_by, previous_value, new_value)
  values (v_org, p_kind, p_entity_type, p_entity_id, p_title, p_permission, p_actor, p_previous, p_new)
  returning id into v_id;
  perform public.app_notify_holders(v_org, p_permission, p_actor, 'approval_requested', 'Approval needed: ' || p_title,
    'Requested by ' || coalesce((select nullif(full_name, '') from public.training_profiles where id = p_actor), (select email from public.training_profiles where id = p_actor)),
    'approvals');
  perform public.app_audit(p_actor, 'approval_requested', 'approval', v_id::text, p_previous, p_new, jsonb_build_object('kind', p_kind, 'title', p_title));
  return v_id;
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
      -- Only one account is printed on invoices.
      if (select show_on_invoices from public.company_bank_accounts where id = v.entity_id) then
        update public.company_bank_accounts set show_on_invoices = false
        where organization_id = v.organization_id and status = 'active' and show_on_invoices;
      end if;
      update public.company_bank_accounts set status = 'active', activated_at = now() where id = v.entity_id and status = 'pending';
    else
      update public.company_bank_accounts set status = 'rejected' where id = v.entity_id and status = 'pending';
    end if;
  end if;

  insert into public.notifications (organization_id, profile_id, kind, title, body, link)
  values (v.organization_id, v.requested_by, case when p_approve then 'approval_approved' else 'approval_rejected' end,
          case when p_approve then 'Approved: ' else 'Rejected: ' end || v.title, coalesce(btrim(p_comment), ''), 'approvals');
  perform public.app_audit(p_actor, case when p_approve then 'approval_approved' else 'approval_rejected' end, 'approval', p_approval::text,
    v.previous_value, v.new_value, jsonb_build_object('kind', v.kind, 'title', v.title, 'comment', p_comment), v.requested_by);
  return jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end);
end;
$$;

create or replace function public.approval_cancel(p_actor uuid, p_approval uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public.approvals where id = p_approval for update;
  if not found or v.requested_by <> p_actor then
    raise exception 'Approval not found.' using errcode = 'P0002';
  end if;
  if v.status <> 'pending' then
    raise exception 'This has already been decided.' using errcode = '22023';
  end if;
  update public.approvals set status = 'cancelled', decided_at = now() where id = p_approval;
  if v.kind = 'company_bank_account' then
    update public.company_bank_accounts set status = 'rejected' where id = v.entity_id and status = 'pending';
  end if;
  perform public.app_audit(p_actor, 'approval_cancelled', 'approval', p_approval::text, null, null, jsonb_build_object('title', v.title));
end;
$$;

------------------------------------------------------------------------------
-- 7. Documents store
------------------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  entity_type text not null check (entity_type ~ '^[a-z_]{2,40}$'),
  entity_id text not null,
  category text not null default 'general',
  title text not null check (length(btrim(title)) between 1 and 160),
  path text not null unique,
  file_name text not null default '',
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  uploaded_by uuid references public.training_profiles(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  archived_at timestamptz
);
create index documents_entity_idx on public.documents (organization_id, entity_type, entity_id);

alter table public.company_settings
  add constraint company_settings_logo_fk foreign key (logo_document_id) references public.documents(id) on delete set null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-documents', 'finance-documents', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'])
on conflict (id) do update set public = false;

------------------------------------------------------------------------------
-- 8. Company setup actions
------------------------------------------------------------------------------

-- Saves the fields given (any subset); every change is audited with old and
-- new values. Unknown keys are refused.
create or replace function public.company_settings_save(p_actor uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old jsonb;
  v_new jsonb;
  v_allowed text[] := array['legal_name', 'trading_name', 'abn', 'acn', 'business_address', 'postal_address', 'phone', 'email', 'website',
    'gst_registered', 'gst_basis', 'bas_frequency', 'accounting_basis', 'financial_year_start_month', 'timezone', 'payment_terms_days',
    'pay_frequency', 'pay_day', 'states', 'super_clearing_house', 'workers_comp', 'payroll_contact'];
  k text;
begin
  perform public.app_require(p_actor, 'org.manage');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Nothing to save.' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not k = any (v_allowed) then
      raise exception 'Unknown setting: %', k using errcode = '22023';
    end if;
  end loop;
  if p_patch ? 'abn' and nullif(p_patch->>'abn', '') is not null and not public.app_valid_abn(p_patch->>'abn') then
    raise exception 'That ABN is not valid. Check the 11 digits.' using errcode = '22023';
  end if;
  if p_patch ? 'acn' and nullif(p_patch->>'acn', '') is not null and not public.app_valid_acn(p_patch->>'acn') then
    raise exception 'That ACN is not valid. Check the 9 digits.' using errcode = '22023';
  end if;

  select to_jsonb(c) into v_old from public.company_settings c where organization_id = v_org for update;
  update public.company_settings c set
    legal_name = case when p_patch ? 'legal_name' then btrim(p_patch->>'legal_name') else c.legal_name end,
    trading_name = case when p_patch ? 'trading_name' then nullif(btrim(p_patch->>'trading_name'), '') else c.trading_name end,
    abn = case when p_patch ? 'abn' then nullif(regexp_replace(p_patch->>'abn', '\s', '', 'g'), '') else c.abn end,
    acn = case when p_patch ? 'acn' then nullif(regexp_replace(p_patch->>'acn', '\s', '', 'g'), '') else c.acn end,
    business_address = case when p_patch ? 'business_address' then p_patch->'business_address' else c.business_address end,
    postal_address = case when p_patch ? 'postal_address' then p_patch->'postal_address' else c.postal_address end,
    phone = case when p_patch ? 'phone' then nullif(btrim(p_patch->>'phone'), '') else c.phone end,
    email = case when p_patch ? 'email' then nullif(lower(btrim(p_patch->>'email')), '') else c.email end,
    website = case when p_patch ? 'website' then nullif(btrim(p_patch->>'website'), '') else c.website end,
    gst_registered = case when p_patch ? 'gst_registered' then (p_patch->>'gst_registered')::boolean else c.gst_registered end,
    gst_basis = case when p_patch ? 'gst_basis' then p_patch->>'gst_basis' else c.gst_basis end,
    bas_frequency = case when p_patch ? 'bas_frequency' then p_patch->>'bas_frequency' else c.bas_frequency end,
    accounting_basis = case when p_patch ? 'accounting_basis' then p_patch->>'accounting_basis' else c.accounting_basis end,
    financial_year_start_month = case when p_patch ? 'financial_year_start_month' then (p_patch->>'financial_year_start_month')::int else c.financial_year_start_month end,
    timezone = case when p_patch ? 'timezone' then p_patch->>'timezone' else c.timezone end,
    payment_terms_days = case when p_patch ? 'payment_terms_days' then (p_patch->>'payment_terms_days')::int else c.payment_terms_days end,
    pay_frequency = case when p_patch ? 'pay_frequency' then p_patch->>'pay_frequency' else c.pay_frequency end,
    pay_day = case when p_patch ? 'pay_day' then p_patch->>'pay_day' else c.pay_day end,
    states = case when p_patch ? 'states' then array(select jsonb_array_elements_text(p_patch->'states')) else c.states end,
    super_clearing_house = case when p_patch ? 'super_clearing_house' then nullif(btrim(p_patch->>'super_clearing_house'), '') else c.super_clearing_house end,
    workers_comp = case when p_patch ? 'workers_comp' then p_patch->'workers_comp' else c.workers_comp end,
    payroll_contact = case when p_patch ? 'payroll_contact' then p_patch->'payroll_contact' else c.payroll_contact end,
    updated_at = now(), updated_by = p_actor
  where organization_id = v_org;
  select to_jsonb(c) into v_new from public.company_settings c where organization_id = v_org;
  perform public.app_audit(p_actor, 'company_settings_saved', 'company_settings', v_org::text,
    (select jsonb_object_agg(key, v_old->key) from jsonb_object_keys(p_patch) key),
    (select jsonb_object_agg(key, v_new->key) from jsonb_object_keys(p_patch) key));
end;
$$;

create or replace function public.number_sequence_save(p_actor uuid, p_kind text, p_prefix text, p_next bigint, p_padding int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_old jsonb;
begin
  perform public.app_require(p_actor, 'org.manage');
  select to_jsonb(s) into v_old from public.number_sequences s where organization_id = v_org and kind = p_kind for update;
  if v_old is null then
    raise exception 'Unknown numbering.' using errcode = 'P0002';
  end if;
  if p_next < (v_old->>'next_number')::bigint then
    raise exception 'Numbers can only move forward, so issued numbers are never reused.' using errcode = '22023';
  end if;
  update public.number_sequences set prefix = upper(btrim(coalesce(p_prefix, ''))), next_number = p_next, padding = p_padding
  where organization_id = v_org and kind = p_kind;
  perform public.app_audit(p_actor, 'number_sequence_saved', 'number_sequence', p_kind, v_old,
    (select to_jsonb(s) from public.number_sequences s where organization_id = v_org and kind = p_kind));
end;
$$;

create or replace function public.company_setup_complete(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_missing text[] := '{}';
begin
  perform public.app_require(p_actor, 'org.manage');
  select * into v from public.company_settings where organization_id = public.app_org_of(p_actor) for update;
  if v.abn is null then v_missing := array_append(v_missing, 'ABN'); end if;
  if coalesce(v.business_address->>'street', '') = '' or coalesce(v.business_address->>'postcode', '') = '' then v_missing := array_append(v_missing, 'business address'); end if;
  if v.email is null then v_missing := array_append(v_missing, 'email'); end if;
  if v.phone is null then v_missing := array_append(v_missing, 'phone'); end if;
  if cardinality(v.states) = 0 then v_missing := array_append(v_missing, 'states you operate in'); end if;
  if coalesce(v.payroll_contact->>'name', '') = '' then v_missing := array_append(v_missing, 'payroll contact'); end if;
  if cardinality(v_missing) > 0 then
    raise exception 'Still needed: %.', array_to_string(v_missing, ', ') using errcode = '22023';
  end if;
  update public.company_settings set setup_completed_at = coalesce(setup_completed_at, now()) where organization_id = v.organization_id;
  perform public.app_audit(p_actor, 'company_setup_completed', 'company_settings', v.organization_id::text, null, null);
end;
$$;

-- A new company bank account is inactive until someone else with banking
-- permission approves it: the main defence against payment redirection.
create or replace function public.company_bank_account_request(p_actor uuid, p_nickname text, p_account_name text, p_bsb text,
  p_account_number text, p_apca text, p_purpose text, p_show_on_invoices boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid;
  v_approval uuid;
  v_new jsonb;
  v_bsb text := regexp_replace(coalesce(p_bsb, ''), '[\s-]', '', 'g');
  v_acct text := regexp_replace(coalesce(p_account_number, ''), '[\s-]', '', 'g');
begin
  perform public.app_require(p_actor, 'org.manage');
  if v_bsb !~ '^\d{6}$' then
    raise exception 'A BSB is 6 digits, like 062-000.' using errcode = '22023';
  end if;
  if v_acct !~ '^\d{5,10}$' then
    raise exception 'An account number is 5 to 10 digits.' using errcode = '22023';
  end if;
  insert into public.company_bank_accounts (organization_id, nickname, account_name, bsb, account_number, apca_user_id, purpose, show_on_invoices, created_by)
  values (v_org, btrim(p_nickname), btrim(p_account_name), v_bsb, v_acct, nullif(btrim(coalesce(p_apca, '')), ''), coalesce(p_purpose, 'operating'), coalesce(p_show_on_invoices, false), p_actor)
  returning id into v_id;
  v_new := jsonb_build_object('nickname', btrim(p_nickname), 'accountName', btrim(p_account_name), 'bsb', v_bsb, 'accountNumber', v_acct,
    'purpose', coalesce(p_purpose, 'operating'), 'showOnInvoices', coalesce(p_show_on_invoices, false));
  v_approval := public.approval_request(p_actor, 'company_bank_account', 'company_bank_account', v_id,
    'New company bank account: ' || btrim(p_nickname) || ' (BSB ' || substr(v_bsb, 1, 3) || '-' || substr(v_bsb, 4) || ')', 'bank.manage', null, v_new);
  update public.company_bank_accounts set approval_id = v_approval where id = v_id;
  return v_id;
end;
$$;

create or replace function public.company_bank_account_retire(p_actor uuid, p_account uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'org.manage');
  select * into v from public.company_bank_accounts where id = p_account and organization_id = public.app_org_of(p_actor) for update;
  if not found then
    raise exception 'Bank account not found.' using errcode = 'P0002';
  end if;
  if v.status <> 'active' then
    raise exception 'Only an active account can be retired.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for retiring it.' using errcode = '22023';
  end if;
  update public.company_bank_accounts set status = 'retired', retired_at = now(), show_on_invoices = false where id = p_account;
  perform public.app_audit(p_actor, 'company_bank_account_retired', 'company_bank_account', p_account::text,
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'retired'), jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

create or replace function public.app_set_profile_role(p_actor uuid, p_profile uuid, p_role text, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'access.manage');
  if p_actor = p_profile then
    raise exception 'Someone else must change your own roles.' using errcode = '42501';
  end if;
  if public.app_org_of(p_profile) is distinct from public.app_org_of(p_actor) then
    raise exception 'Person not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.app_roles where key = p_role) then
    raise exception 'Unknown role.' using errcode = '22023';
  end if;
  if p_on then
    insert into public.profile_roles (profile_id, role_key, granted_by) values (p_profile, p_role, p_actor) on conflict do nothing;
  else
    delete from public.profile_roles where profile_id = p_profile and role_key = p_role;
  end if;
  perform public.app_audit(p_actor, case when p_on then 'role_granted' else 'role_removed' end, 'profile_role', p_profile::text,
    null, jsonb_build_object('role', p_role, 'on', p_on), '{}'::jsonb, p_profile);
end;
$$;

-- Company logo: stored in the private finance bucket, recorded in documents.
create or replace function public.company_logo_set(p_actor uuid, p_path text, p_file_name text, p_content_type text, p_size bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid;
  v_old uuid;
begin
  perform public.app_require(p_actor, 'org.manage');
  if p_path is null or p_path !~ ('^org/' || v_org::text || '/company/logo-[A-Za-z0-9._-]{1,120}$') then
    raise exception 'Invalid upload path.' using errcode = '22023';
  end if;
  if p_content_type not in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml') then
    raise exception 'The logo must be a PNG, JPG, WebP or SVG image.' using errcode = '22023';
  end if;
  select logo_document_id into v_old from public.company_settings where organization_id = v_org for update;
  insert into public.documents (organization_id, entity_type, entity_id, category, title, path, file_name, content_type, size_bytes, uploaded_by)
  values (v_org, 'company', v_org::text, 'logo', 'Company logo', p_path, left(coalesce(p_file_name, ''), 200), p_content_type, p_size, p_actor)
  returning id into v_id;
  if v_old is not null then
    update public.documents set archived_at = now() where id = v_old;
  end if;
  update public.company_settings set logo_document_id = v_id, updated_at = now(), updated_by = p_actor where organization_id = v_org;
  perform public.app_audit(p_actor, 'company_logo_changed', 'company_settings', v_org::text,
    jsonb_build_object('logoDocumentId', v_old), jsonb_build_object('logoDocumentId', v_id));
  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 9. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['organizations', 'company_settings', 'number_sequences', 'company_bank_accounts', 'app_roles',
    'app_role_permissions', 'profile_roles', 'notifications', 'approvals', 'documents']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
end;
$$;
-- Notifications are marked read through the API.
grant update (read_at) on table public.notifications to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'app_org_of(uuid)', 'app_mfa_required(uuid)', 'next_document_number(uuid, text)',
    'app_audit(uuid, text, text, text, jsonb, jsonb, jsonb, uuid)',
    'app_notify_holders(uuid, text, uuid, text, text, text, text)',
    'approval_request(uuid, text, text, uuid, text, text, jsonb, jsonb)', 'approval_decide(uuid, uuid, boolean, text)',
    'approval_cancel(uuid, uuid)', 'company_settings_save(uuid, jsonb)', 'number_sequence_save(uuid, text, text, bigint, integer)',
    'company_setup_complete(uuid)', 'company_bank_account_request(uuid, text, text, text, text, text, text, boolean)',
    'company_bank_account_retire(uuid, uuid, text)', 'app_set_profile_role(uuid, uuid, text, boolean)',
    'company_logo_set(uuid, text, text, text, bigint)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
-- Pure validators are safe for anyone.
grant execute on function public.app_valid_abn(text), public.app_valid_acn(text) to service_role;

commit;
