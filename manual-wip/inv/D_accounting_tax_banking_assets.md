# Inventory D: core accounting, tax, banking and fixed assets (Panalo Accounts)

Taken from the code (read only). Strings in quotes are verbatim. `%` / `${…}` marks a value the code fills in.
Sources: `accounts/app.js`, `accounts/views/{chart,taxcodes,journals,periods,reports,banking,payment-batches,bas,assets}.js`, `accounts/lib/{bank-file,validate,ui,docs}.js`, `supabase/functions/finance-api/{index,ledger,banking,tax,assets}.ts`, `_shared/{aba,bas-pdf,http}.ts`, migrations `20261007000000_finance_foundation.sql`, `20261008000000_ledger_core.sql`, `20261009000000_sales_purchasing.sql` (overrides `journal_reverse`, adds aged reports), `20261012000000_banking.sql`, `20261013000000_bas.sql`, `20261015000000_assets.sql`; docs `ACCOUNTING_ENGINE.md`, `BANKING.md`, `BAS.md`, `ASSETS.md`.

---

## 0. Things that apply to every screen

### 0.1 Permissions used in this area (from `app_permissions`)

| Key | Name shown in Users and roles | Description | MFA |
|---|---|---|---|
| `ledger.manage` | Chart of accounts and tax codes | Create and edit accounts, tax codes and posting rules. | yes |
| `ledger.journal` | Create journals | Prepare manual and adjusting journals. | yes |
| `ledger.post` | Approve and post journals | Approve and post journals to the general ledger. | yes |
| `ledger.reopen` | Reopen closed periods | Reopen a closed accounting period. Every reopen is logged. | yes |
| `bank.manage` | Banking | Bank accounts, payments, imports and reconciliation; approve company bank accounts. | yes |
| `tax.bas` | BAS and tax reporting | Prepare BAS workpapers and tax reports. | yes |
| `tax.review` | Review BAS | Review a BAS workpaper someone else prepared before it is lodged. | yes |
| `assets.manage` | Fixed assets | Keep the asset register, run depreciation and record disposals. | yes |
| `reports.view` | Financial reports | View financial reports and dashboards. | no |
| `audit.view` | Audit log | View the audit log. | yes |
| `data.export` | Export data | Export reports and records. Every export is logged. | yes |

Default roles (seed, `finance_foundation` + later migrations):

| Role | Keys in this area |
|---|---|
| super_admin | ledger.manage, ledger.journal, ledger.post, ledger.reopen, bank.manage, tax.bas, tax.review, assets.manage, reports.view, audit.view, data.export |
| director | ledger.post, ledger.reopen, bank.manage, tax.bas, tax.review, assets.manage, reports.view, audit.view, data.export |
| finance_admin | ledger.manage, ledger.journal, ledger.post, bank.manage, tax.bas, assets.manage, reports.view, audit.view, data.export |
| accountant | ledger.journal, tax.bas, tax.review, reports.view, audit.view, data.export |
| payroll_admin | reports.view, audit.view, data.export |
| project_manager | reports.view |

System administrators also hold every key marked `admin_default` (all of the above).

### 0.2 Common errors (where raised)

- API, missing permission for an action: "Your access doesn't include this area. Ask an administrator if you need it." (index.ts `need`, HTTP 403)
- SQL `app_require`: "You need the "%" permission for this." (% = permission name, e.g. "Approve and post journals")
- API, MFA: "Confirm your sign-in with your authenticator app to continue." (code `mfa_required`; the app then shows the "Confirm it's you" gate)
- API bad ids/dates: "% is not valid." / "% must be a date." (e.g. "The journal date must be a date.")
- Any 5xx: "The secure training service could not complete the request."
- JS 401: "Your sign-in has expired. Please sign in again."
- Screen load failure: heading "Something went wrong" with the error text.
- Success/failure messages appear in the status line at the bottom of each screen (`flash`).

### 0.3 Menu (Accounting, Tax, Banking groups, `app.js`)

| Group | Menu label | Route | Shown when the user has any of |
|---|---|---|---|
| Accounting | Reports | `#/reports` | reports.view, ledger.manage, ledger.journal, ledger.post, audit.view |
| Accounting | Journals | `#/journals` | same as above |
| Accounting | Chart of accounts | `#/chart-of-accounts` | same |
| Accounting | Tax codes | `#/tax-codes` | same |
| Accounting | Periods | `#/periods` | same |
| Accounting | Fixed assets | `#/assets` | assets.manage, reports.view |
| Tax | BAS | `#/bas` (badge: BAS to review for tax.review + reviewed BAS to lodge for tax.bas) | tax.bas, tax.review |
| Tax | TPAR | `#/tpar` | tax.bas, tax.review |
| Banking | Bank accounts | `#/bank-accounts` | bank.manage, reports.view |
| Banking | Reconciliation | `#/reconciliation` (badge: statement lines to match) | bank.manage, reports.view |
| Banking | Payment batches | `#/payment-batches` (badge: batches made by someone else waiting for approval) | bank.manage only |
| Banking | Bank rules | `#/bank-rules` | bank.manage only |

Typing a route you can't see in the menu sends you to `#/dashboard`.

### 0.4 Journal source types (`journal_entries.source_type`)

`manual` (shown "Manual journal" on Journals; "Journal" on banking screens), `invoice`, `credit_note`, `customer_payment` ("Receipt"), `bill`, `supplier_credit`, `supplier_payment` ("Supplier payment"), `pay_run` ("Pay run"), `pay_run_payment` ("Net pay"), `super_payment`, `bank_transaction` ("From the bank line"), `bas`, `bas_payment`, `depreciation`, `asset_disposal`. On Journals, the Source column shows the source reference (document number) if any, else the label, else the raw key.

Journal numbers: `JE-000001` (sequence `journal`, padding 6). Payment batches `PB-0001`. Assets `FA-0001`.

---

## 1. Chart of accounts

- Route `#/chart-of-accounts`; menu "Chart of accounts"; menu perms see 0.3; data action `ledger_setup` (any LEDGER key).
- Eyebrow "ACCOUNTING"; heading "Chart of accounts".
- Intro: "Balances as at ${date}: balance sheet accounts to date, profit and loss accounts for this financial year. Have Panalo's accountant review the chart before the first BAS."
- Header button "Add account" (only `ledger.manage`).

### 1.1 List
- Toolbar: "Find an account" (search, placeholder "Code or name"); checkbox "Show archived".
- Grouped by type in this order with these group headings: Assets, Liabilities, Equity, Revenue, Cost of sales, Operating expenses, Other income, Other expenses.
- Columns: Code | Name | Default tax | Balance | (Actions).
- Name links to Reports > Account transactions for that account. Chips: "System" (system account), "Module entries only" (manual journals not allowed), "Archived". Description shown under the name.
- Balance shown on the account's normal side (debit for asset/expense/cost of sales/other expense; credit otherwise); zero shown blank.
- Row actions (`ledger.manage`): "Edit"; "Archive" / "Restore" (not on system accounts) → `account_set_status`. Success "Saved."

### 1.2 Add / edit form
Heading "Add an account" or "Edit ${code} ${name}". System accounts show: "System account: used by the posting rules, so its type is fixed and it cannot be archived."

| Label | Notes / validation |
|---|---|
| Code | required, max 12. JS: must match `^[0-9A-Za-z][0-9A-Za-z.-]{0,11}$` else "1 to 12 letters, digits, dots or dashes." Server upper-cases it; API: "Account codes are 1 to 12 letters, digits, dots or dashes."; SQL: "Account code % is already used." |
| Name | required, max 120. JS/API: "Give the account a name." (fewer than 2 chars) |
| Type | Assets/Liabilities/Equity/Revenue/Cost of sales/Operating expenses/Other income/Other expenses (keys asset, liability, equity, revenue, cost_of_sales, expense, other_income, other_expense). Disabled for system accounts. API: "Choose an account type." |
| Kind (subtype) | depends on type. Asset: General, Bank, Inventory, Current asset, Fixed asset, Accumulated depreciation. Liability: General, Current liability, Non-current liability, PAYG withholding, Superannuation, Payroll. Equity: General, Share capital. Others: General. Disabled for system accounts. |
| Default tax code | "None" or active codes "CODE · Name" |
| Description | max 500 |
| Checkbox "Allow manual journals to this account" | default ticked; disabled for system accounts |

Buttons "Add account" / "Save changes", "Cancel". Action `account_save` (`ledger.manage`), audited `account_created` / `account_updated`. Success "Account saved."

SQL errors (`account_save`, `account_set_status`):
- "Unknown tax code."
- "That account kind is reserved for the system accounts." (receivable, payable, gst, retained_earnings, current_year_earnings)
- "The type of a system account, or an account with posted entries, cannot change."
- "Manual posting rules of system accounts are fixed."
- "Account not found."
- "System accounts cannot be archived."
- "Move the balance out of % first (balance %)." (only asset, liability and equity accounts with a balance; P&L accounts with a balance can be archived)
- Audited `account_archived` / `account_restored`.

### 1.3 Seeded chart (code, name, type, kind; S = system; M- = manual journals refused; default tax)

| Code | Name | Type | Kind | Flags | Tax |
|---|---|---|---|---|---|
| 1000 | Bank | asset | bank | S | |
| 1100 | Accounts Receivable | asset | receivable | S, M- | |
| 1200 | Inventory - Steel and Materials | asset | inventory | | |
| 1210 | Welding Consumables | asset | inventory | | |
| 1220 | Project Materials | asset | inventory | | |
| 1300 | Work in Progress | asset | current_asset | | |
| 1400 | Prepayments | asset | current_asset | | |
| 1450 | PAYG Income Tax Instalments Paid | asset | current_asset | S (BAS migration) | NG |
| 1500 | Tools and Equipment | asset | fixed_asset | | CAP |
| 1510 | Tools and Equipment - Accumulated Depreciation | asset | accumulated_depreciation | | |
| 1600 | Vehicles | asset | fixed_asset | | CAP |
| 1610 | Vehicles - Accumulated Depreciation | asset | accumulated_depreciation | | |
| 1700 | Plant and Machinery | asset | fixed_asset | | CAP |
| 1710 | Plant and Machinery - Accumulated Depreciation | asset | accumulated_depreciation | | |
| 1800 | Office Equipment | asset | fixed_asset | | CAP |
| 1810 | Office Equipment - Accumulated Depreciation | asset | accumulated_depreciation | | |
| 2000 | Accounts Payable | liability | payable | S, M- | |
| 2100 | PAYG Withholding Payable | liability | payg | S | |
| 2200 | Superannuation Payable | liability | super | S | |
| 2300 | GST Payable/Receivable | liability | gst | S | |
| 2350 | ATO Integrated Client Account | liability | current_liability | S (BAS) | NG |
| 2400 | Payroll Clearing | liability | payroll | S | |
| 2500 | Accrued Expenses | liability | current_liability | | |
| 2600 | Employee Deductions Payable | liability | payroll | S | |
| 3000 | Share Capital | equity | share_capital | | |
| 3100 | Retained Earnings | equity | retained_earnings | S | |
| 3200 | Current Year Earnings | equity | current_year_earnings | S, M- | |
| 4000 | Fabrication Revenue | revenue | general | | GST |
| 4100 | Welding Revenue | revenue | | | GST |
| 4200 | Shutdown/Maintenance Revenue | revenue | | | GST |
| 4300 | Pipework Revenue | revenue | | | GST |
| 4400 | Site Labour Revenue | revenue | | | GST |
| 4500 | Labour Hire Revenue | revenue | | | GST |
| 4600 | Equipment Hire Revenue | revenue | | | GST |
| 4700 | Materials Recharge | revenue | | | GST |
| 4800 | Other Operating Revenue | revenue | | | GST |
| 4850 | Fuel Tax Credits | other_income | general | S (BAS) | NG |
| 4950 | Proceeds from Sale of Assets | other_income | general | S (assets) | GST |
| 5000 | Direct Labour | cost_of_sales | | S | NG |
| 5100 | Direct Materials | cost_of_sales | | | GSTE |
| 5200 | Welding Consumables | cost_of_sales | | | GSTE |
| 5300 | Subcontractors | cost_of_sales | | | GSTE |
| 5400 | Project Travel | cost_of_sales | | | GSTE |
| 5500 | Equipment Hire - Projects | cost_of_sales | | | GSTE |
| 5600 | Freight | cost_of_sales | | | GSTE |
| 5700 | Site Costs | cost_of_sales | | | GSTE |
| 6000 | Administration Wages | expense | | S | NG |
| 6100 | Employer Superannuation | expense | | S | NG |
| 6200 | Workers Compensation | expense | | | |
| 6300 | Vehicle Expenses | expense | | | GSTE |
| 6400 | Fuel | expense | | | GSTE |
| 6500 | Repairs and Maintenance | expense | | | GSTE |
| 6600 | PPE | expense | | | GSTE |
| 6700 | Tools | expense | | | GSTE |
| 6800 | Insurance | expense | | | |
| 6900 | Rent | expense | | | GSTE |
| 7000 | Utilities | expense | | | GSTE |
| 7100 | Software | expense | | | GSTE |
| 7200 | Accounting and Legal | expense | | | GSTE |
| 7300 | Training | expense | | | GSTE |
| 7400 | Recruitment | expense | | | GSTE |
| 7500 | Telephone and Internet | expense | | | GSTE |
| 7600 | Advertising | expense | | | GSTE |
| 7700 | Bank Charges | expense | | | |
| 7800 | Depreciation | expense | | | NG |
| 7810 | Book Value of Assets Disposed | other_expense | general | S (assets) | NG |
| 7850 | ATO Interest and Penalties (non-deductible) | expense | | | NG |
| 7900 | Miscellaneous Expenses | expense | | | |
| 7950 | BAS Rounding | expense | general | S (BAS) | NG |

Seeded descriptions: 2350 "What the business owes the ATO (or is owed) from lodged BAS, less payments and refunds."; 1450 "PAYG instalments (BAS label 5A), offset against income tax at year end."; 4850 "Fuel tax credits claimed on the BAS (label 7D)."; 7950 "Cents dropped when BAS labels are reported in whole dollars."; 4950 "What fixed assets were sold for (before GST)."; 7810 "Cost less accumulated depreciation of assets sold or written off."

---

## 2. Tax codes

- Route `#/tax-codes`; menu "Tax codes"; data `ledger_setup`.
- Eyebrow "ACCOUNTING"; heading "Tax codes".
- Intro: "GST is worked out per line, to the cent, rounding half a cent up. The code, kind and rate of a code that has been used can't change, so past transactions keep their meaning; add a new code instead."
- Header button "Add tax code" (`ledger.manage`).
- Columns: Code | Name (description under it) | Rate | Used for | BAS labels ("—" if none) | Status ("Active" / "Inactive") | Edit (`ledger.manage`).
- Form heading "Add a tax code" / "Edit ${code}". Fields: Code (max 12; disabled for system codes), Name (max 80), Kind (disabled for system), Rate % (0–99, step 0.01, default 10; disabled for system), Used for (Sales / Purchases / Both), Description (max 300), checkbox "Active". Buttons "Save", "Cancel". No client validation.
- Kinds (key → label): gst_income "GST on income"; gst_expense "GST on expenses"; gst_capital "GST on capital purchases"; gst_free_income "GST-free income"; gst_free_expense "GST-free expenses"; export "Exports"; input_taxed_income "Input-taxed sales"; input_taxed_expense "Input-taxed purchases"; no_gst "No GST (BAS excluded)"; out_of_scope "Out of scope".
- Action `tax_code_save` (`ledger.manage`), audited `tax_code_created` / `tax_code_updated`. Success "Tax code saved."
- API errors: "Tax codes are 1 to 12 capital letters, digits or dashes."; "Choose what kind of tax code this is."; "The rate must be between 0 and 99%."
- SQL errors: "Tax code not found."; "The code, kind and rate of a system or used tax code are fixed. Create a new tax code instead."
- BAS labels of a new code are copied from the first system code of the same kind; they can't be edited anywhere in the UI.
- Posting with an inactive code fails: "Line %: tax code % is inactive."

### 2.1 Seeded tax codes (all system codes)

| Code | Name | Kind | Rate | Applies to | BAS labels | Description |
|---|---|---|---|---|---|---|
| GST | GST on Income | gst_income | 10% | sales | G1, 1A | Taxable sales: 10% GST included in G1, GST at 1A. |
| GSTE | GST on Expenses | gst_expense | 10% | purchases | G11, 1B | Non-capital purchases with GST: G11, credit at 1B. |
| CAP | GST on Capital Purchases | gst_capital | 10% | purchases | G10, 1B | Capital purchases (plant, vehicles, equipment) with GST: G10, credit at 1B. |
| FRE | GST Free Income | gst_free_income | 0 | sales | G1, G3 | GST-free sales: G1 and G3. |
| EXP | GST Free Exports | export | 0 | sales | G1, G2 | Exports: G1 and G2. |
| FREE | GST Free Expenses | gst_free_expense | 0 | purchases | G11, G14 | GST-free purchases: G11 and G14. |
| ITS | Input Taxed Sales | input_taxed_income | 0 | sales | G1, G4 | Input-taxed sales (for example interest): G1 and G4. |
| ITP | Input Taxed Purchases | input_taxed_expense | 0 | purchases | G11, G13 | Purchases for making input-taxed sales: G11 and G13. |
| NG | No GST (BAS excluded) | no_gst | 0 | both | none | Not reported on the BAS: wages, super, transfers, loans, tax payments. |
| OOS | Out of Scope | out_of_scope | 0 | both | none | Outside the GST system altogether. |

---

## 3. Journals

Routes `#/journals`, `#/journals/new`, `#/journals/<id>`, `#/journals/<id>/edit`. Menu "Journals".

### 3.1 List (`journals_list`, any LEDGER key)
- Eyebrow "ACCOUNTING"; heading "Journals".
- Intro: "Every posted entry in the general ledger. Posted journals can't be edited or deleted; correct them with a reversal and a new journal."
- Header link "New journal" (`ledger.journal`).
- Filters: Status (All / Draft / Posted / Reversed), From, To (dates), "Narration contains"; button "Filter".
- Columns: Number (link; "Draft" if unnumbered) | Date | Narration (chip "Reversal"; "by ${name}") | Source | Amount (total debits) | Status. Empty: "No journals match."
- Pager: "Newer" / "Page X of Y" / "Older" (50 per page).

### 3.2 Status values
| Key | Label | Meaning | Transitions |
|---|---|---|---|
| draft | Draft | Not in the ledger; editable; no number | → posted (Post); → deleted (Delete draft) |
| posted | Posted | In the ledger, numbered, immutable | → reversed (Reverse; manual journals only) |
| reversed | Reversed | Original of a reversal pair; still counts in reports (pair nets to nil) | none |

### 3.3 Editor (new / edit draft)
- Eyebrow "ACCOUNTING · JOURNALS"; heading "New journal" / "Edit draft journal".
- Intro: "Enter amounts as debits and credits. Lines with a GST code get a GST line added to 2300 when posted. Receivables, payables and current year earnings take entries only from their own modules."
- Header fields: "Date" (required), "Amounts are" (Tax exclusive (GST added) / Tax inclusive (GST included) / No tax), "Narration" (max 500, placeholder "What this journal is for").
- Lines table: Account ("Choose an account…"; only active accounts that allow manual journals, grouped by type) | Description (max 300) | Tax (active codes; disabled when "No tax") | Debit | Credit | GST (calculated) | remove "✕" (disabled with 2 lines). Link "+ Add a line". Choosing an account fills its default tax code if the Tax cell is empty; typing a debit clears the credit and vice versa.
- Live balance line: "Amounts must be numbers with up to 2 decimal places." / "Out of balance by $X (more debits)." / "(more credits)." / "Balanced, including GST."
- Buttons: "Save draft"; "Save and post" (only `ledger.post`; otherwise the text "Someone with "Approve and post journals" will post it."); "Cancel".
- JS: "Fix the highlighted amounts first."
- Save and post that fails to post keeps the draft and reopens the editor with: "Saved as a draft but not posted: ${error}".
- Actions: `journal_save` (`ledger.journal`; SQL `journal_save_draft`, audited `journal_draft_created` / `journal_draft_saved`), then `journal_post` if posting.

### 3.4 Detail
- Heading "${number}" or "Draft journal" + status chip; narration or "No narration"; link "All journals".
- Facts: Date, Source, Amounts (Tax exclusive / Tax inclusive / No tax), Created, Posted, Reverses (link + reason), Reversed by.
- Lines: Account | Description | Tax | Debit | Credit; GST lines styled as tax lines; Total row.
- Draft out of balance: "Out of balance by $X. It can't be posted until it balances."
- Buttons:
  - "Edit" (draft and `ledger.journal`).
  - "Post" (draft and `ledger.post`) → `journal_post`. Rebuilds GST lines, numbers it, posts. Audited `journal_posted`. Success "Posted as ${number}."
  - "Delete draft" (draft and either `ledger.post` or own draft with `ledger.journal`). Confirm: "Delete this draft journal? Drafts aren't part of the ledger, so nothing is lost from the books." → `journal_delete`, audited `journal_draft_deleted`.
  - "Reverse" (posted, not itself a reversal, `ledger.post`). Prompt 1: "Reverse this journal? A mirror-image journal is posted and this one is marked reversed. Reason:"; prompt 2: "Date for the reversal (YYYY-MM-DD). Leave as is to use the original date:". → `journal_reverse`; posts the mirror journal (memo "Reversal of ${number}: ${reason}"), marks the original reversed, opens the new journal. Audited `journal_reversed`.

### 3.5 Posting rules and SQL errors (ledger_core / sales_purchasing / later guards)
- "A journal needs at least two lines." / "A journal can have at most 200 lines." (also API "Add the journal lines.", "A journal can have at most 200 lines.")
- "Line %: amounts must be numbers." / "Line %: amounts cannot be negative; use the other column." / "Line %: enter either a debit or a credit." / "Line %: amounts can have at most 2 decimal places."
- "Line %: choose an account." / "Line %: account % is archived." / "Line %: % % is a control account and only takes entries from its own module."
- "Line %: unknown tax code." / "Line %: tax code % is inactive." / "There is no active GST account."
- "Choose the journal date."
- "Debits (%) and credits (%) must be equal." / "Debits (%) and credits (%) must be equal before posting."
- Period checks: "No accounting period covers %. Add that financial year first." / "The period % to % is closed." / "The period % to % is locked. Only someone who can reopen periods can post into it."
- "Journal not found." / "Only a draft can be edited. Reverse a posted journal instead." / "This journal is already posted."
- "A posted journal cannot be deleted. Reverse it instead." / "You can delete only your own drafts."
- Reverse: "Only a posted journal can be reversed." / "This journal is itself a reversal." / "Give a reason for the reversal." (under 3 chars) / "This journal was posted by a %. Void the % itself instead, so the two stay in step." (non-manual source, e.g. "by a supplier payment")
- Other reversal guards: "This entry is matched to a bank statement line. Unmatch it in Reconciliation first, or record a refund instead." (banking); "BAS journals can't be reversed. Correct the amounts on the next BAS." (bas); "Disposal journals can't be reversed." / "Undo depreciation from Fixed assets, not by reversing its journal." (assets)
- Triggers: "A posted journal cannot be changed. Reverse it and post a replacement." / "Lines of a posted journal cannot be changed." / "Journal % needs at least two lines." / "Journal % does not balance: debits % and credits %." / "Journal % has no amounts."
- GST: per line, half-up to the cent. Exclusive: GST = amount × rate, added on the same side to the first active `gst` account (2300). Inclusive: GST = amount × rate ÷ (1 + rate), line reduced by GST. GST line description "GST (CODE): description".

---

## 4. Periods

- Route `#/periods`; menu "Periods"; data `periods_list` (any LEDGER key).
- Eyebrow "ACCOUNTING"; heading "Accounting periods".
- Intro: "Lock a month once its figures are checked: only people who can reopen periods can then post into it. Close it after BAS or year-end; reopening a closed month needs a reason and is recorded."
- Header button "Add the next financial year" (`ledger.manage`) → `financial_year_add` for the day after the latest year ends; creates the year (named "FY2026-27"; "FY2026" if the year starts in January) and 12 monthly periods. Audited `financial_year_added`. Seeded years: FY2025-26 and FY2026-27, starting in the company's financial-year start month (July default).
- One panel per year: "${name} ${start} to ${end}". Columns: Month (chip "This month") | Dates | Status | Last changed ("name · date time" or "—") | actions.

| Key | Label | Meaning | Buttons (perm) |
|---|---|---|---|
| open | Open | anyone allowed to post can post | "Lock" → soft_locked, "Close" → closed (`ledger.post`) |
| soft_locked | Locked | only `ledger.reopen` holders can post | "Unlock" → open, "Close" → closed (`ledger.post`) |
| closed | Closed | nobody can post | "Reopen" → open (`ledger.reopen`, reason) |

- Close confirm: "Close this month? Nobody can post into it until someone with permission reopens it."
- Reopen prompt: "Reopen this closed month? Give the reason for the record:"
- Action `period_set_status` (API needs `ledger.post` or `ledger.reopen`; SQL needs `ledger.reopen` when leaving closed, otherwise `ledger.post`). Success "Saved."
- Errors: API "Choose a period status."; SQL "Period not found." / "Unknown period status." / "Give a reason for reopening a closed period."
- Audited `period_reopened` (from closed, with reason) or `period_status_changed`.
- Marking a BAS lodged can also soft-lock its months (see 11.6).

---

## 5. Reports

- Route `#/reports?type=pl|bs|tb|account|ar|ap&from=&to=&asAt=&account=`; menu "Reports". Data action `report` needs `reports.view`; export `report_export` needs `data.export`.
- Eyebrow "ACCOUNTING · REPORTS"; heading = tab name; subtitle "${from} to ${to}" or "As at ${date}" (+ " · CODE Name" for account transactions).
- Tabs: "Profit and loss", "Balance sheet", "Trial balance", "Account transactions", "Aged receivables", "Aged payables".
- Filters: P&L and Account transactions: "From", "To", "Quick range" (Choose… / This month / Last month / This financial year / Last financial year); Account transactions also "Account" (all accounts grouped by type; defaults to 1000). Others: "As at". Button "Run report". Defaults: from = start of the financial year, to/as at = today.
- Header button "Export CSV" (`data.export`, after a report has run). Success "Exported. Exports are recorded in the audit log." Audited `report_exported`. File name e.g. `profit-and-loss-2026-07-01-to-2026-10-08.csv`.
- Account names in P&L, balance sheet and trial balance link to Account transactions; journal numbers link to the journal; names in aged reports link to the customer/supplier.

| Report | Content |
|---|---|
| Profit and loss | Sections "Trading income" / "Total trading income", "Cost of sales" / "Total cost of sales", "Gross profit" (with "(x% margin)"), "Operating expenses" / "Total operating expenses", "Other income", "Other expenses", "Net profit". SQL error "The start date is after the end date." |
| Balance sheet | "Assets" / "Total assets", "Liabilities" / "Total liabilities", "Net assets", "Equity", "Retained earnings (prior years)", "Current year earnings", "Total equity". Check line: "Balanced: net assets equal total equity." or "Out of balance: tell your administrator." |
| Trial balance | Columns Account / Type / Debit / Credit; Total. Note: "Profit and loss accounts show this financial year (from ${date}); earlier years are included in retained earnings." Empty "No balances." |
| Account transactions | Date / Journal / Details (with tax code) / Debit / Credit / Balance; "Opening balance" row; "Closing balance". Note: "Balances shown as debits/credits, the normal side for this account; bracketed figures are the other way." Max 5,000 lines. |
| Aged receivables / payables | Customer or Supplier, buckets "Current", "1–30 days", "31–60 days", "61–90 days", "Over 90 days", "Credits", "Total" (31+ days shown red). Empty "Nothing owed to Panalo at this date." / "Nothing owing to suppliers at this date." Note: "Days past the due date. Credits are unapplied credit notes and payments. / Credits are unapplied supplier credits. The total agrees with the Accounts Receivable (1100) / Accounts Payable (2000) balance at the same date." |

API errors: "Unknown report."; date errors e.g. "The report date must be a date."

---

## 6. Bank accounts

- Route `#/bank-accounts`; menu "Bank accounts" (bank.manage or reports.view); data `banking_overview`.
- Eyebrow "BANKING"; heading "Bank accounts". Intro: "Import statements, match each line to what it pays, and reconcile to the statement balance." Header link "Bank rules" (`bank.manage`).
- Table (every active chart account of kind Bank): Account (link to Reconciliation; linked company account nickname under it) | Ledger balance | Statement balance (with date, or "—") | Lines to match | Reconciled to (date + balance, or "Not yet") | buttons "Import statement" (`bank.manage`), "Reconcile". Empty: "No bank accounts in the chart of accounts." Note: "Ledger balance is as at today. Statement balance is from the latest imported file that gave one."
- Panel "Company bank accounts and bank files": "Link each real account to its ledger account, and add the details your bank gave you for direct entry (ABA) files. New accounts and changes to BSB or account number are made in Company settings and need a second person's approval." Empty: "No company bank accounts yet. Add them in Company settings."
  - Each company account: nickname + chip "Waiting for approval" (pending) / "Ready for bank files" (active with ledger link, APCA ID, bank code and user name) / "Bank files not set up"; "BSB 000-000 · account number" (masked "•••123" for users without `bank.manage`).
  - Fields (disabled without `bank.manage`): "Ledger account" ("Not linked" or a bank account); "APCA user ID" (hint "6 digits, from your bank"); "Bank code" (hint "e.g. CBA, WBC, NAB, ANZ"); "User name for bank files" (hint "As registered with the bank"); checkbox "Add a balancing debit line (some banks require it; ask yours)". Button "Save" → `bank_settings_save` (`bank.manage`), audited `company_bank_settings_changed`. Success "Saved."
  - SQL errors: "Bank account not found." / "This bank account is no longer in use." / "Choose a bank account from the chart of accounts." / "An APCA user ID (direct entry user ID) is 6 digits. Your bank gives it to you." / "The bank code is the 3-letter code your bank gives you, like CBA, WBC, NAB or ANZ." / "The user name for bank files is at most 26 characters." / "That ledger account is already linked to another bank account."

### 6.1 Import a statement
- Route `#/bank-accounts/<ledgerId>/import` (button "Import statement").
- Heading "Import a statement". Intro: "${code} ${name}. CSV, OFX/QFX or QIF from your bank's internet banking. Lines already imported are skipped." Link "Back to reconciliation".
- "Statement file" (accepts .csv .ofx .qfx .qif .txt). Over 5 MB: "That file is over 5 MB. Export a shorter date range." Shows "${file} · read as CSV/OFX/QIF".
- Format detection (bank-file.js): OFX if .ofx/.qfx or the text has `<OFX>`/`OFXHEADER`; QIF if .qif or `!Type:`; otherwise CSV.
- CSV "Columns" (guessed from headings or content, changeable): "Date"; "Amount (one column, money out negative)"; "Description"; "Or: money out column"; "and money in column"; "Reference"; "Balance". Options "None" / column names. Checkboxes "The first row is headings", "Swap money in and out (the file shows spending as positive)".
- "Dates are written" (CSV and QIF): "Day/month/year (Australian banks)" / "Month/day/year (Quicken and US software)"; QIF hint "QIF files from Quicken usually use month/day/year. Check the preview dates."
- Readable dates: yyyy-mm-dd, yyyymmdd, "5 Jan 2026", "Jan 5, 2026", d/m/y or m/d/y (also QIF `'`). Amounts: "$1,234.56", "(1,234.56)", "1,234.56 CR", "DR", trailing "-", "AUD".
- Preview: errors "${n} line(s) can't be read and will be left out:" (CSV "Line N: the date "x" isn't readable." / "Line N: no amount."; OFX/QIF "Transaction N: missing date or amount."); "${n} line(s), ${first} to ${last}, net $X."; first 12 lines (Date, Description, Reference, Amount, Balance), "and N more".
- "Closing balance on the statement (optional)" (hint "Used to check the reconciliation"; filled from OFX LEDGERBAL or the CSV balance column), "Balance date". Button "Import ${n} line(s)" → `bank_import` (`bank.manage`), audited `bank_statement_imported`. Goes to Reconciliation with note "Imported N new line(s); M already here were skipped." and, if lines are dated on or before the last reconciliation: "N new line(s) are dated on or before ${date}, when this account was last reconciled. That reconciliation missed them, or they're duplicates with different wording: check them, then match or exclude them."
- Duplicate detection (SQL): a line is skipped if the account already has the same bank transaction ID (OFX FITID), or the same date + amount + description (case and spaces ignored). Identical lines in one file are numbered, so both are kept the first time and neither is added again.
- "Earlier imports": File (format) | Lines ("N new of M") | Dates | Imported (by, when) | "Undo" or chip "Undone". Confirm: "Remove every line this file added? Only possible while none of them has been matched or excluded." → `bank_import_undo`, audited `bank_import_undone`. Success "Import undone."
- Errors: API "Import at most 5,000 lines at a time." / "The statement balance must be a number."; SQL "Choose the bank account this statement is for." / "Unknown statement format." / "The file has no transactions." / "The statement balance can have at most 2 decimal places." / "Line %: the date or amount isn't readable." / "Line %: the date % is out of range." (older than about 10 years or more than 31 days ahead) / "Line %: the amount must be a non-zero number of dollars and cents." / "Line %: there is no description." / undo: "Import not found." / "Some lines from this file are already matched or excluded. Undo those first." / "A later import covers some of the same dates. Undo that one first."

---

## 7. Reconciliation

- Route `#/reconciliation/<ledgerId>` (defaults to the first bank account); menu "Reconciliation" (bank.manage or reports.view). Without bank accounts: "There are no bank accounts in the chart of accounts."
- Eyebrow "BANKING"; heading "Reconciliation"; selector "Bank account"; button "Import statement" (`bank.manage`).
- Cards: "Ledger balance today"; "Statement balance" ("at ${date}" or "No file with a balance yet"); "Reconciled to" (or "Not reconciled yet").
- Tabs: "To match (N)", "Matched", "Excluded", "Reconcile", "History".

### 7.1 To match
- "Search" (description). Columns: Date | Statement line (reference under it) | Amount (money out red) | Suggested | "Other options"/"Close" (`bank.manage`). Empty: "Every imported line is matched or excluded." / "No lines match that search." Max 500: "Showing the first 500 lines."
- Suggestions (only computed for `bank.manage`; others see "No suggestion"): best one is a button, "N other suggestion(s)".
  - "Match ${number} · ${memo}": existing posted ledger lines on this bank account, same amount, within 14 days, ranked by date gap and shared words (up to 3).
  - "Receipt for ${invoice} · ${customer}" (" (part of $X)" if the line is less than owing): money in; open invoice owing that amount, or whose number/reference is in the description.
  - "Pay ${bill} · ${supplier} (ref)": money out; bill owing exactly that amount.
  - "Paid: ${pay run} · net pay|super": money out equal to an approved pay run's net, or unpaid super.
  - "Rule: ${rule name}": first active bank rule that fits.
  - Accepting calls `bank_match` / `bank_receive_payment` / `bank_pay_bills` / `bank_pay_run` / `bank_create_entry`. Success "Matched."
- "Other options" panel:
  - "Match to entries already in the ledger": tick ledger lines (same sign, within 60 days, up to 40 shown); "Selected: $X of $Y"; button "Match" → `bank_match`. No posting. Empty: "Nothing in the ledger for this account within 60 days of this date." Success "Matched."
  - "Receive money" / "Spend money" (create an entry): "From" / "Paid to" (max 120); lines: "Account" (active accounts allowing manual journals, not this bank account), "Tax" ("No GST" or active codes; fills from the account's default), "Amount" (defaults to the line amount); link "Split into another line" (up to 5 lines); "Amounts include GST."; button "Create and match" → `bank_create_entry`: posts a journal (source "bank_transaction", tax inclusive, dated the statement line date) Dr/Cr the bank account against the chosen accounts plus GST to 2300, and matches it. Success "Created and matched."
  - Money in: "Customer payment for invoices": tick invoices (one customer at a time; "Due ${date} · ref"); "The amount is applied to the ticked invoices oldest first; anything over stays as credit for the customer."; button "Record receipt and match" → `bank_receive_payment` (records a customer payment: Dr bank, Cr 1100). Empty "No unpaid invoices."
  - Money out: "Pay bills": tick bills (one supplier); "The ticked bills must add up to the amount paid."; button "Record payment and match" → `bank_pay_bills` (supplier payment: Dr 2000, Cr bank). Empty "No unpaid bills."
  - Money out: "Pay runs": buttons "${number} net pay|super $X" → `bank_pay_run` (net: Dr 2400 Payroll Clearing, Cr bank; super: Dr 2200, Cr bank). Success "Recorded and matched."
  - "Exclude": "For a line that doesn't belong in the books, such as a duplicate. It's kept, marked excluded."; "Reason" (max 300); button "Exclude" → `bank_exclude`. Success "Excluded."
  - JS: "Tick at least one." / "Tick invoices for one customer at a time." / "Tick bills for one supplier at a time." / "The ticked bills don't add up to the amount paid."

### 7.2 Matched / Excluded
- Columns: Date | Statement line | Amount | "Matched to" (journal links with source and memo) or "Reason" | chip "Reconciled" or button "Unmatch" / "Restore" (`bank.manage`).
- Unmatch confirm (created entries): "Unmatch this line? An entry made from it is reversed; a receipt or payment recorded from it stays (void it in its own screen if it's wrong)."; otherwise "Unmatch this line?". → `bank_unmatch`. Success "Unmatched." / "Restored to the lines to match." (Restore of excluded lines has no confirm). Empty: "Nothing here."

### 7.3 Reconcile
- Fields: "Statement date" (defaults to the latest statement balance date after the last reconciliation, else today); "Closing balance on the statement" (filled from the file's balance); first reconciliation only: "Entries before this date are already through the bank" (hint "First reconciliation only: usually the first day of the first statement you imported"). "Last reconciled to ${date}."
- Summary: "Ledger balance at ${date}"; "Earlier entries treated as through the bank"; "Less: entries not yet through the bank (N)"; "Add: in the bank by then, entered after it"; "The statement should show"; "Difference".
- Notes: "N statement line(s) up to this date still need matching or excluding." / "Out of balance. Look for statement lines not imported, entries dated in the wrong month, or a wrong amount in the ledger."
- "Notes (optional)" (max 1000). Button "Complete reconciliation" (`bank.manage`; disabled while lines are open or there is a difference). Confirm: "Complete the reconciliation to ${date}? Lines up to then are locked; you can undo it later with a reason." → `bank_reconcile`, audited `bank_reconciled`. Success "Reconciled." Opens History.
- Panel "Not yet through the bank at ${date}" (up to 300 items, "and N more").
- No ledger posting.

### 7.4 History and the reconciliation report
- History: Statement date (link) | Balance | Unpresented | By | Status ("Completed" / "Undone" + reason). Empty "No reconciliations yet."
- Report route `#/reconciliation/report/<id>`: heading "Bank reconciliation"; "CODE Name · statement ${date}"; buttons "Back", "Print". Rows "Balance per statement", "Add: entries not yet through the bank", "Less: in the bank, entered after the date", "Balance per ledger". "Completed by X date. Entries before D were treated as already through the bank. notes". Undone: "Undone by X: reason". Panels "Not through the bank at ${date}", "Statement lines reconciled (N)" ("Excluded: reason").
- Button "Undo this reconciliation" (`bank.manage`, completed). Prompt "Undo this reconciliation? Its lines unlock. Say why:" → `bank_reconcile_undo`, audited `bank_reconciliation_undone`.

### 7.5 Matching/reconciliation SQL errors
- "Statement line not found." / "This statement line is already matched or excluded." / "Choose what this statement line pays." / "Some of those entries aren't on this bank account, or are already matched." / "The entries total %, but the statement line is %."
- Unmatch: "This line is in a completed reconciliation. Undo that reconciliation first." / "This statement line isn't matched."
- Exclude: "Only an unmatched line can be excluded." / "Say why this line is excluded (for example, a duplicate)."
- Create entry: "Choose the account (or accounts) this money is for." / "Each line needs a positive amount." / "Choose an account other than this bank account." / "The lines add up to %, but the statement line is %." (plus all posting errors in 3.5)
- Receipt/payment/pay run: "Only money in can be a customer receipt." / "Only money out can pay bills." / "Pay runs are money out." / "Choose net pay or super." / "You applied % but only % was received." / "Bill %: the amount is more than what is owing." / "Only an approved, unpaid pay run can be marked as paid." / "Super for this pay run is already recorded, or the run isn't approved." / "There is no super to pay in this pay run."
- Reconcile: "Choose a bank account." / "Enter the statement date." / "Enter the statement's closing balance." (also API) / "This account is reconciled to %. Choose a later statement date." / "Earlier entries can only be cleared on the first reconciliation." / "The cut-off for earlier entries can't be after the statement date." / "Some statement lines up to % aren't matched or excluded yet." / "Out of balance by %: the ledger says the statement should show %."
- Undo: "Reconciliation not found." / "Undo the later reconciliations first." / "Say why it's being undone."

---

## 8. Bank rules

- Route `#/bank-rules`; menu "Bank rules" (`bank.manage` only).
- Eyebrow "BANKING"; heading "Bank rules". Intro: "Rules suggest how to code repeating statement lines (fuel, bank fees, phone). Each suggestion is still accepted by a person." Button "New rule".
- Columns: Order | Rule (chip "Off" if inactive; payee under it) | When (""text" · in/out/in or out · $min to $max") | Code to (account + tax code or "No GST") | "Edit". Empty "No rules yet."
- Form "New rule" / "Edit rule":

| Label | Notes |
|---|---|
| Name | max 80 (2–80 chars in the database) |
| When the description contains | max 100, hint "Not case-sensitive"; also searched in the reference |
| Money | In or out / Out (default) / In |
| Bank account | Any / a bank account |
| Amount from (optional), Amount to (optional) | compares the absolute amount |
| Code to | active accounts allowing manual journals, not bank accounts |
| Tax | No GST / active codes (fills from the account's default) |
| Payee | max 120 |
| Order | default 100, hint "Lower numbers are tried first" (1–9999) |
| Checkbox Active | |

- Buttons "Save rule" → `bank_rule_save` (audited `bank_rule_created`/`bank_rule_updated`; success "Rule saved."), "Cancel", "Delete" (edit only; confirm "Delete this rule?" → `bank_rule_delete`, audited; success "Deleted.").
- SQL errors: "Choose the account the rule codes to (not a bank or control account)." / "Choose an active tax code." / "Choose a bank account, or leave it for all bank accounts." / "Rule not found." Table checks (raw database messages): name 2–80, text 2–100, amounts ≥ 0, "to" ≥ "from", order 1–9999.
- Rules never post on their own; accepting a rule suggestion posts a bank_transaction journal for the full amount (one line).

---

## 9. Payment batches (ABA)

Routes `#/payment-batches`, `#/payment-batches/new`, `#/payment-batches/<id>`. Menu "Payment batches" (`bank.manage` only; all actions `bank.manage`).

### 9.1 List
- Eyebrow "BANKING"; heading "Payment batches". Intro: "Pay approved bills with one bank file. Someone other than the person who makes a batch approves it before the file can be downloaded." Button "New batch".
- Columns: Batch (number link; maker under it) | Pay on | From | Bills | Status (+ chip "For you to approve" on others' drafts) | Total. Empty "No batches yet."

### 9.2 Statuses
| Key | Label | Meaning | Next |
|---|---|---|---|
| draft | Waiting for approval | made, not approved | approved (someone else); cancelled |
| approved | Approved | bank file can be downloaded | paid (after download); cancelled |
| paid | Paid | supplier payments recorded | none (file can still be downloaded again) |
| cancelled | Cancelled | bills freed | none |

### 9.3 New batch
- Heading "New payment batch". Intro: "Bills need an approved supplier bank account. The bank details are copied now and checked again when the batch is approved." Link "Back".
- If no account is ready: "No company bank account is set up for bank files yet. Add the APCA user ID, bank code and user name in Bank accounts."
- Fields: "Pay from" ("Nickname (BSB •••123)"; only active accounts with a ledger link, APCA ID, bank code and user name); "Payment date" (default today); "Description on the bank file" (default "SUPPLIERS", max 12, hint "Up to 12 letters or numbers"; upper-cased, other characters removed); "Show bills due by" (filter).
- Bills table (approved bills with something owing, by due date): tick | Bill (+ supplier reference) | Supplier | Due (red if overdue) | Pay to ("BSB •••123", or a problem: "In a batch already", "No approved bank account", "10-digit account: pay separately"; no tick box then) | Owing | Pay (editable amount once ticked). Empty "No unpaid approved bills." Total "N bill(s), $X".
- Button "Make the batch" → `payment_batch_create`. Notifies `bank.manage` holders ("Payment batch to approve: PB-…"); audited `payment_batch_created`. No ledger posting.
- SQL errors: "Choose an approved company bank account to pay from." / "Set up % for bank files first: its ledger account, APCA user ID, bank code and user name." / "Choose the payment date." / "Choose the bills to pay." / "A batch can pay at most 500 bills." / "Only approved bills can be paid." / "Bill %: the amount is more than what is owing." / "Bill % is already in another batch waiting to be paid." / "% has no approved bank account." / "% has a 10-digit account number, which bank files can't carry. Pay them separately."

### 9.4 Batch detail
- Heading "Payment batch ${number}" + chip; "Pay on ${date} from ${nickname} (BSB •••123) · "DESCRIPTION"". Link "Back".
- Steps: "Made by X date"; "Approved by X date" / "Waiting for someone else to approve" / "Not approved"; "Bank file downloaded by X date" / "Bank file not downloaded yet"; "Marked as paid by X date" / "Cancelled: reason" / "Mark as paid once the bank has processed the file".
- Buttons:
  - "Approve" (draft, not the maker). Maker sees "You made this batch, so someone else must approve it." Confirm: "Approve ${number}: N payment(s), $X? Check the bills and the bank details first." → `payment_batch_approve`; re-checks each bill still owes that much, supplier bank details unchanged, paying account still active and linked. Notifies the maker ("Payment batch approved: …", "Download the bank file and upload it to the bank."). Audited. Success "Approved. The bank file can now be downloaded."
  - "Download bank file (ABA)" (approved or paid) → `payment_batch_aba`; file `PB-0001.aba`; every download audited `payment_batch_file_downloaded` (records who). Message (warning tone): "Downloaded ${file}: N payment(s), $X. Upload it in your bank's internet banking, then mark the batch as paid once the bank has processed it. The file holds bank details: delete it after uploading."
  - "Mark as paid" (approved and downloaded). Confirm: "Has the bank processed the file? This records a payment for each supplier from the bank account." → `payment_batch_mark_paid`: one supplier payment per supplier dated the payment date, reference = batch number; posts Dr 2000 Accounts Payable, Cr the batch's ledger bank account (source supplier_payment). Audited `payment_batch_paid`. Success "Marked as paid. The bills are paid."
  - "Cancel batch" (draft or approved). Prompt: "Cancel this batch? Say why:" or, after download, "Cancel this batch? The bank file was downloaded: make sure it wasn't uploaded to the bank. Say why:" → `payment_batch_cancel`, audited. Success "Cancelled."
- Items: Supplier | Bill (link; supplier reference) | Account (name, BSB, masked number) | Reference (lodgement reference: supplier reference or bill number, max 18) | Amount; Total.
- SQL errors: "Payment batch not found." / "Only a batch waiting for approval can be approved." / "Someone other than the person who made the batch must approve it." / "The account this batch pays from is no longer active or linked to the same ledger account. Cancel the batch and make a new one." / "Bill % is no longer owing that much. Cancel this batch and make a new one." / "%'s bank details changed after the batch was made. Cancel it and make a new one." / "The bank file is available once the batch is approved." / "Only an approved batch can be marked as paid." / "Download the bank file and send it to the bank first." / "Only a batch that hasn't been paid can be cancelled." / "Say why the batch is cancelled." / "You downloaded the bank file, so someone else must confirm with the bank that it wasn't paid, and cancel it."
- Guard while a bill is in an open batch: "This bill is in payment batch %, which is waiting to be approved or paid. Mark that batch as paid, or cancel it first." / "This bill is in payment batch %. Cancel the batch before voiding the bill."
- ABA file (`_shared/aba.ts`): 120-character records, CRLF; record 0 (bank code, user name, APCA ID, description, date DDMMYY), one type-1 record per payment with transaction code 50 (suppliers), optional balancing debit code 13, record 7 totals. Errors (shown as the message): "Bank file: set the 3-letter bank code for the paying account." / "Bank file: set the 6-digit APCA user ID for the paying account." / "Bank file: set the user name registered with the bank." / "Bank file: there is nothing to pay." / "Bank file: a BSB is 6 digits." / "Bank file: account number % must be 5 to 9 digits." / "Bank file: every payment must be more than zero." / API "The bank file total doesn't match the batch." / "Set up % for bank files first (Bank accounts > settings)."

---

## 10. (Pay run ABA) noted for cross-reference
`pay_run_aba` (`payroll.sensitive`) builds a wages file (code 53, description "WAGES", reference "PAY ${run}") from the payroll-purpose company account; it lives on the Pay runs screen (payroll inventory), not here.

---

## 11. BAS

Routes `#/bas` (list + prepare), `#/bas/<id>` (workpaper). Menu "BAS" (tax.bas or tax.review). Read actions need tax.bas or tax.review.

### 11.1 List
- Eyebrow "TAX"; heading "BAS". Intro: "Workpapers for each activity statement, worked out from the ledger. Someone other than the preparer reviews each one; it is then lodged with the ATO (through ATO online services or your tax agent) and marked lodged here. Nothing is sent to the ATO from this system."
- Panel "Settings": "Registered for GST, **accrual|cash** basis, BAS lodged **quarterly|monthly|annual**." or "**Not registered for GST**: only PAYG withholding is reported"; "Change these in Company settings. A BAS keeps the basis it was made with."
- Form "Prepare a BAS" (`tax.bas`): "Lodged" (Monthly/Quarterly/Annual; changing it sets the end date), "Period from", "Period to" (default: the period after the latest BAS, or the most recently ended period), "GST reporting" ("Simpler BAS: G1, 1A and 1B" / "Full: G1 to G20 (calculation worksheet)"; hint "Simpler BAS is for turnover under $10 million. Check which one your ATO account uses."). Button "Prepare" → `bas_create`, audited `bas_created`.
- Columns: Period (link; "Quarterly · accrual basis") | Status (+ "Overdue") | Due | Payable (refund) (whole dollars; refunds in brackets) | Prepared | Reviewed | Lodged (date + reference). Empty "No BAS prepared yet." Note: "Due dates are for lodging yourself. Tax agents may have later dates under the lodgment program; a due date on a weekend or public holiday moves to the next business day."
- Due dates: monthly 21st of next month; quarterly 28th of the month after (December quarter 28 February); annual end of the fourth month after (31 October).

### 11.2 Statuses
| Key | Label | Meaning | Next |
|---|---|---|---|
| draft | Being prepared | figures live, editable | reviewed (Mark reviewed, other person); deleted |
| reviewed | Reviewed, ready to lodge | figures fixed | lodged/settled (Mark lodged); draft (Back to draft) |
| lodged | Lodged, not yet paid | transfer posted | settled (payments/refunds in full) |
| settled | Lodged and settled | nothing left to pay (or label 9 was 0) | lodged again if a payment is voided |

### 11.3 Workpaper
- Eyebrow "TAX · BAS"; heading "${from} to ${to}" + chip; "Quarterly · GST accrual basis · simpler BAS|full reporting · due ${date}". Buttons "Workpaper (PDF)" (`bas_pdf`, audited `bas_workpaper_generated`; file `BAS-workpaper-<from>-to-<to>.pdf`), "All BAS".
- Banners: reviewed and books changed: "**The books changed after this BAS was reviewed (date).** Send it back to draft and review it again before lodging." + changed labels. Lodged with later changes: "**Entries in this period changed after it was lodged.** They will be carried into the next BAS you prepare as adjustments (or you can revise this BAS with the ATO):". Carried in: "**Includes changes to earlier BAS after they were lodged:**".
- Tabs: "BAS", "GST by tax code", "PAYG withholding", "Reconciliation", "To check (N)".
- BAS tab: "Goods and services tax" (simpler: G1 only; full: G1 Total sales (including any GST), G2 Export sales, G3 Other GST-free sales, G4 Input taxed sales, G10 Capital purchases (including any GST), G11 Non-capital purchases (including any GST), G13 Purchases for making input taxed sales, G14 Purchases without GST in the price, G15 Estimated purchases for private use or not income tax deductible) then 1A GST on sales, 1B GST on purchases. "PAYG tax withheld": W1 Total salary, wages and other payments; W2 Amount withheld from payments shown at W1; W4 Amount withheld where no ABN is quoted; W3 Other amounts withheld; W5 Total amounts withheld (W2 + W4 + W3). "Summary": 1A; 4 PAYG tax withheld; 5A PAYG income tax instalment; 8A Amount you owe the ATO; 1B; 7D Fuel tax credit; 8B Amount the ATO owes you; 9 "Payment due" / "Refund due". Note: "Whole dollars, as entered on the activity statement: cents are dropped from each label. The exact amount is shown beside a label where it had cents." + simpler note "Simpler BAS: only G1, 1A and 1B are reported for GST; the other G labels are in the GST tab for checking."
- GST by tax code: Tax code | Labels | Amount | GST | Including GST | "Entries"/"Hide" (drill-down `bas_lines`: date, journal, memo, accounts, base, GST; cash note "Cash basis: invoices and bills are listed with the share paid in the period; other entries in full."; "Only the first 5,000 lines are listed."). Empty "No GST-coded amounts in the period." "Calculation worksheet": G5 G2 + G3 + G4; G6 G1 less G5; G8 G6 + G7 (adjustments); G9 GST on sales: G8 divided by 11; G12 G10 + G11; G16 G13 + G14 + G15; G17 G12 less G16; G19 G17 + G18 (adjustments); G20 GST on purchases: G19 divided by 11; "1A from the GST charged / G9" ("Agree" or "Check: a GST-free or input-taxed item may be coded with GST"); "1B from the GST paid / G20" ("Agree" or "Check the purchase coding") (flag if more than $1 apart).
- PAYG withholding tab: "W1 Pay subject to withholding, from pay runs paid in the period (after salary sacrifice)"; "W2 PAYG withheld by those pay runs"; "W4 Withheld from suppliers who quoted no ABN (bills dated in the period)"; "W3 Other amounts withheld" ("Not used by Panalo; enter on the BAS by hand if ever needed"); "W5 Total withheld". Note: "If the ATO has pre-filled W1 and W2 from Single Touch Payroll, compare them with these before lodging. Single Touch Payroll reporting from this system comes in Phase 8."
- Reconciliation tab: "GST account": "Movement on the GST account in the period (BAS transfers left out)"; "GST on sales less GST on purchases, accrual basis" or "1A less 1B"; "Difference" ("Agrees" / "$X was posted straight to the GST account (see To check)" / "Check entries to the GST account"); cash: "This BAS (cash basis): 1A less 1B" ("The rest stays in the GST account until invoices and bills are paid"). "PAYG withholding account": "Posted by pay runs paid in the period" ("W2 $X: agrees" / ": differs by $Y"); "No-ABN withholding posted on bills" (W4); "Other entries to the account" ("Not on this BAS: check them").
- To check tab: chip "Check" (warn) or "Note" (info) | Entry | What to check | Amount. Empty: "Nothing to check: every amount is coded and the accounts agree." Up to 500, warnings first. Messages (SQL `bas_exceptions`):
  - warn: "No tax code on CODE Name: not on the BAS. Add a code (NG if it really isn't reportable)."
  - warn: "Tax code X is for sales|purchases but is on CODE Name."
  - info: "Capital purchase code on CODE Name, which isn't a fixed asset (G10 or G11?)." / "Fixed asset CODE Name coded X: capital purchases go at G10 (code CAP)."
  - warn: "GST of X at CODE isn't 10% of Y."
  - warn: "Posted straight to the GST account (memo): it isn't on any BAS label, so the GST account won't agree."
  - warn: "GST claimed on a bill from NAME, who has no ABN. / who isn't registered for GST. You need a valid tax invoice to claim it."
  - info: "Invoice|Credit note not approved yet: not on this BAS." / "Bill not approved yet (status): not on this BAS."
  - warn: "Pay run paid in the period isn't approved yet: not at W1 or W2."
  - info: "N bank statement line(s) in the period aren't matched yet: there may be income or costs not in the books."

### 11.4 Prepare, review, lodge, pay panel ("Prepare, review, lodge, pay")
- Steps: "Prepared by X date"; "Reviewed by X: "comment"" / "Review by someone other than the preparer (Review BAS permission)"; "Lodged D, reference R (marked by X) · JE-… · N month(s) locked" / "Lodge with the ATO (online services or your tax agent), then mark it lodged here"; "Settled" / "Nothing to pay" / "Pay the ATO, or receive the refund" / "To pay: $X of $Y" / "Refund to receive: …".
- Draft, `tax.bas`: fields "5A PAYG income tax instalment ($)" (hint "From your instalment notice, or T7 to T11 on the BAS"), "7D Fuel tax credit ($)" (hint "From your fuel tax credit calculator"), "GST reporting" (Simpler BAS / Full (G1 to G20)), "Notes for the reviewer" (max 2000). Buttons "Save" → `bas_save` (adds the saver to the people who changed it; success "Saved."); "Delete draft" (confirm "Delete this draft BAS? Nothing has been lodged or posted." → `bas_delete`).
- Draft, no right to review: "Waiting for review by someone with the Review BAS permission who didn’t prepare or change it."
- Review (`tax.review`, draft, not preparer or anyone who saved it): "Review comment (optional)" (max 1000); "Mark reviewed". Confirm: "Mark this BAS as reviewed? Its figures are fixed now, and it can then be lodged." → `bas_review` (fixes figures and label 9; notifies the preparer "BAS reviewed: …"). Success "Reviewed. The preparer has been told it's ready to lodge."
- Lodge (`tax.bas`, reviewed): "Date lodged with the ATO" (default today), "ATO receipt or reference (optional)" (max 60), checkbox (ticked) "Lock the months of this BAS (only people who can reopen periods can post into them)". "Mark lodged". Confirm: "Has this BAS been lodged with the ATO with exactly these amounts? This posts the transfer to the ATO account and can't be undone." → `bas_lodge`. Success "Marked lodged and posted to the ATO account."
  - Journal (source `bas`, dated the lodgement date, memo "BAS Mon YYYY to Mon YYYY · ref"): Dr 2300 GST (1A − 1B exact) "GST on BAS: 1A less 1B"; Dr 2100 PAYG (W5) "PAYG withholding on BAS (W5)"; Dr 1450 (5A) "PAYG instalment (5A)"; Cr 4850 (7D) "Fuel tax credits (7D)"; Cr 2350 (label 9; Dr for a refund) "Owed to the ATO (9)" / "Refund due from the ATO (9)"; cents difference to 7950 "Cents dropped on the BAS". Status becomes settled if 9 = 0, else lodged. Optionally soft-locks the period's open months.
- "Back to draft" (reviewed, `tax.bas`, shown beside Mark lodged). Prompt "Send this BAS back to draft? Its figures will be worked out again and it will need another review. Say why:" → `bas_reopen`. Success "Back to draft."
- Pay (lodged; `tax.bas` or `bank.manage`): "Paid from" / "Received into" (active bank accounts), "Date", "Amount" (defaults to what's left). Button "Record payment" / "Record refund" → `bas_record_payment`: posts (source `bas_payment`) payment Dr 2350 / Cr bank, refund Dr bank / Cr 2350. Success "Payment recorded." / "Refund recorded." Hint "Record it here, then match the bank statement line to this payment in Reconciliation."
- Payments list: date, "Paid to the ATO" / "Refund from the ATO" · bank, "Voided: reason", journal link, amount, "Void" (lodged/settled; `tax.bas` or `bank.manage`). Prompt "Void this payment? Its journal is reversed and the amount is owing again. Say why:" → `bas_payment_void`. Success "Payment voided."
- API/SQL errors: "5A is in whole dollars." / "7D is in whole dollars." / "Enter the amount." / "BAS not found." / "The business isn't registered for GST and has no payroll: there is no BAS to prepare." / "Choose how often the BAS is lodged." / "A BAS period runs from the first day of a month to the last day of a month." / "A monthly BAS covers one calendar month." / "A quarterly BAS covers a quarter (July to September, October to December, January to March or April to June)." / "A annual BAS covers the financial year." / "A BAS already covers part of this period." / "Only a draft BAS can be changed. Send it back to draft first." / "Enter 5A and 7D in whole dollars." / "Only a draft BAS can be reviewed." / "Someone other than the people who prepared or changed the BAS must review it." / "An earlier BAS isn't lodged yet. Lodge the BAS in order." / "Only a reviewed BAS that isn't lodged can go back to draft." / "Say why it goes back to draft." / "Only a draft BAS can be deleted." / "The BAS must be reviewed before it is marked lodged." / "Enter the date it was lodged with the ATO (after the period ends)." / "The books for this period changed after the BAS was reviewed. Send it back to draft and review it again." / "The BAS accounts (2350 ATO integrated client account, 1450 instalments, 4850 fuel tax credits, 7950 rounding) are missing or changed." / "There is no active GST or PAYG withholding account." / "Payments are recorded against a lodged BAS that isn't settled." / "Choose the bank account." / "Enter the date." / "Enter an amount up to the $X still owing|to be refunded." / "Payment not found." / "Say why the payment is voided." / "This payment is matched to a bank statement line. Unmatch it in Reconciliation first."
- All steps audited (`bas_created`, `bas_saved`, `bas_reviewed`, `bas_reopened`, `bas_deleted`, `bas_lodged`, `bas_payment_recorded`, `bas_payment_voided`).

### 11.5 How figures are worked out
- G labels: GST-inclusive totals of the codes carrying them; 1A/1B: the GST lines actually posted. Accrual basis by journal date; cash basis: invoices/bills in proportion to what was paid and allocated in the period (voided payments count back out), other entries by date. W1/W2 from approved/paid pay runs with payment date in the period; W4 from no-ABN withholding in proportion to bill payments; W3 = 0; W5 = W2 + W3 + W4; 4 = W5; 8A = 1A + 4 + 5A; 8B = 1B + 7D; 9 = 8A − 8B. Reported labels drop cents. Changes to lodged periods are carried into the next BAS as adjustments.

### 11.6 PDF (`_shared/bas-pdf.ts`)
Sections "BAS WORKPAPER", "GOODS AND SERVICES TAX (whole dollars, as entered on the BAS)", "PAYG TAX WITHHELD", "SUMMARY", "GST BY TAX CODE (exact amounts)", "ADJUSTMENTS FROM EARLIER BAS (included above)", "RECONCILIATION TO THE LEDGER", "SIGN-OFF" (Prepared, Reviewed); status line "Draft: figures can still change" / "Reviewed" / "Lodged" / "Lodged and settled"; "page N of M".

---

## 12. TPAR

- Route `#/tpar`; menu "TPAR" (tax.bas or tax.review); data `tpar_get`.
- Eyebrow "TAX"; heading "Taxable payments annual report". Intro: "Payments made in the financial year to contractors marked "Report on the TPAR" (building and construction services). Report them to the ATO by 28 August through ATO online services or your tax agent; this system doesn't lodge it."
- "Financial year" selector (current and three earlier; default = last ended year).
- Cards: "Contractors"; "Gross paid" ("Including GST and any tax withheld"); "GST"; "Due" (28 August; "Lodged ${date}" / "Not marked lodged" / "Year not over yet").
- Columns: Contractor (link; trading name; problems in red: "No ABN, and no tax withheld", "Address incomplete", "Payments not applied to a bill: included in full, GST unknown") | ABN ("None") | Address | Gross paid | GST | Tax withheld (no ABN). Empty "No payments to reportable contractors in this year."
- Button "Download (CSV)" → client-side file `TPAR-2025-26.csv` (columns ABN, Name, Trading name, Address, Gross amount paid (incl GST), Total GST, Total tax withheld (no ABN)). Not logged.
- Note: "Amounts are the share of each bill paid in the year, so part-paid bills count in part. Payments for materials only shouldn't be reported: untick "Report on the TPAR" on suppliers who only sell materials."
- Panel "Subcontractors paid but not marked for the TPAR": "Check whether these provided building and construction services. If they did, tick "Report on the TPAR" on the supplier."
- Lodged: "Marked lodged D, reference R by X: N contractor(s), $X." Else (`tax.bas`, year ended): "Date lodged with the ATO", "Reference (optional)", "Mark lodged" → `tpar_lodge` (stores a snapshot; audited `tpar_lodged`). Success "Marked lodged." No posting, no undo.
- SQL errors: "Choose the financial year." / "Enter the date it was lodged (after the year ended)." / "The TPAR for this year is already marked lodged."

---

## 13. Fixed assets

Routes `#/assets` (tabs via `?tab=`), `#/assets/new`, `#/assets/new?line=<billLineId>`, `#/assets/<id>`, `#/assets/<id>/edit`. Menu "Fixed assets" (assets.manage or reports.view). Writes need `assets.manage`.

### 13.1 Overview
- Eyebrow "ACCOUNTING"; heading "Fixed assets". Intro: "Tools, vehicles, plant and office equipment, with depreciation posted to the ledger each month. Book values are at ${date}. Tax depreciation is recorded for your accountant; it isn't posted or claimed here." Button "Add an asset" (`assets.manage`).
- Tabs "Register", "Depreciation", "Categories", "Reconciliation".

Register tab:
- (`assets.manage`) "Bill lines on fixed asset accounts, not in the register yet": bill, date, supplier, description, account, cost, button "Add to register" (opens the form pre-filled). Lines from approved bills on accounts of kind Fixed asset; a line counts as added when an asset from the same bill has the same cost.
- Filters: "Search" (placeholder "Number, name, serial, location"); "Show" (In use / Disposed / All); button "Download CSV" (client-side `fixed-assets-<date>.csv`, not logged).
- Columns: Asset (name link; number · serial) | Category | In service | Location (custodian) | Cost | Depreciation | Book value | Status ("In use" / "Disposed ${date}"). Total row. Empty "No assets yet." / "Nothing matches."

Depreciation tab (`assets.manage` for the form):
- "Depreciate to month end" (default: month after the last run, or last month end), button "Preview" (JS "Choose the month end."; date moved to month end) → `depreciation_preview`. Then button "Post $X to ${date}" (disabled if nothing). Note "Runs go month by month; the last was to ${date}. One journal a run, by category. Only the latest run can be undone."
- Preview panel "Preview to ${date}": Asset | From | Depreciation; empty "Nothing to depreciate for this period."
- Post: confirm "Post depreciation of $X to ${date}?" → `depreciation_run`. Journal (source `depreciation`, dated the month end, memo "Depreciation to DD Mon YYYY"): per category Dr expense account (7800, coded NG) / Cr accumulated depreciation (e.g. 1510), "Depreciation: Category". Audited `depreciation_run`. Success "Depreciation posted."
- "Runs": To | Total | Journal | Run by | Status ("Posted" / "Undone") | "Undo" (latest posted run only). Prompt "Undo this depreciation run? Its journal is reversed. Reason:" → `depreciation_undo` (reverses the journal on its own date). Success "Run undone." Empty "No depreciation runs yet."
- SQL errors: "Depreciation runs to the last day of a month." / "Depreciation has already been run to %." / "Run depreciation month by month: the next one is to %." / "Depreciation run not found." / "Only the latest depreciation run can be undone." / "An asset in this run has since been disposed of. Depreciation for it can't be undone." / "Say why it is undone." (plus period errors from 3.5)

Categories tab:
- Columns: Category ("Not in use") | Cost account | Accumulated depreciation | Expense | Method | Useful life | Tax effective life | "Edit". Button "Add a category". Note: "Useful life is your accounting estimate. The tax effective life is a note for the accountant (the ATO publishes effective lives); it doesn't change what's posted."
- Seeded: Tools and equipment (1500/1510/7800, Straight line, 60 months); Vehicles (1600/1610/7800, Diminishing value, 96); Plant and machinery (1700/1710/7800, Straight line, 120); Office equipment (1800/1810/7800, Straight line, 36).
- Form "New category" / "Edit ${name}": "Name" (required, max 80), "Cost account" (Fixed asset kind), "Accumulated depreciation account", "Depreciation expense account" (expense/other expense/cost of sales), "Method" (Straight line / Diminishing value / Not depreciated), "Useful life (months)" (1–1200), "Tax effective life (years, a note)", "In use" (Yes/No, edit only). Buttons "Save" ("Category saved."), "Cancel".
- Errors: API "Useful life is a whole number of months from 1 to 1,200." / "The tax effective life is a number of years above 0."; SQL "Choose a fixed asset account for the cost." / "Choose an accumulated depreciation account." / "Choose the depreciation expense account." / "Category not found." / "Assets use this category: its accounts can't change." / "There is already a category with that name." / "Give the category a name and a useful life of 1 to 1,200 months."

Reconciliation tab:
- "As at", button "Check" → `asset_reconciliation`. "Register to ledger at ${date}": Category (accounts) | Register cost | Ledger cost | Register depreciation | Ledger depreciation | Check ("Agrees" / "Differs"). Note: "A difference usually means a bill or journal posted to a fixed asset account that isn't in the register yet, an asset entered with a cost that differs from the bill, or opening balances not brought in. Categories that share accounts show the shared ledger balance on each."

### 13.2 Add / edit an asset
- Heading "Add an asset" / "Edit ${number}". Intro: "Adding an asset doesn't post its cost: the purchase reaches the ledger through its bill (or a journal for opening balances). Depreciation and disposals post from here." From a bill: "From a bill line: check the details, then save." Depreciated asset: "This asset has been depreciated, so its cost, category, in-service date and opening depreciation are fixed. Undo the depreciation runs to change them." (those fields disabled).
- No access: "Your access doesn’t include changing fixed assets." Disposed: "A disposed asset can’t be changed."
- "The asset": "Name" (required, max 160), "Category" (active), "Serial or registration" (80), "Location" (120), "Looked after by" (active/on-leave employees), "Project" (open projects); "Notes" (2000).
- "Purchase": "Purchase date" (required), "In service from" (hint "Leave blank if the same as the purchase date"), "Supplier", "Cost before GST" (required), "GST paid" (hint "Claimed through the bill, not here").
- "Accounting depreciation": "Method" ("Category default" / Straight line / Diminishing value / Not depreciated), "Useful life (months)" (hint "Blank for the category default"), "Residual value", "Opening depreciation" (hint "For an asset brought in from another system"), "Opening depreciation at".
- "Tax treatment (a note for the accountant)": "Tax method" (Not recorded / Prime cost / Diminishing value / Instant asset write-off / Small business pool / Not depreciable), "Tax effective life (years)", "Tax notes" (1000).
- Buttons "Save" → `asset_save` (number FA-0001…; audited `asset_created`/`asset_updated` with old and new values; no posting), "Cancel".
- Errors: API "Give the asset a name." / "The cost must be a positive number." / "GST must be a positive number." / "The residual value must be a positive number." / "Opening depreciation must be a positive number." / "The purchase date must be a date." / useful life and tax life as in 13.1; SQL "Choose the asset category." / "Supplier not found." / "Bill not found." / "Custodian not found." / "Project not found." / "Asset not found." / "A disposed asset can't be changed." / "This asset has been depreciated: its cost, category, in-service date and opening depreciation can't change. Undo the depreciation runs first." / "Give the date the opening depreciation is at (on or after the in-service date)." / "Check the asset: cost above the residual value, in service on or after purchase, a useful life to depreciate, opening depreciation no more than cost less residual." / "Enter the name, purchase date and cost as numbers and dates (useful life in whole months)."
- Depreciation maths: straight line (cost − residual) ÷ life per month; diminishing value book value × 2 ÷ life per month; part months by days; never below residual.

### 13.3 Asset detail
- Eyebrow "FIXED ASSETS · FA-0001"; heading = name; chip "In use"/"Disposed D"; category. Buttons (`assets.manage`, in use): "Edit", "Sell or write off".
- Summary: "Cost (before GST)", "Accumulated depreciation", "Book value".
- "Details": Purchased (from supplier · bill), In service, GST paid, Serial or rego, Location, Looked after by, Project, Notes.
- "Accounting depreciation": Method, Useful life, Residual value, Opening depreciation; table Period | Amount | Journal ("to disposal"); else "Not depreciated yet. Depreciation is posted by the monthly run (Fixed assets, Depreciation)."
- "Tax treatment (for the accountant)": Method, Effective life, Notes; "Recorded only: tax depreciation, write-offs and pooling are worked out by your accountant and aren't posted here."
- "Disposal" (if disposed): Date, Reason, Proceeds (before GST), GST on the sale, Journal.
- Attachments panel (upload needs `assets.manage`; PDF or photo; error "Attach a PDF or a photo.").
- Disposal form "Sell or write off": "Depreciation is worked out to the disposal date and posted with the disposal. The cost and its depreciation come off the register; the book value goes to 7810 Book Value of Assets Disposed and the proceeds to 4950 Proceeds from Sale of Assets. A taxable sale's GST goes to the BAS." Fields "Date" (required), "Proceeds before GST (0 if written off)", "Tax code on the sale" (sales/both codes; default GST), "Proceeds received into" ("Choose…"; asset/liability accounts allowing manual journals, not receivable/payable/GST/fixed asset/accumulated depreciation; hint "A bank account, or a clearing account if you're invoicing the buyer."), "Reason" (required, placeholder "Sold, traded in, scrapped, stolen"). Buttons "Post disposal", "Cancel". Confirm "Post this disposal? It can't be undone from here: a correcting journal would be needed." → `asset_dispose`. Success "Disposal posted."
  - Journal (source `asset_disposal`, dated the disposal date, memo "Disposal of FA-0001 Name"): Cr asset cost account (cost); Dr accumulated depreciation (to date); Dr expense / Cr accumulated (part-month depreciation); Dr 7810 (book value); Dr received-into account (proceeds + GST); Cr 4950 (proceeds, with the tax code; GST line to 2300 → BAS G1/1A). Audited `asset_disposed` (with gain/loss).
  - Errors: API "Enter the proceeds before GST (0 if written off)." / "The disposal date must be a date."; SQL "This asset has already been disposed of." / "Enter the disposal date (after it went into service)." / "Depreciation has already been run past this date. Undo the later runs, or use a later date." / "Say why: sold, traded in, scrapped, stolen." / "The disposal accounts (4950 and 7810) are missing." / "Choose where the proceeds went (a bank account, or a clearing account if invoiced)." / "Choose the tax code for the sale (GST for a taxable sale)."

---

## 14. Segregation of duties

1. Journals: preparing needs `ledger.journal`, posting needs `ledger.post`. A draft from someone without `ledger.post` (default accountant role) always needs a second person. **Someone holding both (super admin, finance admin) can post their own journal; there is no maker/checker rule beyond the permission split.**
2. Periods: lock/unlock/close needs `ledger.post`; reopening a closed month needs `ledger.reopen` and a reason (audited `period_reopened`). Posting into a locked month needs `ledger.reopen`.
3. Payment batches: the maker can't approve (SQL 42501); after download, the person who downloaded can't cancel; approval re-checks bills and bank details.
4. BAS: reviewer must hold `tax.review` and must not have prepared or saved the BAS; earlier BAS must be lodged first; figures fixed at review; lodging refused if the books changed since review.
5. Company bank account BSB/account number changes need a second person's approval (Company settings, other inventory).
6. Reconciliation/matching and ABA files: all `bank.manage`; no second-person rule on reconciliations.
7. Fixed assets: all `assets.manage`; no second person.

## 15. High-risk actions

- Post / Reverse journal; Save and post (ledger postings, immutable).
- Close / Reopen periods; "Add the next financial year".
- Archive accounts; edit tax codes; deactivate tax codes.
- Statement import and Undo import; Exclude; Create and match (posts); Unmatch (reverses created entries); Complete / Undo reconciliation.
- Payment batch Approve, Download bank file (holds bank details), Mark as paid (posts supplier payments), Cancel after download.
- Bank settings (APCA ID, bank code, ledger link).
- BAS Mark lodged (posts transfer, can't be undone, locks months), Record/void payment.
- TPAR Mark lodged (no undo).
- Depreciation run/undo; Post disposal (can't be reversed).
- Export CSV (logged), TPAR/asset CSV downloads (not logged).

## 16. Verification required (in code but not reachable, or UI/back-end mismatch)

1. Reports menu appears for ledger.manage/journal/post/audit.view holders, but the `report` action needs `reports.view`; without it the screen shows "Your access doesn't include this area. Ask an administrator if you need it."
2. Journal detail shows "Reverse" on any posted non-reversal journal (`ledger.post`), but the server refuses journals from modules ("This journal was posted by a %…"), bank-matched entries, BAS, depreciation and disposal journals.
3. Periods: API/SQL allow closed → soft_locked and other transitions; UI only offers Reopen (closed → open).
4. Tax codes: BAS labels can't be set or edited in the UI (copied from the system code of the same kind).
5. `bank_lines` accepts status "all" and from/to date filters; the UI uses only new/matched/excluded and search.
6. Reconciliation report shows "Undo this reconciliation" on every completed reconciliation; only the latest can be undone ("Undo the later reconciliations first.").
7. banking.js source label map has `pay_run_super` ("Super") but super payments post with source `super_payment`, so they show the raw key; journals.js labels only `manual`.
8. BAS: G7, G15, G18 adjustments and W3 are never calculated (always 0); 1C–1G, 5B, 7C, GST instalments not supported (BAS.md). PAYG tab text says STP "comes in Phase 8".
9. BAS "Back to draft" appears only inside the Mark lodged form (reviewed + `tax.bas`).
10. Lodging posts on the lodgement date; if that month is locked/closed, the posting rules in 3.5 apply (comment claims it posts "even if the period's months are already locked", true only for the BAS's own months).
11. TPAR CSV and fixed-asset CSV downloads are produced in the browser: no `data.export` check and no audit entry (unlike report Export CSV).
12. Asset category "In use" can be set only when editing; `asset_category_save` also refuses account changes once assets use the category.
13. Account archive: P&L accounts with a balance can be archived; only asset/liability/equity balances block it.
14. Payment batch "New batch" link is always shown on the list (to `bank.manage` holders); the create screen disables "Make the batch" if no source is ready.
15. Pay-run ABA (`pay_run_aba`) is exposed on Pay runs (payroll), not on Banking screens.
