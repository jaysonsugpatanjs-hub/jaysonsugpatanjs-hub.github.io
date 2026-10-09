# Inventory C: Projects and Payroll (Panalo Accounts)

Source of truth: code as read on 2026-10-08. File references are relative to the repo root.
Front end: `accounts/views/{projects,timesheets,employees,payruns,leave,stp,approvals}.js`, `accounts/app.js`, `accounts/lib/{ui,validate,docs}.js`.
API: `supabase/functions/finance-api/{projects,payroll,stp,banking,index}.ts`, `_shared/payslip-pdf.ts`, `_shared/aba.ts`.
SQL: `20261010000000_projects_timesheets.sql`, `20261011000000_payroll.sql`, `20261014000000_stp.sql` (+ `approval_*` in `20261009…`, `bank_pay_run` in `20261012…`).

Conventions: "JS" = browser check, "API" = edge function (`httpError`), "SQL" = database function `raise exception`. SQL error codes map to HTTP: `42501`→403, `P0002`→404, `22023`→409. Unique-violation → "That record already exists."; check-violation → "One of the values is outside what is allowed."; bad format → "One of the values is not in a valid format.". Missing action permission (API) → "Your access doesn't include this area. Ask an administrator if you need it."; SQL `app_require` → `You need the "<permission name>" permission for this.` Flash messages appear in the page status line.

---

## 0. Permissions, roles and menu

### Permission keys (name / description as seeded)

| Key | Name | Description | MFA required |
|---|---|---|---|
| `projects.manage` | Projects and job costing | "Projects, budgets, cost codes and job costing." | No |
| `time.submit` | Enter my timesheets | "Record your own hours against projects and submit them for approval." | No |
| `time.approve` | Approve timesheets | "Approve timesheets for the people and projects you manage." (NB: code lets the holder approve anyone in the organisation, see SoD) | No |
| `leave.approve` | Approve leave | "Approve leave requests for the people you manage." (same caveat: org-wide) | No |
| `payroll.sensitive` | Payroll: pay, tax and bank details | "See and edit employees' pay rates, TFNs, bank and super details. Not given to system administrators automatically." | Yes |
| `payroll.run` | Prepare pay runs | "Prepare and calculate pay runs." | Yes |
| `payroll.approve` | Approve pay runs | "Approve and finalise pay runs." | Yes |
| `payroll.self` | My pay | "See your own payslips and leave balances, and request leave." | No |
| `reports.view` | Financial reports | "View financial reports and dashboards." | No |
| `data.export` | Export data | "Export reports and records. Every export is logged." | Yes |
| `bank.manage` | Banking | (records pay/super payments; Reconciliation matching) | Yes |

### Default role grants (relevant keys)

| Role | Relevant keys |
|---|---|
| Super admin | projects.manage, time.approve, reports.view, data.export, bank.manage (no payroll keys) |
| Director / owner | payroll.approve, bank.manage, reports.view, data.export, payroll.self |
| Finance admin | bank.manage, reports.view, data.export, payroll.self |
| Payroll admin | payroll.sensitive, payroll.run, leave.approve, time.approve, reports.view, data.export, payroll.self |
| Project manager | projects.manage, time.approve, reports.view, time.submit, payroll.self, purchases.raise |
| Supervisor | time.approve, leave.approve, time.submit, payroll.self |
| Accountant / auditor | reports.view, data.export (none of the above) |

`payroll.self` and `time.submit` for field staff must be granted in Users and roles (docs: "give it to every employee in Users and roles, by position").

### Menu (app.js)

| Group | Label | Route | Shown if user has any of | Count badge |
|---|---|---|---|---|
| (top) | My pay | `#/my-pay` | payroll.self | – |
| Projects | Projects | `#/projects` | projects.manage, reports.view | – |
| Projects | Job costing | `#/job-costing` | projects.manage, reports.view | – |
| Projects | Timesheets | `#/timesheets` | time.submit, time.approve, projects.manage, payroll.run | submitted timesheets not mine (time.approve) |
| Payroll | Employees | `#/employees` | payroll.sensitive, payroll.run, payroll.approve, leave.approve | – |
| Payroll | Pay runs | `#/pay-runs` | payroll.run, payroll.approve, payroll.sensitive | submitted runs (payroll.approve) |
| Payroll | Leave | `#/leave` | leave.approve, payroll.sensitive, payroll.run | submitted requests not mine (leave.approve) |
| Payroll | Super | `#/super` | payroll.run, payroll.approve, payroll.sensitive | – |
| Payroll | STP | `#/stp` | payroll.run, payroll.approve, payroll.sensitive | – |
| Payroll | Payroll reports | `#/payroll-reports` | payroll.run, payroll.approve, payroll.sensitive | – |

A route the user may not open redirects to `#/dashboard`. Dashboard cards from this area: "Pay runs to approve", "Super not yet paid" ("Due within 7 business days of each payday"), "Leave to approve", "Active projects" ("Active or on hold"), "Timesheets to approve" ("Submitted and waiting for you or another approver").

---

## 1. Projects

### 1.1 Projects list — `#/projects`
- Permission: projects.manage or reports.view (API `projects_list`, perm projects.manage/reports.view).
- Eyebrow "PROJECTS"; heading **"Projects"**; intro: "Jobs that time, purchases and invoices are tagged to. Open one to see its budget, costs to date and margin."
- Buttons (projects.manage only): **"Cost codes and rates"** → `#/projects/settings`; **"New project"** → `#/projects/new`.
- Filters: "Show" select — "Open (tender, active, on hold)" (default `open`), "All", then each status label; "Number or name" text; button **"Filter"**.
- Columns: Project (number + name, site underneath), Customer, Manager, Status, Contract, Cost to date, Invoiced, Complete.
- Empty: "No projects here yet."

### 1.2 Project statuses

| Key | Label (chip) | Meaning | UI transitions (button label → target) |
|---|---|---|---|
| `tender` | Tender | Quoting | "Won: make active" → active; "Lost / cancelled" → cancelled |
| `active` | Active (default for new) | Work in progress | "Put on hold" → on_hold; "Mark completed" → completed |
| `on_hold` | On hold | Paused | "Resume" → active; "Cancel" → cancelled |
| `completed` | Completed | Work done | "Close project" → closed; "Reopen" → active |
| `closed` | Closed | Finished; no new timesheet hours | "Reopen" → active |
| `cancelled` | Cancelled | Takes nothing (no hours, no document lines) | "Reopen as tender" → tender |

- Action `project_status` (projects.manage), SQL `project_set_status`; audited `project_status_changed`. SQL accepts any status-to-status change (transitions are a UI restriction only). Flash "Status updated."
- Panel note: "A project can't be closed while timesheets with hours on it are still waiting for approval." SQL error: "Timesheets with hours on this project are still waiting. Approve or correct them before closing it." (blocks when any timesheet with hours on the project is draft, submitted or rejected).
- New projects always start `active`; there is no UI path to create a project as Tender (only via Cancelled → "Reopen as tender"). Verification required if Tender is expected at creation.
- Timesheet project picker lists every project not closed/cancelled (includes tender and on hold). Invoice/bill/PO/quote lines accept any project except cancelled ("Line %: that project was cancelled or doesn't exist.").

### 1.3 New / edit project — `#/projects/new`, `#/projects/<id>/edit`
- Permission: projects.manage (API `project_save`, `projects_setup`, `project_people`).
- Heading **"New project"** or **"Edit <number>"**; intro: (new) "The project number is given when you save. " + "Budgets by cost code drive the remaining-budget and progress figures; leave codes you won't use blank."
- Number: `JOB-1001`, `JOB-1002`… (sequence `project`, prefix `JOB-`).

| Field | Required | Notes / validation |
|---|---|---|
| Project name * | Yes | maxlength 160. JS/API/SQL: "Give the project a name." (< 2 chars) |
| Customer | No | Options "None (internal job)" + active customers. SQL: "Unknown customer." |
| Site | No | maxlength 300; hint "Where the work is done" |
| Customer's order / contract number | No | maxlength 120 |
| Project manager | No | "—" + active portal users. SQL: "Unknown project manager." |
| Contract type | – | Fixed price / Schedule of rates / Cost plus / Internal (no customer) |
| Contract value ($, ex GST) | No | hint "The agreed price, or an estimate for schedule-of-rates work". API: "The contract value must be a positive amount." |
| Start / Finish | No | dates; DB check finish ≥ start (generic check message) |
| Budget table (per active cost code) | No | Columns Cost code, Category, Hours, Amount ($); footer "Total budget". Hours input placeholder "—" for non-labour codes. JS: "Budgets are positive numbers, with dollars and cents."; API: "Budget hours and amounts must be numbers."; SQL: "Budgets must be positive amounts.", "Unknown cost code in the budget." |
| Notes | No | maxlength 3000 |

- Live line under the budget: "Budgeted margin $X (Y%)" (red when budget > contract).
- Buttons: **"Save project"** (→ project page), **"Cancel"**. Audited `project_created` / `project_updated`. Hidden param `quoteId` is preserved; SQL check "That quote is not for this customer." No UI found that links a project to a quote — Verification required.
- `#/projects/new?customer=<id>` pre-selects the customer.

### 1.4 Project page (job costing for one project) — `#/projects/<id>`
- Permission: projects.manage or reports.view (`project_get`, `report_project_costing`).
- Eyebrow "PROJECTS · <number>"; heading = name + status chip; sub-line: customer link or "Internal job" · site · "managed by …" · dates.
- Button **"Edit"** (projects.manage).
- Cards: **Contract** (value; contract type · reference); **Cost to date** ("of $X budget · $Y committed"); **Invoiced** ("$X left to invoice"); **Margin so far** ("Z% of invoiced · budgeted W%", highlighted if negative); **Progress** (% complete; "Set a budget to measure progress" / "Over-billed $X" / "Under-billed $X").
- Panel "Budget and costs by cost code" with "As at" date + **"Update"**. Columns: Cost code, Budget hrs, Actual hrs, Budget, Labour, Other, Actual, Committed, Remaining, Used (bar + %; "No budget"). Uncoded costs appear as "—" / "Not coded". Footnote: "Labour: approved timesheet hours at the labour rate when approved. Other: approved bills tagged to this project, excluding GST. Committed: approved purchase orders not yet billed."
- Panel "Labour": Person, Approved hrs, Cost (projects.manage only), Waiting (unapproved hours). Empty "No hours recorded against this project yet." Link "Timesheets".
- Panel "Invoices" (number/"Draft", "Credit note", date, Draft chip, amount ex GST); empty "Nothing invoiced on this project yet."; button **"New invoice for this project"** (sales.manage and project has a customer) → `#/invoices/new?customer=…&project=…`.
- Panel "Bills and supplier credits": Bill, Supplier, Their reference, Date, Status ("Approved"/"Not approved"), On this project (ex GST); empty "No bills tagged to this project yet."; buttons **"Purchase order for this project"** (purchases.raise or purchases.manage), **"Bill for this project"** (purchases.manage).
- Panel "Status" (projects.manage): transition buttons (1.2). Panel "Notes" if any.

### 1.5 Cost codes and labour rates — `#/projects/settings`
- Permission: projects.manage (else redirected to `#/projects`).
- Heading **"Cost codes and labour rates"**; intro: "Labour rates are what an hour costs Panalo (wages plus on-costs such as super, workers compensation and leave) and what it is charged out at. Job costing uses the rate of each person's class, so nobody's individual pay is shown on projects." Button **"Projects"**.
- **Labour classes** table: Code (max 12, placeholder "NEW"), Name (placeholder "Add a class"), Cost per hour ($), Charge-out per hour ($), Active, button **"Save"** / **"Add"** (`labour_class_save`). Warning note: "Some classes have no cost rate yet, so their hours are costed at $0. Set a loaded cost per hour for each class you use." Errors: API "Codes are up to 12 capital letters, digits or dashes.", "Rates are dollars per hour."; SQL "Rates are dollars and cents per hour.", "Labour class not found.". Seeded classes (rates $0): WELDER Welder, FITTER Pipe fitter / fabricator, RIGGER Rigger / dogman, LAB Trades assistant / labourer, SUP Supervisor / leading hand, APP Apprentice. Audited.
- **Who is costed at which rate**: note "Everyone who can enter timesheets. A person's timesheets can't be approved until they have a class. A change applies to timesheets approved from then on; approved weeks keep the rate they were approved at." Columns Person (email), Labour class select ("Not set" + active classes). Change saves immediately (`labour_assign`); flash "Labour class updated."; SQL "Choose an active labour class.". Empty: 'Nobody can enter timesheets yet. Give people "Enter my timesheets" in Users and roles.'
- **Cost codes**: Code (max 10, placeholder "New"), Name (placeholder "Add a cost code"), Category (Labour, Materials, Equipment, Subcontract, Travel, Consumables, Freight, Other), Active, **"Save"/"Add"** (`cost_code_save`). Note: "Labour cost codes are the ones offered on timesheets. Codes in use can be made inactive but not deleted." Errors: "Cost codes are 1 to 10 letters, digits, dots or dashes.", "Give the cost code a name.", "Choose a category.", "Cost code not found.". Seeded: 100 Labour - fabrication, 110 Labour - welding, 120 Labour - site installation, 130 Labour - supervision, 140 Labour - shutdown and maintenance, 200 Materials - pipe, steel and fittings, 210 Welding consumables and gases, 300 Equipment and plant hire, 400 Subcontractors, 410 Testing and inspection (NDT), 500 Travel and accommodation, 600 Freight and cartage, 900 Other project costs.
- Flash on save: "Saved." No delete for classes, codes or projects in UI or API.

### 1.6 Job costing — `#/job-costing`
- Permission: projects.manage or reports.view.
- Heading **"Job costing"**; intro: "Every project's budget, costs, commitments, invoicing and margin as at today. Margin is invoiced less cost to date; over/under billing compares invoicing with progress on cost."
- Filter "Show": "Open projects" (default), "All", each status; button **"Show"**.
- Columns: Project (status chip if not active), Contract, Budget, Cost to date (red if over budget), Committed, Hours, Invoiced, Margin (with %), Complete, Over / (under) billed. Footer "Total". Empty "No projects."
- Footnote: "Labour is costed at each person's labour rate when their timesheet is approved. Other costs are approved bills tagged to the project, excluding GST. Committed is approved purchase orders not yet billed."
- **"Export CSV"** (data.export): file `job-costing-<date>.csv`, columns Project, Name, Status, Customer, Contract, Budget, Cost to date, Committed, Hours, Invoiced, Margin, Margin %, Complete %, Over/(under) billed. Audited `report_exported` (entity `job_costing`). Flash "Exported. Exports are recorded in the audit log." API error without permission: "Exporting needs the data export permission."

### 1.7 How job-costing figures flow in (SQL `report_project_costing`)

| Figure | Source |
|---|---|
| Labour hours / cost | Timesheet entries on the project, timesheet status `approved`, work date ≤ as-at; cost frozen at approval = hours × round(class cost rate × factor) (factor 1.5 for overtime ×1.5, 2.0 for ×2, else 1) |
| Other (materials, subcontract etc.) | Approved bills (credit notes negative) tagged to the project, ex GST, bill date ≤ as-at, grouped by line cost code |
| Committed | PO lines tagged to the project on POs with status approved / issued / partially_received, ordered ≤ as-at, ex GST, × unbilled fraction (quantity not yet on approved bills) |
| Revenue (Invoiced) | Approved invoices less credit notes tagged to the project, ex GST, dated ≤ as-at |
| Remaining | Budget − labour − other − committed |
| Margin so far | Invoiced − (labour + other); % of invoiced |
| Budgeted margin | Contract value − total budget |
| % complete (progress on cost) | min(1, cost to date ÷ total budget) |
| Over/(under) billing | Invoiced − (contract value × % complete) |

Nothing in Projects/Job costing posts to the ledger (labour cost is a management figure; wages reach the ledger only through pay runs).

---

## 2. Timesheets

Routes: `#/timesheets[?week=YYYY-MM-DD&person=<id>]` (a week), `#/timesheets/review`, `#/timesheets/hours`.
Tabs (shown only to time.approve / projects.manage / payroll.run): "My week", "Review", "Hours for payroll".

### 2.1 Statuses

| Key | Label | Meaning | Transitions |
|---|---|---|---|
| `draft` | Draft | Being entered (also after recall/reopen) | Save → draft; Submit → submitted |
| `submitted` | Waiting for approval | Waiting | Approve → approved; Send back → rejected; Recall (own) → draft; Reopen (approver) → draft |
| `approved` | Approved | Cost frozen; a version stored | Reopen for correction → draft (not if paid/locked) |
| `rejected` | Sent back | Returned with reason; editable | Save / Submit again |

### 2.2 A week — `#/timesheets`
- Permission: time.submit, time.approve, projects.manage or payroll.run (API `timesheet_week`). Seeing another person's week needs time.approve, projects.manage or payroll.run ("You can only see your own timesheets."); any person in the organisation.
- Eyebrow "PROJECTS · TIMESHEETS"; heading **"My timesheet"** (own) or the person's name, + status chip. Intro: "Record your hours for each day, then submit the week for approval." or "Entered by X · " / "Approved by X <time>" / "Decided by X <time>".
- Notes: "Sent back: <comment>" (rejected); "Reopened: <comment>" (draft with reason).
- Week bar: **‹** (Previous week), "Week starting" date (snaps to Monday), **›** (Next week); "Person" select (time.approve only: "Me" + people from `labour_people`, excluding self); "Week total".
- Per day (Mon–Sun) fieldset with day total (red if > 24 h); link **"+ Add hours for <Day>"** (copies project, code, times, break from the last entry with a project).
- Entry fields: **Project** ("No project (workshop / overhead)", open projects, or "Project now closed"), **Cost code** ("—" + active labour codes, "Labour - " prefix stripped), **Start**, **Finish** (time), **Break (min)** (default 30), **Hours** (auto, read-only when times given), **Type** (Ordinary, Overtime ×1.5, Overtime ×2, Travel time), **Notes** (max 300); "Cost $X" (projects.manage only, after approval); link **"Remove"**.
- Buttons and actions:

| Button | Shown when | Action / perm | Result / flash |
|---|---|---|---|
| Save | editable (draft/rejected/new) and own (time.submit or time.approve) or other person (time.approve) | `timesheet_save` submit=false | "Saved." Audited `timesheet_saved` |
| Submit for approval | same | `timesheet_save` submit=true | "Submitted for approval." Notifies time.approve holders ("Timesheet to approve: <name>"). Audited |
| Recall to change | submitted and own week | `timesheet_reopen` (no reason) | "Recalled. Make your changes and submit again." |
| Approve | submitted, not own, not submitted by me, time.approve | `timesheet_decide` approve | "Approved." Freezes cost, stores version, notifies person. No confirm dialog |
| Send back | same | `timesheet_decide` reject | prompt "Send this week back? Say what needs fixing:"; flash "Sent back." SQL "Say what needs fixing." (<3 chars) |
| Reopen for correction | approved, not own, time.approve, not payroll-locked | `timesheet_reopen` with reason | prompt "Reopen this approved week for correction? The costs are worked out again when it is re-approved. Reason:"; flash "Reopened." Clears frozen costs; notifies person |

- JS errors: "Check the highlighted hours." (an hours value not > 0 and ≤ 24), "Add your hours before submitting."
- API/SQL errors (`timesheet_save`): "Times are like 07:00 or 15:30.", "Add the hours for the week.", "A week can have up to 100 entries.", "Hours must be a number.", "A timesheet week starts on a Monday.", "Timesheets can't be entered more than a week ahead.", "This week has been approved. Ask your supervisor to reopen it to make a change.", "This week is waiting for approval. Recall it first to make a change.", "Entry %: check the date, times and hours.", "Entry %: the date must be in the week starting <DD Mon YYYY>.", "Entry %: enter both a start and a finish time, or neither.", "Entry %: the break must be between 0 and 600 minutes.", "Entry %: the start and finish are the same time.", "Entry %: hours must be more than 0 and no more than 24.", "Entry %: that project is closed or doesn't exist.", "Entry %: choose a labour cost code.", "Entry %: unknown type of hours.", "A day can't have more than 24 hours.", "Two entries overlap in time. Split the shift between projects instead of entering the same hours twice.", "Add your hours before submitting.", "Person not found."
- `timesheet_decide` errors: "Only a submitted timesheet can be approved or rejected.", "Someone else must approve your own timesheet.", "You entered and submitted this week, so someone else must approve it.", "Set <Name>'s labour class (Projects, Labour rates) before approving, so the hours can be costed."
- `timesheet_reopen` errors: "This timesheet is already open for changes.", "Someone else must reopen your own approved timesheet.", "These hours have been paid. Correct them in the next pay run instead.", "Give a reason for reopening it."
- Hours from times: (finish − start, +24 h if finish ≤ start i.e. past midnight) − break, rounded to 0.01.
- Panel "Approved versions": "Every version of this week that was approved is kept, including any later reopened and corrected." Each: "Version N · H h · approved by X <time>" with Day, Project, Code, Times, Hours, Type. Versions are append-only (DB trigger: "Approved timesheet versions can't be changed or deleted.").
- Panel "Recent weeks": last 8 weeks with status and hours.

### 2.3 Review — `#/timesheets/review`
- Permission: time.approve, projects.manage or payroll.run (`timesheets_review`) — lists all people in the organisation.
- Heading **"Review timesheets"**; intro: "Open a week to check it against the site diary, then approve it or send it back with a reason. You can't approve your own."
- Status tabs: "Waiting" (submitted, default), "Sent back", "Approved", "Not submitted" (draft).
- Columns: Person (link; "You" tag), Week of, Hours, Overtime, Projects (count), Submitted / Approved (by + time). Empty "Nothing here." Approval happens on the week page (no bulk approve).

### 2.4 Hours for payroll — `#/timesheets/hours`
- Permission: time.approve, projects.manage or payroll.run (`timesheet_hours`). Users with only time.submit can type the URL but the API refuses.
- Heading **"Approved hours"**; intro (stale): "Approved hours by person and type, ready for payroll. Pay runs arrive in Phase 5; until then export them for your payroll system."
- From / To (default the two full weeks before this week) + **"Show"**. Columns: Person, Ordinary, Overtime ×1.5, Overtime ×2, Travel time, Total. Empty "No approved hours in this range." API: "Choose a date range."
- **"Export CSV"** (no data.export check here): `approved-hours-<from>-to-<to>.csv` — Person, Email, Week starting, Date, Project, Project name, Cost code, Type, Start, Finish, Break (min), Hours, Notes. Audited `report_exported` (`timesheet_hours`). Flash "Exported. Exports are recorded in the audit log."

### 2.5 How approved timesheets feed pay runs and job costing
- Job costing: approved entries only, at frozen cost (class rate at approval).
- Pay runs (hourly employees): calculating a draft run claims every approved, not-yet-paid entry for the employee's linked portal profile dated ≤ period end (and ≥ payroll start date), including late approvals from earlier periods. Mapping: ordinary → ORD (casual-loaded rate), overtime_150 → OT150 (base × 1.5), overtime_200 → OT200 (base × 2), travel → TRAVEL (casual-loaded). One line per hour type per project ("Ordinary hours · JOB-1001").
- Warning if unapproved hours exist in the period: "Some timesheet hours in this period aren't approved yet and aren't included."
- Submitting a pay run sets `payroll_locked_at` on those weeks (can't be reopened); sending back unlocks unless an approved run paid part of the week; approval locks permanently.
- Employees with no portal account (`profile_id`) can't have timesheets, so hourly pay must be entered by hand. Verification required.

---

## 3. Employees

### 3.1 List — `#/employees`
- Permission: payroll.sensitive, payroll.run, payroll.approve or leave.approve (`payroll_employees`).
- Eyebrow "PAYROLL"; heading **"Employees"**; intro: "People in the HR register who are paid through payroll. Set up each person's pay, tax declaration, super fund and bank account before their first pay run. Contractors are paid through bills."
- Filters: "Name"; "Show": "Active and in payroll" (default) / "Everyone in the HR register"; **"Filter"**.
- Columns: Employee (link; number; HR status if not active), Position, Basis (Full-time/Part-time/Casual or "Not set up" chip; "Finished" chip if terminated), Paid (Weekly/Fortnightly/Monthly), **Rate** (payroll.sensitive only: "$X pa" or "$X/h"), Needs attention.
- "Needs attention" texts: "Pay details not set up", "No pay rate", "No TFN: 47% withheld", "TFN applied for", "No bank account", "No super fund", "Working holiday maker: withholding not automated".
- Empty: "Nobody here. Add people in the HR register on the portal first." (Employees are created in the portal HR register, not here; contractors are excluded.)

### 3.2 Employee page — `#/employees/<id>`
- Eyebrow "PAYROLL · EMPLOYEES"; heading name + chip (basis, or "Not set up yet"); sub-line number · position · "started <date>" · " · no portal account (can't see their own payslips)".
- Problems note (active HR staff) as in 3.1.
- Without payroll.sensitive: "Pay, tax, super and bank details are only shown to people with "Payroll: pay, tax and bank details"." (pay data not even sent to the browser).

#### Pay form (payroll.sensitive) — `payroll_employee_save`
Button **"Fill in from onboarding"** (`payroll_import_onboarding`, audited `payroll_onboarding_read`): reads latest *accepted* onboarding items tfn_declaration, super_choice, personal_details, bank_details. Note shown: "Filled in from their accepted onboarding forms (<found>). Check, then save. Bank details from onboarding go to approval separately, below." If none: "No accepted onboarding forms with tax, super, personal or bank details were found for this person." (warn). If default fund chosen: "They chose Panalo's default fund. If they have an existing fund, the ATO's stapled fund rules may apply: check before their first super payment." Nothing saves until the user saves.

| Section | Field (label) | Options / hint | Validation |
|---|---|---|---|
| Pay | Employment | Full-time / Part-time / Casual | |
| | Paid by | "Hourly rate (hours from timesheets)" / "Annual salary" | |
| | Pay frequency | Weekly / Fortnightly / Monthly (default company pay frequency) | |
| | Base hourly rate ($) | hint "Before casual loading. National minimum $26.44/h; the award minimum is usually higher." (value from compliance rule) | JS "Enter the base hourly rate." (hourly). API "The hourly rate must be a positive number." (max 10,000) |
| | Annual salary ($) | | JS "Enter the annual salary." (salary) |
| | Ordinary hours a week | default 38 | API "Ordinary hours must be a positive number." (≤60) |
| | Casual loading % | default 25 | ≤100 |
| | Annual leave loading % | default 17.5 | ≤100 |
| | Annual leave a year | "4 weeks" / "5 weeks (shift worker)" | |
| | Award or agreement | hint "For example: Manufacturing and Associated Industries and Occupations Award 2020" | max 200 |
| | Classification | | max 120 |
| | Wages account | expense / cost-of-sales accounts (default 5000 Direct Labour; 6000 Administration Wages available) | SQL "Choose an expense or cost of sales account for wages." |
| | Date of birth | hint "Under 18s working 30 hours a week or less don't get super guarantee" | |
| | Payroll start date | default HR start | |
| | Finish date | | DB check finish ≥ start |
| Tax declaration | TFN (status) | "Provided"; "Applied for (28 days, then 47%)"; "Exempt (under 18 or on a pension)"; "Not provided: withhold 47%" | SQL "Enter the TFN, or choose another TFN status." |
| | Tax file number | label varies: "TFN on file ••• ••• 123" / "TFN from onboarding …"; hint "9 digits" / "Leave blank to keep it; type a new one to replace it" / "Leave blank to save the onboarding TFN; type one to use it instead" | JS + SQL "That TFN isn't valid. Check the digits." (ATO check digit, 8 or 9 digits). API "No TFN was found in their accepted onboarding forms." |
| | Residency | "Australian resident for tax" / "Foreign resident" / "Working holiday maker" | |
| | Tax-free threshold | "Claimed from Panalo" / "Not claimed" | |
| | Study or training loan | "No" / "Yes (HELP, VSL, SFSS, SSL or TSL)" | |
| | Medicare levy | "No variation" / "Half exemption claimed" / "Full exemption claimed" | |
| | Extra tax each pay ($) | hint "Only if they asked for more tax to be taken" | |
| Super | Fund name | | |
| | Fund USI | hint "SMSF? Leave blank and enter its ABN" | |
| | SMSF ABN | | SQL "The super fund ABN isn't valid." |
| | Member number | | |
| | Salary sacrifice to super each pay ($) | | |
| | Notes | max 2000 | |
| | ☐ "Finished: no longer paid" | sets status `terminated` (termination) | |

- Button **"Set up in payroll"** (first time) / **"Save pay details"**. Flash "Pay details saved." Audited `payroll_employee_created`/`_updated` (TFN and bank number excluded; `tfnChanged` flag).
- SQL errors: "Employee not found.", "Someone else in payroll must change your own pay details.", "Contractors are paid through bills, not payroll."
- TFN shown only masked ("••• ••• 123"); never returned in full except in STP export.
- Termination: tick "Finished: no longer paid" (status terminated) and set Finish date; for STP also set "Reason they left". A terminated employee drops out of new pay runs; a final payment is entered as manual lines (kept even if no longer in the run, with warning). No ETP/termination calculation (docs: not automated).

#### STP details (payroll.sensitive, in payroll) — `payroll_employee_stp_save`
Heading "STP details". Fields: Family name (hint "As on their tax file number declaration", max 40), Given names (max 80), Income type (SAW · Salary and wages [default], CHP · Closely held payee, WHM · Working holiday maker, IAA · Inbound assignee, FEI · Foreign employment income, SWP · Seasonal worker programme, LAB · Labour hire, VOL · Voluntary agreement, OSP · Other specified payments, JPD · Joint petroleum development area), Home address, Suburb, State (State…, ACT, NSW, NT, QLD, SA, TAS, VIC, WA), Postcode, "Country (two letters, if needed)" (hint "Only for WHM, IAA and FEI"), "Reason they left (when they finish)" (Still employed; V · Voluntary (resigned, retired); I · Ill health; D · Deceased; R · Redundancy; F · Dismissal; C · Contract ended; T · Transfer). Button **"Save STP details"**; flash "STP details saved." Errors: API/SQL "Choose the state.", "A postcode is 4 digits.", "Check the income type, country (two letters) and cessation type.", "Set up their pay details first.", "Someone else in payroll must change your own pay details." Address audited only as "addressChanged". Home address can be pre-filled from onboarding personal details.

#### Bank account (in payroll; form needs payroll.sensitive) — `payroll_bank_request`
- Shows "<account name> · BSB 062-000 · •••123" and "Approved <date>", or "No bank account yet."; if pending: chip "Change waiting for approval" (form hidden).
- Fields: Account name, BSB (max 7), Account number (max 12; label "Account number (onboarding •••123)" with hint "Leave blank to use the account from onboarding").
- Note: 'Confirm new bank details with the employee in person or on a number you already have. Someone with "Approve pay runs" approves the change; nobody can approve their own.'
- Button **"Request approval"** (none on file) / **"Request a change"**. Flash "Sent for approval. Pay goes to the new account once someone else approves it."
- Errors: JS/SQL "A BSB is 6 digits, like 062-000.", "An account number is 5 to 10 digits."; SQL "Enter the account name.", "Set up the employee's pay details first."; API "No bank account was found in their accepted onboarding forms."
- Creates approval kind `employee_bank` (required permission payroll.approve), title "Bank details for <name>"; notifies payroll.approve holders "Approval needed: …"; one pending request per employee; audit values masked.
- **Approval** happens in Administration › Approvals (`#/approvals`): buttons **"Approve"** (prompt "Approve this change? Add a note for the record (for example, how you checked it):") / **"Reject"** (prompt "Reject this change? Give a reason; the requester will see it:"; SQL "Give a reason for rejecting it."), flash "Approved." / "Rejected."; requester can **"Cancel request"** ("Request cancelled."). SQL rules: "Someone else must approve a change you requested.", "Someone else must approve a change to your own bank details.", "This has already been decided." On approval the employee's bank fields are replaced; requester notified "Approved: …"/"Rejected: …".
- Gap: the Approvals card shows no BSB/account details for `employee_bank` (the `details()` renderer only handles company and supplier bank kinds), although the API returns them unmasked to the approver. Verification required.

#### Leave (in payroll)
- Cards per paid leave type with a balance (Annual and Personal always): "<n> h", "≈ n days" (hours ÷ (ordinary hours/5)).
- Adjust form (payroll.sensitive, `leave_adjust`): Type, Kind ("Opening balance" / "Adjustment"), "Hours (+/−)", Date, Reason (placeholder "For example: balance from the previous payroll system"), **"Record"**. Flash "Leave balance updated." SQL: "Enter the hours (negative to reduce the balance).", "Say why the balance is being adjusted.", "Choose a type of leave.", "Unknown adjustment." Audited `leave_adjusted`.
- "History" (details): date, type, kind (Accrued / Taken / Adjustment / Opening balance), hours, note.

#### Pay history (payroll.sensitive, payroll.run or payroll.approve)
Columns Pay run, Paid, Gross, Tax, Super, Net, link **"Payslip"** (PDF via `payslip_pdf`, audited `payslip_generated`).

---

## 4. Pay runs

### 4.1 Statuses

| Key | Label | Meaning | Allowed transitions (who) |
|---|---|---|---|
| `draft` | Draft | Calculated, editable | Recalculate / add & remove lines / Delete draft / Submit (payroll.run) |
| `submitted` | Waiting for approval | Locked for approval; timesheet weeks locked; leave can't be cancelled | Approve and post (payroll.approve, second person) → approved; Send back (payroll.approve or the preparer) → draft |
| `approved` | Approved, not yet paid | Posted to ledger, final; payslips available | Record net pay paid (payroll.run or bank.manage) → paid |
| `paid` | Paid | Net pay recorded | (super payment can still be recorded) |

Super payment is a separate flag (`super_paid_at`), recordable in approved or paid. Numbering `PR-00001…`.

### 4.2 List — `#/pay-runs`
- Permission: payroll.run, payroll.approve or payroll.sensitive.
- Heading **"Pay runs"**; intro: "Hours come from approved timesheets, leave from approved requests. Someone other than the preparer approves each pay run; approving posts it to the ledger and makes it final."
- **"New pay run"** (payroll.run).
- Columns: Pay run (number, frequency), Period, Payment, Status, People, Gross, Tax, Net, Super (chip "Paid <date>" or "Due <date>", red if overdue). Empty "No pay runs yet."

### 4.3 New pay run — `#/pay-runs/new` (payroll.run)
- Heading **"New pay run"**; intro: "Everyone on this pay frequency is included and worked out straight away. You can add allowances, bonuses and deductions before submitting it for approval."
- Fields: Frequency (Weekly/Fortnightly/Monthly; default company pay frequency), Period start, Period end (auto start+6 / start+13), Payment date. Defaults: weekly = last Mon–Sun, payment = following week on the company pay day; fortnightly = the two weeks ending last Sunday; monthly = this calendar month, paid on the last day.
- Note: "Super must reach each fund within 7 business days of the payment date (Payday Super)."
- Buttons **"Create and calculate"**, **"Cancel"**. Audited `pay_run_created`.
- Errors: API/SQL "Choose how often this pay run pays.", "Choose the pay period and payment date.", "A weekly pay period must be 7 days long." / "A fortnightly pay period must be 14 days long." / "A monthly pay period must be a calendar month long.", "The payment date can't be before the period starts.", "A <frequency> pay run already covers part of this period.", "Finish (approve or delete) the open <frequency> pay run first.", "No PAYG withholding rules are recorded for payments on <date>. An administrator must add the ATO schedule first." (payment dates before 1 July 2026), "No super guarantee rate is recorded for <date>."

### 4.4 Calculation (SQL `pay_run_calculate`, run on create, recalc, line add/remove, submit)
- Included: payroll employees active, on the run's frequency, with start ≤ period end and finish ≥ period start; plus anyone with manual lines.
- Rate: hourly rate, or salary ÷ 52 ÷ ordinary hours; casual loading added to ordinary-hours items.
- Hourly: approved timesheet hours (2.5). Salary: SALARY line = salary ÷ periods (52/26/12) less paid leave lines and unpaid leave hours × rate.
- Leave: approved requests starting ≤ period end, not yet claimed → AL/PL/LSL line at base rate (+ "Leave loading 17.5%" line for annual leave); COMPASS uses PL item; UNPAID has no line (reduces salary).
- Tax: taxable earnings less salary sacrifice → scale (4.8) → Schedule 1 formula + Schedule 8 study loan + extra withholding.
- Super guarantee: SG rate × qualifying earnings, capped by maximum contribution base less QE already paid this FY; 0 for under-18s working ≤ 30 h/week.
- Net = gross − PAYG − salary sacrifice − deductions + reimbursements.
- Warnings (shown in red under the employee): "No pay rate is set."; "The base rate <x> is below the national minimum wage (<y> an hour). Check the award rate."; "Working holiday makers are taxed under Schedule 15, which isn't calculated here. Work out the amount with the accountant and enter it as their extra withholding before submitting."; "No bank account on file."; "No super fund on file. Request the stapled fund from the ATO, or use the default fund."; "No longer paid on this pay run's frequency or dates: only the manual lines are paid."; "<Leave type> balance is less than the <n> hours being taken."; "Some timesheet hours in this period aren't approved yet and aren't included."; "Deductions are more than the pay. Net pay can't be negative."

### 4.5 Pay run page — `#/pay-runs/<id>`
- Eyebrow "PAYROLL · PAY RUN"; heading number + status; sub-line "<frequency> · <start> to <end> · paid <date> · prepared by X · approved by Y <time>".
- Cards: **Gross**; **Tax withheld** ("Owed to the ATO, reported on the BAS"); **Net pay** ("Paid <date>" / "To pay employees"); **Super** ("Paid <date>" / "Due by <date>", highlighted when overdue).
- Note: "<n> thing(s) to check below."
- Table: Employee (expand ▸/▾; tax scale label; "· study loan"; warnings), Hours, Gross, Tax, Deductions (salary sacrifice + deductions), Net, Super (SG + salary sacrifice), **"Payslip"** (approved/paid).
- Expanded lines: Item (description; pay item name; "· added by hand"), Hours, Rate, Amount (deductions in brackets), **"Remove"** (manual lines, draft). Summary: "Taxable $X · tax $Y (incl. $Z study loan) · salary sacrifice $S · super guarantee $G on $Q". Empty "No earnings this period."
- Add-line form (draft, payroll.run): "Add" (active pay items except Salary, "Name (kind)"), "Description on the payslip", "Hours", "Rate", "or Amount", **"Add"** → `pay_run_line_add`; flash "Added and recalculated." Errors: "Hours, rate and amount must be numbers.", "Lines can only be added to a draft pay run.", "Choose a pay item.", "Enter an amount, or hours and a rate.", "Describe the line; it appears on the payslip.", "That employee isn't paid in this pay run." Remove: "Only manual lines on a draft pay run can be removed." Both audited and record the editor in `edited_by`.
- Hint (draft): "Worked out <time>. Recalculate after approving more timesheets or leave."

| Button | Shown when | Action / perm | Confirm / prompt | Flash / consequence |
|---|---|---|---|---|
| Recalculate | draft, payroll.run | `pay_run_recalculate` | – | "Recalculated." Error "Only a draft pay run can be recalculated." |
| Submit for approval | draft, payroll.run | `pay_run_submit` | – | 'Submitted. Someone with "Approve pay runs" approves it next.' Recalculates, drops people with nothing to pay, locks timesheet weeks, sets submitter as preparer, notifies payroll.approve holders ("Pay run to approve: PR-…"), audited |
| Approve and post | submitted, payroll.approve, not preparer, not paid in run | `pay_run_approve` | confirm "Approve <number>? It posts to the ledger, marks the timesheet hours and leave as paid, and can't be changed afterwards. Corrections go in a later pay run." | "Approved and posted. Pay the net amounts and the super, then record both here." Posts journal (4.7), leave taken + accruals, payslip snapshots, notifies preparer, audited |
| (hint) | submitted, user has payroll.approve but blocked | – | – | "You prepared this pay run or are paid in it, so someone else must approve it." |
| Send back | submitted, payroll.approve or preparer | `pay_run_return` | prompt "Send this pay run back to draft? Say what needs changing:" | "Sent back to draft." SQL "Say what needs changing." Unlocks weeks; notifies preparer |
| Bank file (ABA) | approved/paid, payroll.sensitive | `pay_run_aba` | – | warn flash "Downloaded <file>: <n> payment(s), $X. Upload it in your bank's internet banking, then record the net pay as paid. It holds bank details: delete it after uploading. The download is recorded in the audit log." Audited `pay_run_aba_downloaded` |
| Bank payment list (CSV) | approved/paid, payroll.sensitive | `pay_run_bank_list` | – | `net-pay-<number>.csv` (Name, Employee no., Account name, BSB, Account number, Amount, Reference "PAY <number>"); warn flash "Downloaded. It contains full bank details: delete it once the payments are made. The download is recorded in the audit log." Audited `pay_run_bank_list_exported` |
| Delete draft | draft, payroll.run | `pay_run_delete` | confirm "Delete this draft pay run? Nothing has been paid or posted." | returns to list; releases claimed hours/leave; audited. SQL "Only a draft pay run can be deleted. Approved pay runs are final." |

- Submit errors: "Only a draft pay run can be submitted.", "Nobody is being paid in this pay run.", "Someone's net pay is negative. Fix their deductions first.", "A working holiday maker has no tax withheld. Enter their Schedule 15 amount as extra withholding first."
- Approve errors: "Only a submitted pay run can be approved.", "Someone other than the people who prepared it must approve the pay run.", "You're paid in this pay run, so someone else must approve it." Send back: "Only a submitted pay run can be sent back."
- ABA errors: "The bank file is available once the pay run is approved.", "More than one bank account is set up for bank files: mark the one for wages as the payroll account.", "No company bank account is set up for bank files yet (Banking > Bank accounts).", "No approved bank account for <names>. Pay them separately or approve their bank details first.", "Some net pays aren't in the file. Check the pay run.", plus file-format errors e.g. "Bank file: account number <n> must be 5 to 9 digits." (employee accounts may be 10 digits, which the ABA builder rejects). ABA uses transaction code 53, description "WAGES", file `<number>.aba`. Bank list error "Approve the pay run first."
- Ledger line: "Ledger: <journal> · net pay <journal> · super <journal>" (links to `#/journals/<id>`).

#### Record payments panel (approved run, payroll.run or bank.manage)
Heading "Record payments"; text "Record each payment after it has left the bank, or match the bank statement line in Reconciliation, which records it for you."
- "Net pay from" (bank accounts) + "Date" (default payment date) + **"Net pay $X paid"** → `pay_run_record_payment` → status paid; journal Dr 2400 / Cr bank; audited `pay_run_paid`. Errors "Only an approved, unpaid pay run can be marked as paid.", "Choose the bank account the pay came from."
- "Super from" + "Date" (default today) + **"Super $X paid"** → `pay_run_record_super`; journal Dr super payable / Cr bank; audited `super_paid` (with due date). Errors "Super for this pay run is already recorded, or the run isn't approved.", "There is no super to pay in this pay run.", "Choose the bank account the super came from."
- Flash "Recorded." Alternative: Banking › Reconciliation statement line → pay run "net pay"/"super" button (`bank_pay_run`, bank.manage): "Pay runs are money out.", "Choose net pay or super." Bank.manage-only users can't open the Pay runs screens (menu and API need payroll keys) and must use Reconciliation.

### 4.6 Payslips
- PDF (A4) generated on demand from the snapshot fixed at approval; available only for approved/paid runs ("Payslips are available once the pay run is approved."; "Payslip not found.").
- Content (Fair Work reg 3.46): employer trading/legal name, ABN, address, phone/email; "PAYSLIP"; employee name, number, basis, annual salary (salaried), award – classification; Pay period, Payment date, Pay run; "EARNINGS AND ALLOWANCES" (hours, rate, amount), "Gross pay"; "DEDUCTIONS": "PAYG tax withheld (incl. $X study and training loan)", "Salary sacrifice to super - paid to <fund>", deductions ("Paid to <payee>"), reimbursements "(reimbursement, not taxed)"; "NET PAY"; "Paid into account ending <3 digits>"; "SUPERANNUATION": "Super guarantee (employer): …", "Fund: … (USI …) Member no. …"; "YEAR TO DATE (this financial year)"; "LEAVE BALANCES (hours, end of period)"; footer "<legal name> - ABN … - Payslip issued for pay run <number>. Keep it for your records."
- Download points: pay run page "Payslip", employee Pay history "Payslip" (file `Payslip-<Name>-<date>.pdf`, audited), My pay "Download" (`my_payslip`, file `Payslip-<date>.pdf`, not audited).
- Email of payslips: not implemented (Integrations page notes outbound mail not yet connected). Verification required.

### 4.7 Journals posted

**Pay run approval** (`pay_run_approve`, source `pay_run`, dated payment date, memo "Pay run <number> (<start> to <end>)", no GST):

| Dr/Cr | Account | Amount | Line description |
|---|---|---|---|
| Dr | Each employee's wages account (default 5000 Direct Labour; e.g. 6000 Administration Wages) | Earnings + allowances (gross, incl. salary-sacrificed amount) | "Wages <number>" |
| Dr | Reimbursement pay item's account (REIMB → 7900 Miscellaneous Expenses) | Reimbursements | "Reimbursements <number>" |
| Dr | 6100 Employer Superannuation | Super guarantee | "Super guarantee <number>" |
| Cr | First active `payg` account (2100 PAYG Withholding Payable) | PAYG + study loan + extra withholding | "PAYG withheld <number>" |
| Cr | First active `super` account (2200 Superannuation Payable) | SG + salary sacrifice | "Super payable <number>" |
| Cr | 2600 Employee Deductions Payable | Deductions | "Deductions <number>" |
| Cr | 2400 Payroll Clearing | Net pay | "Net pay <number>" |

**Net pay recorded** (`pay_run_payment`): Dr 2400 Payroll Clearing / Cr chosen bank — "Net pay <number>".
**Super recorded** (`super_payment`): Dr 2200 Superannuation Payable / Cr chosen bank — "Super <number>".
PAYG (2100) is cleared through BAS; there is no payroll screen to pay out 2600 deductions (Verification required: how union fees etc. are remitted).

### 4.8 Statutory figures (table `compliance_rules`, dated; all `approved_by` = "Seeded; confirm with accountant")

| rule_name | Value | Effective from | Source recorded |
|---|---|---|---|
| `payg_schedule1` | Coefficients for scales 1, 2, 3, 5, 6; no-TFN "4": resident 0.47, foreign 0.45 | 2026-07-01 | "ATO, Schedule 1 - Statement of formulas for calculating amounts to be withheld (NAT 1004), payments from 1 July 2026." (docs: published 17 June 2026) |
| `stsl_schedule8` | Study/training loan coefficients (threshold_or_foreign; no_threshold) | 2026-07-01 | "ATO, Schedule 8 - Statement of formulas for calculating study and training support loans components, payments from 1 July 2026." |
| `super_guarantee_rate` | 0.12 | 2025-07-01 | "ATO, Key super rates and thresholds - Super guarantee (12% from 1 July 2025)." |
| `super_max_contribution_base` | 270830 | 2026-07-01 | "ATO, Paying super on payday - Maximum contribution base, $270,830 a year for 2026-27, applied to qualifying earnings paid in the financial year." |
| `super_payday_due_business_days` | 7 | 2026-07-01 | "ATO, Paying super on payday: contributions must be received by the fund within 7 business days after payday (20 for a new employee or new fund)." |
| `national_minimum_wage_hourly` | 26.44 | 2026-07-01 | "Fair Work Commission, Annual Wage Review 2026: national minimum wage $1,004.90 a week or $26.44 an hour from 1 July 2026. Award minimums are higher and set by the award." |

- Rules are looked up by the pay run's payment date. No UI to view or edit compliance rules (Verification required).
- The due date shown on screens is hard-coded payment date + 7 business days (Mon–Fri, ignores public holidays); the 20-business-day rule for new employees/new funds is not applied. Only the super-paid audit reads the compliance value.
- Not hard-coded in rules but in code: casual loading default 25%, leave loading 17.5%, annual leave 4/52 (5/52), personal leave 2/52 (0.0384615), TFN-applied grace 28 days, under-18 ≤ 30 h SG exemption.

Tax scale (shown in pay run): "Scale 1 (no tax-free threshold)", "Scale 2 (tax-free threshold)", "Scale 3 (foreign resident)", "Scale 5 (full Medicare exemption)", "Scale 6 (half Medicare exemption)", "No TFN: 47%", "No TFN, foreign: 45%". Selection: not provided, or applied > 28 days → 4r/4f; foreign → 3; no threshold → 1; full Medicare → 5; half → 6; else 2. Working holiday makers: no calculated tax.

### 4.9 Seeded pay items (no UI to add/edit; Verification required)

| Code | Name | Kind | Taxable | Super QE | Ordinary hrs | Multiplier | STP default |
|---|---|---|---|---|---|---|---|
| ORD | Ordinary hours | earning | Y | Y | Y | 1.0 | gross |
| OT150 | Overtime at 150% | earning | Y | N | N | 1.5 | overtime |
| OT200 | Overtime at 200% | earning | Y | N | N | 2.0 | overtime |
| TRAVEL | Travel time | earning | Y | Y | Y | 1.0 | gross |
| SALARY | Salary | earning | Y | Y | Y | 1.0 | gross |
| AL | Annual leave | earning | Y | Y | Y | 1.0 | paid leave O |
| LL | Annual leave loading | earning | Y | Y | N | 1.0 | paid leave O |
| PL | Personal / carer's leave | earning | Y | Y | Y | 1.0 | paid leave O |
| LSL | Long service leave | earning | Y | Y | Y | 1.0 | paid leave O |
| PH | Public holiday (not worked) | earning | Y | Y | Y | 1.0 | gross |
| BONUS | Bonus | earning | Y | Y | N | 1.0 | bonus |
| TOOL | Tool allowance | allowance | Y | Y | N | 1.0 | allowance TD |
| MEAL | Overtime meal allowance | allowance | Y | N | N | 1.0 | allowance MD |
| REIMB | Expense reimbursement | reimbursement | N | N | N | 1.0 (acct 7900) | not reported |
| UNION | Union fees | deduction | N | N | N | – | deduction F |
| DEDUCT | Other deduction | deduction | N | N | N | – | not reported |

Public holidays are not generated automatically (add a PH line by hand). Verification required.

---

## 5. Leave

### 5.1 Leave types (seeded; no UI to edit)

| Code | Name | Paid | Accrual per ordinary hour | Pay item | Note |
|---|---|---|---|---|---|
| ANNUAL | Annual leave | Y | 0.0769231 (uses employee's 4 or 5 weeks ÷ 52) | AL (+LL) | "NES: 4 weeks a year (5 for shift workers), accruing progressively: 4 / 52 of ordinary hours." |
| PERSONAL | Personal / carer's leave | Y | 0.0384615 | PL | "NES: 10 days a year, accruing progressively: 2 / 52 of ordinary hours." |
| LONGSERV | Long service leave | Y | 0 | LSL | "Set by state law (NSW: 2 months after 10 years). Set the accrual rate with your accountant; leave at 0 to track balances by adjustment." |
| COMPASS | Compassionate leave | Y | 0 | PL | "NES: 2 days per occasion; no balance accrues." |
| UNPAID | Unpaid leave | N | 0 | – | "Not paid; recorded for service and leave records." |

Accruals are posted at pay-run approval for non-casual employees on ordinary hours paid (ORD, TRAVEL, SALARY, AL, PL, LSL, PH), dated period end ("Accrued in <number>"). Leave taken is deducted at approval ("Taken, paid in <number>"). Balance = sum of transactions.

### 5.2 Request statuses

| Key | Label | Meaning / transitions |
|---|---|---|
| `submitted` | Waiting | → approved / rejected (leave.approve, not own); → cancelled (employee or leave.approve) |
| `approved` | Approved | Claimed by the next pay run whose period end ≥ first day; → cancelled (blocked once the run is submitted) |
| `rejected` | Declined | final |
| `cancelled` | Cancelled | final |
| `paid` | Taken and paid | set at pay-run approval |

### 5.3 Leave screen — `#/leave`
- Permission: leave.approve, payroll.sensitive or payroll.run (`leave_list`).
- Heading **"Leave"**; intro: "Approved leave is paid in the next pay run and taken off the balance then. You can't approve your own leave."
- Tabs: Waiting, Approved, Declined, Cancelled, Taken and paid.
- Columns: Employee (link; "You"; reason), Leave, Dates, Hours, then (Waiting) "Balance now" (red if short for Annual/Personal/Long service) + **"Approve"** / **"Decline"** (leave.approve, not mine); other tabs "Decided" (by, time, comment). Empty "Nothing here."
- Approve: no confirm; flash "Approved." Decline: prompt "Decline this leave? Tell the employee why:"; flash "Declined." Employee notified ("Leave approved: …" / "Leave declined: …", link My pay).
- **"Record leave for someone"** (leave.approve): note "For leave arranged by phone or on paper. It still needs approval by someone other than the employee." Fields Employee (active, in payroll), Type, Hours (hint "A full day is usually 7.6 hours"), First day, Last day, Note (max 500). Button **"Record request"**; flash "Recorded. It's in the waiting list for approval." The recorder cannot then approve it (buttons still show; server refuses).
- SQL errors (`leave_request_save`): "You're not set up in payroll yet.", "Employee not found.", "Choose a type of leave.", "Choose the first and last day of leave.", "A leave request can cover at most a year.", "Enter the hours of leave.", "Casual employees don't get paid leave of this type." (`leave_request_decide`): "Leave request not found.", "This request can't be cancelled now.", "This leave is in a pay run waiting for approval. Ask payroll to send the pay run back first.", "Only a waiting request can be approved or declined.", "Someone else must approve your own leave.", "You recorded this leave, so someone else must approve it.", "Give a reason for declining it.", "Unknown decision."; API "Choose a decision."
- New requests notify leave.approve holders: "Leave to approve: <name>".

---

## 6. Super — `#/super`
- Permission: payroll.run, payroll.approve or payroll.sensitive.
- Heading **"Super"**; intro: "From 1 July 2026 super guarantee is worked out on qualifying earnings each pay and must reach the fund within 7 business days of payday (Payday Super). Rate 12%; maximum contribution base $270,830.00 a year." (rate and base from compliance rules for today).
- Card **"Not yet paid"**: total unpaid super; text "Some is overdue: late super attracts the super guarantee charge." / "Next due <date>" / "All recorded as paid".
- Table (approved/paid runs with super > 0): Pay run, Payday, Due by, Super, Status ("Paid <date>", "Overdue", "Due"). Empty "No super yet."
- Footnote: "The due date counts weekdays only; if a public holiday falls in between, the real due date is a day later. Contributions are paid through your clearing house; record each payment on its pay run." (last clause for payroll.run).
- Read-only: payment is recorded on the pay run page (or Reconciliation). No per-fund breakdown, no clearing-house file (Verification required).

---

## 7. Payroll reports — `#/payroll-reports`
- Permission: payroll.run, payroll.approve or payroll.sensitive (`payroll_summary`).
- Heading **"Payroll summary"**; intro (stale): "Approved pay by employee for a date range (by payment date). Single Touch Payroll reporting to the ATO arrives in Phase 8; until then, keep lodging STP from your current payroll product."
- From (default 1 July of current FY) / To (today) + **"Show"**.
- Columns: Employee, Pays, Gross, Tax, incl. study loan, Salary sacrifice, Deductions, Super guarantee, Net; Total row. Empty "No approved pay in this range."
- **"Export CSV"** (data.export): `payroll-summary-<from>-to-<to>.csv` adds "Reimbursements"; audited `report_exported`; flash "Exported. Exports are recorded in the audit log."

---

## 8. My pay — `#/my-pay` (payroll.self)
- Eyebrow "MY PAY"; heading = employee name; intro "Your payslips, leave balances and leave requests." If not linked: heading "My pay" + "You aren't set up in payroll yet. Ask the payroll officer."
- Leave cards (types that accrue or have a balance): "<n> h", "≈ n days of 7.6 hours".
- **Payslips**: Paid, Period, Gross, Tax, Net, **"Download"**. Empty "No payslips yet."
- **Request leave**: Type (casuals see unpaid types only), First day, Last day, Hours (hint "A full day is usually 7.6 hours"), "Note (optional)"; **"Send request"**; flash "Sent. You'll get a notification when it's decided."
- **My requests**: type, dates, hours, status chip + comment, **"Cancel"** (Waiting/Approved) with confirm "Cancel this leave request?"; flash "Cancelled."
- Employee cannot see/edit bank, TFN or pay details here.

---

## 9. STP — `#/stp`, `#/stp/<eventId>`
- Permission to open: payroll.run, payroll.approve or payroll.sensitive.
- Heading **"Single Touch Payroll"**; intro: "STP Phase 2 information for each pay run, checked against the reporting rules. **Sending to the ATO is switched off**: keep reporting through your current STP payroll product and use these to check it. Sending needs ATO product registration, conformance testing and an approved sending service provider first."
- Tabs: "Events", "Pay item mapping", "Settings".

### 9.1 Event statuses

| Key | Label | Reachable | Meaning |
|---|---|---|---|
| `draft` | Has errors | Yes | Built, has employer or employee errors |
| `validated` | Checked | Yes | No errors |
| `ready` | Ready | Yes | Confirmed by second person; figures fixed |
| `submitted` | Sent | No | – |
| `accepted` | Accepted | No | – |
| `partially_accepted` | Partly accepted | No | – |
| `rejected` | Rejected | No | – |
| `corrected` | Corrected | No | – |
| `finalised` | Finalised | No | – |

Kinds: "Pay event", "Update event", "Finalisation".

### 9.2 Events tab
- Panel "Pay runs without an STP pay event" (payroll.run): number, "Paid <date>", **"Prepare pay event"** → `stp_event_pay` → opens event. Errors "STP is prepared once the pay run is approved.", "This pay run already has an STP pay event."
- Form (payroll.run): "Event" ("Update event (corrections)" / "Finalisation for the year"), "Financial year" (current and two prior, e.g. "2026-27"), "Year to date at (optional)", **"Prepare"** → `stp_event_year`. Errors: "Unknown STP event.", "Choose the financial year.", "The date must be in the financial year.", "Finish (mark ready or delete) the STP events still being prepared for this year first.", "Nobody's year-to-date figures have changed since the last STP event.", "Nobody was paid in this financial year.", "Some pay runs in this year have no STP pay event marked ready (<numbers>). Prepare those first."
- Table: Event (kind; pay run), Date, Status ("<n> with errors"), Employees, Gross YTD, PAYG YTD, Prepared, Ready. Empty "No STP events yet." Audited `stp_event_created`.

### 9.3 Event page
- Eyebrow "PAYROLL · STP"; heading kind + status; sub-line "Pay run <number>, paid <date>" or "Year to date at <date>" · "financial year 2026-27" · "prepared by X <time>" · "ready, Y <time>". Button **"All events"**.
- "Employer details to fix:" list. Summary: "<n> employee(s), <k> with errors / no errors. Year to date: gross (salary and wages, after salary sacrifice) $X, PAYG $Y (this pay run: gross …, PAYG …)."
- Buttons:

| Button | Shown | Action / perm | Dialog / flash |
|---|---|---|---|
| Check again | draft/validated, payroll.run | `stp_event_check` | "Checked: no errors." / "Still has errors." Error "Only an event being prepared can be checked again." |
| Mark ready | validated, payroll.approve, not the preparer | `stp_event_ready` | confirm "Mark this STP event ready? Its figures are fixed now."; flash "Ready." Errors "Only a checked event with no errors can be marked ready.", "Someone other than the person who prepared it must mark it ready.", "Pay or employee details have changed since this event was checked. Check it again." Audited |
| (hint) | validated but can't mark | – | "Someone who approves pay runs (not the preparer) marks it ready." |
| Download (JSON) / Download (CSV) | payroll.sensitive (any status) | `stp_event_export` | Files `STP-<kind>-<date>.json/.csv`, full TFNs; audited `stp_event_exported`; no flash. JSON note "STP Phase 2 information prepared in Panalo Accounts for checking or for an STP-enabled product. Not lodged with the ATO by this system." |
| Send to the ATO (off) | always, disabled; tooltip "Sending to the ATO is switched off" | – | – |
| Delete | draft/validated, payroll.run | `stp_event_delete` | confirm "Delete this STP event?"; error "Only an event being prepared can be deleted." |

- Note: "Downloads hold tax file numbers: keep them private and delete them after use. Every download is logged."
- Table: Employee (name; "Family, Given · number · TFN …" [TFN masked; hidden without payroll.sensitive]; "Final"; errors red; "Note: …" warnings), Codes ("F/P/C · tax treatment · income type · ceased X"), Gross, Other amounts (Overtime, Bonuses, Paid leave, Allowances, Deductions, "Salary sacrifice S"), PAYG, Super ("L", "OTE", "RESC"). Footnote: "Codes: employment basis (F full-time, P part-time, C casual) · tax treatment · income type. Fix an employee's details on their page (STP details), then check again."
- Employer errors: "The company ABN is missing or not valid (Company settings).", "The company legal name is missing.", "The company address is incomplete (Company settings).", "Add the STP contact person's name and phone number (Payroll > STP > Settings)."
- Employee errors: "Family name is missing.", "Date of birth is missing.", "Home address is incomplete (street, suburb, state and postcode).", "Start date is missing.", "The TFN isn't valid.", "They finished on <date>: choose the reason they left (cessation type).", "A cessation type is set but there is no finish date.", "Income type <X> needs the country (two-letter code).", "A working holiday maker's income type is WHM.", "Income type WHM is only for working holiday makers.", "Gross for the year is negative after salary sacrifice."
- Warnings: "Tax treatment HR assumes Panalo is a registered working holiday maker employer. Use HU if not.", "TFN applied for more than 28 days ago: reported as not quoted. Ask for the TFN.", "No pay this financial year."
- TFN codes: quoted TFN; 111111111 (applied, ≤ 28 days); 000000000 (not quoted / applied > 28 days); 333333333 (exempt, under 18); 444444444 (exempt, other). Tax treatment e.g. `RTXXXX`, `RNXXXX`, `NAXXXX`, `NFXXXX`, `FFXXXX`, `HRXXXX`/`HFXXXX`.

### 9.4 Pay item mapping tab
- Text: "Each pay item is reported in its STP Phase 2 category. Check these with your accountant; changes apply to events prepared from now on."
- Columns: Pay item ("Not in use"), Kind, STP category (Gross (salary and wages), Overtime, Bonuses and commissions, Directors' fees, Paid leave, Allowance, Deduction, Not reported), Type (codes for paid leave / allowance / deduction), link **"Save"** (payroll.sensitive; selects disabled otherwise). Flash "Saved." Errors: "Choose the STP category.", "A deduction is reported as a deduction, or not reported.", "Reimbursements aren't reported.", "Earnings and allowances can't be reported as deductions.", "That STP category and code don't go together.", "Pay item not found." Audited `pay_item_stp_mapped`.
- Footnote: "Reimbursements and deductions other than union fees, workplace giving and child support aren't reported. Salary sacrifice to super is reported separately (type S) and taken off gross; super guarantee, ordinary time earnings and reportable employer super contributions come from the pay runs."

### 9.5 Settings tab
- Heading "Employer details for STP"; "<legal name> · ABN <abn or 'not set'> (Company settings)".
- Fields (editable with payroll.sensitive): Branch number (hint "Usually 001"), Contact name, Contact phone, Contact email; "Software ID (BMS ID) for this payroll: <uuid>. Sending to the ATO: **off**." Button **"Save"**; flash "Saved." Errors: "The branch number is 3 digits (usually 001).", "That email address doesn't look right." Audited `stp_settings_saved`.

---

## 10. Segregation of duties (enforced in SQL unless noted)

| Rule | Where |
|---|---|
| Nobody approves their own timesheet; nobody approves a week they entered and submitted for someone else | `timesheet_decide` |
| Nobody reopens their own approved timesheet | `timesheet_reopen` |
| `time.approve` and `leave.approve` cover everyone in the organisation (not a crew/team) | code; docs warn "give it only to people who should approve anyone's time" |
| Nobody changes their own pay details or STP details | `payroll_employee_save`, `payroll_employee_stp_save` |
| Employee bank change: requested by payroll.sensitive, approved by payroll.approve; not the requester; not the employee themself | `payroll_bank_request`, `approval_decide` |
| Pay run approver must have payroll.approve and must not be the preparer (the person who submitted), anyone who added/removed lines (`edited_by`), or anyone paid in the run | `pay_run_approve` (UI hides the button only for preparer/paid-in-run; `edited_by` is checked server-side only) |
| Leave: nobody approves their own; the person who recorded leave for someone else can't approve it | `leave_request_decide` |
| STP event ready: payroll.approve and not the preparer | `stp_event_ready` |
| payroll.sensitive not granted to system administrators by default; job costing shows class rates, not individual pay | permissions / projects |
| Payroll keys (sensitive, run, approve), bank.manage and data.export require two-step sign-in | `requires_mfa` |

## 11. High-risk actions
- Approve and post a pay run (final, posts ledger, consumes hours/leave, cannot be undone; corrections only in a later run).
- Approving an employee bank change (fraud risk; approver should verify by phone).
- Downloading ABA / bank payment list (full bank details; audited), STP export (full TFNs; audited), payslips.
- Recording net pay / super as paid (posts bank journals).
- Editing TFN, tax declaration, pay rate, wages account; ticking "Finished: no longer paid".
- Leave balance adjustments / opening balances (audited, reason required).
- Reopening approved timesheets (changes costing; audited; blocked once paid).
- Changing labour class rates (affects future approvals' cost).
- Marking an STP event ready (fixes figures).

## 12. Present in code but not reachable / not complete in the UI (Verification required)
- `stp_event_submit` API action (payroll.approve) exists but always refuses: "Sending STP to the ATO isn't switched on in Panalo Accounts. Report this pay through your current STP payroll product; it needs ATO product registration, conformance testing and an approved sending service provider first." DB check forces `transmission_enabled = false`. UI button disabled.
- STP statuses submitted / accepted / partially_accepted / rejected / corrected / finalised: defined but unreachable.
- Project `quote_id` (link project to quote) — preserved on save, no UI to set it.
- `pay_run_aba` optional `sourceId` (choose paying account) — not exposed; server auto-picks the payroll-purpose account.
- `pay_run_line_add` can add an employee not yet in the run (same frequency) — UI only offers the add form inside existing employee rows.
- `timesheets_review` `weekStart` filter — not exposed.
- Home address `street2` and state `OTH` accepted by SQL — not in UI form.
- No UI for: pay items, leave types/accrual rates (e.g. long service), compliance rules, pay item `payee` (shown on payslips as "Paid to …"), public-holiday generation, deleting projects/cost codes/labour classes.
- Payslip emailing — not implemented.
- Employee bank approval card in Approvals shows no account details for kind `employee_bank`.
- Stale UI copy: Hours for payroll ("Pay runs arrive in Phase 5…") and Payroll summary ("…arrives in Phase 8…") predate the built pay runs/STP.
- `super_payday_due_business_days` compliance rule is not used for displayed due dates (hard-coded 7); 20-day new-employee/new-fund rule not applied.
- Employee bank account numbers allowed 5–10 digits, but the ABA builder accepts 5–9 digits (10-digit accounts fail the ABA download).
- Hourly employees without a linked portal account cannot have timesheet hours.
- Not automated (docs): Schedule 15 WHM tax, tax offsets/Medicare adjustment, Schedule 5/7 back pay/bonus/ETP methods, award rates.
