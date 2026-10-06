# Projects, timesheets and job costing (Panalo Accounts, Phase 4)

Projects are the jobs that hours, purchases and invoices are tagged to. Job
costing brings them together: budget by cost code, labour from approved
timesheets, other costs from approved bills, commitments from open purchase
orders, and revenue from approved invoices.

Nothing in this phase posts to the general ledger. Labour costs here are
**management figures**; wages reach the ledger through pay runs (Phase 5),
so nothing is counted twice. Bills and invoices were already in the ledger
(Phase 3); tagging their lines to a project only adds the job-costing view.

## Projects

- Numbered `JOB-1001`, `JOB-1002`… (changeable in Company settings, numbering).
- Customer (or none, for internal work), site, the customer's order or
  contract number, project manager, contract type (fixed price, schedule of
  rates, cost plus, internal), contract value excluding GST, start and finish.
- **Budget by cost code**: hours and dollars. The form shows the budgeted
  margin against the contract value as you type.
- Status: Tender → Active → On hold / Completed → Closed (or Cancelled). A
  project can't be closed while timesheets with hours on it are still
  waiting for approval. Closed projects take no new timesheet hours, but a
  late bill or final invoice can still be tagged to a completed or closed
  job (it belongs to that job's costs), and a reopened week keeps hours it
  already had on it. Cancelled projects take nothing.

## Cost codes and labour rates

- Cost codes (seeded, editable): labour codes (fabrication, welding, site
  installation, supervision, shutdown and maintenance), materials,
  consumables and gases, equipment hire, subcontractors, testing and
  inspection, travel, freight, other. Codes in use can be made inactive but
  not deleted.
- **Labour classes** (Welder, Pipe fitter, Rigger, Trades assistant,
  Supervisor, Apprentice) carry a **cost per hour** (wages plus on-costs:
  super, workers compensation, leave, payroll tax where it applies) and a
  **charge-out rate**. They start at $0: Panalo sets its own.
- Each person who records time is assigned a class. Job costing uses the
  class rate, so **nobody's individual pay appears on a project**. Only people
  who manage projects see the rates and each person's labour cost; job
  costing (also open to `reports.view`, such as directors and the
  accountant) shows labour totals by cost code.

## Timesheets

- One timesheet per person per week, Monday to Sunday.
- Each entry has a day, project (or none for workshop and overhead time), a
  labour cost code, start and finish times with a break, or just hours,
  the type of hours (ordinary, overtime ×1.5, overtime ×2, travel time) and
  notes. A finish before the start means the shift ran past midnight.
- Checks: dates inside the week, no more than 24 hours in a day, hours more
  than 0, start and finish together or not at all (and not the same time),
  **no two entries overlapping in time** (split a shift between projects
  instead), open projects only, no weeks more than one week ahead.
- Draft → Submitted → Approved, or Sent back with a reason. A person can
  recall their own week while it is waiting. Supervisors and project managers
  (`time.approve`) can enter a week for a crew member, and approve or send
  back others' weeks, **never their own, and never a week they entered and
  submitted for someone else**. `time.approve` covers everyone in the
  company, not just a crew; give it only to people who should approve
  anyone's time.
- **Approval freezes the cost** of each entry: hours × class rate × the
  overtime factor. A person needs a labour class before their week can be
  approved.
- An approved week is a time record the employer keeps (Fair Work Act
  record-keeping). **Every approved version is stored permanently** (who
  approved it, when, and each entry's day, project, times, hours and type);
  the database refuses to change or delete these. A correction reopens the
  week with a reason; the person is notified, everything is audited, and the
  corrected week becomes a new version when it is re-approved. The week's
  page lists every approved version. Once paid in a pay run (Phase 5), a week can't be reopened;
  corrections go in the next pay run.
- **Hours for payroll**: approved hours by person and type for any date
  range, with a CSV export (logged), for the payroll system until pay runs
  arrive in Phase 5.

Overtime types record what the person says they worked. Whether hours
attract overtime, penalties or allowances is an award question that Phase 5
(payroll) handles with versioned award rules.

## Tagging documents to projects

Quote, invoice, purchase order and bill lines can carry a project; purchase
order and bill lines also carry a cost code. "New invoice / purchase order /
bill for this project" on a project page fills the project in on every line.

## Job costing

For a project, as at any date, by cost code:

| Figure | Comes from |
| --- | --- |
| Budget hours and dollars | The project budget |
| Actual hours and labour | Approved timesheet entries, at their frozen cost |
| Other costs | Approved bills less supplier credits tagged to the project, excluding GST |
| Committed | Approved or issued purchase order lines not yet billed (by bills dated up to the report date), excluding GST |
| Remaining | Budget − actual − committed |
| Invoiced | Approved invoices less credit notes tagged to the project, excluding GST |

Plus:

- **Margin so far**: invoiced less cost to date, and the budgeted margin
  (contract value less budget).
- **Progress on cost**: cost to date as a share of the total budget (capped at
  100%), the revenue that progress has earned (contract value × progress), and
  **over / under billing**: invoiced less earned. Over-billed means invoicing
  is ahead of the work; under-billed means work is done that hasn't been
  invoiced.

**Job costing** in the menu lists every project with these headline figures and
a total, with a CSV export (logged) for people with `data.export`.

## Who can do what

| Action | Permission |
| --- | --- |
| Projects, budgets, cost codes, labour classes and rates, who is costed at which class | `projects.manage` |
| See projects and job costing (without individual labour costs) | `reports.view` |
| Enter and submit your own timesheet | `time.submit` (supervisors and project managers have it; give it to field staff in Users and roles) |
| Enter a crew member's week; approve or send back others' weeks; reopen approved weeks | `time.approve` |
| See approved hours for payroll | `time.approve`, `projects.manage` or `payroll.run` |

## Database changes (`20261010000000_projects_timesheets.sql`)

- Current structure: no projects or timesheets.
- Change: `cost_codes`, `labour_classes`, `labour_profiles`, `projects`,
  `project_budgets`, `timesheets`, `timesheet_entries`, `timesheet_versions`
  (append-only); project and cost code
  columns on quote, invoice, purchase order and bill lines; the timesheet
  workflow and job costing functions; permission `time.submit`; numbering
  kind `project`.
- Reason: Phase 4 of the brief.
- Affected modules: the document editors (project and cost code per line);
  `doc_calc_lines`, `doc_insert_lines` and `doc_recalc` carry the new tags;
  dashboard (active projects, timesheets to approve).
- Migration strategy: additive; existing document lines get no project.
