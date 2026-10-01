-- Sign-in accounts, position-based permissions and HR onboarding documents.
--
-- * Passwords: temporary passwords set by administrators force a change at
--   the next sign-in (must_change_password). Passwords themselves never touch
--   these tables; Supabase Auth stores them.
-- * Permissions: each position carries default permissions; administrators
--   can allow or deny individual permissions per person. System administrators
--   (training_profiles.role = 'admin') hold every permission.
-- * Onboarding: HR sends an applicant a checklist of Australian onboarding
--   documents; the applicant uploads each one to private storage and HR accepts
--   or rejects it with a reason.
-- Every state change writes its audit row in the same transaction.

begin;

------------------------------------------------------------------------------
-- 1. Accounts
------------------------------------------------------------------------------

alter table public.training_profiles
  add column must_change_password boolean not null default false,
  add column password_set_at timestamptz;

------------------------------------------------------------------------------
-- 2. Permissions
------------------------------------------------------------------------------

create table public.app_permissions (
  key text primary key check (key ~ '^[a-z]+\.[a-z]+$'),
  name text not null,
  description text not null,
  sort integer not null
);

insert into public.app_permissions (key, name, description, sort) values
  ('training.manage', 'Training administration', 'Invite learners, assign, revoke and publish training modules.', 10),
  ('people.view', 'View the people register', 'See employees, positions, sites and licences.', 20),
  ('people.manage', 'Manage the people register', 'Add and edit people, licences, positions, sites and training requirements.', 30),
  ('hr.manage', 'HR onboarding and records', 'Send onboarding requests and review HR documents, including tax, bank and identity documents.', 40),
  ('competency.all', 'Competency matrix: everyone', 'See everyone''s competency and record practical verifications.', 50),
  ('competency.team', 'Competency matrix: own team', 'See the competency of direct reports and record their practicals.', 60),
  ('access.manage', 'Sign-in and access', 'Create logins, issue temporary passwords, disable sign-in and set permissions and document groups.', 70);

create table public.position_permissions (
  position_id uuid not null references public.positions(id) on delete cascade,
  permission_key text not null references public.app_permissions(key) on delete cascade,
  primary key (position_id, permission_key)
);

create table public.profile_permissions (
  profile_id uuid not null references public.training_profiles(id) on delete cascade,
  permission_key text not null references public.app_permissions(key) on delete cascade,
  granted boolean not null,
  set_by uuid references public.training_profiles(id) on delete set null,
  set_at timestamptz not null default now(),
  primary key (profile_id, permission_key)
);

-- Effective permissions: position defaults, plus per-person "allow", minus
-- per-person "deny". Inactive accounts hold nothing; system admins hold all.
create or replace function public.app_permissions_for(p_profile uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select id, role, active from public.training_profiles where id = p_profile
  ), positional as (
    select pp.permission_key as key
    from public.employees e
    join public.position_permissions pp on pp.position_id = e.position_id
    where e.profile_id = p_profile and e.status in ('active', 'on_leave', 'applicant')
  )
  select case
    when not exists (select 1 from me where active) then '{}'::text[]
    when exists (select 1 from me where role = 'admin') then (select array_agg(key order by sort) from public.app_permissions)
    else coalesce((
      select array_agg(distinct k order by k) from (
        select key as k from positional
        where key not in (select permission_key from public.profile_permissions where profile_id = p_profile and not granted)
        union
        select permission_key from public.profile_permissions where profile_id = p_profile and granted
      ) x), '{}'::text[])
  end;
$$;

create or replace function public.app_has(p_profile uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_key = any (public.app_permissions_for(p_profile));
$$;

create or replace function public.app_require(p_profile uuid, p_key text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.app_has(p_profile, p_key) then
    raise exception 'You need the "%" permission for this.',
      coalesce((select name from public.app_permissions where key = p_key), p_key)
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.app_set_position_permission(p_actor uuid, p_position uuid, p_key text, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'access.manage');
  if p_on then
    insert into public.position_permissions (position_id, permission_key) values (p_position, p_key) on conflict do nothing;
  else
    delete from public.position_permissions where position_id = p_position and permission_key = p_key;
  end if;
  perform public.ims_audit(p_actor, case when p_on then 'position_permission_added' else 'position_permission_removed' end,
    jsonb_build_object('positionId', p_position, 'permission', p_key));
end;
$$;

-- p_state: 'allow', 'deny' or 'default' (follow the position).
create or replace function public.app_set_profile_permission(p_actor uuid, p_profile uuid, p_key text, p_state text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'access.manage');
  if p_state not in ('allow', 'deny', 'default') then
    raise exception 'Unknown permission state.' using errcode = '22023';
  end if;
  if p_profile = p_actor and p_key = 'access.manage' and p_state = 'deny' then
    raise exception 'You cannot remove your own access management.' using errcode = '42501';
  end if;
  if p_state = 'default' then
    delete from public.profile_permissions where profile_id = p_profile and permission_key = p_key;
  else
    insert into public.profile_permissions (profile_id, permission_key, granted, set_by)
    values (p_profile, p_key, p_state = 'allow', p_actor)
    on conflict (profile_id, permission_key) do update set granted = excluded.granted, set_by = excluded.set_by, set_at = now();
  end if;
  perform public.ims_audit(p_actor, 'person_permission_set', jsonb_build_object('permission', p_key, 'state', p_state), p_profile);
end;
$$;

------------------------------------------------------------------------------
-- 3. Existing administration functions now check specific permissions
------------------------------------------------------------------------------

create or replace function public.training_assign(
  p_actor uuid, p_learner uuid, p_email text, p_full_name text, p_external_id text,
  p_learner_type text, p_version uuid, p_expires_at timestamptz, p_invited boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version record;
  v_assignment record;
  v_employee uuid;
begin
  perform public.app_require(p_actor, 'training.manage');
  select v.id, v.revision, v.published, m.code, m.status into v_version
  from public.training_module_versions v join public.training_modules m on m.id = v.module_id
  where v.id = p_version;
  if not found or not v_version.published or v_version.status = 'retired' then
    raise exception 'The selected module version is not available for assignment.' using errcode = '22023';
  end if;
  insert into public.training_profiles (id, email, full_name, external_id, learner_type, active)
  values (p_learner, lower(p_email), p_full_name, p_external_id, p_learner_type, true)
  on conflict (id) do update set
    email = excluded.email, full_name = excluded.full_name, external_id = excluded.external_id,
    learner_type = excluded.learner_type, active = true;

  select id into v_employee from public.employees where email = lower(p_email) and profile_id is null;
  if v_employee is not null then
    update public.employees set profile_id = p_learner where id = v_employee;
  end if;

  select id, status into v_assignment from public.training_assignments
  where learner_id = p_learner and module_version_id = p_version and status in ('assigned', 'theory_passed')
  for update;
  if found then
    update public.training_assignments set expires_at = p_expires_at, assigned_by = p_actor
    where id = v_assignment.id
    returning id, status, assigned_at, expires_at, theory_passed_at into v_assignment;
  else
    insert into public.training_assignments (learner_id, module_version_id, assigned_by, expires_at)
    values (p_learner, p_version, p_actor, p_expires_at)
    returning id, status, assigned_at, expires_at, theory_passed_at into v_assignment;
  end if;

  perform public.ims_audit(p_actor,
    case when p_invited then 'learner_invited_and_assigned' else 'learner_assigned' end,
    jsonb_build_object('moduleCode', v_version.code, 'revision', v_version.revision, 'expiresAt', p_expires_at, 'learnerType', p_learner_type),
    p_learner, v_assignment.id);
  return jsonb_build_object(
    'id', v_assignment.id, 'status', v_assignment.status, 'assignedAt', v_assignment.assigned_at,
    'expiresAt', v_assignment.expires_at, 'theoryPassedAt', v_assignment.theory_passed_at,
    'moduleCode', v_version.code, 'moduleRevision', v_version.revision);
end;
$$;

create or replace function public.training_revoke(p_actor uuid, p_assignment uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment record;
begin
  perform public.app_require(p_actor, 'training.manage');
  select id, learner_id, status into v_assignment from public.training_assignments where id = p_assignment for update;
  if not found then
    raise exception 'Assignment not found.' using errcode = 'P0002';
  end if;
  if v_assignment.status = 'revoked' then
    return jsonb_build_object('revoked', true);
  end if;
  update public.training_assignments set status = 'revoked', revoked_at = now(), revoke_reason = p_reason where id = p_assignment;
  perform public.ims_audit(p_actor, 'assignment_revoked', jsonb_build_object('reason', p_reason), v_assignment.learner_id, p_assignment);
  return jsonb_build_object('revoked', true, 'revokedAt', now());
end;
$$;

create or replace function public.training_link_ims_revision(p_actor uuid, p_version uuid, p_revision uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version record;
  v_doc record;
begin
  perform public.app_require(p_actor, 'training.manage');
  select id, module_id, published into v_version from public.training_module_versions where id = p_version for update;
  if not found then
    raise exception 'Module version not found.' using errcode = 'P0002';
  end if;
  if v_version.published then
    raise exception 'Published versions are immutable.' using errcode = '22023';
  end if;
  select d.* into v_doc from public.ims_document_revisions r join public.ims_documents d on d.id = r.document_id where r.id = p_revision;
  if not found then
    raise exception 'IMS revision not found.' using errcode = 'P0002';
  end if;
  if v_doc.training_module_id is null then
    update public.ims_documents set training_module_id = v_version.module_id where id = v_doc.id;
  elsif v_doc.training_module_id <> v_version.module_id then
    raise exception 'That IMS document controls a different training module.' using errcode = '22023';
  end if;
  update public.training_module_versions set ims_revision_id = p_revision where id = p_version;
  perform public.ims_audit(p_actor, 'module_version_linked_to_ims', jsonb_build_object(
    'versionId', p_version, 'revisionId', p_revision, 'docNumber', v_doc.doc_number));
end;
$$;

create or replace function public.training_publish_version(p_actor uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version record;
  v_module record;
  v_rev record;
begin
  perform public.app_require(p_actor, 'training.manage');
  select * into v_version from public.training_module_versions where id = p_version for update;
  if not found then
    raise exception 'The module version was not found.' using errcode = 'P0002';
  end if;
  select * into v_module from public.training_modules where id = v_version.module_id for update;
  if v_module.status = 'retired' then
    raise exception 'Retired modules cannot be published.' using errcode = '22023';
  end if;
  if v_version.ims_revision_id is null then
    raise exception 'Link this version to its IMS document revision before publishing.' using errcode = '22023';
  end if;
  select r.status, r.revision, d.doc_number into v_rev
  from public.ims_document_revisions r join public.ims_documents d on d.id = r.document_id
  where r.id = v_version.ims_revision_id;
  if v_rev.status <> 'approved' then
    raise exception 'IMS revision % of % is not approved yet.', v_rev.revision, v_rev.doc_number using errcode = '22023';
  end if;
  update public.training_module_versions set published = true where id = p_version;
  update public.training_modules set current_version_id = p_version, status = 'active' where id = v_module.id;
  perform public.ims_audit(p_actor, 'module_published', jsonb_build_object(
    'moduleId', v_module.id, 'versionId', p_version, 'code', v_module.code, 'revision', v_version.revision,
    'imsDocument', v_rev.doc_number, 'imsRevision', v_rev.revision));
  return jsonb_build_object('code', v_module.code, 'title', v_module.title, 'versionId', p_version,
    'revision', v_version.revision, 'contentVersion', v_version.content_version);
end;
$$;

create or replace function public.employee_save(p_actor uuid, p_employee jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_employee ->> 'id', '')::uuid;
  v_before jsonb;
begin
  perform public.app_require(p_actor, 'people.manage');
  if v_id is not null then
    select to_jsonb(e) into v_before from public.employees e where id = v_id for update;
    if v_before is null then
      raise exception 'Employee not found.' using errcode = 'P0002';
    end if;
    update public.employees set
      employee_number = p_employee ->> 'employeeNumber',
      full_name = btrim(p_employee ->> 'fullName'),
      email = nullif(lower(btrim(coalesce(p_employee ->> 'email', ''))), ''),
      employment_type = coalesce(p_employee ->> 'employmentType', 'employee'),
      status = coalesce(p_employee ->> 'status', 'active'),
      position_id = nullif(p_employee ->> 'positionId', '')::uuid,
      site_id = nullif(p_employee ->> 'siteId', '')::uuid,
      supervisor_id = nullif(p_employee ->> 'supervisorId', '')::uuid,
      start_date = nullif(p_employee ->> 'startDate', '')::date,
      end_date = nullif(p_employee ->> 'endDate', '')::date
    where id = v_id;
  else
    insert into public.employees (employee_number, full_name, email, employment_type, status, position_id, site_id, supervisor_id, start_date, end_date)
    values (
      p_employee ->> 'employeeNumber', btrim(p_employee ->> 'fullName'),
      nullif(lower(btrim(coalesce(p_employee ->> 'email', ''))), ''),
      coalesce(p_employee ->> 'employmentType', 'employee'), coalesce(p_employee ->> 'status', 'active'),
      nullif(p_employee ->> 'positionId', '')::uuid, nullif(p_employee ->> 'siteId', '')::uuid,
      nullif(p_employee ->> 'supervisorId', '')::uuid,
      nullif(p_employee ->> 'startDate', '')::date, nullif(p_employee ->> 'endDate', '')::date)
    returning id into v_id;
    update public.employees e set profile_id = p.id
    from public.training_profiles p
    where e.id = v_id and e.email is not null and p.email = e.email
      and not exists (select 1 from public.employees x where x.profile_id = p.id);
  end if;
  perform public.ims_audit(p_actor, case when v_before is null then 'employee_created' else 'employee_updated' end,
    jsonb_build_object('employeeId', v_id, 'employeeNumber', p_employee ->> 'employeeNumber',
      'changed', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_employee) k
                  where v_before is not null and k <> 'id')));
  return v_id;
end;
$$;

create or replace function public.admin_save_position(p_actor uuid, p_position jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_position ->> 'id', '')::uuid;
begin
  perform public.app_require(p_actor, 'people.manage');
  if v_id is null then
    insert into public.positions (code, title, department, safety_critical)
    values (upper(btrim(p_position ->> 'code')), btrim(p_position ->> 'title'), coalesce(p_position ->> 'department', ''),
            coalesce((p_position ->> 'safetyCritical')::boolean, false))
    returning id into v_id;
  else
    update public.positions set code = upper(btrim(p_position ->> 'code')), title = btrim(p_position ->> 'title'),
      department = coalesce(p_position ->> 'department', ''), safety_critical = coalesce((p_position ->> 'safetyCritical')::boolean, false),
      active = coalesce((p_position ->> 'active')::boolean, true)
    where id = v_id;
    if not found then raise exception 'Position not found.' using errcode = 'P0002'; end if;
  end if;
  perform public.ims_audit(p_actor, 'position_saved', jsonb_build_object('positionId', v_id, 'code', upper(btrim(p_position ->> 'code'))));
  return v_id;
end;
$$;

create or replace function public.admin_save_site(p_actor uuid, p_site jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_site ->> 'id', '')::uuid;
begin
  perform public.app_require(p_actor, 'people.manage');
  if v_id is null then
    insert into public.sites (code, name) values (upper(btrim(p_site ->> 'code')), btrim(p_site ->> 'name')) returning id into v_id;
  else
    update public.sites set code = upper(btrim(p_site ->> 'code')), name = btrim(p_site ->> 'name'),
      active = coalesce((p_site ->> 'active')::boolean, true) where id = v_id;
    if not found then raise exception 'Site not found.' using errcode = 'P0002'; end if;
  end if;
  perform public.ims_audit(p_actor, 'site_saved', jsonb_build_object('siteId', v_id, 'code', upper(btrim(p_site ->> 'code'))));
  return v_id;
end;
$$;

create or replace function public.admin_set_requirement(
  p_actor uuid, p_position uuid, p_module uuid, p_required boolean, p_refresher_months integer, p_before_start boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'people.manage');
  if p_required then
    insert into public.position_requirements (position_id, module_id, refresher_months, required_before_start)
    values (p_position, p_module, p_refresher_months, coalesce(p_before_start, false))
    on conflict (position_id, module_id) do update
      set refresher_months = excluded.refresher_months, required_before_start = excluded.required_before_start;
  else
    delete from public.position_requirements where position_id = p_position and module_id = p_module;
  end if;
  perform public.ims_audit(p_actor, case when p_required then 'requirement_set' else 'requirement_removed' end,
    jsonb_build_object('positionId', p_position, 'moduleId', p_module, 'refresherMonths', p_refresher_months));
end;
$$;

create or replace function public.admin_save_licence(p_actor uuid, p_licence jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_licence ->> 'id', '')::uuid;
  v_employee uuid := (p_licence ->> 'employeeId')::uuid;
begin
  perform public.app_require(p_actor, 'people.manage');
  if v_id is null then
    insert into public.licences (employee_id, licence_type, licence_number, issuer, issued_on, expires_on, verified_by, verified_at)
    values (v_employee, btrim(p_licence ->> 'licenceType'), nullif(btrim(coalesce(p_licence ->> 'licenceNumber', '')), ''),
            nullif(btrim(coalesce(p_licence ->> 'issuer', '')), ''), nullif(p_licence ->> 'issuedOn', '')::date,
            nullif(p_licence ->> 'expiresOn', '')::date,
            case when (p_licence ->> 'verified')::boolean then p_actor end,
            case when (p_licence ->> 'verified')::boolean then now() end)
    returning id into v_id;
  else
    update public.licences set licence_type = btrim(p_licence ->> 'licenceType'),
      licence_number = nullif(btrim(coalesce(p_licence ->> 'licenceNumber', '')), ''),
      issuer = nullif(btrim(coalesce(p_licence ->> 'issuer', '')), ''),
      issued_on = nullif(p_licence ->> 'issuedOn', '')::date, expires_on = nullif(p_licence ->> 'expiresOn', '')::date,
      verified_by = case when (p_licence ->> 'verified')::boolean then p_actor else verified_by end,
      verified_at = case when (p_licence ->> 'verified')::boolean then now() else verified_at end
    where id = v_id
    returning employee_id into v_employee;
    if not found then raise exception 'Licence not found.' using errcode = 'P0002'; end if;
  end if;
  perform public.ims_audit(p_actor, 'licence_saved', jsonb_build_object(
    'licenceId', v_id, 'employeeId', v_employee, 'type', btrim(p_licence ->> 'licenceType'), 'expiresOn', p_licence ->> 'expiresOn'));
  return v_id;
end;
$$;

create or replace function public.admin_delete_licence(p_actor uuid, p_licence uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  perform public.app_require(p_actor, 'people.manage');
  delete from public.licences where id = p_licence returning employee_id, licence_type into v_row;
  if not found then raise exception 'Licence not found.' using errcode = 'P0002'; end if;
  perform public.ims_audit(p_actor, 'licence_deleted', jsonb_build_object('licenceId', p_licence, 'employeeId', v_row.employee_id, 'type', v_row.licence_type));
end;
$$;

create or replace function public.admin_set_group_member(p_actor uuid, p_group text, p_profile uuid, p_member boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'access.manage');
  if exists (select 1 from public.ims_groups where key = p_group and implicit) then
    raise exception 'Membership of % is automatic.', p_group using errcode = '22023';
  end if;
  if p_member then
    insert into public.ims_group_members (group_key, profile_id) values (p_group, p_profile) on conflict do nothing;
  else
    delete from public.ims_group_members where group_key = p_group and profile_id = p_profile;
  end if;
  perform public.ims_audit(p_actor, case when p_member then 'group_member_added' else 'group_member_removed' end,
    jsonb_build_object('group', p_group), p_profile);
end;
$$;

create or replace function public.training_record_practical(
  p_actor uuid, p_assignment uuid, p_assessor_employee uuid, p_assessor_name text,
  p_assessed_on date, p_site uuid, p_outcome text, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment record;
  v_id uuid;
begin
  select a.id, a.learner_id, a.status into v_assignment from public.training_assignments a where a.id = p_assignment;
  if not found then
    raise exception 'Assignment not found.' using errcode = 'P0002';
  end if;
  -- Everyone with competency.all, or supervisors for their direct reports.
  if not public.app_has(p_actor, 'competency.all') then
    if not (public.app_has(p_actor, 'competency.team') and exists (
      select 1 from public.employees learner
      join public.employees me on learner.supervisor_id = me.id
      where learner.profile_id = v_assignment.learner_id and me.profile_id = p_actor)) then
      raise exception 'You can record practicals only for people you supervise.' using errcode = '42501';
    end if;
  end if;
  if v_assignment.status <> 'theory_passed' then
    raise exception 'Practical verification can only follow a passed theory assessment.' using errcode = '22023';
  end if;
  if p_assessed_on > (now() at time zone 'Australia/Sydney')::date then
    raise exception 'The assessment date cannot be in the future.' using errcode = '22023';
  end if;
  insert into public.practical_verifications (assignment_id, assessor_employee_id, assessor_name, assessed_on, site_id, outcome, notes, recorded_by)
  values (p_assignment, p_assessor_employee, btrim(p_assessor_name), p_assessed_on, p_site, p_outcome, coalesce(p_notes, ''), p_actor)
  returning id into v_id;
  perform public.ims_audit(p_actor, 'practical_verification_recorded', jsonb_build_object(
    'verificationId', v_id, 'outcome', p_outcome, 'assessedOn', p_assessed_on, 'assessor', btrim(p_assessor_name)),
    v_assignment.learner_id, p_assignment);
  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 4. Account functions (the password itself is set through Supabase Auth)
------------------------------------------------------------------------------

create or replace function public.account_temp_password_issued(p_actor uuid, p_profile uuid, p_new_account boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Sign-in managers can issue one to anyone; training administrators only
  -- when creating a brand-new learner login.
  if not (public.app_has(p_actor, 'access.manage') or (p_new_account and public.app_has(p_actor, 'training.manage'))) then
    raise exception 'You need the "Sign-in and access" permission for this.' using errcode = '42501';
  end if;
  update public.training_profiles set must_change_password = true, active = true where id = p_profile;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  perform public.ims_audit(p_actor, case when p_new_account then 'login_created_with_temporary_password' else 'temporary_password_issued' end,
    '{}'::jsonb, p_profile);
end;
$$;

create or replace function public.account_password_changed(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.training_profiles set must_change_password = false, password_set_at = now() where id = p_actor;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  perform public.ims_audit(p_actor, 'password_changed', '{}'::jsonb, p_actor);
end;
$$;

create or replace function public.account_set_active(p_actor uuid, p_profile uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'access.manage');
  if p_profile = p_actor and not p_active then
    raise exception 'You cannot disable your own sign-in.' using errcode = '42501';
  end if;
  update public.training_profiles set active = p_active where id = p_profile;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  perform public.ims_audit(p_actor, case when p_active then 'sign_in_enabled' else 'sign_in_disabled' end, '{}'::jsonb, p_profile);
end;
$$;

-- Links a register entry to its sign-in account (same email).
create or replace function public.account_link_employee(p_actor uuid, p_employee uuid, p_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emp record;
begin
  if not (public.app_has(p_actor, 'access.manage') or public.app_has(p_actor, 'hr.manage')) then
    raise exception 'You need sign-in and access or HR permission for this.' using errcode = '42501';
  end if;
  select * into v_emp from public.employees where id = p_employee for update;
  if not found then
    raise exception 'Person not found on the register.' using errcode = 'P0002';
  end if;
  if v_emp.profile_id is not null and v_emp.profile_id <> p_profile then
    raise exception 'This person is already linked to a different sign-in.' using errcode = '22023';
  end if;
  update public.employees set profile_id = p_profile where id = p_employee;
  update public.training_profiles p set full_name = v_emp.full_name, external_id = v_emp.employee_number,
    learner_type = case when v_emp.employment_type in ('employee', 'applicant', 'contractor') then v_emp.employment_type else p.learner_type end
  where p.id = p_profile;
  perform public.ims_audit(p_actor, 'sign_in_linked_to_register', jsonb_build_object('employeeId', p_employee), p_profile);
end;
$$;

------------------------------------------------------------------------------
-- 5. HR onboarding documents
------------------------------------------------------------------------------

create table public.hr_document_types (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null,
  guidance text not null default '',
  required boolean not null default true,
  applies_to text[] not null check (applies_to <@ array['employee', 'applicant', 'contractor']::text[]),
  sensitive boolean not null default false,
  sort integer not null default 100,
  active boolean not null default true
);

-- Standard Australian onboarding set. HR can edit names, guidance and which
-- are required.
insert into public.hr_document_types (key, name, guidance, required, applies_to, sensitive, sort) values
  ('tfn_declaration', 'Tax file number declaration', 'ATO form NAT 3092, completed and signed. Leave blank sections as instructed by the form.', true, '{employee,applicant}', true, 10),
  ('super_choice', 'Superannuation standard choice form', 'ATO form NAT 13080, or your fund''s name, USI and member number.', true, '{employee,applicant}', true, 20),
  ('right_to_work', 'Right to work in Australia', 'Australian passport or birth certificate, or your foreign passport with your visa grant notice (VEVO).', true, '{employee,applicant,contractor}', true, 30),
  ('photo_id', 'Photo identification', 'Current driver licence (front and back) or passport photo page.', true, '{employee,applicant,contractor}', true, 40),
  ('bank_details', 'Bank account for pay', 'A bank letter, deposit slip or screenshot showing account name, BSB and account number.', true, '{employee,applicant}', true, 50),
  ('emergency_contact', 'Emergency contact', 'Name, relationship and phone number for at least one emergency contact.', true, '{employee,applicant,contractor}', false, 60),
  ('white_card', 'General construction induction (White Card)', 'Front and back of your card.', true, '{employee,applicant,contractor}', false, 70),
  ('tickets', 'Licences and high-risk work tickets', 'Trade licences and HRW tickets (forklift, EWP, dogging and similar). Combine several into one PDF.', false, '{employee,applicant,contractor}', false, 80),
  ('fwis_ack', 'Fair Work Information Statement', 'Signed acknowledgement that you received the Fair Work Information Statement.', true, '{employee,applicant}', false, 90),
  ('casual_statement', 'Casual Employment Information Statement', 'Casual employees only: signed acknowledgement of the statement.', false, '{employee,applicant}', false, 100),
  ('contract', 'Signed employment contract', 'Signed and dated contract or letter of offer.', true, '{employee,applicant}', false, 110),
  ('abn_details', 'ABN and business details', 'ABN, business name and GST registration status.', true, '{contractor}', false, 120),
  ('public_liability', 'Public liability insurance', 'Current certificate of currency.', true, '{contractor}', false, 130),
  ('workers_comp', 'Workers compensation or personal accident cover', 'Certificate of currency, if applicable to you.', false, '{contractor}', false, 140),
  ('contractor_agreement', 'Signed contractor agreement', 'Signed and dated agreement.', true, '{contractor}', false, 150);

create table public.onboarding_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  profile_id uuid not null references public.training_profiles(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'complete', 'cancelled')),
  due_on date,
  message text not null default '' check (length(message) <= 1000),
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_reason text
);
create unique index onboarding_one_open_per_person on public.onboarding_requests (employee_id) where status = 'open';
create index onboarding_requests_profile_idx on public.onboarding_requests (profile_id, created_at desc);

create table public.onboarding_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.onboarding_requests(id) on delete cascade,
  doc_type text not null references public.hr_document_types(key) on delete restrict,
  required boolean not null,
  status text not null default 'pending' check (status in ('pending', 'uploaded', 'accepted', 'rejected')),
  file_path text,
  file_name text,
  uploaded_at timestamptz,
  reviewed_by uuid references public.training_profiles(id) on delete set null,
  reviewed_at timestamptz,
  reject_reason text,
  unique (request_id, doc_type)
);

create or replace function public.onboarding_create(p_actor uuid, p_employee uuid, p_types text[], p_due date, p_message text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emp record;
  v_id uuid;
  v_unknown text[];
begin
  perform public.app_require(p_actor, 'hr.manage');
  select * into v_emp from public.employees where id = p_employee;
  if not found then
    raise exception 'Person not found on the register.' using errcode = 'P0002';
  end if;
  if v_emp.profile_id is null then
    raise exception 'Create or link this person''s sign-in before sending onboarding documents.' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_types, '{}')) = 0 then
    raise exception 'Choose at least one document.' using errcode = '22023';
  end if;
  select array_agg(t) into v_unknown from unnest(p_types) t
  where not exists (select 1 from public.hr_document_types d where d.key = t and d.active);
  if v_unknown is not null then
    raise exception 'Unknown document types: %', array_to_string(v_unknown, ', ') using errcode = '22023';
  end if;
  if p_due is not null and p_due < (now() at time zone 'Australia/Sydney')::date then
    raise exception 'The due date cannot be in the past.' using errcode = '22023';
  end if;
  insert into public.onboarding_requests (employee_id, profile_id, due_on, message, created_by)
  values (p_employee, v_emp.profile_id, p_due, coalesce(p_message, ''), p_actor)
  returning id into v_id;
  insert into public.onboarding_items (request_id, doc_type, required)
  select v_id, d.key, d.required from public.hr_document_types d where d.key = any (p_types);
  perform public.ims_audit(p_actor, 'onboarding_requested',
    jsonb_build_object('requestId', v_id, 'employeeId', p_employee, 'documents', to_jsonb(p_types), 'dueOn', p_due), v_emp.profile_id);
  return v_id;
end;
$$;

create or replace function public.onboarding_record_upload(p_actor uuid, p_item uuid, p_path text, p_file_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
begin
  select i.*, r.profile_id, r.status as request_status into v_item
  from public.onboarding_items i join public.onboarding_requests r on r.id = i.request_id
  where i.id = p_item for update of i;
  if not found or v_item.profile_id <> p_actor then
    raise exception 'Document request not found.' using errcode = 'P0002';
  end if;
  if v_item.request_status <> 'open' then
    raise exception 'This onboarding request is closed.' using errcode = '22023';
  end if;
  if v_item.status = 'accepted' then
    raise exception 'This document has already been accepted.' using errcode = '22023';
  end if;
  if p_path is null or p_path !~ ('^' || v_item.request_id::text || '/' || p_item::text || '/[A-Za-z0-9._-]{1,160}$') then
    raise exception 'Invalid upload path.' using errcode = '22023';
  end if;
  update public.onboarding_items
  set status = 'uploaded', file_path = p_path, file_name = left(coalesce(p_file_name, ''), 200), uploaded_at = now(),
      reviewed_by = null, reviewed_at = null, reject_reason = null
  where id = p_item;
  perform public.ims_audit(p_actor, 'onboarding_document_uploaded',
    jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type), p_actor);
end;
$$;

create or replace function public.onboarding_review(p_actor uuid, p_item uuid, p_accept boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_outstanding integer;
begin
  perform public.app_require(p_actor, 'hr.manage');
  select i.*, r.profile_id, r.status as request_status into v_item
  from public.onboarding_items i join public.onboarding_requests r on r.id = i.request_id
  where i.id = p_item for update of i;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if v_item.request_status <> 'open' then
    raise exception 'This onboarding request is closed.' using errcode = '22023';
  end if;
  if v_item.status <> 'uploaded' then
    raise exception 'Only an uploaded document can be reviewed.' using errcode = '22023';
  end if;
  if v_item.profile_id = p_actor then
    raise exception 'You cannot review your own onboarding documents.' using errcode = '42501';
  end if;
  if not p_accept and length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give the applicant a reason so they know what to fix.' using errcode = '22023';
  end if;
  update public.onboarding_items
  set status = case when p_accept then 'accepted' else 'rejected' end,
      reviewed_by = p_actor, reviewed_at = now(),
      reject_reason = case when p_accept then null else btrim(p_reason) end
  where id = p_item;
  perform public.ims_audit(p_actor, case when p_accept then 'onboarding_document_accepted' else 'onboarding_document_rejected' end,
    jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type, 'reason', p_reason), v_item.profile_id);

  select count(*) into v_outstanding from public.onboarding_items
  where request_id = v_item.request_id and required and status <> 'accepted';
  if v_outstanding = 0 then
    update public.onboarding_requests set status = 'complete', completed_at = now() where id = v_item.request_id;
    perform public.ims_audit(p_actor, 'onboarding_complete', jsonb_build_object('requestId', v_item.request_id), v_item.profile_id);
  end if;
  return jsonb_build_object('requestComplete', v_outstanding = 0);
end;
$$;

create or replace function public.onboarding_cancel(p_actor uuid, p_request uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req record;
begin
  perform public.app_require(p_actor, 'hr.manage');
  select * into v_req from public.onboarding_requests where id = p_request for update;
  if not found then
    raise exception 'Onboarding request not found.' using errcode = 'P0002';
  end if;
  if v_req.status <> 'open' then
    raise exception 'Only an open request can be cancelled.' using errcode = '22023';
  end if;
  update public.onboarding_requests set status = 'cancelled', cancelled_reason = btrim(coalesce(p_reason, '')) where id = p_request;
  perform public.ims_audit(p_actor, 'onboarding_cancelled', jsonb_build_object('requestId', p_request, 'reason', p_reason), v_req.profile_id);
end;
$$;

create or replace function public.hr_document_type_save(p_actor uuid, p_key text, p_name text, p_guidance text, p_required boolean, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require(p_actor, 'hr.manage');
  update public.hr_document_types
  set name = btrim(p_name), guidance = btrim(coalesce(p_guidance, '')), required = p_required, active = p_active
  where key = p_key;
  if not found then
    raise exception 'Document type not found.' using errcode = 'P0002';
  end if;
  if length(btrim(p_name)) < 3 then
    raise exception 'Give the document a name.' using errcode = '22023';
  end if;
  perform public.ims_audit(p_actor, 'hr_document_type_saved', jsonb_build_object('key', p_key, 'required', p_required, 'active', p_active));
end;
$$;

------------------------------------------------------------------------------
-- 6. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['app_permissions', 'position_permissions', 'profile_permissions', 'hr_document_types', 'onboarding_requests', 'onboarding_items']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end;
$$;

grant select on table public.app_permissions, public.position_permissions, public.profile_permissions,
  public.hr_document_types, public.onboarding_requests, public.onboarding_items to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'app_permissions_for(uuid)', 'app_has(uuid, text)', 'app_require(uuid, text)',
    'app_set_position_permission(uuid, uuid, text, boolean)', 'app_set_profile_permission(uuid, uuid, text, text)',
    'account_temp_password_issued(uuid, uuid, boolean)', 'account_password_changed(uuid)',
    'account_set_active(uuid, uuid, boolean)', 'account_link_employee(uuid, uuid, uuid)',
    'onboarding_create(uuid, uuid, text[], date, text)', 'onboarding_record_upload(uuid, uuid, text, text)',
    'onboarding_review(uuid, uuid, boolean, text)', 'onboarding_cancel(uuid, uuid, text)',
    'hr_document_type_save(uuid, text, text, text, boolean, boolean)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hr-documents', 'hr-documents', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update set public = false;

comment on table public.onboarding_items is 'HR onboarding documents. Contains tax, bank and identity records: hr.manage only.';
comment on column public.training_profiles.must_change_password is 'Set when an administrator issues a temporary password; cleared by a password change.';

commit;
