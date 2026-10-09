# Investigation 3: Projects, Job costing, Timesheets, Payroll (Panalo Accounts)

Source of truth: `accounts/views/{projects,timesheets,employees,payruns,leave,stp}.js`, `accounts/app.js`,
`supabase/functions/finance-api/{projects,payroll,stp}.ts` (+ `banking.ts` for `pay_run_aba`),
`supabase/migrations/20261010000000_projects_timesheets.sql`, `20261011000000_payroll.sql`, `20261014000000_stp.sql`.
All text below quoted from source. "UI" = browser; "API perm" = any-of list in the `*Actions` map; "SQL" = `app_require` / checks inside the SQL function (these are the final authority).

---------------------------------------------------------------------------------------------------
## 0. Cross-cutting facts

### 0.1 Menu (app.js MENU) and who sees each item
Hash router: `#/<path>/<sub>`. A menu item shows only if the person holds ANY key in `any` (or the single `perm`). Visiting a route you can't see redirects to `#/dashboard`.

| Group | Menu label | Route | Shown if holds any of | Count badge |
|---|---|---|---|---|
| (none) | My pay | `#/my-pay` | `payroll.self` | none |
| Projects | Projects | `#/projects` | `projects.manage`, `reports.view` | none |
| Projects | Job costing | `#/job-costing` | `projects.manage`, `reports.view` | none |
| Projects | Timesheets | `#/timesheets` | `time.submit`, `time.approve`, `projects.manage`, `payroll.run` | timesheets (submitted, not mine; only if `time.approve`) |
| Payroll | Employees | `#/employees` | `payroll.sensitive`, `payroll.run`, `payroll.approve`, `leave.approve` | none |
| Payroll | Pay runs | `#/pay-runs` | `payroll.run`, `payroll.approve`, `payroll.sensitive` | payRuns (submitted; only if `payroll.approve`) |
| Payroll | Leave | `#/leave` | `leave.approve`, `payroll.sensitive`, `payroll.run` | leave (submitted, not mine; only if `leave.approve`) |
| Payroll | Super | `#/super` | `payroll.run`, `payroll.approve`, `payroll.sensitive` | none |
| Payroll | STP | `#/stp` | same three | none |
| Payroll | Payroll reports | `#/payroll-reports` | same three | none |

Left-nav group titles: "Projects", "Payroll". Dashboard cards (dashboard.js): "Pay runs to approve", "Super not yet paid" (sub-text "Due within 7 business days of each payday"), "Leave to approve", "Active projects" (sub "Active or on hold"), "Timesheets to approve".

### 0.2 Permission display names (what error messages quote)
From `app_permissions.name`:
- `projects.manage` = "Projects and job costing"
- `time.submit` = "Enter my timesheets"
- `time.approve` = "Approve timesheets"
- `leave.approve` = "Approve leave"
- `payroll.sensitive` = "Payroll: pay, tax and bank details" (NOT given to system administrators automatically; requires MFA)
- `payroll.run` = "Prepare pay runs" (MFA)
- `payroll.approve` = "Approve pay runs" (MFA)
- `payroll.self` = "My pay" ("See your own payslips and leave balances, and request leave."; no MFA)
- `reports.view` = "Financial reports"; `data.export` = "Export data" (MFA); `bank.manage` = "Banking" (MFA)
MFA (6-digit authenticator code, gate headings "Confirm it's you" / "Set up two-step sign-in") is required for anyone holding any `requires_mfa` key: payroll.sensitive/run/approve, bank.manage, data.export, ledger.*, etc. NOT required for projects.manage, time.approve, time.submit, leave.approve, reports.view, payroll.self.

### 0.3 Roles -> permissions (foundation + later migrations)
| Role (key) | Keys relevant here |
|---|---|
| Super admin (`super_admin`) | projects.manage, time.approve, reports.view, data.export + non-payroll admin keys (no payroll keys in role) |
| Director / owner (`director`) | payroll.approve, payroll.self, reports.view, data.export, bank.manage, sales/purchases etc. (NO payroll.run, NO payroll.sensitive, NO leave.approve, NO time.*) |
| Finance admin (`finance_admin`) | bank.manage, reports.view, data.export, payroll.self, purchases.raise (NO payroll keys otherwise) |
| Payroll admin (`payroll_admin`) | payroll.sensitive, payroll.run, leave.approve, time.approve, reports.view, data.export, payroll.self (NO payroll.approve) |
| Project manager (`project_manager`) | projects.manage, time.approve, reports.view, time.submit, payroll.self, purchases.raise |
| Supervisor (`supervisor`) | time.approve, leave.approve, time.submit, payroll.self |
| Accountant (`accountant`) | reports.view, data.export (ledger/audit) |
| System administrator (`training_profiles.role = 'admin'`, not a role row) | every permission with `admin_default = true`: includes projects.manage, time.approve, time.submit, leave.approve, payroll.run, payroll.approve, reports.view, data.export; EXCLUDES payroll.sensitive and payroll.self |
Individual allow/deny overrides in Users and roles beat roles.

### 0.4 Generic errors (any screen)
- 403 "Your access doesn't include this area. Ask an administrator if you need it." (API perm any-of failed).
- 403 `You need the "<permission name>" permission for this.` (SQL `app_require`; e.g. `You need the "Prepare pay runs" permission for this.`).
- 401 "Your sign-in has expired. Please sign in again."
- Route-level failure renders a panel: heading "Something went wrong" + red message.
- Error mapping: SQLSTATE 42501 -> 403, P0002 -> 404, 22023 -> 409; messages are shown verbatim (red `.msg.bad` under the form, element `[data-msg]` / `#app-msg`).
- "Exporting needs the data export permission." (403) for CSV on job costing / payroll summary without `data.export`.

### 0.5 Fixtures note (important for the writer)
Everything below under "Test data" exists ONLY in the throwaway database that `supabase/tests/db/run.sh` / `supabase/tests/api/run.sh` build (and drops). There is no seed file with employees/projects (`supabase/seed/ims_folders.sql` only). Staff and screenshots must use a database built from those fixtures, or create the data by hand.

---------------------------------------------------------------------------------------------------
## 1. PROJECTS

Eyebrow on all: "PROJECTS". Intro text quoted per screen.

### 1.1 Projects list  - route `#/projects` (menu "Projects")
- h1 "Projects". Lead: "Jobs that time, purchases and invoices are tagged to. Open one to see its budget, costs to date and margin."
- Buttons (only `projects.manage`): "Cost codes and rates" (-> `#/projects/settings`), "New project" (-> `#/projects/new`).
- Filter toolbar: field "Show" (`#p-st`; options: "Open (tender, active, on hold)" default, "All", then each status label), field "Number or name" (`#p-q`), button "Filter". Optional `?status=` in hash.
- Table columns: Project (number in mono + name, site under it), Customer, Manager, Status, Contract, Cost to date, Invoiced, Complete. Empty: "No projects here yet."
- API: `projects_list` perm `projects.manage` or `reports.view`.

### 1.2 Project statuses (PROJECT_STATUS) and allowed transitions
| Stored | Label | Chip |
|---|---|---|
| tender | Tender | pending |
| active | Active | good |
| on_hold | On hold | pending |
| completed | Completed | info |
| closed | Closed | (neutral) |
| cancelled | Cancelled | (neutral) |
Buttons on project page ("Status" panel; `projects.manage`), UI-offered transitions only:
- Tender: "Won: make active" -> active; "Lost / cancelled" -> cancelled
- Active: "Put on hold" -> on_hold; "Mark completed" -> completed
- On hold: "Resume" -> active; "Cancel" -> cancelled
- Completed: "Close project" -> closed; "Reopen" -> active
- Closed: "Reopen" -> active
- Cancelled: "Reopen as tender" -> tender
Panel note: "A project can't be closed while timesheets with hours on it are still waiting for approval."
SQL (`project_set_status`, `projects.manage`) accepts ANY of the six statuses from any status; only guard: closing is refused if any timesheet with entries on the project is draft/submitted/rejected -> "Timesheets with hours on this project are still waiting. Approve or correct them before closing it." Success flash: "Status updated."
Effects of status: Closed and Cancelled projects drop out of timesheet project pickers and `projects_setup`; new timesheet entries on closed/cancelled are refused (a week already containing hours on a then-closed project may keep them). Cancelled projects take no document-line tags ("that project was cancelled or doesn't exist"); closed projects still accept late bills/invoices.

### 1.3 New / Edit project - routes `#/projects/new`, `#/projects/<id>/edit`
h1 "New project" or "Edit JOB-xxxx". Lead: "The project number is given when you save. Budgets by cost code drive the remaining-budget and progress figures; leave codes you won't use blank." (new) / just second sentence (edit).
Fields (id): "Project name *" (`pj-name`, 160), "Customer" (`pj-cust`; first option "None (internal job)"), "Site" (`pj-site`; hint "Where the work is done"), "Customer's order / contract number" (`pj-ref`), "Project manager" (`pj-mgr`; option "—"), "Contract type" (`pj-bill`: Fixed price / Schedule of rates / Cost plus / Internal (no customer)), "Contract value ($, ex GST)" (`pj-value`; hint "The agreed price, or an estimate for schedule-of-rates work"), "Start" (`pj-start`), "Finish" (`pj-end`), "Notes" (`pj-notes`).
h2 "Budget": table Cost code | Category | Hours | Amount ($) with an input per active cost code (`[data-budget] [data-h]`, `[data-a]`), footer "Total budget"; live line (`[data-margin]`) "Budgeted margin $X (Y%)" (turns red when budget > contract).
Buttons: "Save project", "Cancel". Number assigned on first save (`JOB-1001`, `JOB-1002`... prefix JOB-, 4 digits).
Errors: "Give the project a name." (name < 2 chars; UI + API + SQL), "Budgets are positive numbers, with dollars and cents." (UI), "The contract value must be a positive amount.", "Budget hours and amounts must be numbers.", "Unknown customer.", "That quote is not for this customer.", "Unknown project manager.", "Budgets must be positive amounts.", "Unknown cost code in the budget.", "Project not found." DB check: finish before start fails the `end_date >= start_date` check (400 check-constraint, generic message).
API: `project_save` (`projects.manage`); setup data `projects_setup`, `project_people` (`projects.manage`).

### 1.4 Project page = job costing for one project - route `#/projects/<id>`
Eyebrow "PROJECTS · JOB-xxxx"; h1 = project name + status chip; sub-line: customer link or "Internal job" · site · "managed by X" · dates. Button "Edit" (manage).
Figure cards (h2 / big number / small text):
1. "Contract" - contract value; small = contract type label + customer reference.
2. "Cost to date" - `totals.actualCost`; small "of $<budget> budget · $<committed> committed".
3. "Invoiced" - `revenue.invoiced`; small "$<toInvoice> left to invoice".
4. "Margin so far" - `margin.grossMargin`; small "<marginPercent>% of invoiced · budgeted <budgetMarginPercent>%" (card gets `attention` style when negative).
5. "Progress" - percentComplete; small "Over-billed $x" / "Under-billed $x" / "Set a budget to measure progress".
Panel h2 "Budget and costs by cost code": toolbar field "As at" (`#pj-asat`, date, default today) + button "Update". Columns: Cost code | Budget hrs | Actual hrs | Budget | Labour | Other | Actual | Committed | Remaining | Used (bar + %). Total row. Empty "No budget or costs yet." Foot note: "Labour: approved timesheet hours at the labour rate when approved. Other: approved bills tagged to this project, excluding GST. Committed: approved purchase orders not yet billed."
Other panels: h2 "Labour" (table Person | Approved hrs | Cost (manage only) | Waiting; link "Timesheets"); h2 "Invoices" (button "New invoice for this project" needs `sales.manage` and a customer); h2 "Bills and supplier credits" (columns Bill | Supplier | Their reference | Date | Status ("Approved"/"Not approved") | On this project (ex GST); buttons "Purchase order for this project" (`purchases.raise` or `purchases.manage`), "Bill for this project" (`purchases.manage`)); h2 "Status" (above); h2 "Notes".
API: `project_get` (`projects.manage` or `reports.view`). `reports.view`-only users do not see the Cost column on Labour (cost shown only with `projects.manage`).

### 1.5 JOB COSTING - how figures are computed (SQL `report_project_costing`, `report_projects_summary`)
Everything "as at" a date (default today, Sydney time). Figures ex GST.
- Budget (hours, amount) = `project_budgets` per cost code.
- Actual hours = sum of hours of timesheet entries on the project where timesheet status = approved and work_date <= as-at.
- **Labour cost** = sum of `cost_amount` frozen at timesheet approval = hours x ROUND(labour class cost_rate x hour-type factor, 2); factor 1.0 ordinary/travel, 1.5 overtime_150, 2.0 overtime_200. It is a management figure (loaded class rate), NOT the employee's actual pay, and it does NOT post to the ledger. Reopen clears costs; re-approval re-prices at the then-current class rate.
- **Other cost** = approved bills less approved supplier credit notes tagged to project (+cost code), net of GST (inclusive amounts less GST), bill_date <= as-at.
- **Committed** = purchase order lines on the project with PO status approved/issued/partially_received and order_date <= as-at, net of GST, x unbilled fraction (1 - billed qty / qty; billed = approved bill lines linked to the PO line dated <= as-at).
- **Actual (cost to date)** = Labour + Other. **Remaining** = Budget - Labour - Other - Committed. **Used %** = (Labour + Other) / Budget x 100 (blank if no budget).
- **Revenue ("Invoiced")** = approved invoices less credit notes tagged to project, ex GST, invoice_date <= as-at. Draft invoices are not counted (they show a "Draft" chip in the list).
- **Margin so far (`grossMargin`)** = Invoiced - Cost to date. Margin % = margin / invoiced x 100 (none if invoiced = 0). Budgeted margin % = (contract - total budget) / contract x 100.
- **Progress (percent complete)** = MIN(100%, cost to date / total budget); needs a budget > 0. Earned revenue = contract value x progress. **Over / (under) billed** = Invoiced - Earned (positive = over-billed, negative = under-billed; shown in brackets).
- Worked example in tests (JOB-1001, as at 30 Sep 2026): cost $4,372.50 (labour 1,722.50 + materials 1,900 + subcontract 750), committed $750, remaining $4,877.50, invoiced $8,000, margin $3,627.50 (45.3%), progress 43.7%, earned $8,745.00, under-billed $745.00.

### 1.6 JOB COSTING screen - route `#/job-costing`
h1 "Job costing". Lead: "Every project's budget, costs, commitments, invoicing and margin as at today. Margin is invoiced less cost to date; over/under billing compares invoicing with progress on cost."
Button "Export CSV" (`[data-csv]`) only with `data.export`; flash "Exported. Exports are recorded in the audit log." Filter: "Show" (`#jc-st`: Open projects / All / each status) + button "Show".
Exact columns: Project | Contract | Budget | Cost to date | Committed | Hours | Invoiced | Margin (with % beneath) | Complete | Over / (under) billed. Footer row "Total" sums Contract, Budget, Cost to date, Committed, Hours, Invoiced, Margin. Cost shows red if > budget; margin red if < 0. Non-active projects get a status chip. Empty "No projects."
Footnote: "Labour is costed at each person's labour rate when their timesheet is approved. Other costs are approved bills tagged to the project, excluding GST. Committed is approved purchase orders not yet billed."
CSV columns: Project, Name, Status, Customer, Contract, Budget, Cost to date, Committed, Hours, Invoiced, Margin, Margin %, Complete %, Over/(under) billed. File `job-costing-<date>.csv`. Export is audited (`report_exported`/`job_costing`).
API: `projects_list` (`projects.manage` or `reports.view`); SQL `report_project_costing` requires `projects.manage` or `reports.view`.

### 1.7 Cost codes and labour rates - route `#/projects/settings` (redirects to `#/projects` without `projects.manage`)
h1 "Cost codes and labour rates". Lead: "Labour rates are what an hour costs Panalo (wages plus on-costs such as super, workers compensation and leave) and what it is charged out at. Job costing uses the rate of each person's class, so nobody's individual pay is shown on projects." Link button "Projects".
- h2 "Labour classes": columns Code | Name | Cost per hour ($) | Charge-out per hour ($) | Active | (Save/Add). Warning `.note` if an active class has $0 cost: "Some classes have no cost rate yet, so their hours are costed at $0. Set a loaded cost per hour for each class you use." Seeded classes (all rates start at $0): WELDER Welder, FITTER Pipe fitter / fabricator, RIGGER Rigger / dogman, LAB Trades assistant / labourer, SUP Supervisor / leading hand, APP Apprentice. Blank bottom row (placeholders "NEW", "Add a class") adds a class (button "Add"; existing rows "Save").
- h2 "Who is costed at which rate": text "Everyone who can enter timesheets. A person's timesheets can't be approved until they have a class. A change applies to timesheets approved from then on; approved weeks keep the rate they were approved at." Per person select (aria "Labour class for <name>"; option "Not set"). Empty: `Nobody can enter timesheets yet. Give people "Enter my timesheets" in Users and roles.` Changing the select saves immediately: flash "Labour class updated."
- h2 "Cost codes": Code | Name | Category (Labour, Materials, Equipment, Subcontract, Travel, Consumables, Freight, Other) | Active | Save/Add. Note: "Labour cost codes are the ones offered on timesheets. Codes in use can be made inactive but not deleted." Seeded: 100 Labour - fabrication, 110 Labour - welding, 120 Labour - site installation, 130 Labour - supervision, 140 Labour - shutdown and maintenance (labour); 200 Materials - pipe, steel and fittings; 210 Welding consumables and gases (consumables); 300 Equipment and plant hire; 400 Subcontractors; 410 Testing and inspection (NDT) (subcontract); 500 Travel and accommodation; 600 Freight and cartage; 900 Other project costs.
Flash after save: "Saved."
Errors: "Cost codes are 1 to 10 letters, digits, dots or dashes.", "Give the cost code a name.", "Choose a category.", "Cost code not found.", "Codes are up to 12 capital letters, digits or dashes.", "Rates are dollars per hour.", "Rates are dollars and cents per hour.", "Labour class not found.", "Choose an active labour class.", "Person not found." Duplicate code -> unique violation (409, generic).
API perms: `cost_code_save`, `labour_class_save`, `labour_assign` = `projects.manage`; `labour_people` = `projects.manage` or `time.approve`; rates visible only with `projects.manage`.

---------------------------------------------------------------------------------------------------
## 2. TIMESHEETS

Eyebrow "PROJECTS · TIMESHEETS". Nav tabs (`nav.tabs`, aria "Timesheets"): "My week" (`#/timesheets`), and for holders of `time.approve`/`projects.manage`/`payroll.run`: "Review" (`#/timesheets/review`), "Hours for payroll" (`#/timesheets/hours`). People with only `time.submit` see no tab bar.

### 2.1 Timesheet statuses (STATUS map) and transitions
| Stored | Label shown | Chip tone |
|---|---|---|
| draft | Draft | pending |
| submitted | Waiting for approval | info |
| approved | Approved | good |
| rejected | Sent back | bad |
Review sub-tabs use friendlier names: "Waiting" (submitted), "Sent back" (rejected), "Approved", "Not submitted" (draft).
Transitions (SQL):
- (none) / draft / rejected --Save--> draft ("Save"); --Submit for approval--> submitted. Editable only when no timesheet exists, or status draft or rejected.
- submitted --"Recall to change"--> draft (only the timesheet's owner; no reason needed). An approver (`time.approve`) may also reopen a submitted week via API with a reason (no UI button).
- submitted --Approve--> approved (freezes costs, stores a version, notifies person). submitted --"Send back"--> rejected (comment required, notifies person).
- approved --"Reopen for correction"--> draft (approver with `time.approve`, reason >= 3 chars, costs cleared, person notified, comment stored as note "Reopened: <reason>"); impossible once `payroll_locked_at` is set.
- Re-approval of a reopened week adds a new row in `timesheet_versions` (append-only, can't be edited or deleted: "Approved timesheet versions can't be changed or deleted.").
Segregation: nobody approves/rejects their own week; the person who entered AND submitted a week for someone else (`submitted_by`) can't approve it; nobody reopens their own approved week.

### 2.2 My week - route `#/timesheets` (params `?week=YYYY-MM-DD&person=<id>`)
h1 "My timesheet" (own week) or the person's name, + status chip. Sub-line: "Entered by X · " (if a supervisor entered it) and either "Approved by X <date time>" / "Decided by X ..." or "Record your hours for each day, then submit the week for approval."
Notes: "Sent back: <comment>" (rejected), "Reopened: <reason>" (draft with comment).
Week bar: buttons "‹" (aria "Previous week") and "›" ("Next week"); field "Week starting" (`#ts-week`, any date snaps to Monday); for approvers a select "Person" (`#ts-person`, first option "Me", lists crew from `labour_people` = people with `time.submit` or a labour class); "Week total" (`[data-total]`).
Per-day fieldsets legend "Mon 7 Sep 2026" etc. with live day total; button "+ Add hours for Mon" (per day).
Entry row fields (ids `eN-p`, `eN-c`, `eN-s`, `eN-e`, `eN-b`, `eN-h`, `eN-y`, `eN-n`; `data-f` attr):
- "Project" (first option "No project (workshop / overhead)"; open projects "JOB-1001 Berth 4 pipework"; closed one already on the week shows "Project now closed")
- "Cost code" (first option "—"; labour codes only, shown like "110 welding"; "Labour - " prefix stripped)
- "Start" (time), "Finish" (time), "Break (min)" (default 30 on new rows), "Hours" (auto and read-only when start/finish given; typed otherwise), "Type" (Ordinary, Overtime ×1.5, Overtime ×2, Travel time), "Notes" (300 chars)
- "Cost $x" line (only for `projects.manage`, after approval); link "Remove".
Action buttons: "Save", "Submit for approval" (`type=submit`, `data-act=save|submit`); "Recall to change" (`[data-recall]`, owner while submitted); "Approve" (`[data-approve]`) and "Send back" (`[data-reject]`) for `can.decide`; "Reopen for correction" (`[data-reopen]`).
Prompts: Send back: "Send this week back? Say what needs fixing:"; Reopen: "Reopen this approved week for correction? The costs are worked out again when it is re-approved. Reason:".
Flashes: "Saved.", "Submitted for approval.", "Recalled. Make your changes and submit again.", "Approved.", "Sent back.", "Reopened."
Below: h2 "Approved versions" ("Every version of this week that was approved is kept, including any later reopened and corrected."; `<details>` "Version N · X h · approved by Y <time>"); h2 "Recent weeks" (links "Week of <date>" + chip + hours).
Permissions: `can.edit` = editable status and (own week: `time.submit` OR `time.approve`; someone else's: `time.approve`). `can.decide` = submitted, not your own week, you didn't submit it, you hold `time.approve`. `can.reopen` = approved, not your own, `time.approve`, not payroll-locked. Viewing others' weeks needs one of time.approve / projects.manage / payroll.run ("You can only see your own timesheets.").
Rules/limits: week starts Monday; max one week ahead; <=100 entries; each day <= 24 h; each entry > 0 and <= 24 h, 2 decimals; start/finish both or neither; finish earlier than start = shift past midnight; no overlapping entries; labour cost codes only; open projects only; break 0-600.
Notifications: submit notifies all `time.approve` holders ("Timesheet to approve: <name>", "<DD Mon> week · N hours", link timesheets/review); approve -> "Timesheet approved: week of DD Mon"; reject -> "Timesheet sent back: week of DD Mon"; reopen by another -> "Timesheet reopened: week of DD Mon".
API: `timesheet_week` (time.submit or review perms), `timesheet_save` (`time.submit`/`time.approve`), `timesheet_reopen` (`time.submit`/`time.approve`), `timesheet_decide` (`time.approve`).

Errors (save/submit) - exact:
- "A timesheet week starts on a Monday." / "Timesheets can't be entered more than a week ahead." / "A week can have up to 100 entries." (also API "A week can have up to 100 entries.")
- "This week has been approved. Ask your supervisor to reopen it to make a change." (editing approved)
- "This week is waiting for approval. Recall it first to make a change."
- "Entry N: check the date, times and hours." / "Entry N: the date must be in the week starting DD Mon YYYY." / "Entry N: enter both a start and a finish time, or neither." / "Entry N: the break must be between 0 and 600 minutes." / "Entry N: the start and finish are the same time." / "Entry N: hours must be more than 0 and no more than 24." / "Entry N: that project is closed or doesn't exist." / "Entry N: choose a labour cost code." / "Entry N: unknown type of hours."
- "A day can't have more than 24 hours." / "Two entries overlap in time. Split the shift between projects instead of entering the same hours twice." / "Add your hours before submitting." (SQL + UI) / "Person not found."
- API: "Times are like 07:00 or 15:30." / "Hours must be a number." / "Add the hours for the week."
- UI: "Check the highlighted hours."
Errors (decide/reopen): "Timesheet not found." / "Only a submitted timesheet can be approved or rejected." / "Someone else must approve your own timesheet." / "You entered and submitted this week, so someone else must approve it." / "Set <Name>'s labour class (Projects, Labour rates) before approving, so the hours can be costed." (message literally: `Set <Name>'s labour class (Projects, Labour rates) before approving, so the hours can be costed.`) / "Say what needs fixing." (send back < 3 chars) / "This timesheet is already open for changes." / "Someone else must reopen your own approved timesheet." / "These hours have been paid. Correct them in the next pay run instead." / "Give a reason for reopening it." / "You can only see your own timesheets."

### 2.3 Review - route `#/timesheets/review`
h1 "Review timesheets". Lead: "Open a week to check it against the site diary, then approve it or send it back with a reason. You can't approve your own."
Status tabs (role=tab buttons `[data-st]`): Waiting | Sent back | Approved | Not submitted (default Waiting). Columns: Person (link; "You" marker on own), Week of, Hours, Overtime, Projects (count), Submitted (or "Approved" column heading when on Approved tab: shows approver + time). Empty "Nothing here." Limit 200. API `timesheets_review` perms `time.approve`, `projects.manage`, `payroll.run`. (Only `time.approve` holders can actually decide.)

### 2.4 Hours for payroll - route `#/timesheets/hours`
h1 "Approved hours". Lead (stale wording in UI): "Approved hours by person and type, ready for payroll. Pay runs arrive in Phase 5; until then export them for your payroll system." (Pay runs now exist.)
Toolbar: "From" (`#h-from`), "To" (`#h-to`) default previous 2 weeks Mon-Sun, button "Show". Columns: Person | Ordinary | Overtime ×1.5 | Overtime ×2 | Travel time | Total. Empty "No approved hours in this range." Button "Export CSV" (appears once data loaded; NOT gated by data.export in UI or API) -> audited; columns Person, Email, Week starting, Date, Project, Project name, Cost code, Type, Start, Finish, Break (min), Hours, Notes; file `approved-hours-<from>-to-<to>.csv`; flash "Exported. Exports are recorded in the audit log." Error "Choose a date range." API `timesheet_hours` (time.approve/projects.manage/payroll.run).

### 2.5 How timesheets flow to PAY RUNS and to JOB COSTING
- Job costing: on **approval** each entry is priced at the person's labour class cost rate x overtime factor (frozen). Job costing sums those for approved weeks by project and cost code. No ledger posting; salaried staff's timesheets can still be costed.
- Payroll: only **hourly** employees draw hours from timesheets. When a pay run is created or recalculated it "claims" every APPROVED timesheet entry for that employee that has no pay run yet, with `work_date <= period end` (also late approvals from earlier periods; not before the employee's payroll start date) and sets `timesheet_entries.pay_run_id`. Entries are grouped by hour type (and project) into pay lines: ordinary -> "Ordinary hours" (casual loading added for casuals, default 25%), overtime_150 -> "Overtime at 150%", overtime_200 -> "Overtime at 200%", travel -> "Travel time"; line descriptions get " · JOB-xxxx" appended when tied to a project. Hours aren't claimed twice. Unapproved hours in the period produce a warning on the employee row: "Some timesheet hours in this period aren't approved yet and aren't included."
- Locking: **Submit for approval** of a pay run sets `payroll_locked_at` on the claimed weeks (no reopen: "These hours have been paid. Correct them in the next pay run instead."); sending the pay run back unlocks them unless an approved run paid part of the week; approval locks permanently. Salaried employees are paid salary; timesheets are not used.
- Wages/ledger (payroll) and job-cost labour (timesheet class rates) are separate figures and never reconciled automatically.

---------------------------------------------------------------------------------------------------
## 3. PAYROLL

Eyebrow "PAYROLL" (sub-screens "PAYROLL · EMPLOYEES", "PAYROLL · PAY RUNS", "PAYROLL · PAY RUN", "PAYROLL · STP", "MY PAY").

### 3.1 Employees list - route `#/employees`
h1 "Employees". Lead: "People in the HR register who are paid through payroll. Set up each person's pay, tax declaration, super fund and bank account before their first pay run. Contractors are paid through bills."
Filter: "Name" (`#em-q`, client-side), "Show" (`#em-show`: "Active and in payroll" default / "Everyone in the HR register"), button "Filter". Columns: Employee (link; number + HR status if not active), Position, Basis (Full-time/Part-time/Casual, or chip "Not set up"; chip "Finished" if terminated), Paid (Weekly/Fortnightly/Monthly), Rate (only `payroll.sensitive`: "$x pa" or "$x/h"), "Needs attention". Empty: "Nobody here. Add people in the HR register on the portal first."
"Needs attention" strings (only for HR-active people): "Pay details not set up", "No pay rate", "No TFN: 47% withheld", "TFN applied for", "No bank account", "No super fund", "Working holiday maker: withholding not automated".
Contractors never appear. API `payroll_employees` perms: payroll.sensitive, payroll.run, payroll.approve, leave.approve.

### 3.2 Employee page - route `#/employees/<id>`
h1 = name + chip (Full-time/Part-time/Casual green, or "Not set up yet"). Sub-line: number · position · started date · " · no portal account (can't see their own payslips)". `.note` lists problems (same strings) for HR-active people.
If NOT `payroll.sensitive`: panel "Pay, tax, super and bank details are only shown to people with "Payroll: pay, tax and bank details"." (still sees Leave balances and Pay history).
With `payroll.sensitive` (all ids below):
- Form `form[data-pay]`, h2 "Pay", button "Fill in from onboarding" (`[data-import]`). Selects/fields: "Employment" (`py-basis`: Full-time/Part-time/Casual), "Paid by" (`py-paybasis`: "Hourly rate (hours from timesheets)" / "Annual salary"), "Pay frequency" (`py-freq`: Weekly/Fortnightly/Monthly), "Base hourly rate ($)" (`py-rate`; hint "Before casual loading. National minimum $26.44/h; the award minimum is usually higher."), "Annual salary ($)" (`py-salary`), "Ordinary hours a week" (`py-hours`, default 38), "Casual loading %" (`py-casual`, 25), "Annual leave loading %" (`py-loading`, 17.5), "Annual leave a year" (`py-alw`: "4 weeks" / "5 weeks (shift worker)"), "Award or agreement" (`py-award`), "Classification" (`py-class`), "Wages account" (`py-acc`; default 5000), "Date of birth" (`py-dob`; hint "Under 18s working 30 hours a week or less don't get super guarantee"), "Payroll start date" (`py-start`), "Finish date" (`py-end`).
- h3 "Tax declaration": "TFN" (`py-tfns`: "Provided", "Applied for (28 days, then 47%)", "Exempt (under 18 or on a pension)", "Not provided: withhold 47%"), tax file number text (`py-tfn`, label becomes "TFN on file ••• ••• 782" / "TFN from onboarding ..."; hint "Leave blank to keep it; type a new one to replace it" / "9 digits"), "Residency" (`py-res`: "Australian resident for tax", "Foreign resident", "Working holiday maker"), "Tax-free threshold" (`py-tft`: "Claimed from Panalo"/"Not claimed"), "Study or training loan" (`py-stsl`: "No"/"Yes (HELP, VSL, SFSS, SSL or TSL)"), "Medicare levy" (`py-med`: "No variation", "Half exemption claimed", "Full exemption claimed"), "Extra tax each pay ($)" (`py-extra`; hint "Only if they asked for more tax to be taken").
- h3 "Super": "Fund name" (`py-fund`), "Fund USI" (`py-usi`; hint "SMSF? Leave blank and enter its ABN"), "SMSF ABN" (`py-fundabn`), "Member number" (`py-member`), "Salary sacrifice to super each pay ($)" (`py-ss`). If onboarding showed a default fund: "They chose Panalo's default fund. If they have an existing fund, the ATO's stapled fund rules may apply: check before their first super payment."
- "Notes" (`py-notes`); checkbox "Finished: no longer paid" (`py-term`); submit "Set up in payroll" (first time) or "Save pay details"; flash "Pay details saved."
- "Fill in from onboarding" (action `payroll_import_onboarding`, audited `payroll_onboarding_read`): copies the LATEST ACCEPTED onboarding items of types tax declaration, super choice, personal details, bank details into the form (nothing saved until you save). Note shown: "Filled in from their accepted onboarding forms (<types>). Check, then save. Bank details from onboarding go to approval separately, below." Full TFN/account number never reach the browser (masked). Warn flash if nothing: "No accepted onboarding forms with tax, super, personal or bank details were found for this person."
- (After set-up) form `[data-stp]` h2 "STP details": see 3.10.
- h2 "Bank account": shows "<account name> · BSB 062-000 · •••678" and "Approved <date>" or "No bank account yet."; if request pending: chip "Change waiting for approval". Else form `[data-bank]`: "Account name" (`bk-name`), "BSB" (`bk-bsb`), "Account number" (`bk-acct`; label "Account number (onboarding •••321)" when imported; hint "Leave blank to use the account from onboarding"); text "Confirm new bank details with the employee in person or on a number you already have. Someone with "Approve pay runs" approves the change; nobody can approve their own."; button "Request approval" (none yet) or "Request a change". Flash: "Sent for approval. Pay goes to the new account once someone else approves it."
- h2 "Leave": cards per paid leave type with balance (hours "h" and "≈ N days"; only ANNUAL/PERSONAL always, others if non-zero); for `payroll.sensitive` a form `[data-adjust]`: "Type" (`la-type`), "Kind" (`la-kind`: "Opening balance"/"Adjustment"), "Hours (+/−)" (`la-hours`), "Date" (`la-date`), "Reason" (`la-note`; placeholder "For example: balance from the previous payroll system"), button "Record"; flash "Leave balance updated." `<details>` "History" (kinds: Accrued, Taken, Adjustment, Opening balance).
- h2 "Pay history": columns Pay run | Paid | Gross | Tax | Super | Net | button "Payslip" (downloads PDF via `payslip_pdf`).
Bank change approval: appears on **Approvals** (`#/approvals`, kind `employee_bank`, title "Bank details for <name>") for holders of `payroll.approve`; approver clicks Approve/Reject (reject needs a reason >= 3 chars). NB: approvals.js `details()` renders no BSB/account detail for `employee_bank` (only the title), unlike company/supplier bank approvals.
API: `payroll_employee_get` (people-read perms), `payroll_employee_save`, `payroll_import_onboarding`, `payroll_bank_request`, `leave_adjust`, `payroll_employee_stp_save`, `pay_run_bank_list` = `payroll.sensitive`.

Employee/bank/leave-adjust errors (exact):
- UI field errors: "That TFN isn't valid. Check the digits." (TFN check-digit), "Enter the base hourly rate." (hourly basis, rate not > 0), "Enter the annual salary.", "A BSB is 6 digits, like 062-000.", "An account number is 5 to 10 digits."
- API/SQL: "Employee not found." / "Someone else in payroll must change your own pay details." / "Contractors are paid through bills, not payroll." / "That TFN isn't valid. Check the digits." / "Enter the TFN, or choose another TFN status." / "Choose an expense or cost of sales account for wages." / "The super fund ABN isn't valid." / "<label> must be a positive number." (e.g. "The hourly rate must be a positive number.", "Ordinary hours...", "Casual loading...", "Leave loading...", "Extra withholding...", "Salary sacrifice...") / "No TFN was found in their accepted onboarding forms." (409) / "No bank account was found in their accepted onboarding forms." (409)
- Bank request: "Set up the employee's pay details first." / "A BSB is 6 digits, like 062-000." / "An account number is 5 to 10 digits." / "Enter the account name."
- Approval decision: "Approval not found." / "This has already been decided." / "Someone else must approve a change you requested." / "Someone else must approve a change to your own bank details." / `You need the "Approve pay runs" permission for this.` / "Give a reason for rejecting it."
- Leave adjust: "Choose a type of leave." / "Unknown adjustment." / "Enter the hours (negative to reduce the balance)." / "Say why the balance is being adjusted." (note < 3 chars)

### 3.3 Pay runs list - route `#/pay-runs`
h1 "Pay runs". Lead: "Hours come from approved timesheets, leave from approved requests. Someone other than the preparer approves each pay run; approving posts it to the ledger and makes it final." Button "New pay run" (`payroll.run`).
Columns: Pay run (number PR-00001 + frequency), Period ("<start> to <end>"), Payment, Status (chip), People, Gross, Tax, Net, Super (chip "Paid <date>" green / "Due <date>" amber / red when overdue; shown only for approved/paid runs with super).

### 3.4 Pay run statuses (RUN_STATUS) and transitions
| Stored | Label | Chip |
|---|---|---|
| draft | Draft | pending |
| submitted | Waiting for approval | info |
| approved | Approved, not yet paid | good |
| paid | Paid | good |
Flow:
- Create (`payroll.run`) -> **draft** (calculated immediately).
- Draft: Recalculate; add/remove manual lines; "Submit for approval" -> **submitted**; "Delete draft".
- Submitted: "Approve and post" (`payroll.approve`) -> **approved**; "Send back" -> draft (reason >= 3 chars; allowed for `payroll.approve` holders or the preparer).
- Approved: record net pay -> **paid** (`pay_runs.status='paid'`, `paid_at`). Super can be recorded in approved OR paid state; recording super does not change status (sets `super_paid_at`).
- Approved/paid runs are final: cannot be changed or deleted ("Approved pay runs are final"); corrections go in a later run.
Rules: one open (draft/submitted) run per frequency; no overlapping periods per frequency.

### 3.5 New pay run - route `#/pay-runs/new` (`payroll.run`)
h1 "New pay run". Lead: "Everyone on this pay frequency is included and worked out straight away. You can add allowances, bonuses and deductions before submitting it for approval."
Fields: "Frequency" (`pr-f`: Weekly/Fortnightly/Monthly; default from Company settings pay frequency), "Period start" (`pr-s`), "Period end" (`pr-e`; auto +6 / +13 days when start changes; monthly = whole month), "Payment date" (`pr-p`; defaults from company pay day). Text: "Super must reach each fund within 7 business days of the payment date (Payday Super)." Buttons "Create and calculate", "Cancel".
Errors: "Choose how often this pay run pays." / "Choose the pay period and payment date." / "A weekly pay period must be 7 days long." (fortnightly: "14 days"; monthly: "a calendar month") / "The payment date can't be before the period starts." / "A weekly pay run already covers part of this period." / "Finish (approve or delete) the open weekly pay run first." / "No PAYG withholding rules are recorded for payments on <date>. An administrator must add the ATO schedule first." (payment dated before 1 Jul 2026) / "No super guarantee rate is recorded for <date>." / "The period start/end/payment date must be a date" style from API date helper.
Calculation (SQL `pay_run_calculate`): includes active payroll employees on that frequency whose start/end dates overlap the period; salary staff = annual salary / periods; hourly staff from timesheets (3.5/2.5); approved leave starting on/before period end is claimed (paid leave lines at base rate; Annual leave adds "Leave loading N%" line; unpaid leave reduces salary). PAYG per Schedule 1/8 on taxable pay after salary sacrifice, plus extra withholding. Super guarantee = 12% of qualifying earnings up to the maximum contribution base ($270,830 yr) ; none for under-18 working <= 30 h/week. Net = gross - tax - salary sacrifice - deductions + reimbursements. Employee warnings (shown in red/amber under the name): "No pay rate is set." / "The base rate X is below the national minimum wage (Y an hour). Check the award rate." / "Working holiday makers are taxed under Schedule 15, which isn't calculated here. Work out the amount with the accountant and enter it as their extra withholding before submitting." / "No bank account on file." / "No super fund on file. Request the stapled fund from the ATO, or use the default fund." / "No longer paid on this pay run's frequency or dates: only the manual lines are paid." / "<Leave type> balance is less than the N hours being taken." / "Some timesheet hours in this period aren't approved yet and aren't included." / "Deductions are more than the pay. Net pay can't be negative."

### 3.6 Pay run page - route `#/pay-runs/<id>`
Eyebrow "PAYROLL · PAY RUN"; h1 "PR-00001" + status chip; sub-line "weekly · 5 Oct 2026 to 11 Oct 2026 · paid 14 Oct 2026 · prepared by X · approved by Y <time>".
Cards: "Gross"; "Tax withheld" (small "Owed to the ATO, reported on the BAS"); "Net pay" (small "To pay employees" / "Paid <date>"); "Super" (small "Due by <date>" / "Paid <date>"; card flagged attention when overdue). `.note` "N thing(s) to check below." when warnings exist.
Employee table (each row expandable via `[data-toggle]` "▸ Name"): columns Employee (scale text such as "Scale 2 (tax-free threshold)", "· study loan", warnings) | Hours | Gross | Tax | Deductions | Net | Super | (Payslip link when approved/paid). Footer "Total". Expanded: inner table Item | Hours | Rate | Amount | (Remove for manual lines in draft), summary "Taxable x · tax y (incl. z study loan) · salary sacrifice ... · super guarantee a on b"; add-line form (draft, `payroll.run`): "Add" (pay item select, e.g. "Bonus (earning)", "Union fees (deduction)"; SALARY excluded), "Description on the payslip", "Hours", "Rate", "or Amount", button "Add" (flash "Added and recalculated."). Manual lines tagged "added by hand".
Seeded pay items: ORD Ordinary hours, OT150, OT200, TRAVEL, SALARY, AL Annual leave, LL Annual leave loading, PL Personal / carer's leave, LSL, PH Public holiday (not worked), BONUS Bonus, TOOL Tool allowance, MEAL Overtime meal allowance, REIMB Expense reimbursement (account 7900), UNION Union fees, DEDUCT Other deduction.
Buttons (`[data-act]`): "Recalculate" (draft + payroll.run; flash "Recalculated."; note "Worked out <time>. Recalculate after approving more timesheets or leave."), "Submit for approval" (draft + payroll.run; flash `Submitted. Someone with "Approve pay runs" approves it next.`), "Approve and post" (submitted + payroll.approve + not preparer + not paid in run; confirm dialog: "Approve PR-xxxxx? It posts to the ledger, marks the timesheet hours and leave as paid, and can't be changed afterwards. Corrections go in a later pay run."; flash "Approved and posted. Pay the net amounts and the super, then record both here."), "Send back" (submitted; prompt "Send this pay run back to draft? Say what needs changing:"; flash "Sent back to draft."), "Bank file (ABA)" and "Bank payment list (CSV)" (approved/paid, `payroll.sensitive` only), "Delete draft" (confirm "Delete this draft pay run? Nothing has been paid or posted."). If submitted, you hold approve but are blocked: "You prepared this pay run or are paid in it, so someone else must approve it."
Ledger line under actions: "Ledger: <journal no>" · "net pay <journal>" · "super <journal>" (links to `#/journals/<id>`).
Panel h2 "Record payments" (approved/paid; `payroll.run` or `bank.manage`): text "Record each payment after it has left the bank, or match the bank statement line in Reconciliation, which records it for you." Forms: "Net pay from" (`pn-b`, bank accounts), "Date" (`pn-d`, default payment date), button "Net pay $x paid"; "Super from" (`ps-b`), "Date" (`ps-d`, default today), button "Super $x paid". Flash "Recorded." Neither moves money: they only post ledger journals.
Downloads: ABA flash `Downloaded <PR-xxxxx>.aba: N payment(s), $total. Upload it in your bank's internet banking, then record the net pay as paid. It holds bank details: delete it after uploading. The download is recorded in the audit log.` CSV (columns Name, Employee no., Account name, BSB, Account number, Amount, Reference "PAY PR-xxxxx") flash "Downloaded. It contains full bank details: delete it once the payments are made. The download is recorded in the audit log."
Payslips: row link "Payslip" (needs RUN_READ perms; PDF `Payslip-<Name>-<date>.pdf`); error "Payslips are available once the pay run is approved." (409) / "Payslip not found."
API perms: `pay_runs_list`, `pay_run_get`, `payslip_pdf`, `payroll_summary` = payroll.run|approve|sensitive; `pay_run_create|recalculate|line_add|line_remove|submit|delete` = payroll.run; `pay_run_return` = payroll.run|approve; `pay_run_approve` = payroll.approve; `pay_run_record_payment|record_super` = payroll.run|bank.manage; `pay_run_bank_list`, `pay_run_aba` = payroll.sensitive.

### 3.7 What each pay run action does (SQL) and segregation
- **Submit** (`pay_run_submit`, payroll.run): recalculates; drops people with nothing to pay; sets `prepared_by` = the submitter; locks claimed timesheet weeks (`payroll_locked_at`); notifies `payroll.approve` holders ("Pay run to approve: PR-xxxxx" / "Paid <date> · net $x", link pay-runs). Errors: "Only a draft pay run can be submitted." / "Nobody is being paid in this pay run." / "Someone's net pay is negative. Fix their deductions first." / "A working holiday maker has no tax withheld. Enter their Schedule 15 amount as extra withholding first."
- **Send back** (`pay_run_return`): "Only a submitted pay run can be sent back." / "Say what needs changing." Unlocks timesheet weeks (unless an approved run paid part). Notifies preparer ("Pay run sent back: PR-xxxxx").
- **Approve and post** (`pay_run_approve`, payroll.approve): refusals: "Only a submitted pay run can be approved." / "Someone other than the people who prepared it must approve the pay run." (preparer or anyone who added/removed lines = `edited_by`) / "You're paid in this pay run, so someone else must approve it." Effects:
  1. Ledger journal dated the payment date, source `pay_run`, description "Pay run PR-xxxxx (5 Oct to 11 Oct 2026)", no tax codes:
     Dr the employee's wages account (default 5000 Direct Labour; 6000 Administration Wages for office) for earnings + allowances; Dr 6100 Employer Superannuation (super guarantee); Dr reimbursement account (pay item's, default 7900 Miscellaneous Expenses);
     Cr 2100 PAYG Withholding Payable (tax + study loan + extra withholding); Cr 2200 Superannuation Payable (super guarantee + salary sacrifice); Cr 2600 Employee Deductions Payable; Cr 2400 Payroll Clearing (net pay).
  2. Leave: each leave request in the run becomes status paid and a `taken` transaction (negative hours) is written; leave ACCRUALS written for non-casual staff with ordinary hours: Annual = ordinary hours x annual weeks/52 (4/52 or 5/52 = 0.0769231/h); Personal = ordinary hours x 0.0384615 (2/52); Long service/Compassionate/Unpaid accrue 0. Dated period end, note "Accrued in PR-xxxxx". Casuals accrue nothing.
  3. Timesheet weeks stay locked (paid). Payslip snapshots (lines, YTD, leave balances, masked bank) fixed per employee.
  4. Run status approved; preparer notified ("Pay run approved: PR-xxxxx" / "Pay the net amounts and the super, then record both.").
- **Record net pay** (`pay_run_record_payment`): only when status approved. Journal "Net pay for PR-xxxxx": Dr 2400 Payroll Clearing, Cr chosen bank account; status -> paid. Errors "Only an approved, unpaid pay run can be marked as paid." / "Choose the bank account the pay came from."
- **Record super** (`pay_run_record_super`): journal "Super contributions for PR-xxxxx": Dr 2200 Superannuation Payable, Cr bank; sets `super_paid_at`. Errors "Super for this pay run is already recorded, or the run isn't approved." / "There is no super to pay in this pay run." / "Choose the bank account the super came from."
- Bank reconciliation can also record both (action `bank_pay_run`).
- **Delete**: "Only a draft pay run can be deleted. Approved pay runs are final."
- Line errors: "Lines can only be added to a draft pay run." / "Choose a pay item." / "Enter an amount, or hours and a rate." / "Describe the line; it appears on the payslip." / "That employee isn't paid in this pay run." / "Only manual lines on a draft pay run can be removed." / "Hours, rate and amount must be numbers." / "Only a draft pay run can be recalculated." / "Pay run not found."
- ABA errors (`pay_run_aba`, in banking.ts): "The bank file is available once the pay run is approved." / "No company bank account is set up for bank files yet (Banking > Bank accounts)." / "More than one bank account is set up for bank files: mark the one for wages as the payroll account." / "No approved bank account for <names>. Pay them separately or approve their bank details first." / "Some net pays aren't in the file. Check the pay run." Bank list: "Approve the pay run first."
- Segregation summary: approver != preparer (the one who SUBMITTED), != anyone who edited lines, != anyone paid in the run. Payroll admin (payroll.run, no approve) prepares; Director (payroll.approve, no run) approves. A person holding both can prepare but is blocked from approving own run. System administrators hold BOTH payroll.run and payroll.approve by default but not payroll.sensitive.

### 3.8 Leave - route `#/leave` (approvers) and My pay (employees)
**Leave statuses (STATUS map):** submitted = "Waiting" (pending), approved = "Approved" (good), rejected = "Declined" (bad), cancelled = "Cancelled", paid = "Taken and paid" (info).
Transitions: submitted -> approved / rejected(Declined) (`leave.approve`, never own, never leave you recorded for someone else; decline needs reason >= 3 chars); submitted or approved -> cancelled (the employee themself, or `leave.approve`; refused if already claimed by a pay run no longer in draft); approved -> paid (when the pay run containing it is approved; leave balance reduced then, and leave is "paid in the next pay run" that covers its first day, i.e. start date <= period end).
Screen: h1 "Leave". Lead: "Approved leave is paid in the next pay run and taken off the balance then. You can't approve your own leave." Tabs (role=tab, `[data-st]`): Waiting | Approved | Declined | Cancelled | Taken and paid (default Waiting). Columns: Employee (link, "You" marker, reason under), Leave (type), Dates, Hours, then on Waiting tab "Balance now" (red if balance < hours for Annual/Personal/Long service) + buttons "Approve" / "Decline" (`[data-ok]`, `[data-no]`; hidden for own rows); other tabs "Decided" (who, when, comment). Empty "Nothing here."
Prompt on Decline: "Decline this leave? Tell the employee why:". Flashes "Approved." / "Declined."
Form (needs `leave.approve`) h2 "Record leave for someone": text "For leave arranged by phone or on paper. It still needs approval by someone other than the employee." Fields "Employee" (`lf-emp`; active, in-payroll only), "Type" (`lf-type`), "Hours" (`lf-hours`; hint "A full day is usually 7.6 hours"), "First day" (`lf-start`), "Last day" (`lf-end`), "Note" (`lf-reason`); button "Record request"; flash "Recorded. It's in the waiting list for approval."
Leave types: Annual leave (ANNUAL), Personal / carer's leave (PERSONAL), Long service leave (LONGSERV), Compassionate leave (COMPASS), Unpaid leave (UNPAID).
Notifications: new request -> `leave.approve` holders ("Leave to approve: <name>"); decision -> employee ("Leave approved/declined/cancelled: DD Mon to DD Mon", link my-pay).
Errors: "You're not set up in payroll yet." / "Employee not found." / "Choose a type of leave." / "Choose the first and last day of leave." / "A leave request can cover at most a year." / "Enter the hours of leave." / "Casual employees don't get paid leave of this type." / "Leave request not found." / "This request can't be cancelled now." / "This leave is in a pay run waiting for approval. Ask payroll to send the pay run back first." / "Only a waiting request can be approved or declined." / "Someone else must approve your own leave." / "You recorded this leave, so someone else must approve it." / "Give a reason for declining it." / "Unknown decision." / API "Choose a decision."
API perms: `leave_list` (leave.approve, payroll.sensitive, payroll.run), `leave_request` and `leave_decide` (payroll.self, leave.approve).

### 3.9 My pay - route `#/my-pay` (`payroll.self`)
Eyebrow "MY PAY"; h1 = employee name; lead "Your payslips, leave balances and leave requests." If the person isn't linked to an employee record: panel text "You aren't set up in payroll yet. Ask the payroll officer." (404 message).
Cards: one per leave type with accrual (e.g. "Annual leave" `35.32 h`, "≈ 4.6 days of 7.6 hours"). h2 "Payslips" (table Paid | Period | Gross | Tax | Net | button "Download"; empty "No payslips yet."; payslip only for approved/paid runs). Form h2 "Request leave": "Type" (`my-type`; casuals don't see paid types), "First day" (`my-start`), "Last day" (`my-end`), "Hours" (`my-hours`; hint "A full day is usually 7.6 hours"), "Note (optional)" (`my-reason`), button "Send request"; flash "Sent. You'll get a notification when it's decided." h2 "My requests" with status chips and link "Cancel" (for Waiting/Approved; confirm "Cancel this leave request?"; flash "Cancelled."). Requests are decided by `leave.approve` holders. Payslip PDF contains employer name/ABN, items, tax, super, YTD, leave balances.
API `my_pay`, `my_payslip` = `payroll.self`.

### 3.10 Super - route `#/super`
h1 "Super". Lead: "From 1 July 2026 super guarantee is worked out on qualifying earnings each pay and must reach the fund within 7 business days of payday (Payday Super). Rate 12%; maximum contribution base $270,830 a year." Card "Not yet paid" ($ total; small "Some is overdue: late super attracts the super guarantee charge." / "Next due <date>" / "All recorded as paid"; flagged attention if overdue). Table Pay run | Payday | Due by | Super | Status (chips "Paid <date>", "Overdue", "Due"); empty "No super yet." Footnote: "The due date counts weekdays only; if a public holiday falls in between, the real due date is a day later. Contributions are paid through your clearing house; record each payment on its pay run." (the last clause only for `payroll.run`).
**It is a REPORT only.** It lists approved/paid pay runs with super > 0 (super = super guarantee + salary sacrifice). It makes NO payments, creates NO SuperStream/clearing-house file, does not talk to funds or a clearing house, and has no buttons. Recording that super was paid is done on the pay run page ("Super $x paid") or by matching a bank line; that only posts Dr 2200 Cr bank. Due date = payment date + 7 weekdays (public holidays ignored). Integrations screen states nothing claims SuperStream approval; "Super clearing house" is only a free-text name in Company settings (note: "The ATO's free clearing house closed on 1 July 2026").

### 3.11 Payroll reports - route `#/payroll-reports`
Menu "Payroll reports"; h1 "Payroll summary". Lead (stale wording): "Approved pay by employee for a date range (by payment date). Single Touch Payroll reporting to the ATO arrives in Phase 8; until then, keep lodging STP from your current payroll product." Fields "From" (`#ps-f`, default 1 July of current financial year), "To" (`#ps-t`, default today), button "Show". Columns: Employee (link; number) | Pays | Gross | Tax | incl. study loan | Salary sacrifice | Deductions | Super guarantee | Net; total row. Empty "No approved pay in this range." Button "Export CSV" (`data.export`; API 403 "Exporting needs the data export permission."; audited). CSV columns: Employee, Employee no., Pays, Gross, Tax withheld, Study loan component, Salary sacrifice, Deductions, Reimbursements, Super guarantee, Net; file `payroll-summary-<from>-to-<to>.csv`. Includes runs in status approved or paid. Error "The payroll summary could not be loaded."

### 3.12 STP - routes `#/stp`, `#/stp/<eventId>`
**What STP does here:** prepares and validates STP Phase 2 information (employer details, per-employee year-to-date amounts by category, tax treatment/income/TFN codes), lets a second person mark it Ready, and exports JSON/CSV for checking against the current STP product. **What it does NOT do:** send anything to the ATO. Transmission is switched off in the database (`stp_settings.transmission_enabled` has a CHECK that forces false; `stp_event_submit` always raises). The app is not ATO approved/STP certified. Statuses Sent/Accepted/Partly accepted/Rejected/Corrected/Finalised exist in the map but are unreachable.
Screen `#/stp`: eyebrow "PAYROLL", h1 "Single Touch Payroll". Lead: "STP Phase 2 information for each pay run, checked against the reporting rules. **Sending to the ATO is switched off**: keep reporting through your current STP payroll product and use these to check it. Sending needs ATO product registration, conformance testing and an approved sending service provider first."
Tabs (`[data-tab]`): "Events", "Pay item mapping", "Settings" (`?tab=` supported).
- Events tab: (payroll.run) panel h2 "Pay runs without an STP pay event" - rows "PR-xxxxx  Paid <date>" + button "Prepare pay event" (`[data-pay]`; only for approved/paid runs). Year form `form[data-year]` (payroll.run): "Event" (`sy-k`: "Update event (corrections)" / "Finalisation for the year"), "Financial year" (`sy-y`, last 3 FYs like 2026-27), "Year to date at (optional)" (`sy-d`), button "Prepare". Table columns Event (Pay event / Update event / Finalisation + pay run no.) | Date | Status | Employees | Gross YTD | PAYG YTD | Prepared | Ready. Empty "No STP events yet."
- Pay item mapping tab: "Each pay item is reported in its STP Phase 2 category. Check these with your accountant; changes apply to events prepared from now on." Columns Pay item | Kind | STP category | Type | (Save link). Categories: "Gross (salary and wages)", "Overtime", "Bonuses and commissions", "Directors' fees", "Paid leave", "Allowance", "Deduction", "Not reported". Type codes: paid leave O/C/U/P/W/A, allowances CD/AD/LD/MD/RD/TD/KN/QN/G1/H1/ND/T1/U1/V1, deductions F/W/G/D. Editing needs `payroll.sensitive`; flash "Saved." Note: "Reimbursements and deductions other than union fees, workplace giving and child support aren't reported. Salary sacrifice to super is reported separately (type S) and taken off gross; super guarantee, ordinary time earnings and reportable employer super contributions come from the pay runs."
- Settings tab: h2 "Employer details for STP" (company name · ABN from Company settings); fields "Branch number" (`ss-b`; hint "Usually 001"), "Contact name" (`ss-n`), "Contact phone" (`ss-p`), "Contact email" (`ss-e`); line "Software ID (BMS ID) for this payroll: <uuid>. Sending to the ATO: **off**." Save (payroll.sensitive) flash "Saved."
**STP event statuses (STP_STATUS):** draft = "Has errors" (bad); validated = "Checked" (info); ready = "Ready" (good); submitted = "Sent" (info); accepted = "Accepted" (good); partially_accepted = "Partly accepted" (warn); rejected = "Rejected" (bad); corrected = "Corrected"; finalised = "Finalised" (good). Reachable here: draft, validated, ready only. Event kinds: "Pay event", "Update event", "Finalisation".
Event page `#/stp/<id>`: eyebrow "PAYROLL · STP"; h1 "<Kind> <status chip>"; sub-line pay run link/"Year to date at <date>" · "financial year 2026-27" · "prepared by X <time>" · "ready, X <time>". Button "All events". Employer errors block "Employer details to fix:". Summary "N employee(s), M with errors / no errors. Year to date: gross (salary and wages, after salary sacrifice) $x, PAYG $y (this pay run: gross, PAYG)." Buttons: "Check again" (draft/validated + payroll.run), "Mark ready" (validated + payroll.approve + not the preparer; confirm "Mark this STP event ready? Its figures are fixed now."; flash "Ready."), "Download (JSON)" / "Download (CSV)" (`payroll.sensitive`; contain full TFNs; audited), disabled "Send to the ATO (off)" (tooltip "Sending to the ATO is switched off"), "Delete" (draft/validated + payroll.run; confirm "Delete this STP event?"). Message under: "Downloads hold tax file numbers: keep them private and delete them after use. Every download is logged." When validated and you can't mark ready: "Someone who approves pay runs (not the preparer) marks it ready." Check flashes "Checked: no errors." / "Still has errors." Table Employee (family, given · number · "TFN ••• ••• 782" hidden unless sensitive; red errors; "Note:" warnings) | Codes (employment basis F/P/C · tax treatment code e.g. RTXXXX · income type) | Gross | Other amounts | PAYG | Super (L liability, OTE, RESC). Foot: "Codes: employment basis (F full-time, P part-time, C casual) · tax treatment · income type. Fix an employee's details on their page (STP details), then check again."
Employee "STP details" form (`form[data-stp]`, on employee page for payroll.sensitive; button "Save STP details"; flash "STP details saved."): "Family name" (`st-fn`; hint "As on their tax file number declaration"), "Given names" (`st-gn`), "Income type" (`st-it`: SAW Salary and wages, CHP, WHM, IAA, FEI, SWP, LAB, VOL, OSP, JPD), "Home address" (`st-st`), "Suburb" (`st-sb`), "State" (`st-se`), "Postcode" (`st-pc`), "Country (two letters, if needed)" (`st-cc`; hint "Only for WHM, IAA and FEI"), "Reason they left (when they finish)" (`st-ce`: Still employed, V Voluntary, I Ill health, D Deceased, R Redundancy, F Dismissal, C Contract ended, T Transfer).
Workflow: approve a pay run -> Prepare pay event (payroll.run; "STP is prepared once the pay run is approved."; one per run: "This pay run already has an STP pay event.") -> if errors it stays "Has errors": fix and "Check again" -> "Checked" -> different person with payroll.approve "Mark ready" -> "Ready". Update event: only staff whose YTD changed since last ready event ("Nobody's year-to-date figures have changed since the last STP event."); finalisation: everyone paid in the year, each pay run needs a ready pay event ("Some pay runs in this year have no STP pay event marked ready (PR-xxxxx). Prepare those first.").
Errors/checks (record-level): "Family name is missing." / "Date of birth is missing." / "Home address is incomplete (street, suburb, state and postcode)." / "Start date is missing." / "The TFN isn't valid." / "They finished on DD Mon YYYY: choose the reason they left (cessation type)." / "A cessation type is set but there is no finish date." / "Income type X needs the country (two-letter code)." / "A working holiday maker's income type is WHM." / "Income type WHM is only for working holiday makers." / "Gross for the year is negative after salary sacrifice." Employer-level: "The company ABN is missing or not valid (Company settings)." / "The company legal name is missing." / "The company address is incomplete (Company settings)." / "Add the STP contact person's name and phone number (Payroll > STP > Settings)." Warnings: "Tax treatment HR assumes Panalo is a registered working holiday maker employer. Use HU if not." / "TFN applied for more than 28 days ago: reported as not quoted. Ask for the TFN." / "No pay this financial year."
Other STP errors: "The branch number is 3 digits (usually 001)." / "That email address doesn't look right." / "Choose the STP category." / "Pay item not found." / "A deduction is reported as a deduction, or not reported." / "Reimbursements aren't reported." / "Earnings and allowances can't be reported as deductions." / "That STP category and code don't go together." / "Set up their pay details first." / "A postcode is 4 digits." / "Choose the state." / "Check the income type, country (two letters) and cessation type." / "Unknown STP event." / "Choose the financial year." / "The date must be in the financial year." / "Finish (mark ready or delete) the STP events still being prepared for this year first." / "Nobody was paid in this financial year." / "STP event not found." / "Only an event being prepared can be checked again." / "Only a checked event with no errors can be marked ready." / "Someone other than the person who prepared it must mark it ready." / "Pay or employee details have changed since this event was checked. Check it again." / "Only an event being prepared can be deleted." / Send (API only, no UI): "Sending STP to the ATO isn't switched on in Panalo Accounts. Report this pay through your current STP payroll product; it needs ATO product registration, conformance testing and an approved sending service provider first."
API perms: `stp_overview`, `stp_event_get` = payroll.run|approve|sensitive; `stp_event_pay|year|check|delete` = payroll.run; `stp_event_ready|submit` = payroll.approve; `stp_event_export`, `stp_settings_save`, `stp_item_map`, `payroll_employee_stp_save` = payroll.sensitive. Without payroll.sensitive the event page hides DOB, address and TFN digits.

---------------------------------------------------------------------------------------------------
## 4. PERMISSION / ACTION MATRIX (quick)

| Action | Needs |
|---|---|
| View projects, job costing | projects.manage or reports.view |
| Create/edit project, status, budgets, cost codes, labour classes/rates, assign class | projects.manage |
| See rates / individual labour cost | projects.manage |
| Enter own timesheet | time.submit or time.approve |
| Enter crew member's week; approve/send back; reopen approved | time.approve (never own; never week you submitted for them) |
| Review list, Hours for payroll | time.approve, projects.manage or payroll.run |
| Employees list / page (non-sensitive) | payroll.sensitive, run, approve or leave.approve |
| Edit pay/tax/super/STP details, import onboarding, request bank change, adjust leave balances, bank file/list, STP export/settings/mapping | payroll.sensitive (not for yourself) |
| Approve bank change | payroll.approve (not requester, not the employee) |
| Create pay run, add lines, recalc, submit, delete, record pay/super, prepare STP events | payroll.run (record also bank.manage) |
| Approve pay run, mark STP ready | payroll.approve (not preparer/editor/paid-in-run; STP not creator) |
| Send back pay run | payroll.approve or payroll.run (UI shows button to approvers and the preparer) |
| Leave approve/decline, record leave for others | leave.approve |
| My pay, request/cancel own leave, payslips | payroll.self |
| Super, Payroll reports, STP views | payroll.run, payroll.approve or payroll.sensitive |
| CSV export of job costing / payroll summary | data.export |

---------------------------------------------------------------------------------------------------
## 5. TEST DATA (committed vs rolled back) and best test users

Files in `supabase/tests/db/*.test.sql` run in filename order into one throwaway database (api tests re-run them as fixtures). Top-level `begin;` ... `rollback;` appears only in `zzz_bas.test.sql`, `zzzz_stp.test.sql`, `zzzzz_assets.test.sql` (all their data is discarded). All other files run in autocommit and keep their data (apart from inner `ROLLBACK_OK` savepoint blocks, noted).

Users (all `@fin.test`, created by inserting into `auth.users`; passwords/MFA are not part of fixtures):
| Email | Created in | Role / permissions | Use for screenshots |
|---|---|---|---|
| sysadmin@fin.test | finance_foundation | `training_profiles.role='admin'` (admin_default keys; no payroll.sensitive) | negative case: sees Employees page without pay sections; can create AND approve pay runs (not the same one) |
| finance@fin.test | finance_foundation | finance_admin | Projects/Job costing (reports.view); recording payments; "not in payroll" case (My pay shows "You aren't set up in payroll yet. Ask the payroll officer."); NO Pay runs/Timesheets menu |
| director@fin.test | finance_foundation | director (payroll.approve, payroll.self, reports.view) | approve pay run, approve bank change (Approvals), mark STP ready, Super, STP, Payroll reports; no Leave or Timesheets menu |
| payroll@fin.test | finance_foundation | payroll_admin (sensitive, run, leave.approve, time.approve) | Employees (full), New pay run, add lines, Submit, Leave approvals, Hours for payroll, STP prepare, bank file |
| staff@fin.test | finance_foundation | no role | negative: no access |
| pm@fin.test | sales_purchasing | project_manager (set by `app_set_profile_role`) | Projects, project page, Cost codes and rates, Timesheets Review/Approve |
| welder1@fin.test, welder2@fin.test, welder3@fin.test | timesheets_job_costing | direct `time.submit` only | timesheet entry (My week); welder2 has NO labour class (cannot be approved until set) |
| tradie@fin.test | workforce_payroll | direct `time.submit` + `payroll.self`; employee PAY-001 Tom Tradie | My pay with a payslip; My week |
| office@fin.test | workforce_payroll | direct `payroll.self`; employee PAY-002 Olivia Office | My pay, leave request |

Committed data:
- Projects (pm manages): **JOB-1001 "Berth 4 pipework"** (customer Hunter Refinery Pty Ltd, site Kooragang Berth 4, contract $20,000, start 1 Sep 2026; budget: cost 110 welding 40 h/$3,000; 200 materials $5,000; 400 subcontract $2,000 = $10,000), with approved welder1 week 7 Sep 2026 (25.5 h, $1,722.50), welder2 week 7 Sep 2026 Sent back ("Thursday was rained off"), welder2 week 14 Sep 2026 draft entered by pm, approved bills (materials net $1,900 after a credit; $750 subcontract), a $750 open PO commitment, approved invoice $8,000 + GST. Labour class WELDER set to cost $65/charge $110 (other classes $0); welder1 and welder3 assigned WELDER. Further projects: JOB "Short job" (closed; welder3 weeks Aug 2026, one approved with 2 versions, an Argon PO/bill $1,000), "Old job" (closed), "Lost tender" (cancelled), and sales-test projects (check numbering in the Projects list). 
- Employees: **PAY-001 Tom Tradie** (full-time hourly $40, weekly, TFN provided, AustralianSuper, bank 062-000 / 12345678 approved by director; onboarding items: accepted `tfn_declaration` and `bank_details` 87654321 — for demoing "Fill in from onboarding"), **PAY-002 Olivia Office** ($78,000 salary, scale 1, study loan, $100/wk salary sacrifice, wages account 6000, annual leave opening balance 40 h), **PAY-003 Casey Casual** (casual $30/h, no TFN), **PAY-004 Jamie Junior** (16 years, $25/h). PAY-099 (Pat Payroll) is rolled back.
- Pay run: one weekly **paid** pay run (number PR-00001-style, period 5-11 Oct 2026, payment 14 Oct 2026): gross $4,067.50, tax $1,003.00, super $513.70, net $2,949.50; approved by director; net recorded 14 Oct, super recorded 16 Oct from account 1000. Tom: gross $1,640.00 / PAYG $343 / super $182.40 / net $1,297.00. Olivia: gross $1,552.50 (incl. 7.6 h annual leave + 17.5% loading), PAYG $463, salary sacrifice $100, deduction $15 union fees, net $974.50. Casey: $375 / PAYG $176 / net $199. Jamie: $500 / PAYG $21 / no super / net $479 with national minimum wage warning. Olivia annual leave balance ~35.32 h, Tom personal ~1.46 h. Olivia's leave request is "Taken and paid". The inner "review fixes" block (second pay run 12-18 Oct, unpaid leave, PAY-099) is rolled back, so NO draft/submitted pay run, and NO STP events, exist in the committed fixture (STP data is rolled back; settings contact missing, so first prepared STP event would show "Has errors").
- No pending leave requests, no waiting timesheets (welder2's week is Sent back, welder1's week 21 Sep exists only in API tests).
For screenshots needing a draft/submitted pay run, STP events, or a waiting timesheet: create them live (see below). Note a new weekly pay run must start after 11 Oct 2026 (e.g. 12-18 Oct, payment 21 Oct) and payments before 1 Jul 2026 are refused.

---------------------------------------------------------------------------------------------------
## 6. SCREENSHOTS TO CAPTURE

(Route / best user / state / selectors to highlight)
1. Projects list - `#/projects` / pm@fin.test (or director for read-only) / JOB-1001 visible / `.page-head .actions a.btn` ("Cost codes and rates", "New project"), `form[data-filter] #p-st`, `table.tbl`.
2. New project form - `#/projects/new` / pm / empty / `#pj-name`, `#pj-cust`, `#pj-value`, budget table `[data-budget]`, `[data-margin]`, button `button[type=submit]` "Save project".
3. Project page (job costing for one) - `#/projects/<JOB-1001 id>` / pm / as at default / cards `.cards.figures`, `form[data-asat]`, cost-code table `table.tbl.report`, status buttons `[data-status]`.
4. Job costing - `#/job-costing` / director (no Cost column on labour) and pm / `[data-csv]` (needs data.export: director/finance), `#jc-st`, `table.report tfoot tr.grand`.
5. Cost codes and labour rates - `#/projects/settings` / pm / `[data-class]` rows, `[data-save-class]`, `select[data-assign]`, `[data-code]` rows, `[data-save-code]`.
6. My week (entry) - `#/timesheets` / tradie@fin.test or welder1 (use a current/future week via `?week=`; new draft week) / `#ts-week`, `.entry` rows (`[data-entry]`), `[data-add]`, `[data-total]`, buttons `[data-act=save]`, `[data-act=submit]`.
7. Submitted/recall state - same route after Submit / tradie / `[data-recall]`.
8. Review (Waiting) - `#/timesheets/review` / pm or payroll@ after tradie submits / `button[data-st]` tabs, rows with "You" marker; then open a week and show `[data-approve]`, `[data-reject]`; approved week with `[data-reopen]` and h2 "Approved versions" (welder1 week 7 Sep 2026 `?week=2026-09-07&person=<welder1 id>` as pm).
9. Hours for payroll - `#/timesheets/hours` / payroll@ / set From 2026-09-01 To 2026-09-30 / `#h-from`, `#h-to`, `[data-csv]`.
10. Employees list - `#/employees` / payroll@ (shows Rate col) vs director (no Rate) / `#em-show`, "Needs attention" column.
11. Employee page - `#/employees/<PAY-001 id>` / payroll@ / sections `form[data-pay]`, `[data-import]` ("Fill in from onboarding" - fixture has accepted onboarding items for Tom), tax block `#py-tfns #py-tfn #py-res #py-tft #py-stsl #py-med`, super `#py-fund #py-usi #py-fundabn #py-member #py-ss`, `form[data-stp]`, `form[data-bank]` (`#bk-name #bk-bsb #bk-acct`), leave `[data-adjust]`, "Pay history" `[data-slip]`. For "Bank change waiting for approval" state submit a request as payroll@ first; then show it on `#/approvals` as director.
12. New pay run - `#/pay-runs/new` / payroll@ / `#pr-f #pr-s #pr-e #pr-p`, `[data-create] button[type=submit]`.
13. Draft pay run detail with warnings - `#/pay-runs/<new id>` / payroll@ after creating 12-18 Oct 2026 / `[data-toggle]`, `form[data-add]`, `[data-act=recalc]`, `[data-act=submit]`, `[data-act=delete]`.
14. Submitted pay run: approve - same / director@ / `[data-act=approve]`, `[data-act=return]`; payroll@ sees note "You prepared..." only if it also had approve.
15. Approved/paid pay run (fixture PR for 5-11 Oct) - `#/pay-runs/<id>` / payroll@ or director / cards, ledger links, `[data-slip]`, `[data-act=aba]`, `[data-act=banklist]` (payroll@ only; ABA shows error unless a bank account is configured), `form[data-pay=net]`, `form[data-pay=super]` (visible only while unpaid: fixture is fully paid; create a new run and approve it to capture).
16. Pay runs list - `#/pay-runs` / director / status chips, Super column chips.
17. Super - `#/super` / director or payroll@ / `.cards.figures`, table; use a freshly approved run to show "Due" chip.
18. Payroll reports - `#/payroll-reports` / director (has data.export) / `#ps-f #ps-t`, `[data-csv]`.
19. Leave - `#/leave` / payroll@ (Waiting tab; create a request as office@ first) / `button[data-st]` tabs, `[data-ok]`, `[data-no]`, `form[data-for]`.
20. My pay - `#/my-pay` / tradie@ (payslip + leave cards) and office@ (leave request form `form[data-request]`) / `[data-slip]`, `[data-cancel]`.
21. STP events - `#/stp` / payroll@ / panel "Pay runs without an STP pay event" with `[data-pay]` button for the paid fixture run; `form[data-year]`; tabs `[data-tab=events|mapping|settings]`.
22. STP event with errors - `#/stp/<id>` after "Prepare pay event" / payroll@ / red errors per employee, disabled "Send to the ATO (off)" button (`button[disabled]`), `[data-act=check]`; after fixing, director@ `[data-act=ready]`; JSON/CSV `[data-act=json]` `[data-act=csv]`.
23. STP settings and mapping tabs - `#/stp?tab=settings` and `?tab=mapping` / payroll@.
24. Approvals inbox showing employee bank request - `#/approvals` / director@ (note: no account details shown for this kind).
25. Negative/permission cases: finance@ `#/my-pay` (message "You aren't set up in payroll yet. Ask the payroll officer."); staff@ (no access gate); sysadmin@ `#/employees/<id>` showing "Pay, tax, super and bank details are only shown to people with...".

---------------------------------------------------------------------------------------------------
## 7. SURPRISES / STALE TEXT / GOTCHAS FOR THE WRITER

1. Stale in-app wording: Hours for payroll lead says "Pay runs arrive in Phase 5" and Payroll summary lead says STP "arrives in Phase 8"; both phases are built. Integrations screen still says STP data is prepared "from Phase 5". Don't copy as fact.
2. System administrators (`role='admin'`) hold `payroll.run` and `payroll.approve` (admin_default true) but not `payroll.sensitive`/`payroll.self`; the separation rule is enforced per run (preparer/editor/paid-in-run cannot approve), not by role.
3. Pay-run "preparer" for approval purposes is whoever clicked Submit (`prepared_by` overwritten at submit); anyone who added/removed a line is blocked too (`edited_by`). The Approve button still shows to such an editor (UI doesn't know `edited_by`) and then errors "Someone other than the people who prepared it must approve the pay run."
4. Timesheet payroll claim uses `work_date <= period end` and no lower bound: late-approved earlier hours are paid in the next run. Only hourly staff draw from timesheets.
5. Job-cost labour is class cost rate (management figure), unrelated to pay-run wages; neither reconciles.
6. Job costing "Margin" is invoiced less cost to date (not contract less cost); over/under billing uses cost-based progress. Draft/unapproved invoices and bills are excluded.
7. Super screen is read-only reporting: no payment, no SuperStream, no clearing-house integration; due date ignores public holidays.
8. STP: preparation/validation/export only; "Send to the ATO (off)" is permanently disabled; sent/accepted/rejected statuses are unreachable. Marking Ready also needs a different person.
9. Approvals screen shows no bank details for `employee_bank` requests (only the title "Bank details for <name>"), so approvers can't see BSB/account in-app before approving (details exist in the audit log, masked).
10. Employee bank details can only change through approval; BSB/account typed in the form never saves directly.
11. "Hours for payroll" CSV export is not gated by `data.export` (job costing and payroll summary exports are).
12. Project status buttons are UI-restricted; the API accepts any status (only closing has a guard).
13. Pay dates before 1 July 2026 fail ("No PAYG withholding rules are recorded for payments on ...").
14. The fixture DB has no draft/submitted pay run, no STP events, no waiting timesheets or leave; create them live for those screenshots. Fixture users have no passwords/MFA configured: privileged ones (payroll, director, finance, sysadmin) hit the MFA gate on first screen.
15. Timesheet week h1 for a supervisor viewing a crew member shows the person's name, not "My timesheet"; "Cost $" line only for projects.manage users.
