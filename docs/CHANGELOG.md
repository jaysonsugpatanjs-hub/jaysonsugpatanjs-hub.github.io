# Changelog

## Panalo Accounts Phase 1 — foundation (2026-10-07)

**Database** (`20261007000000_finance_foundation.sql`)

- Current structure: people, positions, permissions and audit tables served
  one implicit company.
- Change: added `organizations` and `organization_id` (default Panalo) on
  `training_profiles`, `employees`, `positions`, `sites`, `personnel_documents`,
  `onboarding_requests`; company settings, numbering and bank accounts; finance
  permission keys, roles and role assignments; approvals, notifications and
  documents; audit columns and an append-only trigger.
- Reason: Phase 1 of the brief (company setup, roles, permissions, approval
  engine, audit) and multi-company readiness.
- Affected modules: every permission check (roles now feed
  `app_permissions_for`; system admins no longer get `payroll.sensitive`).
- Migration strategy: additive only; existing rows get Panalo's organisation
  by default; no data removed.

**API**: new `finance-api` Edge Function with permission and MFA gate.

**App**: `/accounts/` with sign-in hand-off from the portal, two-step sign-in
set-up, dashboard, company setup wizard (8 steps), bank accounts with
second-person approval, users and roles, approvals inbox, notifications,
integrations status and audit log viewer. Later-phase menu items show which
phase delivers them.

**Tests**: database tests for validators, roles, MFA flag, settings, numbering,
bank approvals, append-only audit and browser lock-out; API tests for access,
MFA, permissions, settings, logo upload, approvals, masking, roles and audit;
unit tests for form validation.
