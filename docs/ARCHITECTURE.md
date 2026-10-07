# Panalo Accounts — architecture

Panalo Accounts is the finance and payroll part of the Panalo portal. It shares
the portal's Supabase project, sign-in, people register, permissions, HR files
and audit log. The full Phase 0 design (diagrams, legal requirements register,
schema plan) is the "Panalo Accounts — Phase 0 Architecture" document.

## Parts

| Part | Where | Notes |
| --- | --- | --- |
| Accounts web app | `accounts/` → `/accounts/` | Static ES modules, no build step; served by GitHub Pages |
| Portal | `training/` → `/training/` | Sign-in, onboarding, HR files, IMS, training; also the shared `auth.js` |
| Finance API | `supabase/functions/finance-api` | Edge Function: session → permissions → MFA → action. Modules: `index.ts` (foundation), `ledger.ts`, `sales.ts`, `purchases.ts`, `projects.ts`, `payroll.ts`, `banking.ts`, `tax.ts`, `docs.ts` (shared helpers); PDFs in `_shared/finance-pdf.ts` and `_shared/payslip-pdf.ts`, `_shared/bas-pdf.ts`; ABA bank files in `_shared/aba.ts`; statement files are read in the browser by `accounts/lib/bank-file.js` |
| Database | `supabase/migrations` | Postgres; every write through a security-definer function |
| Files | Storage buckets `finance-documents`, `hr-documents` | Private; short-lived signed links only |

## Request path

1. The browser sends the user's session token to `finance-api`.
2. The function loads the profile and its effective permissions
   (`app_permissions_for`: position defaults + roles + personal allow, minus personal deny).
3. Anyone holding a key marked `requires_mfa` must have an `aal2` session
   (password + authenticator); otherwise the API answers `403 mfa_required`.
4. The action's own permission is checked.
5. Writes call a SQL function that checks the permission again, applies the
   business rules and writes the audit row in the same transaction.

Sales and purchasing (Phase 3) are described in `SALES_PURCHASING.md`; projects,
timesheets and job costing (Phase 4) in `PROJECTS_TIMESHEETS.md`; payroll
(Phase 5) in `PAYROLL.md`; banking (Phase 6) in `BANKING.md`; BAS and TPAR (Phase 7) in `BAS.md`; the
ledger and its posting engine in `ACCOUNTING_ENGINE.md`.

## Phase 1 data model

- `organizations` — Panalo is `00000000-0000-4000-8000-000000000001`. People
  tables carry `organization_id` (default Panalo).
- `company_settings` — one row per organisation; ABN/ACN validated by
  `app_valid_abn` / `app_valid_acn`.
- `number_sequences` + `next_document_number()` — forward-only numbering.
- `company_bank_accounts` — `pending` until approved by a second person.
- `app_permissions` (+ `area`, `admin_default`, `requires_mfa`), `app_roles`,
  `app_role_permissions`, `profile_roles`.
- `approvals` + `approval_request` / `approval_decide` / `approval_cancel` —
  the reusable four-eyes engine.
- `notifications`, `documents`.
- `training_audit_events` — now with `entity_type`, `entity_id`, `old_value`,
  `new_value`; append-only by trigger.

## Why no build step (yet)

The brief prefers React, TypeScript, Vite and Tailwind. The development
environment used for Phase 1 cannot reach the npm registry, so a React app
could not be built or tested before release. Phase 1 therefore follows the
portal's tested no-build pattern. The screens are small modules
(`accounts/views/*.js`) that can be ported to React components when the
Phase 3 screens (invoices, bills) justify a build pipeline.
