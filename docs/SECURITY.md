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
  until a second person with banking permission approves them. Supplier bank
  changes use the same engine (`purchases.bank`, Phase 3), and so do employee
  bank changes (`employee_bank`, approved by `payroll.approve`; nobody approves
  a change to their own account). Only approved bills can be paid. Pay runs
  are approved by someone other than the preparer and anyone paid in the run.
- **Bank files.** A supplier payment batch is approved by someone other than
  the person who made it before its ABA file can be downloaded; supplier bank
  details are fixed in the batch and checked again on approval; bills in an
  open batch can't be paid any other way; every file download is logged; a
  batch whose file was downloaded can only be cancelled by someone else.
  Statement files are read in the browser and only their lines are stored.
- **Pay data.** TFNs and bank account numbers are masked in every API response
  except the logged bank payment list and bank file, and are never written to
  the audit log.
  Employees see only their own payslips and leave (`payroll.self`).
- **Append-only audit.** Audit rows cannot be updated or deleted; settings
  changes record old and new values.
- **Private files.** Logos, HR records and receipts live
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
