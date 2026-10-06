# Security

## Principles

- **Deny by default.** Every table has RLS on and no browser grants; the
  browser can only call Edge Functions. CI tests check this for each table.
- **Checked twice.** Permissions are checked in the Edge Function and again in
  the SQL function that does the write.
- **Two-step sign-in.** Anyone holding a permission marked `requires_mfa`
  (company settings, ledger, sales, purchases, banking, payroll, BAS, audit,
  exports, access management) needs an authenticator code for Panalo Accounts.
- **Separation of duties.** System administrators do not automatically get
  `payroll.sensitive` (pay rates, TFNs, bank and super details). Nobody can
  change their own roles or approve their own request.
- **Four-eyes on money movement.** New company bank accounts stay inactive
  until a second person with banking permission approves them. Supplier and
  employee bank changes will use the same engine (Phases 3 and 5).
- **Append-only audit.** Audit rows cannot be updated or deleted; settings
  changes record old and new values.
- **Private files.** Logos, HR records and (later) payslips and receipts live
  in private buckets and are opened through two- to ten-minute signed links.

## Roles

| Role | Highlights |
| --- | --- |
| Super admin | Company settings, users, every finance area except payroll details |
| Director / owner | Reports, approvals (banking, journals, pay runs), audit |
| Finance admin | Sales, purchases, banking, journals, BAS, reports |
| Payroll admin | Payroll details, pay runs, leave, timesheets, payroll reports |
| Project manager | Projects, job costing, timesheet approval |
| Supervisor | Team timesheets and leave, team competency |
| Accountant / auditor | Ledger read, adjusting journals, reports, audit log |

Positions still set defaults, and per-person allow/deny overrides (Portal ›
Admin › People) win over roles.

## Resetting someone's authenticator

If a privileged user loses their phone, an administrator removes the factor in
Supabase (Authentication › Users › the user › MFA factors). The user then sets
up a new one at their next Panalo Accounts sign-in.

## Reporting a problem

Treat any suspected exposure of TFNs, bank details or pay data as a possible
notifiable data breach: assess within 30 days and notify the OAIC and affected
people when required.
