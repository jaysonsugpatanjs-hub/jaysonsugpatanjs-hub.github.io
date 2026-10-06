# Changelog

## Panalo Accounts Phase 3 — sales and purchasing (2026-10-09)

**Database** (`20261009000000_sales_purchasing.sql`)

- Current structure: ledger only; no customers, suppliers or documents.
- Change: customers, suppliers, quotes, invoices and credit notes, purchase
  orders with goods receipts, bills and supplier credits, payments and their
  allocations, dated `compliance_rules`, ageing and statement reports,
  attachments for these records. Details in `SALES_PURCHASING.md`.
- Reason: Phase 3 of the brief.
- Affected modules: approvals gain `supplier_bank`; manual journal reversal
  now refuses journals that belong to a document (void the document instead);
  new permission `purchases.raise` for project managers.
- Migration strategy: additive; no existing rows change.

**API**: sales and purchasing actions in `finance-api`; PDFs for tax
invoices, adjustment notes, quotes, purchase orders and customer statements;
signed-URL attachments; approval lists mask bank account numbers except for
the approver and requester.

**App**: Customers, Quotes, Invoices (and credit notes), Payments received,
Suppliers, Purchase orders, Bills (and supplier credits), Supplier payments;
aged receivables and payables in Reports; dashboard figures. Links such as
`#/invoices/<id>` now survive the first page load, and wide tables scroll
inside their box on phones.

**Tests**: database tests with worked figures (part payments, overpayments,
credit notes, voids, ageing buckets at past dates, statements, 47% no-ABN
withholding and the $75 threshold, PO receipts, bank-change approval, AR and
AP control accounts agreeing with ageing); API tests covering permissions,
PDF contents, the quote-to-invoice flow, three-way match, attachments and
dashboard figures; browser unit tests for line rounding and allocation.

## Panalo Accounts Phase 2 — accounting core (2026-10-08)

**Database** (`20261008000000_ledger_core.sql`)

- Current structure: no ledger tables.
- Change: `financial_years`, `accounting_periods`, `tax_codes`, `accounts`,
  `journal_entries`, `journal_lines`; the posting engine and report functions.
- Reason: Phase 2 of the brief; every later module posts through this engine.
- Affected modules: none existing (new tables only); the dashboard reads
  ledger headlines for people with `reports.view`.
- Migration strategy: additive; seeds the brief's chart, GST codes and two
  financial years for Panalo.

**API**: ledger actions in `finance-api` (accounts, tax codes, journals,
periods, reports, logged exports).

**App**: Reports (profit and loss, balance sheet, trial balance, account
transactions with drill-down and CSV export), Journals (list, editor with live
GST and balance check, detail, post, reverse), Chart of accounts, Tax codes,
Periods; dashboard figures for bank, profit, GST and draft journals.

**Tests**: database tests with hand-calculated figures (GST exclusive and
inclusive, half-cent rounding, prior-year roll-over, balance sheet balancing,
reversals, period locks, immutability, unbalanced posting refused by the
database); API tests for permissions, drafts that fail to post, reversal
links, period rules, report consistency and audited exports.

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
