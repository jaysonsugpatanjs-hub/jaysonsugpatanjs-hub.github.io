begin;

create table public.training_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check (email = lower(email)),
  full_name text not null default '',
  external_id text,
  learner_type text not null default 'employee' check (learner_type in ('employee', 'applicant', 'contractor')),
  role text not null default 'learner' check (role in ('learner', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.training_modules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  slug text not null unique,
  title text not null,
  description text not null default '',
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  practical_required boolean not null default true,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.training_module_versions (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.training_modules(id) on delete cascade,
  revision text not null,
  content_version text not null,
  slide_count integer not null check (slide_count >= 2),
  pass_mark integer not null default 80 check (pass_mark between 1 and 100),
  storage_prefix text not null unique,
  learner_manifest jsonb not null,
  answer_key jsonb not null,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  unique (module_id, content_version)
);

alter table public.training_modules
  add constraint training_modules_current_version_fk
  foreign key (current_version_id)
  references public.training_module_versions(id)
  on delete set null;

create table public.training_assignments (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.training_profiles(id) on delete cascade,
  module_version_id uuid not null references public.training_module_versions(id) on delete restrict,
  status text not null default 'assigned' check (status in ('assigned', 'theory_passed', 'revoked')),
  assigned_by uuid references public.training_profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),
  expires_at timestamptz not null,
  theory_passed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  updated_at timestamptz not null default now(),
  check (expires_at > assigned_at)
);

create unique index training_one_open_assignment_per_version
  on public.training_assignments (learner_id, module_version_id)
  where status in ('assigned', 'theory_passed');
create index training_assignments_learner_idx on public.training_assignments (learner_id, assigned_at desc);

create table public.training_slide_attempts (
  id bigint generated always as identity primary key,
  assignment_id uuid not null references public.training_assignments(id) on delete cascade,
  slide_number integer not null check (slide_number > 0),
  selected_answer integer not null check (selected_answer >= 0),
  correct boolean not null,
  attempted_at timestamptz not null default now()
);

create index training_slide_attempts_assignment_idx
  on public.training_slide_attempts (assignment_id, slide_number, attempted_at);

create table public.training_assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.training_assignments(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  answers jsonb not null,
  correct_count integer not null check (correct_count >= 0),
  total_questions integer not null check (total_questions > 0),
  score integer not null check (score between 0 and 100),
  critical_passed boolean not null,
  passed boolean not null,
  missed_question_numbers integer[] not null default '{}',
  module_revision text not null,
  submitted_at timestamptz not null default now(),
  unique (assignment_id, attempt_number)
);

create index training_assessment_attempts_assignment_idx
  on public.training_assessment_attempts (assignment_id, submitted_at desc);

create table public.training_certificates (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references public.training_assessment_attempts(id) on delete restrict,
  certificate_number text not null unique,
  storage_path text not null unique,
  status text not null default 'issued' check (status in ('issued', 'void')),
  issued_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);

create table public.training_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  subject_user_id uuid references auth.users(id) on delete set null,
  assignment_id uuid references public.training_assignments(id) on delete set null,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index training_audit_events_subject_idx on public.training_audit_events (subject_user_id, created_at desc);
create index training_audit_events_assignment_idx on public.training_audit_events (assignment_id, created_at desc);

create or replace function public.training_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger training_profiles_updated_at
before update on public.training_profiles
for each row execute function public.training_set_updated_at();

create trigger training_modules_updated_at
before update on public.training_modules
for each row execute function public.training_set_updated_at();

create trigger training_assignments_updated_at
before update on public.training_assignments
for each row execute function public.training_set_updated_at();

create or replace function public.training_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.training_profiles (
    id,
    email,
    full_name,
    external_id,
    learner_type
  ) values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'external_id', ''),
    case
      when new.raw_user_meta_data ->> 'learner_type' in ('employee', 'applicant', 'contractor')
        then new.raw_user_meta_data ->> 'learner_type'
      else 'employee'
    end
  )
  on conflict (id) do update set
    email = excluded.email,
    updated_at = now();
  return new;
end;
$$;

create trigger on_auth_user_created_training_profile
after insert or update of email on auth.users
for each row execute function public.training_handle_new_user();

alter table public.training_profiles enable row level security;
alter table public.training_modules enable row level security;
alter table public.training_module_versions enable row level security;
alter table public.training_assignments enable row level security;
alter table public.training_slide_attempts enable row level security;
alter table public.training_assessment_attempts enable row level security;
alter table public.training_certificates enable row level security;
alter table public.training_audit_events enable row level security;

revoke all on table public.training_profiles from anon, authenticated;
revoke all on table public.training_modules from anon, authenticated;
revoke all on table public.training_module_versions from anon, authenticated;
revoke all on table public.training_assignments from anon, authenticated;
revoke all on table public.training_slide_attempts from anon, authenticated;
revoke all on table public.training_assessment_attempts from anon, authenticated;
revoke all on table public.training_certificates from anon, authenticated;
revoke all on table public.training_audit_events from anon, authenticated;
revoke all on sequence public.training_slide_attempts_id_seq from anon, authenticated;
revoke all on sequence public.training_audit_events_id_seq from anon, authenticated;
revoke execute on function public.training_set_updated_at() from public, anon, authenticated;
revoke execute on function public.training_handle_new_user() from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'training-content',
  'training-content',
  false,
  26214400,
  array['image/webp', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'font/ttf', 'application/x-font-ttf']
)
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('training-certificates', 'training-certificates', false, 5242880, array['application/pdf'])
on conflict (id) do update set public = false;

comment on table public.training_module_versions is 'Answer-bearing module content. Server-only; never grant browser access.';
comment on table public.training_assessment_attempts is 'Authoritative server-marked theory assessment record.';
comment on table public.training_certificates is 'Server-issued theory certificate record; practical authorisation is separate.';

commit;
