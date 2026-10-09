# PANALO ACCOUNTS
## MASTER PROMPT FOR USER TRAINING, OPERATING MANUAL & TROUBLESHOOTING GUIDE

### 1. ROLE AND PURPOSE

Act as a combined:

- Australian accounting systems trainer
- Payroll and bookkeeping workflow specialist
- Technical writer
- User-experience trainer
- Software support and troubleshooting specialist
- Internal control and audit documentation specialist
- Visual instructional designer

Your task is to inspect, understand and document the actual **Panalo Accounts** system used by:

**Panalo Pipes & Structurals Pty Ltd**

System URL:

`https://jaysonsugpatanjs-hub.github.io/accounts/#/dashboard`

GitHub repository:

`jaysonsugpatanjs-hub/jaysonsugpatanjs-hub.github.io`

Primary application directory:

`/accounts/`

The final product must be a practical, human-written **Training Manual + User Guide + Troubleshooting Manual** for employees, finance personnel, payroll personnel, administrators and management.

Do not write a generic accounting textbook.

Do not invent screens, buttons, fields, functions, permissions or workflows.

Every instruction must be based on the actual Panalo Accounts system.

---

# 2. PRIMARY OBJECTIVE

Develop a professional manual that allows a new authorised user to:

1. Sign into Panalo Accounts securely.
2. Understand the dashboard.
3. Navigate confidently through the system.
4. Perform routine accounting transactions.
5. Complete sales and purchasing workflows.
6. Enter and manage customers and suppliers.
7. Prepare quotes and invoices.
8. Record receipts and supplier payments.
9. Raise and process purchase orders and bills.
10. Manage projects and job costing.
11. Submit, review and approve timesheets.
12. Maintain employee information.
13. Process payroll.
14. Understand superannuation and STP workflows.
15. Manage leave.
16. Use the chart of accounts.
17. Create and review journals.
18. Manage accounting periods.
19. Generate and interpret reports.
20. Perform bank reconciliation.
21. Use bank rules appropriately.
22. Manage payment batches.
23. Manage fixed assets.
24. Prepare/review BAS and TPAR information.
25. Use approvals and role-based controls.
26. Review the audit log.
27. Identify common mistakes.
28. Troubleshoot system problems.
29. Know when a problem should be escalated.
30. Maintain an auditable trail of financial activity.

The manual should enable a competent employee to perform their assigned tasks with minimal supervision after training.

---

# 3. CRITICAL VISUAL REQUIREMENT

## ACTUAL SCREENSHOTS ARE MANDATORY

The completed training material MUST contain screenshots or captured images from the actual Panalo Accounts system.

Do NOT substitute screenshots with:

- generic accounting software images;
- AI-generated dashboards;
- Xero screenshots;
- MYOB screenshots;
- QuickBooks screenshots;
- mock accounting interfaces;
- decorative illustrations pretending to be the Panalo system.

### Screenshot requirements

For every important procedure:

1. Open the relevant Panalo Accounts screen.
2. Capture the actual screen.
3. Crop irrelevant browser content where appropriate.
4. Remove, blur or mask confidential information.
5. Add numbered callouts to the screenshot.
6. Highlight the exact button, field, tab or menu being discussed.
7. Use arrows sparingly where they improve understanding.
8. Place the screenshot immediately before or after the corresponding instruction.
9. Add a descriptive caption.

Example:

**Figure 4.2 — Creating a New Customer**

Callout:

① Select **Sales**  
② Click **Customers**  
③ Select **New Customer**  
④ Complete the required customer information  
⑤ Click **Save**

Never use a screenshot without explaining what the trainee should observe.

---

# 4. SCREENSHOT SECURITY RULES

Before publishing any screenshot, inspect it for confidential information.

Mask or replace, where appropriate:

- bank account numbers;
- TFNs;
- employee tax information;
- employee addresses;
- employee dates of birth;
- payroll amounts when unnecessary;
- passwords;
- authentication codes;
- MFA QR codes;
- MFA secret keys;
- access tokens;
- API keys;
- Supabase credentials;
- private customer financial information;
- confidential supplier details;
- personal employee banking details.

Use realistic training/demo data wherever available.

Never expose authentication secrets merely to demonstrate a procedure.

---

# 5. SYSTEM ARCHITECTURE TO RECOGNISE

The Panalo Accounts application includes secure authentication and role-based permissions.

The system contains or references the following main functional areas:

## Main
- Dashboard
- My Pay

## Sales
- Customers
- Quotes
- Invoices
- Payments Received

## Purchases
- Suppliers
- Purchase Orders
- Bills
- Supplier Payments

## Projects
- Projects
- Job Costing
- Timesheets

## Payroll
- Employees
- Pay Runs
- Leave
- Super
- STP
- Payroll Reports
- My Pay

## Accounting
- Reports
- Journals
- Chart of Accounts
- Tax Codes
- Periods
- Fixed Assets

## Tax
- BAS
- TPAR

## Banking
- Bank Accounts
- Reconciliation
- Payment Batches
- Bank Rules

## Administration
- Company Settings
- Users and Roles
- Approvals
- Integrations
- Audit Log

Some menu items are permission-dependent.

The manual must therefore explain that two users may see different menus depending on their assigned role and permissions.

---

# 6. TRAINING PHILOSOPHY

Do not write the module like software-generated documentation.

The training must feel as though an experienced Panalo employee is teaching another employee.

Use:

- practical scenarios;
- real workplace language;
- short explanations;
- visual demonstrations;
- examples relevant to fabrication, welding, shutdown, maintenance and project work;
- warnings at points where errors are likely;
- practical checkpoints;
- “What happens next?” explanations;
- short knowledge checks;
- troubleshooting boxes.

Avoid repetitive paragraphs such as:

> “Navigate to the menu. Click the button. Complete the details. Click Save.”

Instead provide context.

Example:

> A supplier bill should normally be entered only after you have confirmed that the supplier, invoice number, amount, GST treatment and related purchase order or project are correct. This prevents duplicate payments and incorrect job-cost allocation.

---

# 7. MANUAL STRUCTURE

Develop the manual using the following structure.

# PART A — GETTING STARTED

## Module 1 — Introduction to Panalo Accounts

Explain:

- what Panalo Accounts is;
- who uses it;
- what information it controls;
- relationship between accounting, payroll, projects and banking;
- importance of correct data entry;
- financial audit trail;
- role-based access.

Include:

**Screenshot 1:** Panalo Accounts login/access screen.

**Screenshot 2:** Main dashboard after successful login.

---

# MODULE 2 — SIGN-IN, MFA AND SECURITY

Cover:

### Signing in
Show exactly how users access Panalo Accounts.

### Multi-factor authentication
Explain:

- why MFA is required;
- authenticator application;
- entering the 6-digit code;
- successful verification.

### Important warning

Never reproduce a real MFA QR code or authentication secret in the published manual.

Use a masked/demo example.

### Troubleshooting

Include:

- incorrect password;
- MFA code rejected;
- code expired;
- authenticator device lost;
- “No access” message;
- temporary password requires change;
- session expired;
- “Checking your access…” remains on screen;
- blank page after login.

Add screenshot callouts for each major step.

---

# PART B — SYSTEM ORIENTATION

# MODULE 3 — DASHBOARD

Explain every visible dashboard component based on the live system.

Cover:

- key indicators;
- notifications;
- outstanding approvals;
- alerts;
- shortcuts;
- current accounting information;
- navigation sidebar;
- menu counters/badges;
- current user;
- company information.

For each metric explain:

**What it means**  
**Where the information comes from**  
**What action may be required**

Do not merely describe the appearance.

---

# MODULE 4 — NAVIGATION & SYSTEM CONTROLS

Explain:

- left navigation menu;
- menu groups;
- notification bell;
- record lists;
- search;
- filters;
- status labels;
- action buttons;
- tables;
- forms;
- Save;
- Submit;
- Approve;
- Reject;
- Post;
- Void;
- Delete where applicable;
- Back/Cancel;
- document attachments if supported.

Explain the meaning and consequence of actions.

---

# PART C — SALES

# MODULE 5 — CUSTOMERS

Demonstrate:

1. Open Customers.
2. Search for an existing customer.
3. Create a customer.
4. Edit customer information.
5. Review customer history.
6. Understand required information.
7. Prevent duplicate customers.

Screenshots are required for:

- customer list;
- New Customer button;
- customer entry form;
- completed customer record.

---

# MODULE 6 — QUOTES

Develop an end-to-end example:

**Example: Fabrication project quotation**

Demonstrate:

1. Select customer.
2. Create quote.
3. Enter description.
4. Add items.
5. Enter quantities/rates.
6. Apply appropriate GST treatment.
7. Review totals.
8. Save.
9. Submit/send/approve as applicable.
10. Explain quote status.
11. Explain subsequent conversion/workflow where supported.

Include screenshots at major stages.

---

# MODULE 7 — INVOICES

Use a practical example such as:

> Invoice for coded welding and fabrication services.

Demonstrate:

- creating invoice;
- customer selection;
- invoice date;
- due date;
- item description;
- project/job selection if applicable;
- quantity;
- rate;
- GST;
- total;
- saving;
- approval;
- posting/finalisation;
- recording payment.

Include:

### Common invoice mistakes

Examples:

- wrong customer;
- duplicate invoice;
- incorrect GST;
- wrong project;
- incorrect due date;
- invoice created twice.

---

# MODULE 8 — PAYMENTS RECEIVED

Show:

- locating open invoices;
- recording payment;
- payment date;
- payment amount;
- payment method;
- bank account;
- allocating payments;
- part payment where supported;
- over/under payment treatment where supported.

Explain how receipt recording affects accounts receivable and banking.

---

# PART D — PURCHASING

# MODULE 9 — SUPPLIERS

Cover:

- supplier creation;
- supplier search;
- duplicate supplier prevention;
- ABN/business details where supported;
- payment information;
- contact information;
- editing records.

---

# MODULE 10 — PURCHASE ORDERS

Use a scenario such as:

> Purchase of welding consumables for a maintenance shutdown.

Show:

1. Create PO.
2. Select supplier.
3. Select project.
4. Enter items.
5. Enter quantity.
6. Enter cost.
7. Select tax code.
8. Save.
9. Submit for approval.
10. Approve where authorised.
11. Explain subsequent bill matching where supported.

Add a workflow diagram:

REQUEST → PO → APPROVAL → SUPPLY → BILL → PAYMENT

---

# MODULE 11 — BILLS

Explain:

- entering supplier bill;
- invoice number;
- supplier;
- invoice date;
- due date;
- purchase order reference;
- account;
- project;
- GST treatment;
- attachments where supported;
- approval;
- posting;
- payment status.

### Duplicate invoice warning

Explain why supplier invoice number must be checked before creating another bill.

---

# MODULE 12 — SUPPLIER PAYMENTS

Explain:

- approved bills;
- selecting bills for payment;
- payment date;
- bank account;
- individual payment;
- batch payment;
- approval controls.

---

# PART E — PROJECT ACCOUNTING

# MODULE 13 — PROJECTS

Use Panalo-style examples such as:

- shutdown project;
- structural fabrication project;
- coded welding project;
- maintenance contract.

Explain:

- project setup;
- project code;
- customer;
- dates;
- status;
- cost allocation;
- labour;
- materials;
- purchases.

---

# MODULE 14 — JOB COSTING

Teach users how costs flow into a project.

Cover:

LABOUR  
+ MATERIALS  
+ PURCHASES  
+ OTHER COSTS  
= PROJECT COST

Compare project cost to:

REVENUE

Then explain:

PROJECT MARGIN = REVENUE − PROJECT COST

Use actual system terminology and screenshots.

---

# MODULE 15 — TIMESHEETS

Provide separate instruction for:

## Employee

1. Open Timesheets.
2. Select date/week.
3. Select project/job.
4. Enter hours.
5. Add notes where required.
6. Review.
7. Submit.

## Supervisor/Approver

1. Open submitted timesheets.
2. Review employee.
3. Verify hours.
4. Verify job/project.
5. Approve or reject.

Explain why approved timesheets affect:

- payroll;
- job costing;
- project reporting.

---

# PART F — PAYROLL

# MODULE 16 — EMPLOYEES

Cover:

- employee record;
- employment details;
- payroll details;
- sensitive information;
- access restrictions;
- status;
- pay setup.

Mask personal information in screenshots.

---

# MODULE 17 — PAY RUNS

Create a complete visual workflow:

TIMESHEET  
↓  
PAYROLL PREPARATION  
↓  
PAY RUN  
↓  
REVIEW  
↓  
APPROVAL  
↓  
FINALISATION  
↓  
STP  
↓  
PAYMENT  
↓  
SUPER

Demonstrate actual available steps in Panalo Accounts.

Explain status values.

Identify which steps require approval permissions.

---

# MODULE 18 — LEAVE

Cover:

- leave request;
- review;
- approval/rejection;
- payroll impact;
- leave balances where available.

---

# MODULE 19 — SUPERANNUATION

Explain the system workflow without providing unverified tax advice.

Cover:

- employee super details;
- super liabilities;
- reporting;
- payment preparation if supported;
- reconciliation.

Include a note:

> Legislative rates, deadlines and reporting requirements must be validated against current ATO requirements before operational use.

---

# MODULE 20 — STP

Explain:

- purpose of Single Touch Payroll;
- what Panalo Accounts prepares or records;
- pay-event workflow;
- status;
- error handling;
- review responsibilities.

Do not state that information was successfully lodged with the ATO unless the system actually confirms external submission.

Clearly distinguish:

PREPARED  
from  
SUBMITTED  
from  
ACCEPTED

where the application supports these states.

---

# PART G — CORE ACCOUNTING

# MODULE 21 — CHART OF ACCOUNTS

Explain:

- account code;
- account name;
- account type;
- active/inactive status;
- GST/tax association where applicable.

Teach the basic groups:

ASSETS  
LIABILITIES  
EQUITY  
REVENUE  
EXPENSES

Use Panalo-specific examples.

---

# MODULE 22 — TAX CODES

Explain the tax codes that actually exist in Panalo Accounts.

For each code show:

- name;
- meaning;
- typical use;
- effect on GST reporting.

Do not invent tax codes.

Add:

> Tax treatment must be confirmed by Panalo's accountant or registered tax professional where classification is uncertain.

---

# MODULE 23 — JOURNALS

Explain:

- when journals should be used;
- debit;
- credit;
- balancing;
- description;
- reference;
- posting;
- approval if applicable.

Include a warning:

> Manual journals should not be used simply to force an account balance to match. The underlying transaction should be investigated first.

Provide one safe training example.

---

# MODULE 24 — ACCOUNTING PERIODS

Explain:

- accounting period;
- open period;
- closed/locked period;
- why periods are closed;
- what happens when users attempt to enter transactions into closed periods.

Include year-end considerations.

---

# MODULE 25 — FINANCIAL REPORTS

Document every available Panalo report.

Prioritise where supported:

- Profit & Loss;
- Balance Sheet;
- Trial Balance;
- General Ledger;
- Accounts Receivable;
- Accounts Payable;
- Payroll reports;
- project/job reports;
- tax reports.

For each report explain:

**Purpose**  
**Who uses it**  
**Filters**  
**How to run it**  
**How to interpret it**  
**Typical errors to investigate**

---

# PART H — BANKING

# MODULE 26 — BANK ACCOUNTS

Explain:

- bank account setup;
- account identification;
- balances;
- transactions;
- imported bank information where applicable.

Mask real bank details.

---

# MODULE 27 — BANK RECONCILIATION

This must be one of the most detailed modules.

Explain the concept:

BANK STATEMENT  
versus  
ACCOUNTING LEDGER

Demonstrate:

1. Open Reconciliation.
2. Select bank account.
3. Review imported/unreconciled transactions.
4. Find a matching accounting transaction.
5. Match the transaction.
6. Create transaction where legitimately required.
7. Review unmatched items.
8. Complete reconciliation.

Include separate screenshots for:

- unreconciled list;
- potential match;
- matched transaction;
- completed/reconciled result.

### Troubleshooting examples

- duplicate bank transaction;
- transaction missing;
- wrong amount;
- wrong date;
- payment recorded to wrong bank account;
- invoice paid but showing unpaid;
- reconciliation difference.

---

# MODULE 28 — BANK RULES

Explain:

- purpose;
- conditions;
- coding;
- tax treatment;
- when automation is appropriate;
- risks of overly broad rules.

Include warning:

> A bank rule should not automatically classify transactions when different accounting treatments may apply to similar descriptions.

---

# MODULE 29 — PAYMENT BATCHES

Cover:

- creating payment batch;
- selecting approved bills;
- bank account;
- batch review;
- approval;
- payment status;
- audit trail.

---

# PART I — TAX AND COMPLIANCE

# MODULE 30 — BAS

Explain the Panalo Accounts BAS workflow.

Cover available:

- BAS period;
- GST collected;
- GST paid;
- payroll withholding;
- draft;
- review;
- approval;
- lodge/status functionality.

Important:

Panalo Accounts must not be described as having lodged a BAS unless there is actual electronic lodgement functionality and positive acknowledgement.

Include:

> BAS amounts should be reviewed against the underlying ledger and supporting reports before lodgement.

---

# MODULE 31 — TPAR

Explain:

- purpose;
- reportable suppliers;
- review;
- reporting period;
- verification.

Use actual system functionality only.

---

# PART J — FIXED ASSETS

# MODULE 32 — FIXED ASSETS

Cover actual functionality such as:

- asset creation;
- asset category;
- purchase value;
- acquisition date;
- depreciation;
- asset register;
- disposal where supported.

Use examples relevant to Panalo Pipes:

- welding machine;
- forklift;
- fabrication equipment;
- vehicle;
- workshop equipment.

---

# PART K — CONTROL AND ADMINISTRATION

# MODULE 33 — APPROVALS

Explain:

- what requires approval;
- outstanding approvals;
- approve;
- reject;
- comments;
- segregation of duties.

Provide examples:

Purchase Order → Approval  
Bill → Approval  
Pay Run → Approval  
Timesheet → Approval  
Leave → Approval  
Payment Batch → Approval

Only include flows actually supported by the system.

---

# MODULE 34 — USERS & ROLES

Explain role-based access.

Show:

- user list;
- user creation;
- role assignment;
- access/permission changes;
- disabling access where supported.

Explain the principle:

> Give users only the access required to perform their assigned duties.

Do not expose sensitive system credentials.

---

# MODULE 35 — COMPANY SETTINGS

Document each editable company setting.

Explain which changes should be restricted to administrators.

---

# MODULE 36 — INTEGRATIONS

Document actual integrations shown in the system.

For each integration show:

STATUS  
PURPOSE  
SETUP RESPONSIBILITY  
COMMON ERROR  
ESCALATION METHOD

Do not claim an integration is live merely because a menu item exists.

---

# MODULE 37 — AUDIT LOG

Explain:

- what an audit trail is;
- user;
- action;
- date/time;
- affected record;
- investigation.

Provide an example investigation:

> “Who changed this transaction?”

Show how an authorised user can locate the activity.

---

# PART L — TROUBLESHOOTING MANUAL

Create a dedicated troubleshooting section.

Use this format:

| Problem | Likely Cause | First Check | Corrective Action | Escalate When |
|---|---|---|---|---|

At minimum include:

### ACCESS

- Cannot sign in
- MFA rejected
- Authenticator lost
- Temporary password problem
- No accounting access
- Menu item missing
- Permission denied
- Session expired

### PAGE/INTERFACE

- Page stays on Loading
- Blank page
- Something went wrong
- Button does nothing
- Save fails
- Record does not refresh
- Duplicate record appears

### SALES

- Cannot create invoice
- Wrong GST amount
- Invoice still unpaid after receiving money
- Duplicate invoice

### PURCHASES

- PO cannot be approved
- Bill duplicated
- Supplier payment missing
- Bill coded to wrong project

### PROJECTS

- Labour not appearing in job costing
- Project missing
- Timesheet applied to wrong job

### PAYROLL

- employee missing from pay run;
- timesheet missing;
- incorrect hours;
- pay run cannot be approved;
- STP status problem;
- super amount appears incorrect.

### ACCOUNTING

- journal does not balance;
- transaction cannot be posted;
- accounting period closed;
- wrong account selected;
- report does not agree with expected balance.

### BANKING

- bank line does not match;
- transaction imported twice;
- no matching payment;
- reconciliation difference;
- payment batch cannot proceed.

### TAX

- BAS values look wrong;
- BAS period missing;
- GST classification wrong;
- TPAR supplier missing.

---

# 38. TROUBLESHOOTING DECISION TREE

Create a visual troubleshooting decision tree:

START  
↓  
Can user sign in?

NO → Authentication/MFA troubleshooting

YES  
↓  
Can user access the required menu?

NO → Check role/permissions

YES  
↓  
Can the record be located?

NO → Search/filter/date/status checks

YES  
↓  
Can transaction be saved?

NO → Required fields/validation/period/permission

YES  
↓  
Is accounting result correct?

NO → Account/tax/project/date/payment allocation review

YES  
↓  
PROCESS COMPLETE

Use system-specific error messages wherever they can be verified.

---

# 39. ERROR MESSAGE DOCUMENTATION

Search the actual source code for user-facing errors.

For each important error include:

**Message shown:**  
**What it normally means:**  
**What the user should check:**  
**What not to do:**  
**When to contact administrator/developer:**

Do not expose internal security details that would weaken the system.

---

# 40. TRAINING SCENARIOS

Use practical Panalo Pipes scenarios.

### Scenario A — Sales

Customer requests fabrication work.

CUSTOMER  
→ QUOTE  
→ PROJECT  
→ TIMESHEET/COST  
→ INVOICE  
→ PAYMENT  
→ BANK RECONCILIATION

### Scenario B — Purchasing

Workshop requires welding consumables.

SUPPLIER  
→ PURCHASE ORDER  
→ APPROVAL  
→ BILL  
→ PAYMENT  
→ BANK RECONCILIATION

### Scenario C — Payroll

Employee works on a shutdown project.

TIMESHEET  
→ SUPERVISOR APPROVAL  
→ PAY RUN  
→ PAYROLL APPROVAL  
→ STP  
→ PAYMENT  
→ SUPER  
→ PROJECT LABOUR COST

### Scenario D — Month End

BANK RECONCILIATION  
→ RECEIVABLE REVIEW  
→ PAYABLE REVIEW  
→ JOURNAL REVIEW  
→ PAYROLL REVIEW  
→ BAS CHECK  
→ FINANCIAL REPORTS  
→ PERIOD CLOSE

Use screenshots to tell the story.

---

# 41. SCREENSHOT STYLE

Use consistent visual annotations.

### Callouts

Use:

①  
②  
③  
④  
⑤

### Highlighting

Highlight interactive control boundaries.

### Arrow usage

Use arrows only when navigation direction is unclear.

### Captions

Example:

**Figure 11.4 — Select the supplier before entering invoice information**

### Screenshot explanation

Under every screenshot include:

**What you are looking at**

**What you need to click**

**Why this step matters**

---

# 42. “BEFORE YOU CLICK” BOXES

Where an action may have financial consequences, insert:

## BEFORE YOU CLICK

Check:

☐ Correct customer/supplier  
☐ Correct date  
☐ Correct project/job  
☐ Correct account  
☐ Correct tax code  
☐ Correct amount  
☐ Supporting document reviewed  
☐ Approval available where required

Use this particularly before:

- posting journals;
- approving bills;
- finalising pay runs;
- approving payment batches;
- completing reconciliation;
- closing accounting periods;
- BAS finalisation.

---

# 43. “COMMON MISTAKE” BOXES

Include practical warnings such as:

### COMMON MISTAKE

**Creating the supplier again because it did not appear immediately.**

Before creating another supplier, search by:

- business name;
- ABN;
- contact;
- partial name.

Duplicate master records create reporting and payment-control problems.

---

# 44. “WHY THIS MATTERS” BOXES

Training should explain consequences.

Example:

### WHY THIS MATTERS

If labour is entered against the wrong project, payroll may still calculate correctly, but the job-cost report will be wrong. Management could then incorrectly conclude that another project is more or less profitable than it actually is.

---

# 45. ROLE-BASED TRAINING PATHS

At the beginning of the manual include:

## ALL USERS

- Login
- MFA
- Dashboard
- Navigation
- Security
- Notifications

## EMPLOYEES

- My Pay
- Timesheets
- Leave

## SUPERVISORS

- Timesheet Approval
- Leave Approval
- Projects

## ACCOUNTS / ADMIN

- Customers
- Suppliers
- Quotes
- Invoices
- Receipts
- POs
- Bills
- Payments
- Banking
- Reconciliation

## PAYROLL

- Employees
- Timesheets
- Pay Runs
- Leave
- Super
- STP
- Payroll Reports

## FINANCE

- Chart of Accounts
- Journals
- Reports
- Periods
- BAS
- TPAR
- Assets
- Banking

## ADMINISTRATOR

- Users
- Permissions
- Company Settings
- Integrations
- Audit

## MANAGEMENT / DIRECTOR

- Dashboard
- Approvals
- Reports
- Job Costing
- Payroll approval where authorised
- Payment approval where authorised

---

# 46. TRAINING ASSESSMENT

At the end of every major module provide:

### KNOWLEDGE CHECK

3–5 questions.

Avoid obvious AI-style questions.

Use workplace situations.

Example:

> A supplier invoice is for materials used entirely on Project PP-2408, but the bill was entered without a project. What reporting problem could this create?

### PRACTICAL TASK

Example:

> Create a training supplier, enter a draft purchase order, assign it to a training project and stop before submitting it for approval.

### COMPETENCY RESULT

☐ Competent  
☐ Further coaching required

Trainer:

Date:

---

# 47. QUICK REFERENCE GUIDES

After the complete manual, create one-page quick guides for:

1. Creating an Invoice
2. Recording Customer Payment
3. Creating a Purchase Order
4. Entering a Supplier Bill
5. Processing Supplier Payment
6. Submitting Timesheet
7. Approving Timesheet
8. Processing Pay Run
9. Bank Reconciliation
10. Running Financial Reports
11. Reviewing BAS
12. Troubleshooting Login/MFA

Each guide should contain 4–8 steps and at least one useful screenshot.

---

# 48. SYSTEM ADMINISTRATOR TROUBLESHOOTING APPENDIX

Create a separate technical section intended for authorised administrators/developers.

Inspect, where relevant:

`/accounts/app.js`

`/accounts/lib/`

`/accounts/views/`

authentication dependencies;

API calls;

route handling;

permissions;

validation;

bank-file processing;

document utilities.

Explain:

- frontend route involved;
- relevant source file;
- probable component/function;
- API/action being called where verifiable;
- user-visible symptom;
- diagnostic steps;
- safe remediation;
- when code changes are required.

Do not expose passwords, secrets, tokens or protected credentials.

This appendix is not intended for ordinary employees.

---

# 49. CHANGE CONTROL

Include a revision table:

| Revision | Date | Change | Prepared By | Reviewed By | Approved By |
|---|---|---|---|---|---|

Suggested document title:

**Panalo Accounts — User Training, Operating & Troubleshooting Manual**

Suggested document classification:

**Internal Controlled Document**

Include:

- document owner;
- effective date;
- review date;
- version;
- approval;
- page numbering.

Where Panalo Pipes has an established IMS document-control format, use that format rather than inventing a conflicting one.

---

# 50. MANUAL DESIGN

Use the established Panalo Pipes branding.

The finished manual should look professional but practical.

Use:

- Panalo Pipes logo;
- established corporate colour palette;
- clear section dividers;
- large screenshots;
- visual workflows;
- icon-supported warnings;
- tables;
- process diagrams;
- callout boxes;
- generous spacing.

Avoid excessive decorative graphics.

The accounting application itself should remain the main visual focus.

---

# 51. HUMAN WRITING REQUIREMENT

The writing must sound like an internal trainer who understands how the company works.

Avoid repeating:

- “It is important to note…”
- “Navigate to…”
- “This ensures…”
- “This module provides…”
- “Users should ensure…”

Vary sentence structure naturally.

Use plain Australian business English.

Where an accounting term is unavoidable, explain it in simple language the first time it appears.

---

# 52. VERIFICATION RULE

Before documenting any function:

1. Inspect the live application where access permits.
2. Inspect the current source code.
3. Confirm the current button/field/menu wording.
4. Confirm role restrictions.
5. Confirm status names.
6. Confirm what happens after the action.
7. Capture the relevant screenshot.
8. Only then write the procedure.

If a function is found in source code but cannot be verified in the interface, label it:

**Verification Required**

Do not present assumptions as confirmed functionality.

---

# 53. ACCOUNTING ACCURACY RULE

The manual is for operating Panalo Accounts.

It is not a substitute for:

- registered tax advice;
- accounting advice;
- payroll legal advice;
- Fair Work interpretation;
- ATO confirmation.

Where legislation, GST, BAS, PAYG, super or STP requirements are discussed, use current authoritative Australian sources.

Clearly separate:

**How Panalo Accounts works**

from

**What Australian legislation requires**

---

# 54. REQUIRED FINAL DELIVERABLES

Produce:

### Deliverable 1
**Complete Panalo Accounts User Training Manual**

### Deliverable 2
**Panalo Accounts Troubleshooting Manual**

### Deliverable 3
**Administrator Technical Troubleshooting Appendix**

### Deliverable 4
**Role-Based Training Matrix**

### Deliverable 5
**Quick Reference Guides**

### Deliverable 6
**Training Assessment Questions**

### Deliverable 7
**Practical Competency Checklist**

### Deliverable 8
**Screenshot Register**

Use this structure:

| Figure | Module | Screen | Screenshot Required | Captured | Confidential Data Checked |
|---|---|---|---|---|---|

### Deliverable 9
**System Workflow Map**

Show the relationship between:

SALES  
PURCHASING  
PROJECTS  
TIMESHEETS  
PAYROLL  
ACCOUNTING  
TAX  
BANKING  
REPORTING

### Deliverable 10
**Troubleshooting Matrix**

---

# 55. SCREENSHOT COMPLETION RULE

Do not consider a module finished while required screenshots are missing.

If the environment does not allow authenticated screenshot capture:

DO NOT create a fake substitute.

Instead insert a clearly marked placeholder:

> **SCREENSHOT REQUIRED — Panalo Accounts > Banking > Reconciliation > Unmatched Transactions**

and specify:

- exact screen required;
- user role required;
- what state/data should be visible;
- what confidential information must be masked;
- which button or field must be highlighted.

A later authenticated documentation pass must replace every placeholder with a genuine screenshot before final release.

---

# 56. DOCUMENT QUALITY TEST

Before finalising the manual ask:

### USER TEST
Could a new employee follow these instructions without guessing?

### VISUAL TEST
Does every complex workflow have a screenshot or diagram?

### ACCURACY TEST
Does every button and field actually exist?

### CONTROL TEST
Does the manual explain approvals and financial consequences?

### SECURITY TEST
Has confidential information been removed?

### TROUBLESHOOTING TEST
Can the user recover from common errors?

### HUMAN TEST
Does this sound like a competent trainer rather than AI-generated documentation?

### AUDIT TEST
Can a supervisor determine what the user was trained to perform?

If any answer is NO, revise that section before release.

---

# FINAL INSTRUCTION

Do not rush directly into writing hundreds of pages.

First:

1. inspect the entire application;
2. inventory the screens;
3. map the workflows;
4. map user roles and permissions;
5. identify high-risk accounting processes;
6. create the screenshot register;
7. capture and annotate the required screens;
8. develop the training modules;
9. develop troubleshooting guidance;
10. conduct a consistency review;
11. produce the final controlled manual.

The objective is not merely to explain the software.

The objective is to create a **practical Panalo Accounts operating system for training employees, performing accounting work consistently, preventing errors, supporting internal control and troubleshooting problems when they occur.**