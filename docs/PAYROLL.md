# Payroll (Panalo Accounts, Phase 5)

Employees' pay, tax declarations, super and bank details; leave; pay runs that
work out PAYG withholding, study and training loan repayments, super and leave
accruals; payslips; and posting to the ledger. Single Touch Payroll (STP)
reporting to the ATO is Phase 8: until then keep lodging STP from the current
payroll product, and treat this as a parallel run until the two agree.

## The rules it uses (dated, with sources)

Statutory figures live in `compliance_rules` with the date they start and
their source. A change is a new row with its own start date; past pay runs
keep the rule that applied when they were paid. Payments dated before
1 July 2026 are refused, because no rules are recorded for them.

| Rule | Value | From | Source |
| --- | --- | --- | --- |
| PAYG withholding | Schedule 1 coefficients for scales 1, 2, 3, 5 and 6; no TFN 47% (resident) or 45% (foreign) | 1 July 2026 | ATO Schedule 1 (NAT 1004), published 17 June 2026 |
| Study and training loans | Schedule 8 coefficients (tax-free threshold claimed or foreign resident; not claimed) | 1 July 2026 | ATO Schedule 8 |
| Super guarantee | 12% | 1 July 2025 | ATO key super rates |
| Maximum contribution base | $270,830 a year (qualifying earnings) | 1 July 2026 | ATO, Paying super on payday |
| Super due | 7 business days after payday | 1 July 2026 | ATO, Paying super on payday |
| National minimum wage | $26.44 an hour ($1,004.90 a week) | 1 July 2026 | Fair Work Commission, Annual Wage Review 2026 |

The withholding calculation follows Schedule 1 exactly: weekly earnings are
whole dollars plus 99 cents (fortnightly halved first; monthly: add a cent to
amounts ending in 33 cents, then × 3 ÷ 13); `y = ax − b` is rounded to the
nearest dollar (50 cents up), then converted back (× 2 fortnightly; × 13 ÷ 3
rounded, monthly). The tests check it against the ATO's worked examples.

**Have the accountant check these values before the first live pay run.**

### Scales

| Situation | Scale |
| --- | --- |
| Resident, tax-free threshold claimed | 2 |
| Resident, threshold not claimed | 1 |
| Full / half Medicare levy exemption claimed | 5 / 6 |
| Foreign resident with a TFN | 3 |
| No TFN (or applied for more than 28 days before payday, counted from when the status was set) | 47% resident, 45% foreign |

Not automated yet: working holiday makers (Schedule 15), tax offset and
Medicare levy adjustment claims, and the special methods for back pay,
bonuses and termination payments (Schedules 5 and 7, ETPs). Working holiday
makers get no calculated withholding: the pay run can't be submitted until
their Schedule 15 amount is entered as extra withholding; for the others, bonuses are taxed as
ordinary pay in the period they're paid, so check those runs with the
accountant and enter any difference as an extra withholding.
Award rates aren't built in: the employee's rate is entered, and the system
warns if it is below the national minimum wage. The award minimum for
Panalo's trades is higher; check the award's pay guide each 1 July.

## Employees

An employee in the HR register (not a contractor) is set up in payroll with:

- employment (full-time, part-time, casual), paid by hourly rate or annual
  salary, pay frequency, ordinary hours, casual loading (default 25%), annual
  leave loading (default 17.5%), 4 or 5 weeks' annual leave, award and
  classification, wages account (5000 Direct Labour or 6000 Administration
  Wages), date of birth, start and finish dates;
- the tax declaration: TFN (check-digit validated), residency, tax-free
  threshold, study loan, Medicare variation, extra withholding;
- super fund (USI, or ABN for a self-managed fund), member number, salary
  sacrifice;
- a bank account, set only through approval (below).

"Fill in from onboarding" copies what the person gave in their accepted
onboarding forms (tax declaration, super choice, date of birth, bank details)
into the form for checking. Nothing is saved until you save it.

TFNs and bank account numbers are never sent to the browser in full, never
written to the audit log, and only people with "Payroll: pay, tax and bank
details" (`payroll.sensitive`) can see or change pay details. System
administrators don't get that permission automatically, and nobody can change
their own pay details.

## Bank details

A new or changed employee bank account is a request that someone with
"Approve pay runs" approves. Nobody can approve their own request, or a
change to their own account. Old and new account numbers are masked in the
audit log.

## Leave

- Annual leave accrues at 4/52 (or 5/52) of ordinary hours, personal/carer's
  leave at 2/52 (10 days a year): the National Employment Standards. Accrual
  counts ordinary hours worked and paid leave. Casuals accrue nothing.
- Long service leave depends on state law (NSW: 2 months after 10 years). It
  starts at no accrual; set the rate with the accountant, or keep it by
  adjustment.
- Employees request leave in **My pay**; someone with "Approve leave" approves
  it (never their own, nor leave they recorded for someone else). Approved leave is paid in the next pay run that covers
  its first day, with annual leave loading, and comes off the balance then.
- Opening balances and corrections are recorded with a reason.

## Pay runs

1. **Create** (`payroll.run`): frequency, period (7 days, 14 days or a
   calendar month) and payment date. Everyone active on that frequency is
   worked out at once. Overlapping pay runs are refused, and only one pay run
   per frequency can be open (draft or waiting for approval) at a time.
2. Hours come from **approved timesheets** not yet paid (including late
   approvals from earlier periods), by type: ordinary (casual loading added),
   overtime ×1.5 and ×2, travel. The pay run claims those hours and the leave
   when it is worked out, so nothing is paid twice. Salaried staff are paid
   their salary less any leave (unpaid leave comes off the salary). Approved leave, allowances, bonuses, deductions and
   reimbursements are added as lines.
3. **Tax** on taxable pay (after salary sacrifice), plus the study loan
   component and any extra withholding requested.
4. **Super guarantee** at 12% of qualifying earnings (ordinary-hours pay,
   paid leave, allowances and bonuses for ordinary work; not overtime), up to
   the yearly maximum contribution base; none for an under-18 working 30 hours
   a week or less. Salary sacrifice is paid to super too.
5. **Submit**: the claimed timesheet weeks are locked and the leave can't be
   cancelled while the run waits (sending it back unlocks them). Then
   **approve** by a second person with `payroll.approve`, who can't be the
   preparer, anyone who added or removed lines, or someone paid in the run.
   Approval:
   - posts the journal: Dr wages (by each employee's wages account), Dr 6100
     super expense, Dr reimbursements; Cr 2100 PAYG withholding, Cr 2200 super
     payable, Cr 2600 deductions, Cr 2400 payroll clearing (net pay);
   - marks the leave as taken and records leave accruals (the paid weeks stay
     locked);
   - fixes each payslip's content, including year to date and leave balances.
   An approved pay run can't be changed or deleted: corrections go in a later
   pay run.
6. **Pay**: download the bank file (ABA) or the bank payment list (CSV); both
   are logged (see `BANKING.md`). Make the payments, then record them, or match
   the bank statement line, which records them: Dr 2400, Cr bank. Pay super
   through the clearing house and record it: Dr 2200, Cr bank. The Super
   screen shows what is due and flags anything past its due date.

## Payslips

Payslips meet the Fair Work Regulations (reg 3.46): employer name and ABN,
employee name, pay period, payment date, gross and net pay, hours and rate for
each item (or the annual salary), each loading, allowance and bonus,
each deduction (with who it was paid to), super and the fund, plus year to
date and leave balances. They must be given within one working day of
payday: employees download them in **My pay**; payroll can download anyone's.

## Who can do what

| Action | Permission |
| --- | --- |
| See and change pay, tax, super details; request bank changes; adjust leave | `payroll.sensitive` |
| Prepare pay runs, add lines, submit | `payroll.run` |
| Approve pay runs and employee bank changes | `payroll.approve` (not the preparer, not someone paid in the run) |
| Record pay and super payments | `payroll.run` or `bank.manage` |
| Approve leave | `leave.approve` |
| My pay: own payslips and leave, request leave | `payroll.self` (give it to every employee in Users and roles, by position) |

All payroll keys except My pay need two-step sign-in.

## Database changes (`20261011000000_payroll.sql`)

- Current structure: an HR employee register; no pay records.
- Change: `pay_items`, `leave_types`, `payroll_employees`,
  `leave_transactions`, `leave_requests`, `pay_runs`, `pay_run_employees`,
  `pay_run_lines`; `timesheet_entries.pay_run_id`; compliance rules; the
  `payroll.self` permission; approval kind `employee_bank` (and
  `approval_decide` handles it); withholding, leave and pay run functions.
- Reason: Phase 5 of the brief.
- Affected modules: timesheets (paid hours lock the week), approvals,
  dashboard.
- Migration strategy: additive; no existing rows change.
