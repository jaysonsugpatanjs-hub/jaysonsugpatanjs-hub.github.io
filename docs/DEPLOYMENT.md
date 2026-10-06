# Deployment

All changes go through a pull request. CI must pass before merge.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| Build and publish GitHub Pages bundle | PR and push to `main` | Training checks, `npm run test:accounts` (syntax + unit tests), site build |
| Supabase database migrations | PR (tests); manual run with `confirm=APPLY` on `main` | Database tests and API tests (PostgREST + Deno) on every PR; applies migrations to the live project only when dispatched |
| Deploy Supabase training API | Push to `main` touching `supabase/functions/**` | Unit tests, `deno check`, deploys `training-api`, `admin-api`, `ims-api`, `finance-api` |

## Releasing a change with a migration

1. Merge the pull request.
2. Run **Supabase database migrations** with `confirm` = `APPLY` straight away,
   so the database matches the newly deployed functions.
3. Check the run's "Apply migrations" step succeeded.

## Before payroll goes live

- Move to Supabase Pro in Sydney with point-in-time recovery.
- Set up nightly off-system exports and a weekly restore test (Phase 9).
- Connect Panalo's own email sender in Supabase (Authentication › Emails ›
  SMTP) so invitations and notices reach people outside the Supabase team.
- Create a staging Supabase project with fictional data for testing.

## Secrets

Only in GitHub Actions secrets (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`)
and Supabase function secrets. `training/config.js` holds only the public
project URL and publishable key. See `.env.example` for the names.
