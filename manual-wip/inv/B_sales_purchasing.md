# Inventory B: Sales and Purchasing (Panalo Accounts)

Source files (repo `/home/claude/jaysonsugpatanjs-hub.github.io`):
front end `accounts/views/{customers,quotes,invoices,receipts,suppliers,purchase-orders,bills,supplier-payments}.js`, `accounts/lib/docs.js`, `accounts/lib/validate.js`, `accounts/lib/ui.js`, `accounts/app.js`;
API `supabase/functions/finance-api/{sales,purchases,docs,index}.ts`;
SQL `supabase/migrations/20261009000000_sales_purchasing.sql` (+ `doc_calc_lines` / `doc_insert_lines` / `doc_recalc` redefined in `20261010000000_projects_timesheets.sql`; `approval_decide` redefined in `20261011000000_payroll.sql`; payment-batch guard in `20261012000000_banking.sql`);
design doc `docs/SALES_PURCHASING.md`.

Conventions in this file: "JS" = raised in the browser; "API" = raised in the finance-api edge function; "SQL" = raised in a database function. Strings in quotes are verbatim. `%` in SQL messages is filled with a value.

---

## 0. Cross-cutting rules

### 0.1 Access, MFA and routing
- Every API call goes through `index.ts`: verified session → profile → permissions → MFA → the action's permission (`need()`), then the SQL function checks the permission again (`app_require`) and writes the audit row.
- Generic permission error (API, `need()` and attachment checks): "Your access doesn't include this area. Ask an administrator if you need it."
- MFA: if the user holds any permission flagged `requires_mfa` (true for `sales.manage`, `purchases.manage`, `purchases.bank`, `bank.manage`, `audit.view`, `data.export`, `org.manage`, `ledger.manage`; false for `purchases.raise`, `reports.view`), every action except `whoami` needs an aal2 session. Error (API): "Confirm your sign-in with your authenticator app to continue."
- Router (`app.js`): a route opens only if its menu item is allowed for the user; otherwise it redirects to `#/dashboard`. Sub-routes (`/new`, `/<id>`, `/<id>/edit`) inherit the menu item's rule.
- Unknown action (API): "Unknown Panalo Accounts action."
- Generic browser fallback (`friendlyError`): 401 → "Your sign-in has expired. Please sign in again."; otherwise the server message, or "Something went wrong. Please try again."

### 0.2 Permissions used in this area

| Key | Name (catalogue) | Description (catalogue) | MFA | Default roles |
| --- | --- | --- | --- | --- |
| `sales.manage` | Sales | "Customers, quotes, invoices, credit notes and receipts." | yes | super_admin, director, finance_admin |
| `purchases.manage` | Purchases | "Suppliers, purchase orders, bills and supplier payments." | yes | super_admin, director, finance_admin |
| `purchases.raise` | Raise purchase orders | "Create purchase orders and record goods received; someone with Purchases approves them." | no | project_manager, finance_admin, super_admin |
| `purchases.bank` | Approve supplier bank changes | "Approve changes to supplier bank details." | yes | super_admin, director (NOT finance_admin) |
| `bank.manage` | Banking | "Bank accounts, payments, imports and reconciliation; approve company bank accounts." | yes | super_admin, director, finance_admin |
| `reports.view` | Financial reports | "View financial reports and dashboards." | no | super_admin, director, finance_admin, payroll_admin, project_manager, accountant |

Note: the payment-recording keys (`bank.manage`) differ from the document keys (`sales.manage` / `purchases.manage`). Despite the catalogue description of `purchases.manage` ("…and supplier payments"), recording/voiding supplier payments needs `bank.manage`.

### 0.3 Menu (accounts/app.js MENU)

| Group | Menu label | Route | Visible to anyone holding |
| --- | --- | --- | --- |
| Sales | Customers | `#/customers` | `sales.manage`, `bank.manage`, `reports.view` |
| Sales | Quotes | `#/quotes` | same |
| Sales | Invoices | `#/invoices` (credit notes: `#/invoices?kind=credit_note`) | same |
| Sales | Payments received | `#/receipts` | same |
| Purchases | Suppliers | `#/suppliers` | `purchases.manage`, `purchases.raise`, `bank.manage`, `reports.view` |
| Purchases | Purchase orders | `#/purchase-orders` | same |
| Purchases | Bills | `#/bills` (supplier credits: `#/bills?kind=credit_note`) | `purchases.manage`, `bank.manage`, `reports.view` (NOT `purchases.raise`) |
| Purchases | Supplier payments | `#/supplier-payments` | `purchases.manage`, `bank.manage`, `reports.view` |

Related screens outside this area: `#/approvals` (supplier bank change decisions), `#/payment-batches` (`bank.manage`), `#/reports` (aged receivables/payables).

### 0.4 Numbering
- `next_document_number(org, kind)` hands out `prefix + lpad(n, padding)`. Seeded defaults (all start at 1001, padding 4): invoice `INV-1001`, quote `QU-1001`, purchase order `PO-1001`, customer credit note `CN-1001`, bill `BILL-1001`. Editable in Company settings (numbering). Error (SQL) if a sequence is missing: "No numbering set up for %."
- **When numbered:** invoices and customer credit notes on **approval** (drafts show "Draft"); quotes, purchase orders and bills **on first save** (drafts already numbered). Supplier credits use the **bill** sequence (`BILL-…`), there is no separate supplier-credit prefix. Voided documents keep their number.

### 0.5 Audit and notifications
- Every write function calls `app_audit`. Events: `customer_created`/`customer_updated`, `supplier_created`/`supplier_updated` (bank account number removed), `approval_requested`/`approval_approved`/`approval_rejected` (bank numbers masked `***123`), `quote_created`/`quote_saved`/`quote_status_changed`, `invoice_created`/`invoice_saved`/`invoice_approved`/`invoice_voided`/`invoice_draft_deleted`/`invoice_sent`, `credit_note_applied`, `customer_payment_recorded`/`customer_payment_allocated`/`customer_payment_voided`, `purchase_order_created`/`purchase_order_saved`/`purchase_order_status_changed` (with reason)/`goods_received`, `bill_created`/`bill_saved`/`bill_submitted`/`bill_approved` (incl. withholding)/`bill_voided`/`bill_draft_deleted`, `supplier_credit_applied`, `supplier_payment_recorded`/`supplier_payment_voided`, `document_attached`/`document_archived`, `document_pdf_generated` (every PDF download, incl. statements), `journal_reversed` (on every void).
- **Nothing is emailed.** The only notifications are in-app: a supplier bank change request notifies holders of `purchases.bank` ("Approval needed: Bank details for supplier <name>", body "Requested by <name>"); the decision notifies the requester ("Approved: …" / "Rejected: …"). Design doc: "nothing is emailed yet" (emailing invoices/statements/remittances is listed under "Not in this phase").

### 0.6 Ledger posting (all via `ledger_post_entry`, non-manual)
Chart seeds: 1000 Bank, 1100 Accounts Receivable (control, no manual journals), 2000 Accounts Payable (control), 2100 PAYG Withholding Payable, 2300 GST Payable/Receivable. Control accounts are chosen by subtype (`receivable`, `payable`, `payg`, `gst`; first active by code).

| Event | Debit | Credit | Journal memo |
| --- | --- | --- | --- |
| Invoice approved | 1100 AR (total) | each income line (net) + 2300 GST (per taxed line) | "Invoice INV-…" |
| Customer credit note approved | income lines (net) + 2300 GST | 1100 AR (total) | "Credit note CN-…" |
| Payment received | chosen bank account | 1100 AR | "Receipt from <customer>[ · <reference>]" (no tax) |
| Bill approved | expense/cost/asset lines (net) + 2300 GST | 2000 AP (total − withholding) + 2100 PAYG (withholding, if any; "No-ABN withholding: <supplier>") | "Bill BILL-…[ · <supplier ref>] · <supplier>" |
| Supplier credit approved | 2000 AP (total) | expense lines + 2300 GST | "Supplier credit BILL-… …" |
| Supplier payment | 2000 AP | chosen bank account | "Payment to <supplier>[ · <reference>]" (no tax) |
| Any void (invoice, credit note, receipt, bill, supplier credit, supplier payment) | exact mirror journal, dated the original entry date | | "Reversal of JE-…: <reason>" |

- GST is recomputed by the ledger engine per line from the line amount and tax code; lines with amount 0 are left out of the journal.
- Period checks on posting (SQL): "No accounting period covers %. Add that financial year first." / "The period % to % is closed." / "The period % to % is locked. Only someone who can reopen periods can post into it." Voids post on the original date, so voiding into a closed period fails the same way.
- Manual journal reversal of a document journal is refused (SQL): "This journal was posted by a %. Void the % itself instead, so the two stay in step."
- A journal matched to a bank statement line can't be reversed (banking trigger): "This entry is matched to a bank statement line. Unmatch it in Reconciliation first, or record a refund instead." (affects voiding matched receipts/payments).
- Mismatch guard on approval (SQL, invoices and bills): "A tax rate or account changed since this was saved. Open it, check the lines and save it again."

---

## 1. Shared document editor (accounts/lib/docs.js)

Used by quotes, invoices, customer credit notes, purchase orders, bills and supplier credits.

### 1.1 Header fields
- Party select: label = "Customer" or "Supplier" with required star; placeholder option "Choose a customer…" / "Choose a supplier…". A small note under it (`partyNote`, per screen).
- Screen-specific fields (see each screen).
- "Amounts are" select:
  - `exclusive` → "Tax exclusive (GST added)" (default)
  - `inclusive` → "Tax inclusive (GST included)"
  - `no_tax` → "No GST" (disables the Tax column on every line; tax codes are dropped server-side)

### 1.2 Line table columns
"Description" | "Account" | "Qty" | "Unit price" | "Disc %" | "Tax" | "GST" (calculated) | "Amount" (calculated) | remove "✕" (disabled when only one line).

Per line, under the description: Type select (line kind) and, where enabled, Project select and Cost code select.
- Line kinds (`LINE_KINDS`): `labour` Labour, `materials` Materials, `equipment` Equipment, `subcontract` Subcontract, `travel` Travel, `consumables` Consumables, `freight` Freight, `other` Other (default "Other"; PO and bill first line defaults to "Materials"). Unknown kinds become `other`.
- Project select: "No project" + open projects (`number name`; closed/cancelled hidden; a line already tagged to a closed project shows its number or "Closed project"). Offered on quotes, invoices/credit notes, POs, bills/supplier credits.
- Cost code select: placeholder "Cost code…"; only on POs and bills (purchases); disabled until a project is chosen; clearing the project clears the cost code. Server ignores cost codes on sales documents.
- A line copied from a PO shows "From the purchase order".
- "+ Add a line" copies the previous line's account, tax code, project and cost code (or the party defaults).
- Choosing an account fills the tax code from the account's default if the tax cell is empty.
- Account lists: sales screens show active, manual-allowed `revenue`/`other_income` accounts; purchase screens show active, manual-allowed accounts that are not revenue/other income/equity. Tax lists: sales screens show codes that apply to sales or both; purchase screens show purchases or both.
- Default account when a new document starts: sales = customer's default income account, else 4000; purchases = supplier's default expense account, else 5100. Default tax = party default, else the account's default.

### 1.3 Totals block
"Subtotal (ex GST)" (just "Subtotal" for No GST), "GST" (hidden for No GST), "Total". Bills add a no-ABN preview (see §8). If any amount is invalid: "Check the highlighted amounts".

### 1.4 Calculation and rounding (JS `validate.js` mirrors SQL `doc_calc_lines`)
- Line amount = round(qty × unit price × (1 − discount/100), 2), half up.
- GST per line: exclusive = round(amount × rate, 2); inclusive = round(amount × rate ÷ (1 + rate), 2); no_tax or rate 0 = 0.
- Subtotal = Σ(amount) (exclusive) or Σ(amount − GST) (inclusive); total = subtotal + Σ GST. GST is rounded per line, not on the total.
- Seed tax codes: sales `GST` (10%), `FRE`, `EXP`, `ITS`; purchases `GSTE` (10%), `CAP` (10%), `FREE`, `ITP`; both `NG`, `OOS`.

### 1.5 Validation
JS (inline, red highlight): quantity must match `^\d+(\.\d{1,3})?$` and be > 0; unit price `^\d*(\.\d{1,4})?$` (`$`, `,`, spaces stripped); discount 0–100.
JS on submit:
- "Choose a customer." / "Choose a supplier."
- "Fix the highlighted amounts first."
- Blank lines (no description, price or account) are dropped; then "Add at least one line."
- "Line N: add a description and choose an account."

API (`cleanDocLines`): "Add at least one line." / "A document can have at most 150 lines."

SQL (`doc_calc_lines`):
- "Choose how amounts are entered."
- "Add at least one line." / "A document can have at most 150 lines."
- "Line %: quantity, price and discount must be numbers."
- "Line %: quantity must be more than 0, with up to 3 decimals."
- "Line %: unit price can't be negative and has up to 4 decimals."
- "Line %: discount is between 0 and 100%."
- "Line %: add a description."
- "Line %: choose an account."
- "Line %: account % can't be used here." (inactive or control account)
- "Line %: use an income account for sales (% is %)." (sales allows revenue, other_income, liability)
- "Line %: use an expense, cost or asset account for purchases."
- "Line %: unknown or inactive tax code."
- "Line %: that tax code is for %, not %." (e.g. a purchase code on a sale)
- "Line %: that project was cancelled or doesn't exist." (closed/completed projects are allowed server-side; only cancelled refused)
- "Line %: unknown or inactive cost code."
- "Line %: choose the project the cost code belongs to."

Field limits: description 500, unit 20, notes/terms 3000, scope 5000, reference 120, title 200.

### 1.6 Buttons common to the editor
Configured submit buttons (per screen) plus "Cancel" link. Buttons disable while saving and re-enable on error.

### 1.7 Read-only document view
Lines table: "Description" (with kind, project link and cost code), "Account", "Qty" (PO lines also show "N received"), "Unit price", "Disc", "Tax", "GST", "Amount (inc)" / "Amount (ex)" / "Amount".

### 1.8 Attachments panel (heading "Attachments")
- Available on customers, quotes, invoices/credit notes, suppliers, purchase orders, bills/supplier credits (and assets, out of scope).
- List shows file name (opens a 120-second signed link), size "N KB · date", and "Remove" (if allowed). Empty: "Nothing attached."
- Upload button: "Attach a PDF or photo" (accepts PDF, JPEG, PNG, WebP). Progress flash "Uploading…"; success "Attached <file name>."
- Remove confirm(): "Remove this attachment? It is kept in the archive for the audit trail." (soft archive, audited)
- Who can add/remove: sales records `sales.manage`; bills/suppliers `purchases.manage`; purchase orders `purchases.manage` or `purchases.raise` (remove needs `purchases.manage`). Who can open: `reports.view`, or the record's manage permission (purchases: manage or raise).
- Errors: API "Attachments are not available here." / "Attach a PDF or a photo (JPG, PNG or WebP)." / "Attachments must be under 15 MB." / "A secure upload link could not be created." / "Invalid upload path." / "The upload didn't arrive. Please try again." / "Attachment not found." / "The file could not be opened."; JS "The upload didn't go through. Please try again."; SQL "Record not found." / "Attach a PDF or a photo."
- Storage: private bucket `finance-documents`, path `org/<org>/<entity>/<id>/…`.

### 1.9 PDFs
"Download PDF" buttons. Titles: invoice "Tax invoice" (or "Invoice" if company not GST-registered), credit note "Adjustment note", "Quote", "Purchase order", "Statement". Drafts are stamped "DRAFT - NOT YET ISSUED"; void/cancelled "VOID". GST-free lines marked "*" with footnote "* No GST applies to this item." Invoice PDFs include "How to pay" (the company bank account approved with "show on invoices") with "Please use <number> as the payment reference." and "Balance due". PO PDFs include "Invoicing": "Please quote <number> on your invoice and include your ABN. Invoices without a valid purchase order number may be delayed." File names: `Tax-invoice-<number|draft>.pdf`, `Adjustment-note-<number|draft>.pdf`, `Quote-<number>.pdf`, `Purchase-order-<number>.pdf`, `Statement-<customer>-<to>.pdf`. Every generation is audited (`document_pdf_generated`).

### 1.10 Payment methods (receipts and supplier payments)
`bank_transfer` "Bank transfer" (default), `card` "Card", `cheque` "Cheque", `cash` "Cash", `other` "Other".

---

## 2. Customers (`#/customers`, accounts/views/customers.js)

API actions: `sales_setup`, `customers_list`, `customer_get` (perm any of `sales.manage`, `bank.manage`, `reports.view`); `customer_save` (`sales.manage`); `customer_statement` (read perms).

### 2.1 List `#/customers`
- Eyebrow "SALES"; heading "Customers"; intro "Who Panalo invoices. Balances include unpaid invoices, less credit notes and unapplied payments."
- Button "New customer" (`sales.manage`) → `#/customers/new`.
- Filters: "Name contains" (text), "Show" ("Active" / "Archived"); button "Filter".
- Columns: "Customer" (link; trading name under it), "ABN" (formatted `12 345 678 901` or "—"), "Contact" (contact + email), "Terms" ("N days" or "Default"), "Overdue" (sum of 1–30, 31–60, 61–90, 90+ buckets; red if > 0), "Balance" (aged-receivables total; chip "Over limit" when balance > credit limit).
- Footer: "Total owed to Panalo". Empty: "No customers yet."
- Error (API): "Customers could not be loaded."

### 2.2 Form `#/customers/new`, `#/customers/<id>/edit`
- Eyebrow "SALES · CUSTOMERS"; heading "New customer" or "Edit <name>"; intro "The ABN is checked with the ATO's check-digit rule. A tax invoice of $1,000 or more must show the customer's name or ABN."
- Fields:
  - "Legal or business name" (required, max 160)
  - "Trading name" (max 160)
  - "ABN" (hint "11 digits"; max 14 chars)
  - "Accounts contact" (max 120)
  - "Accounts email" (hint "Where invoices and statements go")
  - "Phone"
  - Fieldset "Billing address": "Street", "Suburb", "State" (— / ACT NSW NT QLD SA TAS VIC WA), "Postcode"
  - Fieldset "Site address (optional)": same four fields
  - "Payment terms (days)" (hint "Blank uses the company default (N days)")
  - "Credit limit ($)" (hint "Optional; flags the customer when exceeded")
  - "Default income account" ("None" + income accounts)
  - "Default tax code" ("From the account" + sales codes)
  - Checkbox "Their purchase order number must be on every invoice"
  - "Notes" (max 2000)
  - Edit only: checkbox "Archived (hidden from new invoices)"
- Buttons: "Save customer" (→ detail page), "Cancel".
- Validation:
  - JS: "Enter the customer's name." (< 2 chars); "That ABN isn't valid. Check the 11 digits." (ATO mod-89 check); "That email address doesn't look right."; "A postcode is 4 digits." (billing postcode only); "Enter a number of days." (terms not 1–3 digits).
  - API: "Give the customer a name."; "Payment terms are 0 to 180 days."; "The credit limit must be a positive amount."; "That email address doesn't look right."
  - SQL: "That ABN isn't valid. Check the 11 digits."; "Unknown default account." / "Unknown default tax code."; "Customer not found."
- Audited. No ledger effect. **No duplicate detection** on name or ABN (none in JS, API or SQL).
- Credit limit only flags ("Over limit" chip); it never blocks an invoice.
- Archiving hides the customer from new quotes/invoices/receipt pickers (setup lists only active); saving a quote/invoice for an archived customer fails: "Choose an active customer."

### 2.3 Detail `#/customers/<id>`
- Eyebrow "SALES · CUSTOMERS"; heading = name (+ chip "Archived"); sub-line "ABN … · <billing address>" or "No billing address".
- Buttons: "Edit", "New invoice" (→ `#/invoices/new?customer=<id>`) (both `sales.manage`); "Record payment" (→ `#/receipts/new?customer=<id>`) when `bank.manage` and the customer has unpaid approved invoices.
- Cards: "Balance owing" (approved invoices owing − credit notes left − unapplied receipts; "N unpaid invoice(s)"); "Terms" ("N days"/"Default"; "Credit limit $…" or "No credit limit"; " · PO number required"); "Contact".
- Section "Invoices and credit notes": "Number" (or "Draft"; "Credit note" tag), "Date", "Due", "Reference", "Status" (+ "Overdue" chip), "Total" (credit notes negative), "Owing". Empty "No invoices yet."
- Section "Payments received": "Date", "Reference", "Status" ("Void"/"Banked"), "Amount", "Not yet applied". Empty "No payments yet."
- Section "Quotes" (only if any): "Number", "Date", "Title", "Status", "Total".
- Section "Statement": "From" (default 1st of this month), "To" (default today); buttons "Show" (on-screen table: "Date", "Reference", "Details", "Amount", "Balance"; first row "Opening balance"; footer "Closing balance") and "Download PDF" (statement PDF with ageing and open invoices; audited). API error: "The start date must be before the end date."
  - Statement rows: approved invoices (+), approved credit notes (−) at full total, posted receipts (−) at full amount ("Payment received"; reference or "Receipt").
- Attachments panel (`sales.manage` to add). "Notes" section if notes.
- API: "Customer not found."

---

## 3. Quotes (`#/quotes`, accounts/views/quotes.js)

Quotes never touch the ledger. API: `quotes_list`, `quote_get`, `quote_pdf` (read perms); `quote_save`, `quote_status`, `quote_to_invoice` (`sales.manage`).

### 3.1 Status values

| Key | Label | Meaning |
| --- | --- | --- |
| `draft` | Draft | Editable |
| `approved` | Approved | Internally approved, ready to send |
| `sent` | Sent | Sent to customer (sets sent_at) |
| `accepted` | Accepted | Customer accepted |
| `declined` | Declined | Customer declined |
| `converted` | Invoiced | Its invoice has been approved |
| `cancelled` | Cancelled | Closed |

Extra chip "Expired" when valid-until < today and status is draft/approved/sent (computed, not stored).

Allowed transitions (SQL `quote_set_status`): draft → approved, cancelled; approved → sent, accepted, declined, cancelled, draft; sent → accepted, declined, cancelled; accepted or declined → sent. Converted is set only by invoice approval. Error: "A % quote can't become %." (e.g. "A accepted quote can't become cancelled.").

### 3.2 List
- Eyebrow "SALES"; heading "Quotes"; intro "Quotes don't affect the books. Once accepted, turn one into an invoice in a click."
- Button "New quote" (`sales.manage`).
- Filters: "Status" ("All" + each label; also `?status=` in the URL), "Title contains"; button "Filter".
- Columns: "Number", "Customer", "Title", "Date", "Valid until", "Status" (+ "Expired"), "Total". Empty "No quotes yet." Max 300 rows.
- API: "Quotes could not be loaded."

### 3.3 Editor `#/quotes/new[?customer=&project=]`, `#/quotes/<id>/edit` (drafts only; non-drafts redirect to detail)
- Eyebrow "SALES · QUOTES"; heading "New quote" / "Edit draft quote"; intro "Describe the work and price it line by line. Approve the quote before sending it to the customer."
- Fields: "Customer" (required), "Quote date" (default today), "Valid until" (default today + 30 days), "Title" (placeholder "For example: Shutdown pipework, Unit 3"), "Customer reference", "Amounts are", lines (with Project, no cost codes), "Scope of work" (placeholder "What's included, what isn't, assumptions"), "Terms and conditions".
- Button: "Save draft" only; "Cancel".
- Errors: API "Customer is not valid." / "The quote date must be a date."; SQL "Choose an active customer." / "Quote not found." / "Only a draft quote can be edited." plus §1.5.
- `?project=<id>` pre-tags lines (Verification required: no link in the UI currently passes `project` to the quote editor; projects page links only to invoices, POs and bills).

### 3.4 Detail `#/quotes/<id>`
- Eyebrow "SALES · QUOTE"; heading "<number> <status chip> [Expired]"; sub-line customer link · date · "valid until …".
- "Download PDF" (`quote_pdf`; any read perm; audited).
- Facts: "Customer reference", "Prepared by", "Approved" (who · when), "Invoice" (link once created).
- Action buttons (all need `sales.manage`):
  - draft: "Edit", "Approve" (→ approved; records approver)
  - approved: "Mark as sent", "Customer accepted", "Back to draft" (clears approval)
  - sent: "Customer accepted", "Customer declined"
  - declined: "Reopen" (→ sent)
  - approved/sent/accepted: "Create invoice"
  - any status except converted/cancelled: "Cancel quote" — confirm(): "Cancel this quote?" (Note: shown for accepted and declined too, but SQL refuses those transitions.)
- Success flash after a status change: "Updated."
- "Create invoice" (`quote_to_invoice`): creates a **draft invoice** dated today, copying customer, lines (description, qty, unit, price, discount, account, tax code, kind, project), reference, amounts-are, terms; notes = "Quote <number>: <title>" (or "Quote <number>"); type Standard; due date from terms. Opens the invoice editor. The quote stays in its status until that invoice is **approved**, then becomes `converted` ("Invoiced") with a link.
  - API errors: "Only an approved, sent or accepted quote can be invoiced." / "An invoice (INV-…) has already been created from this quote." or "An invoice draft has already been created from this quote." (only non-void invoices count; a deleted draft frees the quote again).
  - Quotes do not convert to projects here (a project can reference a quote from the Projects module; out of scope).
- Attachments panel (`sales.manage`).

---

## 4. Invoices and customer credit notes (`#/invoices`, accounts/views/invoices.js)

API: `invoices_list`, `invoice_get`, `invoice_pdf` (read perms); `invoice_save`, `invoice_approve`, `invoice_void`, `invoice_mark_sent`, `credit_apply` (`sales.manage`); `receipt_allocate` (`bank.manage`).

### 4.1 Status values (both kinds)

| Key | Label | Meaning |
| --- | --- | --- |
| `draft` | Draft | Not in the books, no number, editable, deletable |
| `approved` | Approved | Numbered and posted; fixed |
| `void` | Void | Reversed; number stays used |

Computed chips: "Paid" / "Applied" (approved, nothing owing), "Fully applied" (credit note), "Overdue" (invoice, owing > 0, due date < today; list shows "N days overdue"), "Sent" (sent_at set).
Transitions: draft → approved (approve), draft → deleted (delete), approved → void. No un-void, no edit after approval.

### 4.2 Invoice types (`invoice_type`)
`standard` Standard, `progress` Progress claim, `deposit` Deposit, `final` Final claim, `variation` Variation, `materials` Materials, `labour` Labour. Label only; no different accounting.

### 4.3 List `#/invoices` and `#/invoices?kind=credit_note`
- Eyebrow "SALES"; heading "Invoices" / "Credit notes".
- Intro (invoices): "Drafts aren't in the books. Approving gives the invoice its number and posts it to Accounts Receivable, income and GST." Intro (credit notes): "Adjustment notes reduce what a customer owes, including the GST."
- Buttons (`sales.manage`): "Credit notes" / "Invoices" (switch list), "New invoice" / "New credit note".
- Warning when company ABN missing: "Add Panalo's ABN in Company settings: invoices can't be approved without it, because a tax invoice must show it."
- Tabs: "All", "Draft", "Unpaid", "Overdue", "Paid", "Void" (also `?view=`).
- Search: "Number contains"; button "Search".
- Columns: "Number" (or "Draft"; reference under it), "Customer" (non-standard type under it), "Date", "Due" (invoices only), "Status", "Total", "Owing" / "Unapplied". Footer "N shown" with total and owing. Empty "Nothing here." Pager "Previous" / "Page X of Y" / "Next" (50 per page).
- API: "Invoices could not be loaded."

### 4.4 Editor `#/invoices/new[?customer=&kind=credit_note&from=<invoice>&project=]`, `#/invoices/<id>/edit`
- Eyebrow "SALES · INVOICES" / "SALES · CREDIT NOTES"; heading "New invoice" / "New credit note" / "Edit draft invoice" / "Edit draft credit note".
- Intro (invoice): "Saved drafts don't affect the books. Approve to number the invoice and post it." Intro (credit note): "A credit note (adjustment note) reduces what the customer owes, and the GST, once approved. Apply it to an invoice afterwards."
- Customer note: "N-day terms" or "Default terms (N days)", plus " · needs their PO number".
- Fields: "Customer" (required); "Invoice date" / "Date"; "Due date" (invoices only); "Customer PO / reference" / "Reference (invoice it adjusts)"; "Invoice type" (invoices only); "Amounts are"; lines (Project, no cost code); "Notes on the invoice" / "Notes on the credit note"; "Terms" (placeholder for invoices "For example: payment within 30 days of the invoice date").
- **Due date rule:** invoice date + customer terms (else company default `payment_terms_days`, else 30). Auto-updates when the date or customer changes until the user edits the due date. Server applies the same rule when due date is blank (credit notes also get a due date internally).
- Credit note from an invoice (`?from=<invoice>`, button "Credit note" on an approved invoice): copies customer, amounts-are, reference = invoice number, all lines; links `original_invoice_id` (printed on the adjustment note).
- Buttons: "Save draft", "Save and approve" (primary), "Cancel".
  - "Save and approve": saves, then tries `invoice_approve`. On a business-rule failure the draft is kept and the detail page shows "Saved as a draft but not approved: <reason>".
- Errors: API "Customer is not valid." / "The invoice date must be a date."; SQL "Choose an active customer." / "That quote is not for this customer." / "A credit note can only adjust an approved invoice of the same customer." / "Invoice not found." / "Only a draft can be edited. Void it or issue a credit note instead." + §1.5.

### 4.5 Detail `#/invoices/<id>`
- Eyebrow "SALES · INVOICE" / "SALES · CREDIT NOTE"; heading number (or "Draft invoice"/"Draft credit note") + status chips; sub-line customer · date · "due …".
- "Download PDF" (any read perm; audited).
- Facts: "Customer reference"/"Reference", "Type", "Amounts" ("Tax exclusive"/"Tax inclusive"/"No GST"), "Created", "Approved" (who · when), "Ledger" (journal link; "reversed by" link), "Sent", "Void reason".
- Totals: subtotal, GST, total; when approved "Paid and credited" / "Applied" and "Balance due" / "Left to apply".
- Buttons:
  - "Edit" (draft, `sales.manage`)
  - "Approve and number" (invoice) / "Approve" (credit note) — draft, `sales.manage` → `invoice_approve`. Flash "Approved as <number> and posted to the ledger." Posts (§0.6). If the invoice came from a quote, the quote becomes Invoiced.
    - SQL errors: "Invoice not found." / "This has already been approved." / "The total must be more than zero." / "Add Panalo's ABN in Company settings first: a tax invoice must show it." / "A tax rate or account changed since this was saved. Open it, check the lines and save it again." / "Company settings say Panalo isn't registered for GST, so it can't charge GST. Use a GST-free or no-GST code." / "This customer needs their purchase order number on every invoice." (invoice kind, blank reference) + period errors.
  - "Record payment" (approved invoice with balance, `bank.manage`) → `#/receipts/new?customer=…&invoice=…`
  - "Mark as sent" (approved invoice, not yet sent, `sales.manage`) → `invoice_mark_sent`; flash "Marked as sent."; audited; no email is sent. SQL error "Only an approved invoice can be marked as sent."
  - "Credit note" (approved invoice, `sales.manage`) → new credit note from this invoice.
  - "Void" (approved, either kind, `sales.manage`) — prompt(): "Void <number>? The ledger entry is reversed and the number stays used. Reason:"; JS "Give a reason for voiding it." (< 3 chars); flash "Voided. The ledger entry has been reversed." SQL: "This is already void." / "Payments or credits are applied to it. Remove those first." (see §12 gaps) + reversal/period errors.
  - "Delete draft" (draft, `sales.manage`) — confirm(): "Delete this draft? It isn't in the books, so nothing else changes."; calls `invoice_void` with reason "Draft deleted" which hard-deletes the draft (audited `invoice_draft_deleted`).
- Section "Payments and credits" (invoice) / "Applied to" (credit note), approved only: table "Date", "From", "Amount"; empty "Nothing applied yet."
  - On an invoice with balance: "Apply existing credit" form — "Credit" select (open credit notes "Credit note CN-… · $x available" and receipts with unapplied money "Receipt <ref|date> · $x available"), "Amount" (default min(owing, available)), button "Apply". Credit note source → `credit_apply` (`sales.manage`); receipt source → `receipt_allocate` (`bank.manage`). Flash "Applied."
  - On a credit note with something left (`sales.manage`): "Apply to an invoice" form — "Invoice" select ("INV-… · $x owing"), "Amount", "Apply". If none: "This customer has no unpaid invoices to apply it to."
  - SQL (credit_note_apply): "Choose an approved credit note and invoice for the same customer." / "The amount can't exceed what is left on the credit note or the invoice." API: "The amount must be an amount in dollars and cents."
  - Allocation date = latest of the chosen date, credit note date and invoice date. No ledger posting (AR already reduced by the credit note).
- Attachments panel (add with `sales.manage`).

---

## 5. Payments received (`#/receipts`, accounts/views/receipts.js)

API: `receipts_list`, `receipt_get` (read perms); `receipt_record`, `receipt_allocate`, `receipt_void` (`bank.manage`).

Statuses: `posted` → chip "Banked"; `void` → "Void". Transition posted → void only.

### 5.1 List
- Eyebrow "SALES"; heading "Payments received"; intro "Money customers have paid in. Each payment is banked to the ledger and applied to their invoices."
- Button "Record a payment" (`bank.manage`).
- Columns: "Date" (link), "Customer", "Reference", "Method", "Status", "Amount", "Not applied". Empty "No payments recorded yet." No filters (latest 300).

### 5.2 Record `#/receipts/new[?customer=&invoice=]`
- Eyebrow "SALES · PAYMENTS"; heading "Record a payment"; intro "Enter what arrived in the bank, then say which invoices it pays. Anything left over is kept as a credit for the customer."
- Fields: "Customer" (required), "Date received" (default today), "Amount received ($)" (required), "Paid into" (active bank-subtype accounts; first preselected), "Method", "Reference" (placeholder "As shown on the bank statement").
- Section "Apply to invoices" (after choosing a customer): table "Invoice", "Date", "Due" (+ "Overdue"), "Owing", "Apply" (input per invoice), sorted by due date; link "Apply oldest first". If none: "This customer has no unpaid invoices. The whole payment will be kept as a credit."
  - Arriving from an invoice pre-fills that invoice's owing as the amount and allocation.
  - Running message: "Applied $x · $y kept as a credit" / "You've applied $x more than was received." / "An applied amount is not valid or is more than the invoice owes."
- Buttons: "Record payment", "Cancel".
- JS errors: "Enter the amount received first." (oldest-first with no amount); "Choose the customer."; "Enter the amount received, in dollars and cents."; "Fix the amounts applied first."
- API errors: "Customer is not valid." / "The date received must be a date." / "The amount received must be an amount in dollars and cents." / "Bank account is not valid." / "Each amount applied must be an amount in dollars and cents."
- SQL errors: "Customer not found." / "Choose the bank account the money went into." / "Enter the amount received." / "Payments can only be applied to this customer's approved invoices." / "Invoice %: the amount applied is more than what is owing." / "You applied % but only % was received."
- Posting: Dr bank / Cr 1100 AR for the full amount (§0.6); audited. Redirects to the receipt.
- **Allocation rules:** part payments allowed (any amount ≤ owing per invoice); total applied ≤ received; **overpayment / unapplied money stays as a customer credit** (shown as "Not yet applied", reduces the customer balance and the ageing "Credits" column) and can be applied later. Allocation date = later of payment date and invoice date. Receipts apply only to invoices (not to credit notes); no refund function exists (Verification required: refunds of credits are not built).

### 5.3 Detail `#/receipts/<id>`
- Eyebrow "SALES · PAYMENT RECEIVED"; heading "$x from <customer> <Banked|Void>"; sub-line date · reference or "No reference"; button "Customer".
- Facts: "Paid into", "Method", "Recorded by", "Ledger" (+ reversal), "Void reason", "Not yet applied".
- "Applied to" table: "Invoice", "Date", "Amount"; voided rows tagged "Removed when the payment was voided". Empty "Not applied to any invoice."
- "Apply the credit" form (unapplied > 0, `bank.manage`, open invoices exist): "Invoice" ("INV-… · $x owing"), "Amount", "Apply" → `receipt_allocate`; flash "Applied." SQL: "Choose a receipt and an approved invoice for the same customer." / "The amount can't exceed what is left on the receipt or the invoice."
- "Void payment" (`bank.manage`, posted) — prompt(): "Void this payment? Use this if it was entered by mistake or the payment bounced. The bank entry is reversed and the invoices go back to unpaid. Reason:"; API "Say why the receipt is being voided." (< 3 chars); SQL "Receipt not found." / "This receipt is already void."; flash "Payment voided." Reverses the journal and voids all its allocations.
- Bank reconciliation can also create receipts (`customer_payment_record` from a statement line) — Banking area.

---

## 6. Suppliers (`#/suppliers`, accounts/views/suppliers.js)

API: `purchases_setup`, `suppliers_list`, `supplier_get` (any of `purchases.manage`, `purchases.raise`, `bank.manage`, `reports.view`); `supplier_save`, `supplier_bank_request` (`purchases.manage`); `approval_decide` (any user; SQL requires `purchases.bank`).

### 6.1 List
- Eyebrow "PURCHASES"; heading "Suppliers"; intro "Suppliers and subcontractors. Warnings show missing ABNs (47% must then be withheld) and insurance or licences about to expire."
- Button "New supplier" (`purchases.manage`).
- Filters "Name contains", "Show" (Active/Archived); "Filter".
- Columns: "Supplier" (chips "Subcontractor", "TPAR"; warnings), "ABN" (or chip "No ABN"), "Trade", "Insurance", "Licence" (date + "Expired" chip, or "N days" chip within 30 days), "Owing". Empty "No suppliers yet."
- Warning texts (API): "No ABN: 47% must be withheld from payments over $75"; "Insurance expired"; "Insurance expires within 30 days"; "Licence expired"; "Licence expires within 30 days"; "No insurance on file" (subcontractor with no insurance date).
- API: "Suppliers could not be loaded."

### 6.2 Form `#/suppliers/new`, `#/suppliers/<id>/edit`
- Eyebrow "PURCHASES · SUPPLIERS"; heading "New supplier" / "Edit <name>"; intro "Bank details are added separately, from the supplier's page, and need a second person to approve them."
- Fields: "Legal or business name" (required); "Trading name"; "ABN" (hint "If a supplier doesn't quote an ABN, 47% of payments over $75 (ex GST) must be withheld and paid to the ATO"); "Trade or category" (hint "For example: steel supply, rigging, NDT"); "Contact"; "Accounts email"; "Phone"; "Payment terms (days)" (hint "Blank means 30 days"); fieldset "Address" (Street, Suburb, State, Postcode); "Default expense account" ("None"…); "Default tax code" ("From the account"…); fieldset "Tax and compliance": checkboxes "Registered for GST" (default on), "Subcontractor", "Report on the Taxable Payments Annual Report (TPAR)", "No-ABN withholding doesn't apply (for example, a hobbyist or private individual statement is held)"; "Insurance expires" (hint "Public liability / workers compensation for subcontractors"); "Licence expires"; "Notes"; edit only "Archived".
- Buttons "Save supplier", "Cancel".
- JS: "Enter the supplier's name."; "That ABN isn't valid. Check the 11 digits."; "That email address doesn't look right." (No postcode or terms check in JS.)
- API: "Give the supplier a name."; "Payment terms are 0 to 180 days."; "That email address doesn't look right."
- SQL: "That ABN isn't valid. Check the 11 digits."; "Unknown default account." / "Unknown default tax code."; "Supplier not found."
- **No duplicate detection** on supplier name or ABN. Audited (bank number excluded).

### 6.3 Detail `#/suppliers/<id>`
- Eyebrow "PURCHASES · SUPPLIERS"; heading name + chips "Subcontractor"/"Archived"; sub-line "ABN …" or "No ABN quoted", trade, address.
- Buttons: "Edit", "Enter a bill" (→ `#/bills/new?supplier=`) (`purchases.manage`); "New purchase order" (`purchases.raise` or `purchases.manage`).
- Note when no ABN and not exempt: "This supplier has no ABN on file. When a bill over $75 (ex GST) is approved, 47% is withheld and recorded as owing to the ATO; only the rest is paid to the supplier. Ask them for their ABN."
- Cards: "Owing to them"; "Insurance"/"Licence" (date or "Not recorded"); "Pay to" (account name, "BSB 062-000 · <account>", "Changed <date>"; or "No bank details"). Account number is shown in full only to `bank.manage` or `purchases.bank`; others see "•••123".
  - If a change is pending: chip "Change waiting for approval". Else (`purchases.manage`): link "Change bank details".
- Bank change form (heading "New bank details"): guidance "Only change bank details after confirming them with the supplier by phone, on a number you already have. Never act on an emailed request alone. Someone else must approve the change before it is used." Fields "Account name", "BSB", "Account number". Buttons "Request approval", "Cancel".
  - JS: "A BSB is 6 digits, like 062-000."; "An account number is 5 to 10 digits."
  - SQL: "Supplier not found." / same BSB and account messages / "A bank change for this supplier is already waiting for approval."
  - Success flash: "Sent for approval. The new details are used once someone else approves them."
  - Creates an approval (kind `supplier_bank`, title "Bank details for supplier <name>", required permission `purchases.bank`) with previous and new values; notifies `purchases.bank` holders; audited with masked numbers. **Bank details are never edited directly.**
- Sections "Bills" ("Bill", "Their reference", "Date", "Due", "Status", "Total", "Owing"; "Credit" tag; empty "No bills yet."), "Purchase orders" (if any), "Payments" (if any; "Void"/"Paid"), attachments (`purchases.manage`).

### 6.4 Approving a supplier bank change (`#/approvals`, Administration > Approvals)
- Heading "Approvals"; intro "Some changes need a second person: you can never approve your own request. Every decision is recorded with the previous and new values."
- Card shows "Account name", "BSB", "Account number", "Replaces" (old BSB · account, or "No bank details on file") and warning "Changed supplier bank details are the most common way businesses are defrauded. Phone the supplier on a number you already have (not one from the request or an email) and confirm the BSB and account number before approving."
- Buttons "Approve" (prompt "Approve this change? Add a note for the record (for example, how you checked it):"; flash "Approved.") and "Reject" (prompt "Reject this change? Give a reason; the requester will see it:"; flash "Rejected."). Requester can cancel their own request (flash "Request cancelled.").
- SQL: "Approval not found." / "This has already been decided." / "Someone else must approve a change you requested." / "Give a reason for rejecting it." + permission check on `purchases.bank`.
- On approval the supplier's bank name/BSB/account and `bank_changed_at` are updated; requester notified; audited (masked). Only one pending change per supplier (unique index).
- Default roles: only super_admin and director hold `purchases.bank`.

---

## 7. Purchase orders (`#/purchase-orders`, accounts/views/purchase-orders.js)

POs never touch the ledger. API: `pos_list`, `po_get`, `po_pdf` (read perms); `po_save`, `po_status`, `po_receive` (`purchases.raise` or `purchases.manage` at API; SQL narrows by status, below).

### 7.1 Status values

| Key | Label | Meaning |
| --- | --- | --- |
| `draft` | Draft | Editable by raiser |
| `submitted` | Awaiting approval | Waiting for `purchases.manage` |
| `approved` | Approved | Approved; bill may be entered |
| `issued` | Issued | Sent to supplier; goods can be received |
| `partially_received` | Part received | Some lines received |
| `completed` | Completed | All received, or closed manually |
| `cancelled` | Cancelled | Closed without completion |

List filter also offers `open` → "Open (approved to part received)".

Transitions (SQL `po_set_status` / `po_receive`):
- draft → submitted: `purchases.raise` or `purchases.manage` ("Only a draft can be submitted.")
- submitted → approved, or submitted → draft ("Send back"): `purchases.manage` ("Only a submitted purchase order can be approved or sent back.")
- approved → issued: `purchases.manage` ("Approve the purchase order before issuing it.")
- issued/partially_received → partially_received/completed: automatic on receiving
- issued/partially_received → completed ("Close order"): `purchases.manage` ("Only an issued purchase order can be closed.")
- any except completed/cancelled → cancelled: `purchases.manage` ("This purchase order is already closed."; "Bills are matched to this purchase order." if any non-void bill references it)
- API: "Choose a purchase order status."; SQL "Unknown purchase order status." / "Purchase order not found."

### 7.2 List
- Eyebrow "PURCHASES"; heading "Purchase orders"; intro "Raise an order, have it approved, send it to the supplier, then record what arrives. Bills are matched against the order."
- Button "New purchase order" (`purchases.raise` or `purchases.manage`).
- Filters "Status", "Number contains"; "Filter".
- Columns "Number" (reference under), "Supplier", "Date", "Required by", "Raised by", "Status", "Total". Empty "No purchase orders yet."
- API: "Purchase orders could not be loaded."

### 7.3 Editor `#/purchase-orders/new[?supplier=&project=]`, `/<id>/edit` (drafts only)
- Eyebrow "PURCHASES · PURCHASE ORDERS"; heading "New purchase order" / "Edit draft purchase order".
- Intro: "Save as a draft, or submit it for approval." (`purchases.manage`) or "Submit it when ready; someone with Purchases approves it before it goes to the supplier." (raiser only).
- Supplier note: "No ABN on file" · "Subcontractor".
- Fields: "Supplier" (required), "Order date", "Required by", "Job / reference" (placeholder "For example: job number"), "Amounts are", lines (Project + Cost code), "Deliver to", "Notes for the supplier".
- Buttons: "Save draft", "Save and submit for approval" (primary), "Cancel".
- API "Supplier is not valid." / "The order date must be a date."; SQL "Choose an active supplier." / "Only a draft purchase order can be edited." + §1.5. Number `PO-…` assigned on first save; raiser recorded as "Raised by".

### 7.4 Detail `#/purchase-orders/<id>`
- Eyebrow "PURCHASES · PURCHASE ORDER"; heading number + status; sub-line supplier · date · "required by …"; "Download PDF".
- Facts: "Job / reference", "Raised by", "Approved" (who · when), "Issued", "Deliver to", "Billed so far" ("$x of $y", non-void bills).
- Buttons (only those allowed show):
  - "Edit", "Submit for approval" (draft; raise or manage)
  - "Approve", "Send back" (submitted; manage). "Send back" prompt(): "Send it back to draft? Tell the requester why:" (reason recorded in audit; not required, not notified)
  - "Mark as issued to supplier" (approved; manage) — records issued time only; nothing is sent to the supplier by the app
  - "Enter the bill" (approved/issued/part received/completed; manage) → `#/bills/new?po=<id>`
  - "Close order" (issued/part received; manage)
  - "Cancel order" (not completed/cancelled; manage) — prompt(): "Cancel this purchase order? Reason:"
  - Success flash: "Updated."
- "Record goods received" form (issued/part received; raise or manage): intro "Enter what arrived today. The order moves to part received or completed automatically."; table "Item", "Ordered", "Received so far", "Received now" (disabled when fully received); buttons "Record receipt" and link "Everything outstanding arrived" (fills the remaining quantity).
  - JS "Quantities must be numbers."; API "Enter the quantity received on at least one line." / "Line is not valid."; SQL "Goods can be received only on an issued purchase order." / "Unknown purchase order line." / "Line %: can't receive more than ordered (% of %)."
  - Flash "Everything has arrived. The order is completed." or "Receipt recorded." Audited (`goods_received`); no ledger posting.
- "Bills against this order" table ("Bill", "Their reference", "Status" shown as the raw key, e.g. `submitted`, "Total").
- Attachments (add: edit/receive rights or `purchases.manage`).

### 7.5 Three-way match (PO ↔ goods received ↔ bill)
- "Enter the bill" (`bill_from_po`, `purchases.manage`) pre-fills a draft bill with each PO line's **received but not yet billed** quantity (if nothing has been received on the order at all, the **ordered** quantity), same price, discount, account, tax, kind, project, cost code, and keeps `po_line_id`. Notes "Purchase order <number>". API error: "Everything on this purchase order has already been billed."
- The bill detail shows "Matched to <PO>" with "Item", "Ordered", "Received", "This bill", "PO price", "Bill price", "Check" (chip "Matches" / "Check"). A line is flagged when this bill's quantity for the line exceeds the received quantity, or the bill price exceeds the PO price. Intro: "Ordered, received and billed quantities. A line is flagged when more is billed than was received, or the price is higher than ordered."
- Approving a flagged bill asks confirm(): "This bill doesn't match the purchase order (more billed than received, or a higher price). Approve it anyway?" — a warning only; the server does not block.
- SQL guards on bill save: "The purchase order must be approved and for this supplier." / "A line is linked to a different purchase order."

---

## 8. Bills and supplier credits (`#/bills`, accounts/views/bills.js)

API: `bills_list`, `bill_get` (read perms incl. `purchases.raise`, though the menu hides Bills from raise-only users); `bill_save`, `bill_from_po`, `bill_submit`, `bill_approve`, `bill_void`, `supplier_credit_apply` (`purchases.manage`).

### 8.1 Status values

| Key | Label | Meaning |
| --- | --- | --- |
| `draft` | Draft | Editable; numbered; not in the books |
| `submitted` | For review | Sent for review; still editable |
| `approved` | Approved | Posted to AP; payable |
| `void` | Void | Reversed |

Computed chips: "Paid"/"Applied", "Fully applied", "Overdue". Transitions: draft → submitted ("Send for review"); draft or submitted → approved; draft/submitted → deleted; approved → void. **Saving a submitted bill puts it back to Draft** (`bill_save` sets status draft). Approval can happen straight from Draft (review step optional).

### 8.2 List `#/bills`, `#/bills?kind=credit_note`
- Eyebrow "PURCHASES"; heading "Bills" / "Supplier credits".
- Intro: "Supplier invoices. A bill is posted to Accounts Payable when it is approved, and only approved bills can be paid." / "Credit notes from suppliers reduce what Panalo owes them."
- Buttons (`purchases.manage`): "Supplier credits"/"Bills" (switch), "Enter a bill"/"New supplier credit".
- Tabs: "All", "To review" (draft + submitted), "Unpaid", "Overdue", "Paid", "Void".
- Search "Supplier reference contains"; "Search".
- Columns: "Bill", "Supplier" (+ "$x withheld (no ABN)"), "Their reference", "Date", "Due" (+ "Overdue"), "Status", "Total", "Owing". Footer "N shown". Empty "Nothing here." Pager as invoices. Sorted by due date.
- API: "Bills could not be loaded."

### 8.3 Editor `#/bills/new[?supplier=&po=&kind=credit_note&project=]`, `#/bills/<id>/edit` (draft/submitted only)
- Eyebrow "PURCHASES · BILLS" / "PURCHASES · SUPPLIER CREDITS"; heading "Enter a bill" / "Bill from purchase order" / "New supplier credit" / "Edit bill" / "Edit supplier credit".
- Intro: "Copy the supplier's invoice: their reference, the lines and the GST. Attach a copy of it after saving." / credit: "Enter the supplier's credit note as they issued it."
- Supplier note: "No ABN: 47% will be withheld" (no ABN, not exempt) · "Not registered for GST: use a GST-free code".
- Fields: "Supplier" (required), "Supplier's invoice number", "Bill date", "Due date" (bills only), "Amounts are", lines (Project + Cost code), "Notes". When from a PO: "Matched to a purchase order. Lines keep their link to the order so differences show on the bill."
- **Due date rule:** bill date + supplier terms, else 30 days (auto until edited; server applies the same when blank).
- Extra totals (bills, supplier without ABN and not exempt, when withholding applies): "No-ABN withholding (to the ATO)" "($x)" and "Payable to supplier".
- Buttons (only for `purchases.manage`; others see only "Cancel"): "Save draft", "Save for review", "Save and approve" (primary). "Save and approve" failure → detail shows "Saved but not approved: <reason>".
- **Duplicate detection (SQL):** "A bill with supplier reference % already exists for this supplier." — case-insensitive, same supplier, any non-void bill **or supplier credit**; blank references are not checked.
- Other errors: API "Supplier is not valid." / "The bill date must be a date."; SQL "Choose an active supplier." / "Bill not found." / "An approved bill can't be edited. Void it instead." + §1.5 + PO guards (§7.5).
- Number `BILL-…` assigned on first save (also for supplier credits).

### 8.4 Detail `#/bills/<id>`
- Eyebrow "PURCHASES · BILL" / "PURCHASES · SUPPLIER CREDIT"; heading number + chips; sub-line supplier · "their ref …" · date · "due …". No PDF for bills.
- Note (bill not yet approved, supplier without ABN, not exempt): "This supplier has no ABN on file. When approved, 47% of a bill over $75 (ex GST) is withheld and recorded as owing to the ATO."
- Facts: "Entered by", "Approved", "Ledger", "Purchase order", "Void reason". Totals incl. "No-ABN withholding (to the ATO)" and "Owing to supplier" / "Left to apply".
- Buttons (`purchases.manage` unless noted):
  - "Edit" (draft/submitted)
  - "Send for review" (draft) → `bill_submit`; flash "Sent for review."; SQL "Only a draft bill can be sent for review."
  - "Approve" (draft/submitted) → `bill_approve` (PO mismatch confirm, §7.5); flash "Approved and posted to Accounts Payable."
    - SQL errors: "Bill not found." / "This bill is already approved or void." / "The total must be more than zero." / "A tax rate or account changed since this was saved. Open it, check the lines and save it again." / "This supplier isn't registered for GST (or has no ABN), so no GST can be claimed. Use a GST-free or no-GST code." / "No no-ABN withholding rate is recorded for %. Ask an administrator to add the compliance rule." + period errors. Payment-batch guard can also refuse status changes.
  - "Pay" (approved bill with balance, `bank.manage`) → `#/supplier-payments/new?supplier=…&bill=…`
  - "Void" (approved) — prompt(): "Void this bill? The ledger entry is reversed. Reason:"; JS "Give a reason for voiding it."; flash "Voided."; SQL "This bill is already void." / "Payments or credits are applied to it. Remove those first." / batch guard "This bill is in payment batch %. Cancel the batch before voiding the bill."
  - "Delete" (draft/submitted) — confirm(): "Delete this unapproved bill? It isn't in the books."; hard delete via `bill_void` with reason "Deleted before approval"; audited.
- "Payments and credits" / "Applied to" section (approved): rows date, source ("Payment" / "Credit …" / "Bill …"), amount; empty "Nothing yet." On a bill with balance and open supplier credits: form "Supplier credit" ("Credit <their ref|number> · $x"), "Amount", "Apply" → `supplier_credit_apply`; flash "Credit applied." SQL "Choose an approved supplier credit and bill for the same supplier." / "The amount can't exceed what is left on the credit or the bill." (No apply form on the credit's own page — apply from the bill.)
- Attachments (add: `purchases.manage`).

### 8.5 No-ABN withholding
- Applies on approval of a **bill** (not credits) when the supplier has no ABN and "No-ABN withholding doesn't apply" is not ticked, and the bill **subtotal (ex GST) > threshold**.
- Amount = round(bill **total** (incl. GST) × rate, 2). Rate and threshold are dated compliance rules: `no_abn_withholding_rate` 0.47 and `no_abn_withholding_threshold` 75, effective 2024-07-01 ("Seeded; confirm with accountant"); the rule in force on the bill date is used. The JS preview uses the live rate and a fixed $75 threshold.
- Posting: Cr 2100 PAYG Withholding Payable (withheld), Cr 2000 AP (total − withheld). The bill's owing and payable amount exclude the withholding. Payment of the withheld amount to the ATO is via BAS (out of scope).
- Also: GST cannot be claimed from a supplier without an ABN or not GST-registered (approval blocked).

---

## 9. Supplier payments (`#/supplier-payments`, accounts/views/supplier-payments.js)

API: `supplier_payments_list`, `supplier_payment_get` (read perms); `supplier_payment_record`, `supplier_payment_void` (`bank.manage`).

Statuses: `posted` → "Paid"; `void` → "Void".

### 9.1 List
- Eyebrow "PURCHASES"; heading "Supplier payments"; intro "Record payments after they leave the bank, or pay several bills with one bank file in Payment batches." ("Payment batches" links to `#/payment-batches`).
- Button "Pay bills" (`bank.manage`).
- Columns "Date", "Supplier", "Reference", "Method", "Status", "Amount". Empty "No payments yet." Latest 300.
- API "Payments could not be loaded."

### 9.2 Record `#/supplier-payments/new[?supplier=&bill=]`
- Eyebrow "PURCHASES · PAYMENTS"; heading "Pay bills"; intro "Choose the supplier and how much of each approved bill was paid. Bills waiting for approval aren't listed and can't be paid."
- Fields: "Supplier" (required), "Payment date", "Paid from" (bank accounts), "Method", "Reference".
- Shows "Pay to <name> · BSB … · <account>" (masked unless `bank.manage`/`purchases.bank`) or "No bank details on file for this supplier."
- Bills table (approved bills with balance only): "Bill", "Their reference", "Due" (+ "Overdue"), "Owing" (+ "after $x withheld"), "Pay". Link "Pay all in full". Running "Total payment $x" or "An amount is not valid or is more than the bill owes." If none: "No approved bills are owing to this supplier."
- Buttons "Record payment", "Cancel".
- JS: "Choose the supplier."; "Fix the highlighted amounts first."; "Enter how much was paid on at least one bill."
- API: "Choose the bills to pay and the amounts." / "Each amount paid must be an amount in dollars and cents." / "Supplier is not valid." / "The payment date must be a date." / "Bank account is not valid."
- SQL: "Supplier not found." / "Choose the bank account the money came from." / "Choose the bills to pay and the amounts." / "Payments can only be applied to this supplier's bills." / "Bill % is not approved, so it can't be paid." / "Bill %: the amount is more than what is owing." / batch guard "This bill is in payment batch %, which is waiting to be approved or paid. Mark that batch as paid, or cancel it first."
- Payment amount = sum of allocations (no overpayment / unallocated supplier payments from this screen). Part payments allowed. Posting Dr 2000 AP / Cr bank. Audited. **This only records a payment already made — no bank file is produced and nothing is sent.**

### 9.3 Detail `#/supplier-payments/<id>`
- Eyebrow "PURCHASES · PAYMENT"; heading "$x to <supplier> <Paid|Void>"; sub-line date · reference/"No reference"; button "Supplier".
- Facts "Paid from", "Method", "Supplier account" (current supplier bank details, masked per permission), "Recorded by", "Ledger", "Void reason". Table "Bill", "Their reference", "Paid".
- "Void payment" (`bank.manage`) — prompt(): "Void this payment? The bank entry is reversed and the bills go back to unpaid. Reason:"; API "Say why the payment is being voided."; SQL "Payment not found." / "This payment is already void."; flash "Payment voided."

### 9.4 Recording vs payment batches
- Supplier payments screen: single supplier, records after the fact, one person (`bank.manage`), immediate posting.
- Payment batches (`#/payment-batches`, `bank.manage`, Banking area): many bills, ABA bank file, needs an approved supplier bank account, **a different person must approve the batch** ("Someone other than the person who made the batch must approve it."); "Mark as paid" then calls the same `supplier_payment_record` per supplier. While a bill sits in a draft/approved batch it can't be paid, credited or voided any other way.
- Bank reconciliation can also create a supplier payment from a money-out statement line.

---

## 10. Segregation of duties (as built)

| Control | Enforced? | Where |
| --- | --- | --- |
| Supplier bank details change needs a second person with `purchases.bank`; requester can't approve own | Yes | SQL `approval_decide` ("Someone else must approve a change you requested.") |
| Only one pending bank change per supplier | Yes | SQL + unique index |
| Bank details never editable in the supplier form | Yes | `supplier_save` ignores bank fields |
| Payment batch approver ≠ creator | Yes | banking SQL |
| PO raised by `purchases.raise`-only user must be approved by `purchases.manage` holder | Yes (by permission) | SQL `po_set_status` |
| PO raiser with `purchases.manage` approving own PO | **Allowed** | Design doc: "someone with `purchases.manage` can … approve an order they raised" |
| Same person entering and approving a bill | **Allowed** | Design doc says a second-person rule is "a small rule change" |
| Same person creating and approving an invoice / credit note | **Allowed** | no check |
| Recording payments separated from documents | Partly: payments need `bank.manage`, documents need `sales.manage`/`purchases.manage`; default roles finance_admin/director/super_admin hold both |
| Quotes: approval by different person | Not enforced |

## 11. High-risk actions
- Approving a supplier bank change (payment redirection fraud) — `purchases.bank`, MFA.
- Approving bills (posts AP, GST credits, withholding) and invoices (AR, GST) — irreversible except by void.
- Voiding invoices, bills, receipts, supplier payments (reverses journals; blocked in closed periods and when bank-matched; reason required).
- Recording supplier payments (marks bills paid; no file, but wrong entries misstate AP/bank).
- Approving a bill that fails the three-way match (warning only).
- Ticking "No-ABN withholding doesn't apply" on a supplier (removes 47% withholding) — no second approval.
- Editing a supplier's ABN / GST-registered flag (affects withholding and GST claims) — audited only.
- Deleting drafts (hard delete; audited).

## 12. Present in code but not reachable / gaps ("Verification required")
- **Removing an allocation (unapplying a credit note or receipt) has no function or UI.** Only voiding a receipt/supplier payment removes its allocations. Consequently an invoice/bill with a credit applied, or a credit note that has been applied, can't be voided ("Payments or credits are applied to it. Remove those first."). Verification required.
- `aged_receivables`, `aged_payables` actions exist here but are used from `#/reports` (Accounting > Reports), not from these screens.
- Quote editor accepts `?project=` but no UI link passes it. Verification required.
- Sales lines may use `liability` accounts per SQL (e.g. deposits), but the sales account picker only lists revenue/other income — not reachable in UI.
- Quote "Cancel quote" button shows on Accepted/Declined quotes, but SQL refuses ("A accepted quote can't become cancelled.").
- SQL allows Approved → Declined and Accepted → Sent (reopen); the UI doesn't offer them.
- Customer "Credit limit" is informational only; no approval block.
- `quote.sentAt` returned by API but not displayed.
- `invoices_list` supports `from`/`to` date filters and `customerId`; UI doesn't expose date filters. `quotes_list`, `pos_list`, `supplier_payments_list`, `receipts_list` support `customerId`/`supplierId`; not exposed as filters.
- Supplier-credit apply form exists only on the bill page (no "apply to a bill" on the credit page, unlike customer credit notes).
- Bills editor reachable by `bank.manage`/`reports.view` users via URL but shows no save buttons.
- `purchases.raise`-only users can read bills via API (`bill_get`/`bills_list` permitted) but the Bills menu/route is hidden; PO detail shows bills table with no links usable by them (route redirects to dashboard).
- Emailing documents, statements and remittances: not built (design doc). Refunds of customer credits, bad-debt write-offs, recurring invoices, retentions: not built.
- "Mark as sent" / "Mark as issued to supplier" only record a timestamp; nothing is transmitted.
- No duplicate detection for customer/supplier names or ABNs; duplicate check exists only for supplier invoice number per supplier.
- Send-back and cancel reasons on POs are optional (prompt accepts blank) and are stored only in the audit log; requester is not notified.
- PO "Bills against this order" table shows raw status keys (e.g. `submitted`) instead of labels.
