-- Integrated IMS: employee register, competency, controlled IMS folders and
-- documents with revision approval, plus atomic training operations.
--
-- Every table follows the existing training pattern: row-level security on,
-- browser roles revoked, and access only through the Edge Functions using the
-- service role. Every state-changing function writes its audit row inside the
-- same transaction as the change, so an action cannot happen without a record.

begin;

------------------------------------------------------------------------------
-- 1. People
------------------------------------------------------------------------------

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,29}$'),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,29}$'),
  title text not null,
  department text not null default '',
  safety_critical boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_number text not null unique check (employee_number ~ '^[A-Za-z0-9][A-Za-z0-9-]{1,29}$'),
  full_name text not null check (length(full_name) between 1 and 100),
  email text check (email is null or email = lower(email)),
  employment_type text not null default 'employee' check (employment_type in ('employee', 'applicant', 'contractor')),
  status text not null default 'active' check (status in ('applicant', 'active', 'on_leave', 'terminated')),
  position_id uuid references public.positions(id) on delete restrict,
  site_id uuid references public.sites(id) on delete restrict,
  supervisor_id uuid references public.employees(id) on delete set null,
  start_date date,
  end_date date,
  profile_id uuid unique references public.training_profiles(id) on delete set null,
  retain_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date),
  check (supervisor_id is null or supervisor_id <> id)
);
create unique index employees_email_unique on public.employees (email) where email is not null;
create index employees_supervisor_idx on public.employees (supervisor_id);

create table public.licences (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  licence_type text not null check (length(licence_type) between 1 and 120),
  licence_number text,
  issuer text,
  issued_on date,
  expires_on date,
  evidence_path text,
  verified_by uuid references public.training_profiles(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_on is null or issued_on is null or expires_on >= issued_on)
);
create index licences_employee_idx on public.licences (employee_id);
create index licences_expiry_idx on public.licences (expires_on) where expires_on is not null;

------------------------------------------------------------------------------
-- 2. Competency
------------------------------------------------------------------------------

create table public.position_requirements (
  position_id uuid not null references public.positions(id) on delete cascade,
  module_id uuid not null references public.training_modules(id) on delete cascade,
  refresher_months integer check (refresher_months is null or refresher_months between 1 and 120),
  required_before_start boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (position_id, module_id)
);

create table public.practical_verifications (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.training_assignments(id) on delete restrict,
  assessor_employee_id uuid references public.employees(id) on delete set null,
  assessor_name text not null check (length(assessor_name) between 1 and 100),
  assessed_on date not null,
  site_id uuid references public.sites(id) on delete set null,
  outcome text not null check (outcome in ('competent', 'not_yet_competent')),
  notes text not null default '' check (length(notes) <= 2000),
  evidence_path text,
  recorded_by uuid references public.training_profiles(id) on delete set null,
  recorded_at timestamptz not null default now()
);
create index practical_verifications_assignment_idx on public.practical_verifications (assignment_id, assessed_on desc);

------------------------------------------------------------------------------
-- 3. IMS folders, access and documents
------------------------------------------------------------------------------

create table public.ims_groups (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null,
  implicit boolean not null default false
);

insert into public.ims_groups (key, name, implicit) values
  ('all_employees', 'All employees (current staff on the register)', true),
  ('system_admins', 'System administrators', true),
  ('document_controllers', 'Document controllers', false),
  ('supervisors', 'Supervisors', false),
  ('hr_admins', 'HR admins', false),
  ('welding_supervisors', 'Welding supervisors', false),
  ('whs_advisers', 'WHS advisers', false);

create table public.ims_group_members (
  group_key text not null references public.ims_groups(key) on delete cascade,
  profile_id uuid not null references public.training_profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_key, profile_id)
);

create table public.ims_folders (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.ims_folders(id) on delete restrict,
  name text not null check (length(name) between 1 and 120 and name !~ '[/\\]'),
  sort_key text not null default '',
  inherit_access boolean not null default true,
  created_at timestamptz not null default now(),
  unique (parent_id, name)
);
create unique index ims_folders_single_root on public.ims_folders ((parent_id is null)) where parent_id is null;

create table public.ims_folder_grants (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.ims_folders(id) on delete cascade,
  principal_group text references public.ims_groups(key) on delete cascade,
  principal_profile uuid references public.training_profiles(id) on delete cascade,
  level text not null check (level in ('viewer', 'editor', 'approver', 'owner')),
  granted_by uuid references public.training_profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  check ((principal_group is null) <> (principal_profile is null))
);
create unique index ims_folder_grants_group_unique on public.ims_folder_grants (folder_id, principal_group) where principal_group is not null;
create unique index ims_folder_grants_profile_unique on public.ims_folder_grants (folder_id, principal_profile) where principal_profile is not null;

create table public.ims_documents (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.ims_folders(id) on delete restrict,
  doc_number text not null unique check (doc_number ~ '^[A-Z0-9][A-Z0-9-]{1,49}$'),
  title text not null check (length(title) between 1 and 200),
  doc_type text not null default 'Procedure' check (length(doc_type) between 1 and 60),
  owner_profile_id uuid references public.training_profiles(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  required_gates text[] not null default '{ims}' check (required_gates <@ array['technical', 'whs', 'ims']::text[] and cardinality(required_gates) >= 1),
  review_months integer not null default 12 check (review_months between 1 and 60),
  review_due date,
  current_revision_id uuid,
  training_module_id uuid unique references public.training_modules(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ims_documents_folder_idx on public.ims_documents (folder_id);

create table public.ims_document_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.ims_documents(id) on delete cascade,
  revision text not null check (revision ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$'),
  change_summary text not null default '' check (length(change_summary) <= 1000),
  f01_reference text check (f01_reference is null or length(f01_reference) <= 40),
  file_path text,
  status text not null default 'in_approval' check (status in ('in_approval', 'approved', 'superseded', 'withdrawn')),
  author_profile_id uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  effective_from date,
  unique (document_id, revision)
);
create unique index ims_one_open_revision on public.ims_document_revisions (document_id) where status = 'in_approval';

alter table public.ims_documents
  add constraint ims_documents_current_revision_fk
  foreign key (current_revision_id) references public.ims_document_revisions(id) on delete set null;

create table public.ims_revision_approvals (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.ims_document_revisions(id) on delete cascade,
  gate text not null check (gate in ('technical', 'whs', 'ims')),
  approver_profile_id uuid not null references public.training_profiles(id) on delete restrict,
  comment text not null default '' check (length(comment) <= 500),
  approved_at timestamptz not null default now(),
  unique (revision_id, gate)
);

create table public.ims_document_links (
  from_document_id uuid not null references public.ims_documents(id) on delete cascade,
  to_document_id uuid not null references public.ims_documents(id) on delete cascade,
  relation text not null check (relation in ('teaches', 'references', 'supersedes')),
  primary key (from_document_id, to_document_id, relation),
  check (from_document_id <> to_document_id)
);

alter table public.training_module_versions
  add column ims_revision_id uuid references public.ims_document_revisions(id) on delete restrict;

create trigger employees_updated_at before update on public.employees
for each row execute function public.training_set_updated_at();
create trigger ims_documents_updated_at before update on public.ims_documents
for each row execute function public.training_set_updated_at();

------------------------------------------------------------------------------
-- 4. Access resolution
------------------------------------------------------------------------------

create or replace function public.ims_level_rank(p_level text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_level when 'viewer' then 1 when 'editor' then 2 when 'approver' then 3 when 'owner' then 4 else 0 end;
$$;

create or replace function public.ims_level_name(p_rank integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_rank when 1 then 'viewer' when 2 then 'editor' when 3 then 'approver' when 4 then 'owner' else 'none' end;
$$;

-- Highest access level a profile holds on a folder: grants on the folder plus
-- every ancestor reached while each folder on the way still inherits.
create or replace function public.ims_folder_level(p_folder uuid, p_profile uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile record;
  v_folder record;
  v_current uuid := p_folder;
  v_level integer := 0;
  v_here integer;
  v_steps integer := 0;
  v_is_employee boolean;
begin
  select id, role, active into v_profile from public.training_profiles where id = p_profile;
  if not found or not v_profile.active then
    return 0;
  end if;
  -- "All employees" means current staff on the employee register, not every
  -- login: applicants and contractors invited only for training are excluded.
  select exists (
    select 1 from public.employees e
    where e.profile_id = p_profile and e.employment_type = 'employee' and e.status in ('active', 'on_leave')
  ) into v_is_employee;
  loop
    select id, parent_id, inherit_access into v_folder from public.ims_folders where id = v_current;
    exit when not found;
    select coalesce(max(public.ims_level_rank(g.level)), 0) into v_here
    from public.ims_folder_grants g
    where g.folder_id = v_current
      and (
        g.principal_profile = p_profile
        or (g.principal_group = 'all_employees' and v_is_employee)
        or (g.principal_group = 'system_admins' and v_profile.role = 'admin')
        or g.principal_group in (select m.group_key from public.ims_group_members m where m.profile_id = p_profile)
      );
    v_level := greatest(v_level, v_here);
    exit when v_folder.parent_id is null or not v_folder.inherit_access;
    v_current := v_folder.parent_id;
    v_steps := v_steps + 1;
    if v_steps > 64 then
      raise exception 'Folder nesting is too deep.';
    end if;
  end loop;
  return v_level;
end;
$$;

-- Every grant that applies to a folder, direct or inherited, with its source.
create or replace function public.ims_effective_grants(p_folder uuid)
returns table (grant_id uuid, principal_group text, principal_profile uuid, level text, source_folder uuid, inherited boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_folder record;
  v_current uuid := p_folder;
  v_steps integer := 0;
begin
  loop
    select id, parent_id, inherit_access into v_folder from public.ims_folders where id = v_current;
    exit when not found;
    return query
      select g.id, g.principal_group, g.principal_profile, g.level, g.folder_id, g.folder_id <> p_folder
      from public.ims_folder_grants g where g.folder_id = v_current;
    exit when v_folder.parent_id is null or not v_folder.inherit_access;
    v_current := v_folder.parent_id;
    v_steps := v_steps + 1;
    if v_steps > 64 then
      raise exception 'Folder nesting is too deep.';
    end if;
  end loop;
end;
$$;

create or replace function public.ims_folder_tree(p_profile uuid)
returns table (id uuid, parent_id uuid, name text, sort_key text, inherit_access boolean, access_level integer)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.parent_id, f.name, f.sort_key, f.inherit_access, public.ims_folder_level(f.id, p_profile)
  from public.ims_folders f
  order by f.sort_key, f.name;
$$;

create or replace function public.ims_require_level(p_folder uuid, p_profile uuid, p_min integer, p_action text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.ims_folder_level(p_folder, p_profile) < p_min then
    raise exception 'You need % access on this folder to %.', public.ims_level_name(p_min), p_action
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.ims_audit(p_actor uuid, p_event text, p_details jsonb, p_subject uuid default null, p_assignment uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.training_audit_events (actor_user_id, subject_user_id, assignment_id, event_type, details)
  values (p_actor, p_subject, p_assignment, p_event, coalesce(p_details, '{}'::jsonb));
$$;

------------------------------------------------------------------------------
-- 5. Folder management
------------------------------------------------------------------------------

create or replace function public.ims_create_folder(p_actor uuid, p_parent uuid, p_name text, p_sort_key text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_parent is null then
    if exists (select 1 from public.ims_folders where parent_id is null) then
      raise exception 'The root folder already exists.' using errcode = '23505';
    end if;
    if not exists (select 1 from public.training_profiles where id = p_actor and role = 'admin' and active) then
      raise exception 'Only a system administrator can create the root folder.' using errcode = '42501';
    end if;
  else
    perform public.ims_require_level(p_parent, p_actor, 4, 'create folders');
  end if;
  insert into public.ims_folders (parent_id, name, sort_key)
  values (p_parent, btrim(p_name), coalesce(p_sort_key, btrim(p_name)))
  returning id into v_id;
  if p_parent is null then
    insert into public.ims_folder_grants (folder_id, principal_group, level, granted_by)
    values (v_id, 'system_admins', 'owner', p_actor);
  end if;
  perform public.ims_audit(p_actor, 'ims_folder_created', jsonb_build_object('folderId', v_id, 'parentId', p_parent, 'name', btrim(p_name)));
  return v_id;
end;
$$;

create or replace function public.ims_folder_owner_count(p_folder uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.ims_effective_grants(p_folder) where level = 'owner';
$$;

create or replace function public.ims_set_grant(p_actor uuid, p_folder uuid, p_group text, p_profile uuid, p_level text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_previous text;
begin
  perform public.ims_require_level(p_folder, p_actor, 4, 'manage access');
  if (p_group is null) = (p_profile is null) then
    raise exception 'Grant access to exactly one group or one person.' using errcode = '22023';
  end if;
  if public.ims_level_rank(p_level) = 0 then
    raise exception 'Unknown access level.' using errcode = '22023';
  end if;
  if p_group is not null then
    select id, level into v_id, v_previous from public.ims_folder_grants where folder_id = p_folder and principal_group = p_group;
  else
    select id, level into v_id, v_previous from public.ims_folder_grants where folder_id = p_folder and principal_profile = p_profile;
  end if;
  if v_id is null then
    insert into public.ims_folder_grants (folder_id, principal_group, principal_profile, level, granted_by)
    values (p_folder, p_group, p_profile, p_level, p_actor)
    returning id into v_id;
  else
    update public.ims_folder_grants set level = p_level, granted_by = p_actor, granted_at = now() where id = v_id;
  end if;
  if public.ims_folder_level(p_folder, p_actor) < 4 and public.ims_folder_owner_count(p_folder) = 0 then
    raise exception 'This change would leave the folder without an owner.' using errcode = '42501';
  end if;
  perform public.ims_audit(p_actor, 'ims_access_granted', jsonb_build_object(
    'folderId', p_folder, 'group', p_group, 'profileId', p_profile, 'level', p_level, 'previousLevel', v_previous));
  return v_id;
end;
$$;

create or replace function public.ims_remove_grant(p_actor uuid, p_grant uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant record;
begin
  select * into v_grant from public.ims_folder_grants where id = p_grant;
  if not found then
    raise exception 'Access entry not found.' using errcode = 'P0002';
  end if;
  perform public.ims_require_level(v_grant.folder_id, p_actor, 4, 'manage access');
  delete from public.ims_folder_grants where id = p_grant;
  if public.ims_folder_owner_count(v_grant.folder_id) = 0 then
    raise exception 'The last owner of a folder cannot be removed.' using errcode = '42501';
  end if;
  perform public.ims_audit(p_actor, 'ims_access_removed', jsonb_build_object(
    'folderId', v_grant.folder_id, 'group', v_grant.principal_group, 'profileId', v_grant.principal_profile, 'level', v_grant.level));
end;
$$;

-- Stopping inheritance copies the inherited grants onto the folder first, so
-- nobody loses access by surprise; owners then remove what they do not want.
create or replace function public.ims_set_inherit(p_actor uuid, p_folder uuid, p_inherit boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_folder record;
begin
  select * into v_folder from public.ims_folders where id = p_folder;
  if not found then
    raise exception 'Folder not found.' using errcode = 'P0002';
  end if;
  if v_folder.parent_id is null then
    raise exception 'The root folder has nothing to inherit.' using errcode = '22023';
  end if;
  perform public.ims_require_level(p_folder, p_actor, 4, 'change inheritance');
  if v_folder.inherit_access = p_inherit then
    return;
  end if;
  if not p_inherit then
    insert into public.ims_folder_grants (folder_id, principal_group, principal_profile, level, granted_by)
    select distinct on (coalesce(e.principal_group, e.principal_profile::text))
      p_folder, e.principal_group, e.principal_profile, e.level, p_actor
    from public.ims_effective_grants(p_folder) e
    where e.inherited
      and not exists (
        select 1 from public.ims_folder_grants d
        where d.folder_id = p_folder
          and (d.principal_group is not distinct from e.principal_group)
          and (d.principal_profile is not distinct from e.principal_profile)
      )
    order by coalesce(e.principal_group, e.principal_profile::text), public.ims_level_rank(e.level) desc;
  end if;
  update public.ims_folders set inherit_access = p_inherit where id = p_folder;
  perform public.ims_audit(p_actor, case when p_inherit then 'ims_inheritance_restored' else 'ims_inheritance_stopped' end,
    jsonb_build_object('folderId', p_folder));
end;
$$;

------------------------------------------------------------------------------
-- 6. Documents, revisions and approvals
------------------------------------------------------------------------------

create or replace function public.ims_create_document(
  p_actor uuid, p_folder uuid, p_number text, p_title text, p_type text,
  p_required_gates text[] default '{ims}', p_review_months integer default 12, p_training_module uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.ims_require_level(p_folder, p_actor, 2, 'create documents');
  insert into public.ims_documents (folder_id, doc_number, title, doc_type, owner_profile_id, required_gates, review_months, training_module_id)
  values (p_folder, upper(btrim(p_number)), btrim(p_title), btrim(p_type), p_actor,
          coalesce(p_required_gates, '{ims}'), coalesce(p_review_months, 12), p_training_module)
  returning id into v_id;
  perform public.ims_audit(p_actor, 'ims_document_created', jsonb_build_object(
    'documentId', v_id, 'folderId', p_folder, 'docNumber', upper(btrim(p_number))));
  return v_id;
end;
$$;

create or replace function public.ims_create_revision(
  p_actor uuid, p_document uuid, p_revision text, p_summary text, p_f01 text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc record;
  v_id uuid;
begin
  select * into v_doc from public.ims_documents where id = p_document;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if v_doc.status = 'archived' then
    raise exception 'Archived documents cannot be revised.' using errcode = '22023';
  end if;
  perform public.ims_require_level(v_doc.folder_id, p_actor, 2, 'create revisions');
  insert into public.ims_document_revisions (document_id, revision, change_summary, f01_reference, author_profile_id)
  values (p_document, btrim(p_revision), coalesce(p_summary, ''), nullif(btrim(coalesce(p_f01, '')), ''), p_actor)
  returning id into v_id;
  perform public.ims_audit(p_actor, 'ims_revision_created', jsonb_build_object(
    'documentId', p_document, 'revisionId', v_id, 'revision', btrim(p_revision), 'f01', p_f01));
  return v_id;
end;
$$;

create or replace function public.ims_attach_revision_file(p_actor uuid, p_revision uuid, p_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rev record;
begin
  select r.*, d.folder_id into v_rev
  from public.ims_document_revisions r join public.ims_documents d on d.id = r.document_id
  where r.id = p_revision;
  if not found then
    raise exception 'Revision not found.' using errcode = 'P0002';
  end if;
  if v_rev.status <> 'in_approval' then
    raise exception 'Only a revision awaiting approval can change its file.' using errcode = '22023';
  end if;
  if exists (select 1 from public.ims_revision_approvals where revision_id = p_revision) then
    raise exception 'The file cannot change after an approval has been recorded.' using errcode = '22023';
  end if;
  perform public.ims_require_level(v_rev.folder_id, p_actor, 2, 'upload revision files');
  if p_path is null or p_path !~ ('^' || v_rev.document_id::text || '/' || p_revision::text || '/[A-Za-z0-9._-]{1,120}$') then
    raise exception 'Invalid revision file path.' using errcode = '22023';
  end if;
  update public.ims_document_revisions set file_path = p_path where id = p_revision;
  perform public.ims_audit(p_actor, 'ims_revision_file_attached', jsonb_build_object('revisionId', p_revision, 'path', p_path));
end;
$$;

-- Records one approval gate. When every gate the document requires is
-- recorded, the revision becomes the approved current revision and the
-- previous approved revision is superseded, all in this transaction.
create or replace function public.ims_record_approval(p_actor uuid, p_revision uuid, p_gate text, p_comment text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rev record;
  v_doc record;
  v_missing text[];
begin
  select * into v_rev from public.ims_document_revisions where id = p_revision for update;
  if not found then
    raise exception 'Revision not found.' using errcode = 'P0002';
  end if;
  select * into v_doc from public.ims_documents where id = v_rev.document_id for update;
  if v_rev.status <> 'in_approval' then
    raise exception 'This revision is not awaiting approval.' using errcode = '22023';
  end if;
  if not (p_gate = any (v_doc.required_gates)) then
    raise exception 'This document does not use the % approval gate.', p_gate using errcode = '22023';
  end if;
  perform public.ims_require_level(v_doc.folder_id, p_actor, 3, 'approve revisions');
  if v_rev.author_profile_id = p_actor then
    raise exception 'The author cannot approve their own revision.' using errcode = '42501';
  end if;
  if v_rev.file_path is null then
    raise exception 'Attach the revision file before approval.' using errcode = '22023';
  end if;
  insert into public.ims_revision_approvals (revision_id, gate, approver_profile_id, comment)
  values (p_revision, p_gate, p_actor, coalesce(p_comment, ''));
  perform public.ims_audit(p_actor, 'ims_approval_recorded', jsonb_build_object(
    'documentId', v_doc.id, 'revisionId', p_revision, 'revision', v_rev.revision, 'gate', p_gate));

  select coalesce(array_agg(g), '{}') into v_missing
  from unnest(v_doc.required_gates) g
  where not exists (select 1 from public.ims_revision_approvals a where a.revision_id = p_revision and a.gate = g);

  if cardinality(v_missing) = 0 then
    update public.ims_document_revisions set status = 'superseded'
    where document_id = v_doc.id and status = 'approved';
    update public.ims_document_revisions
    set status = 'approved', approved_at = now(), effective_from = (now() at time zone 'Australia/Sydney')::date
    where id = p_revision;
    update public.ims_documents
    set status = 'approved', current_revision_id = p_revision,
        review_due = ((now() at time zone 'Australia/Sydney')::date + make_interval(months => v_doc.review_months))::date
    where id = v_doc.id;
    perform public.ims_audit(p_actor, 'ims_revision_approved', jsonb_build_object(
      'documentId', v_doc.id, 'docNumber', v_doc.doc_number, 'revisionId', p_revision, 'revision', v_rev.revision));
  end if;
  return jsonb_build_object('approved', cardinality(v_missing) = 0, 'missingGates', to_jsonb(v_missing));
end;
$$;

------------------------------------------------------------------------------
-- 7. Atomic training operations
------------------------------------------------------------------------------

create or replace function public.training_require_admin(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.training_profiles where id = p_actor and role = 'admin' and active) then
    raise exception 'Training administrator access is required.' using errcode = '42501';
  end if;
end;
$$;

-- Profile, assignment and audit row in one transaction. The auth invitation
-- itself happens before this call in the Edge Function.
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
  perform public.training_require_admin(p_actor);
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
  perform public.training_require_admin(p_actor);
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

-- Links a draft module version to the IMS revision that approves it.
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
  perform public.training_require_admin(p_actor);
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

-- Publication requires the linked IMS revision to be approved. Asset
-- completeness is checked by the Edge Function against private storage first.
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
  perform public.training_require_admin(p_actor);
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
  perform public.training_require_admin(p_actor);
  select a.id, a.learner_id, a.status into v_assignment from public.training_assignments a where a.id = p_assignment;
  if not found then
    raise exception 'Assignment not found.' using errcode = 'P0002';
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
  perform public.training_require_admin(p_actor);
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

------------------------------------------------------------------------------
-- 7b. Reference data and membership (admin only, audited)
------------------------------------------------------------------------------

create or replace function public.admin_set_group_member(p_actor uuid, p_group text, p_profile uuid, p_member boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.training_require_admin(p_actor);
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

create or replace function public.admin_save_position(p_actor uuid, p_position jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_position ->> 'id', '')::uuid;
begin
  perform public.training_require_admin(p_actor);
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
  perform public.training_require_admin(p_actor);
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
  perform public.training_require_admin(p_actor);
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
  perform public.training_require_admin(p_actor);
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
  perform public.training_require_admin(p_actor);
  delete from public.licences where id = p_licence returning employee_id, licence_type into v_row;
  if not found then raise exception 'Licence not found.' using errcode = 'P0002'; end if;
  perform public.ims_audit(p_actor, 'licence_deleted', jsonb_build_object('licenceId', p_licence, 'employeeId', v_row.employee_id, 'type', v_row.licence_type));
end;
$$;

------------------------------------------------------------------------------
-- 8. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['sites', 'positions', 'employees', 'licences', 'position_requirements', 'practical_verifications',
                           'ims_groups', 'ims_group_members', 'ims_folders', 'ims_folder_grants', 'ims_documents',
                           'ims_document_revisions', 'ims_revision_approvals', 'ims_document_links']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end;
$$;

grant select, insert, update on table
  public.sites, public.positions, public.employees, public.licences, public.position_requirements,
  public.practical_verifications, public.ims_groups, public.ims_group_members, public.ims_folders,
  public.ims_folder_grants, public.ims_documents, public.ims_document_revisions, public.ims_revision_approvals,
  public.ims_document_links
to service_role;
grant delete on table public.licences, public.position_requirements, public.ims_group_members, public.ims_document_links to service_role;
grant update (ims_revision_id) on table public.training_module_versions to service_role;
grant select on table public.training_audit_events to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'ims_level_rank(text)', 'ims_level_name(integer)', 'ims_folder_level(uuid, uuid)', 'ims_effective_grants(uuid)',
    'ims_folder_tree(uuid)', 'ims_require_level(uuid, uuid, integer, text)', 'ims_audit(uuid, text, jsonb, uuid, uuid)',
    'ims_create_folder(uuid, uuid, text, text)', 'ims_folder_owner_count(uuid)', 'ims_set_grant(uuid, uuid, text, uuid, text)',
    'ims_remove_grant(uuid, uuid)', 'ims_set_inherit(uuid, uuid, boolean)',
    'ims_create_document(uuid, uuid, text, text, text, text[], integer, uuid)',
    'ims_create_revision(uuid, uuid, text, text, text)', 'ims_attach_revision_file(uuid, uuid, text)',
    'ims_record_approval(uuid, uuid, text, text)', 'training_require_admin(uuid)',
    'training_assign(uuid, uuid, text, text, text, text, uuid, timestamptz, boolean)',
    'training_revoke(uuid, uuid, text)', 'training_link_ims_revision(uuid, uuid, uuid)',
    'training_publish_version(uuid, uuid)',
    'training_record_practical(uuid, uuid, uuid, text, date, uuid, text, text)', 'employee_save(uuid, jsonb)',
    'admin_set_group_member(uuid, text, uuid, boolean)', 'admin_save_position(uuid, jsonb)', 'admin_save_site(uuid, jsonb)',
    'admin_set_requirement(uuid, uuid, uuid, boolean, integer, boolean)', 'admin_save_licence(uuid, jsonb)',
    'admin_delete_licence(uuid, uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ims-documents', 'ims-documents', false, 52428800, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false;

comment on table public.employees is 'Employee register: source of truth for people, positions and sites. Server-only.';
comment on table public.ims_folder_grants is 'Folder access. Effective access = grants here plus ancestors while inheriting.';
comment on column public.training_module_versions.ims_revision_id is 'Approved IMS revision required before publication.';

commit;
