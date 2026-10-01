-- Minimal stand-ins for the Supabase-managed schemas the migrations touch, so
-- the migrations can run against a plain Postgres in tests and CI.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  alter role service_role bypassrls; -- as on Supabase
end $$;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

-- Test-only stand-ins for the Supabase Auth admin API, used by the API tests
-- through PostgREST. Passwords are never stored: only which fields changed.
create table auth.admin_calls (
  id bigint generated always as identity primary key,
  user_id uuid,
  call text not null,
  fields text[] not null default '{}',
  at timestamptz not null default now()
);

create or replace function public.test_auth_create_user(p_email text, p_meta jsonb, p_call text)
returns uuid
language plpgsql
security definer
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from auth.users where lower(email) = lower(p_email)) then
    raise exception 'A user with this email address has already been registered';
  end if;
  insert into auth.users (email, raw_user_meta_data) values (lower(p_email), coalesce(p_meta, '{}')) returning id into v_id;
  insert into auth.admin_calls (user_id, call) values (v_id, p_call);
  return v_id;
end;
$$;

create or replace function public.test_auth_update_user(p_id uuid, p_fields text[])
returns boolean
language plpgsql
security definer
as $$
begin
  if not exists (select 1 from auth.users where id = p_id) then
    raise exception 'User not found';
  end if;
  insert into auth.admin_calls (user_id, call, fields) values (p_id, 'update', p_fields);
  return true;
end;
$$;

create or replace function public.test_auth_calls(p_id uuid)
returns table (call text, fields text[])
language sql
security definer
as $$
  select call, fields from auth.admin_calls where user_id = p_id order by id;
$$;
