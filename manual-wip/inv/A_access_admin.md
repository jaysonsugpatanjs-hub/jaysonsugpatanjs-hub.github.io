# Inventory A — Access, sign-in, MFA, dashboard, navigation, administration

Source files read: `accounts/index.html`, `accounts/app.js`, `accounts/lib/ui.js`, `accounts/lib/docs.js`, `accounts/lib/validate.js`, `accounts/views/{dashboard,planned,company,users,approvals,integrations,audit,leave}.js`, `training/auth.js`, `training/index.html`, `training/app.js`, `training/admin/people.js` (sign-in part), `supabase/functions/finance-api/{index,docs,payroll}.ts` + `*Headlines` in ledger/sales/purchases/projects/payroll/banking/tax, `supabase/functions/_shared/{http,accounts}.ts`, `supabase/functions/admin-api/{index,accounts}.ts`, `supabase/functions/training-api/index.ts` (password change), migrations `20261002000000_access_onboarding.sql`, `20261007000000_finance_foundation.sql`, `20261009…`, `20261010…`, `20261011…`, `20261013…`, `20261015…`, `docs/SECURITY.md`, `docs/PAYROLL.md`.

Conventions: "JS" = browser message, "API" = finance-api Edge Function, "SQL" = database function. Quotes are verbatim.

---

## 1. Reaching Panalo Accounts

### 1.1 URLs
- App: `/accounts/` (page title `Panalo Accounts`; `noindex`). Hash routes `#/dashboard`, `#/company`, etc. Default route = `#/dashboard`.
- Sign-in happens on the **portal**, not in Accounts: `/training/` (page title `Panalo Pipes Training Portal`). Accounts' Sign in button links to `../training/?next=/accounts/`.
- After a successful portal sign-in, `?next=` sends the user back if it matches `^/(accounts|training)/[A-Za-z0-9/_#.-]*$` (training/app.js `goNext`). Already-signed-in users opening the portal with `?next=` are redirected immediately.
- Other entry points: portal Administration header (`training/admin/`) has a link `Panalo Accounts` (→ `/accounts/`). The learner portal home page has **no** link to Accounts (Verification required whether users are expected to bookmark `/accounts/`).
- Session is shared with the portal (same browser `localStorage` key `panalo-training-session-v1`). Signing in on the portal signs you into Accounts; Accounts' Sign out signs you out of the portal too.

### 1.2 Portal sign-in page (training/index.html)
- Card eyebrow `SIGN IN`, heading `Sign in to the Panalo portal`, text: "Use the email address Panalo invited and your password. If you were given a temporary password, you'll choose your own straight after signing in."
- Fields: `Email address` (type email, required, placeholder `name@example.com`), `Password` (required). Button `Sign in` (while working: `Signing in…`). Link button `Forgot password?`.
- Privacy note: "Access is limited to people invited by Panalo. Your email, training activity, results and any documents you upload are kept for training and HR administration."
- Errors (JS, training/auth.js):
  - "Enter a valid email address."
  - "Enter your password."
  - Wrong credentials (never reveals whether email exists): "That email and password don't match. Check them, or use Forgot password."
  - Not configured: "The secure training service has not been connected yet."
- Forgot password form: field `Email address`, button `Email me a reset link`, link `Back to sign in`. Result (always same): "If that email has a Panalo account, a reset link is on its way. It works once and expires soon." Rate limit: "Too many requests. Wait a minute and try again."
- Portal not configured panel: eyebrow `PORTAL SETUP`, heading `Secure service connection pending`, "The protected training backend has not been connected to this page. No learner records or course files are available publicly."

### 1.3 Choosing / changing a password (portal)
- Panel eyebrow `YOUR PASSWORD`; heading/intro depend on reason:
  - invite link: `Welcome to Panalo` / "Choose the password you'll use to sign in from now on."
  - recovery link: `Reset your password` / "Choose a new password. It replaces your old one straight away."
  - temporary password: `Choose your own password` / "You signed in with a temporary password. Choose your own to continue."
  - default: `Choose your password` / "Set a password you'll use to sign in from now on."
- Rules shown: "At least 12 characters"; "A mix of at least three: lower-case, capitals, numbers, symbols"; "Not a common password, and not your email name".
- Fields `New password`, `Type it again` (minlength 12). Button `Save password` (working text `Saving…`). Mismatch (JS): "The two passwords don't match."
- Server rules (`_shared/accounts.ts passwordProblem`, error code `weak_password`):
  - "Use at least 12 characters." / "Use 128 characters or fewer." / "Don't start or end the password with a space." / "Mix at least three of: lower-case letters, capitals, numbers and symbols." / "That password is too common. Choose something harder to guess." / "Don't include your email name in the password." / "Avoid repeating the same character four or more times."
  - Supabase refusal: "That password could not be set. Try a different one."
- Temporary passwords: generated as four groups of four (e.g. `Kp7m-Q3xv-T9cw-Hn4r`), no 0/O/1/l/I. Issuing one sets `must_change_password = true`.
- Note: a user with a temporary password who signs in from Accounts' link (`?next=/accounts/`) is redirected to Accounts **before** the portal asks for a new password, so they land on the Accounts gate "Change your temporary password first" and must click `Open the portal`.

### 1.4 Accounts gate states (accounts/app.js `init`/`start`)
All gate screens: eyebrow `PANALO ACCOUNTS`, then heading + body.

| Condition | Heading (exact) | Body (exact) / buttons |
|---|---|---|
| Initial page load | `Checking your access…` | (empty) |
| Service not configured (JS `isConfigured`) | `Not connected yet` | "The secure service has not been configured." |
| No stored session, or API 401 | `Sign in to Panalo Accounts` | "Sign in on the Panalo portal with your email and password, then you'll come straight back here." Button `Sign in` → `../training/?next=%2Faccounts%2F` |
| API code `password_change_required` (profile `must_change_password`) | `Change your temporary password first` | "You signed in with a temporary password. Choose your own on the portal, then come back." Button `Open the portal` → `../training/` |
| API code `no_access` | `No access to Panalo Accounts` | Server message: "Your account doesn't include Panalo Accounts. Ask an administrator if you need it." Button `Back to the portal` |
| Any other error | `Panalo Accounts is unavailable` | error text (red). Examples: "This account is not active." (API, inactive profile); "The secure training service could not complete the request." (any 5xx); "This website is not permitted to call Panalo Accounts." (CORS) |
| MFA needed, factor already verified | `Confirm it's you` | see 1.5 |
| MFA needed, no verified factor | `Set up two-step sign-in` | see 1.5 |

Who passes the `no_access` check (API, index.ts): the user must hold at least one permission whose `area` is not `Portal` (i.e. area `Accounts` or `Payroll`), or `access.manage`. Inactive profiles hold no permissions (SQL `app_permissions_for`).

### 1.5 Two-step sign-in (MFA, TOTP)
- Required when the user holds **any** permission with `requires_mfa = true` (API `whoami` → `mfa.required`; every other action is refused with 403 "Confirm your sign-in with your authenticator app to continue." code `mfa_required` until the session is `aal2`). If that error arrives while navigating, the MFA screen is shown.
- MFA-required keys: `access.manage`, `org.manage`, `ledger.manage`, `ledger.journal`, `ledger.post`, `ledger.reopen`, `sales.manage`, `purchases.manage`, `purchases.bank`, `bank.manage`, `payroll.sensitive`, `payroll.run`, `payroll.approve`, `tax.bas`, `tax.review`, `audit.view`, `data.export`, `assets.manage`.
- Not MFA: `projects.manage`, `time.approve`, `time.submit`, `leave.approve`, `reports.view`, `purchases.raise`, `payroll.self` and all Portal-area keys. So by role defaults: Project manager and Supervisor do **not** need MFA; all other roles do.
- **Enrolment screen** `Set up two-step sign-in`: "Your access includes company finances, so Panalo Accounts needs a second step at sign-in. This is required for administrators, directors, finance and payroll staff." Steps:
  1. "Install an authenticator app on your phone, such as Microsoft Authenticator or Google Authenticator."
  2. "In the app, add an account and scan this code." (QR image, alt "QR code for your authenticator app") + "Can't scan? Enter this key instead: <secret>"
  3. "Type the 6-digit code the app shows."
  Field `6-digit code` (numeric, maxlength 7). Button `Turn on two-step sign-in`. Factor friendly name "Panalo Accounts". Any earlier unverified (abandoned) factor is deleted automatically before a new QR is made.
- **Verification screen** `Confirm it's you`: "Your access includes company finances, so Panalo Accounts asks for the 6-digit code from your authenticator app each time you sign in." Field `6-digit code`; button `Verify`; footnote "Lost your phone? Ask a Panalo administrator to reset your authenticator."
- While checking: `Checking…`. Errors (JS): "Enter the 6-digit code from your authenticator app." (not exactly 6 digits after removing spaces); "That code didn't work. Codes change every 30 seconds; try the current one."
- Reset of a lost authenticator: no UI. docs/SECURITY.md: an administrator removes the factor in Supabase (Authentication › Users › the user › MFA factors); the user enrols again at next Accounts sign-in. (Verification required: who holds Supabase dashboard access.)

### 1.6 Session expiry
- Access token refreshed automatically when within 60 s of expiry (default lifetime 3600 s from the token). If refresh fails the stored session is cleared.
- On page load with no valid session → `Sign in to Panalo Accounts` gate.
- Mid-use: API 401 is retried once after a refresh; if still failing, the screen shows a panel `Something went wrong` with "Your sign-in has expired. Please sign in again." (route error handler does not send the user back to the gate; reload the page to get the Sign in button). Verification required: exact Supabase refresh-token lifetime.
- Generic friendly errors (training/auth.js `friendlyError`): 401 → "Your sign-in has expired. Please sign in again."; 403 without message → "This account does not have access to that training."; fallback → "Something went wrong. Please try again."

---

## 2. App shell

### 2.1 Header (after access granted)
- Brand (links `#/dashboard`): mark `P`, `PANALO ACCOUNTS`, small line = organisation name from the database (`Panalo Pipes & Structurals Pty Ltd`; fallback `Panalo Pipes & Structurals`).
- Bell button (aria-label `Notifications`) with red count = unread notifications (of the latest 50). Panel title `Notifications`; `Mark all read` (only when unread > 0; API `notifications_read`, marks all as read); empty: `Nothing yet.` Each item = title (link to its screen, default `#/dashboard`), small "body · date time". Opening an item closes the panel but does **not** mark it read.
- Signed-in person's name.
- `Portal` link → `../training/`.
- `Sign out` button → logs out of Supabase and returns to `../training/`.

### 2.2 Router behaviour
- While a screen loads: `Loading…`.
- Unknown route, or a route the user's permissions don't allow → silently redirected to `#/dashboard`.
- Screen error → panel `Something went wrong` + message.
- Status line at top of main area (`#app-msg`) is cleared on each navigation.

### 2.3 Left menu (MENU in accounts/app.js) — items shown only if user holds the listed permission (`perm`) or **any** of the `any` list. A group heading is hidden if none of its items are visible.

Shorthands: SALES = `sales.manage`, `bank.manage`, `reports.view`; PURCHASES = `purchases.manage`, `purchases.raise`, `bank.manage`, `reports.view`; RUNS = `payroll.run`, `payroll.approve`, `payroll.sensitive`; LEDGER = `reports.view`, `ledger.manage`, `ledger.journal`, `ledger.post`, `audit.view`.

| Group | Label | Route | Shown to | Badge |
|---|---|---|---|---|
| (none) | Dashboard | `#/dashboard` | everyone with Accounts access | — |
| (none) | My pay | `#/my-pay` | `payroll.self` | — |
| Sales | Customers | `#/customers` | any SALES | — |
| Sales | Quotes | `#/quotes` | any SALES | — |
| Sales | Invoices | `#/invoices` | any SALES | — |
| Sales | Payments received | `#/receipts` | any SALES | — |
| Purchases | Suppliers | `#/suppliers` | any PURCHASES | — |
| Purchases | Purchase orders | `#/purchase-orders` | any PURCHASES | — |
| Purchases | Bills | `#/bills` | `purchases.manage`, `bank.manage`, `reports.view` | — |
| Purchases | Supplier payments | `#/supplier-payments` | `purchases.manage`, `bank.manage`, `reports.view` | — |
| Projects | Projects | `#/projects` | `projects.manage`, `reports.view` | — |
| Projects | Job costing | `#/job-costing` | `projects.manage`, `reports.view` | — |
| Projects | Timesheets | `#/timesheets` | `time.submit`, `time.approve`, `projects.manage`, `payroll.run` | timesheets |
| Payroll | Employees | `#/employees` | `payroll.sensitive`, `payroll.run`, `payroll.approve`, `leave.approve` | — |
| Payroll | Pay runs | `#/pay-runs` | any RUNS | payRuns |
| Payroll | Leave | `#/leave` | `leave.approve`, `payroll.sensitive`, `payroll.run` | leave |
| Payroll | Super | `#/super` | any RUNS | — |
| Payroll | STP | `#/stp` | any RUNS | — |
| Payroll | Payroll reports | `#/payroll-reports` | any RUNS | — |
| Accounting | Reports | `#/reports` | any LEDGER | — |
| Accounting | Journals | `#/journals` | any LEDGER | — |
| Accounting | Chart of accounts | `#/chart-of-accounts` | any LEDGER | — |
| Accounting | Tax codes | `#/tax-codes` | any LEDGER | — |
| Accounting | Periods | `#/periods` | any LEDGER | — |
| Accounting | Fixed assets | `#/assets` | `assets.manage`, `reports.view` | — |
| Tax | BAS | `#/bas` | `tax.bas`, `tax.review` | bas |
| Tax | TPAR | `#/tpar` | `tax.bas`, `tax.review` | — |
| Banking | Bank accounts | `#/bank-accounts` | `bank.manage`, `reports.view` | — |
| Banking | Reconciliation | `#/reconciliation` | `bank.manage`, `reports.view` | bankLines |
| Banking | Payment batches | `#/payment-batches` | `bank.manage` | batches |
| Banking | Bank rules | `#/bank-rules` | `bank.manage` | — |
| Administration | Company settings | `#/company` | everyone (edit needs `org.manage`) | — |
| Administration | Users and roles | `#/users` | `access.manage` | — |
| Administration | Approvals | `#/approvals` | everyone | approvals |
| Administration | Integrations | `#/integrations` | everyone | — |
| Administration | Audit log | `#/audit` | `audit.view` | — |

(Route `#/my-pay` also: `#/timesheets/review` and sub-paths like `#/invoices/<id>` are handled by the views.)

### 2.4 Menu count badges (`refreshCounts`, shown only when > 0; refreshed after sign-in and by some screens)
| Badge | Counts | Only computed if |
|---|---|---|
| Approvals | approval requests you can decide (pending, not requested by you, you hold the required permission) | always |
| Pay runs | pay runs with status `submitted` (includes ones you prepared) | `payroll.approve` |
| Leave | submitted leave requests that are not your own | `leave.approve` |
| Reconciliation | bank transaction lines with status `new` ("linesToMatch") | `bank.manage` |
| Payment batches | draft payment batches created by someone else ("batchesToApprove") | `bank.manage` |
| BAS | (`tax.review`: draft BAS not prepared by you) + (`tax.bas`: BAS with status `reviewed`, to lodge) | `tax.bas` or `tax.review` |
| Timesheets | submitted timesheets that are not your own | `time.approve` |
Failures while counting are ignored silently.

### 2.5 Planned / phase placeholder screens (views/planned.js)
- Template: eyebrow = group name upper-case; heading = item label; chip `Arrives in Phase N`; text "This screen is part of Phase N: <description>. Each phase is built, tested and reviewed before the next starts, and every money movement will post through the same double-entry ledger."; button `Back to the dashboard`. Menu items would carry a `Phase N` tag.
- **Not reachable in the current build (Verification required)**: no MENU item is defined with a phase, so this screen and the `Phase N` tag never appear.

---

## 3. Dashboard (`#/dashboard`, label `Dashboard`, no permission; API action `dashboard`, perm none)

Header: eyebrow `DASHBOARD`; heading = trading name, else legal name, else `Panalo Accounts`; sub-line "<legal name> · ABN <xx xxx xxx xxx>"; company logo (alt `Company logo`) if uploaded.

Cards appear in rows; a row/card appears only if the user's permissions give that data (headline functions return null otherwise). Cards with something waiting get the "attention" highlight.

| Card heading | Figure | Small text / link | Source & rule | Who sees |
|---|---|---|---|---|
| Bank | money | "Bank accounts in the ledger, as at <today>"; link `Transactions` → `#/reports?type=account` | Sum of balance-sheet rows for accounts with subtype `bank`, as at today (Sydney) via SQL `report_balance_sheet` | `reports.view` |
| Net profit this financial year | money | "From <FY start>"; link `Profit and loss` → `#/reports?type=pl` | `currentYearEarnings` from balance sheet; FY start from `ledger_fy_start` | `reports.view` |
| GST owed (estimate) | money | "Balance of the GST account; bracketed means a refund is due" (no link) | Sum of balance-sheet rows with subtype `gst` | `reports.view` |
| Draft journals | count | "Not in the ledger until posted"; link `Review drafts` → `#/journals?status=draft` | journal_entries with status `draft` | `reports.view` |
| Customers owe | money | "<x> overdue" or "Nothing overdue"; link `Aged receivables` → `#/reports?type=ar` | Aged receivables total today; overdue = 30+60+90+over-90 buckets (excludes "current") | `sales.manage`, `bank.manage` or `reports.view` |
| Draft invoices | count | "Not sent or posted until approved"; link `Review` → `#/invoices?view=draft` | invoices status `draft` | same as above |
| Panalo owes suppliers | money | "<x> overdue" / "Nothing overdue"; link `Aged payables` → `#/reports?type=ap` | Aged payables total; overdue as above | `purchases.manage`, `purchases.raise`, `bank.manage` or `reports.view` |
| Waiting on purchasing | count (bills + orders) | "<n> bill(s) to review · <n> order(s) to approve"; links `Bills` → `#/bills?view=draft`, `Orders` → `#/purchase-orders` | bills status `draft`/`submitted`; purchase orders status `submitted` | same as above |
| Bank lines to match | count | link `Reconciliation` | bank_transactions status `new` | `bank.manage` |
| Payment batches to approve | count | link `Payment batches` | draft payment batches created by someone else | `bank.manage` |
| Next BAS | due date (red if past) | "<from> to <to>" or "None in progress"; link `BAS` | earliest open BAS (status `draft`/`reviewed`) by period | `tax.bas` or `tax.review` |
| BAS to review | count | — | draft BAS not prepared by you | same |
| To lodge / to pay | "n / n" | — | BAS status `reviewed` / status `lodged` | same |
| Pay runs to approve | count | link `Pay runs` | pay runs status `submitted` | `payroll.approve` (row needs any RUNS) |
| Super not yet paid | money | "Due within 7 business days of each payday"; link `Super` | sum of `super` on pay runs `approved`/`paid` with no `super_paid_at` | any RUNS |
| Leave to approve | count | link `Leave` | all submitted leave requests (includes your own — differs from menu badge) | `leave.approve` |
| Active projects | count | "Active or on hold"; link `Job costing` | projects status `active`/`on_hold` | `projects.manage` |
| Timesheets to approve | count | "Submitted and waiting for you or another approver"; link `Review` → `#/timesheets/review` | submitted timesheets not your own | `time.approve` |
| Company setup | `Complete` (green) or "<n> of 6" | Complete: "Change details any time in Company settings."; else "Still needed: <list>." Button: `View settings` (complete or no edit right) / `Continue setup` (incomplete and `org.manage`) | `setup_completed_at`; missing list = ABN, business address, email, phone, states you operate in, payroll contact | everyone |
| Approvals waiting for you | count | "<n> of your own requests waiting for someone else." or "Changes that need a second person, such as new bank accounts."; button `Open approvals` | approvals you can decide; your pending requests | everyone |
| Notifications | unread count | "unread" | notifications | everyone |

"What's being built" panel: "Panalo Accounts is delivered in phases, each tested before the next starts. Menu items marked with a phase arrive then." Table columns `Phase`, `Module`, `Includes`, `Status`:
1 Foundation — "Company setup, roles, two-step sign-in, approvals, audit log"; 2 Accounting core — "Chart of accounts, tax codes, journals, posting engine, trial balance, P&L, balance sheet"; 3 Sales and purchasing — "Customers, suppliers, quotes, invoices, purchase orders, bills"; 4 Projects — "Projects, cost codes, timesheets, job costing"; 5 Payroll — "Pay settings, PAYG, super, leave, pay runs, payslips"; 6 Banking — "Bank import, matching, rules, reconciliation"; 7 BAS — "GST and PAYG reconciliation, BAS workpaper, TPAR"; 8 STP and assets — "STP Phase 2 data and exports, fixed assets"; 9 Hardening — "Security review, backups, restore tests, user acceptance". Status chip: phases 1–8 `Live`, phase 9 `Next` (hard-coded in JS).
Footer (only `audit.view`): "Every change in Panalo Accounts is recorded in the audit log." (link to `#/audit`).
Dashboard is read-only; nothing posts or is audited.

---

## 4. Shared UI conventions

### 4.1 Formats (accounts/lib/ui.js)
- Time zone for all dates: `Australia/Sydney`. Date = en-AU medium (e.g. `8 Oct 2026`); date-time = medium date + short time. Empty date → `—`.
- Money: 2 decimals with thousands separators, no `$` sign (`1,234.50`); negatives in brackets `(1,234.50)`. Some tables blank out zero.
- Money input: commas, spaces and `$` are ignored; max 2 decimals; anything else is invalid.
- ABN shown `xx xxx xxx xxx`; ACN `xxx xxx xxx`; BSB `xxx-xxx`. Masked account numbers `•••• 123` (last 3 digits).
- "Today" = Sydney date.
- Hours (leave) up to 2 decimals.

### 4.2 Form conventions
- Required fields show a red `*` after the label.
- Field hints appear under the field; field errors appear under the field in red, the field is outlined and focused (`fieldError`).
- Flash messages: status line under the form/page (`data-msg`), tones good (green), bad (red), warn, or neutral ("Saving…", "Uploading…").
- Chips (status labels) with tones: `good` (green), `bad` (red), `pending`, `info`, neutral.
- Confirm/prompt dialogs are browser-native `window.confirm`/`window.prompt`; pressing Cancel on a prompt aborts the action; an empty prompt answer is sent as an empty comment.

### 4.3 CSV download (`downloadCsv`)
- Excel-compatible UTF-8 with BOM, CRLF line ends; cells with `" , newline` quoted. Text starting with `= + - @ tab CR` (except plain numbers) is prefixed with `'` to stop spreadsheet formulas. (Used by report screens; not in the admin screens.)

### 4.4 PDF downloads (`downloadPdf` in lib/docs.js)
- API returns `{ fileName, base64 }`; browser saves the PDF with that name. Each PDF generation is audited on the server (e.g. `document_pdf_generated`, `payslip_generated`).

### 4.5 Attachments panel (lib/docs.js + finance-api/docs.ts)
- Heading `Attachments`. List: file name (click opens a 2-minute signed link in a new tab, API `attachment_open`), "<n> KB · <date>", `Remove` link. Empty: `Nothing attached.`
- Add button: `Attach a PDF or photo` (file picker accepts PDF, JPEG, PNG, WebP).
- Flash: `Uploading…` → `Attached <file name>.`; upload failure (JS): "The upload didn't go through. Please try again."
- Server rules: types by extension pdf/png/jpg/jpeg/webp — "Attach a PDF or a photo (JPG, PNG or WebP)."; size 1 byte–15 MB — "Attachments must be under 15 MB."; record types bill, purchase_order, supplier, invoice, quote, customer, asset — else "Attachments are not available here."; upload not found — "The upload didn't arrive. Please try again."
- Permissions: add/attach = `sales.manage` (invoice/quote/customer), `purchases.manage` (bill/PO/supplier; `purchases.raise` also for PO), `assets.manage` (asset). Open also allowed with `reports.view`. Remove (`attachment_archive`) needs `sales.manage`/`purchases.manage`/`assets.manage` (SQL checks `sales.manage` for sales records else `purchases.manage`).
- Remove confirm: "Remove this attachment? It is kept in the archive for the audit trail." Remove = archive (file kept, `archived_at` set), audited `document_archived`.
- Verification required: a user with only `purchases.raise` sees `Remove` on a PO but the SQL archive requires `purchases.manage`.

### 4.6 Common API/SQL error texts
- Permission (API): "Your access doesn't include this area. Ask an administrator if you need it."
- Permission (SQL `app_require`): "You need the "<permission name>" permission for this."
- Bad id: "<Label> is not valid." Unknown action: "Unknown Panalo Accounts action."
- DB constraint mapping (`_shared/http.ts`): duplicate → "That record already exists."; check constraint → "One of the values is outside what is allowed."; bad format/date → "One of the values is not in a valid format."; server error → "The secure training service could not complete the request."

---

## 5. Company settings (`#/company`, menu `Company settings`, Administration)

- View: anyone with Accounts access (API `company_get`, perm none). Edit: `org.manage` (`canEdit`). Without `org.manage`: chip `Read only`, no stepper, only the Review step is shown (no buttons). Full bank account numbers and APCA IDs only for `org.manage` or `bank.manage`; others see `•••• 123`.
- Header: eyebrow `ADMINISTRATION`, heading `Company settings`. Intro: before completion "Set up the company once; every invoice, payslip and report uses these details."; after completion "Setup completed <date>. Changes save straight away and are recorded in the audit log."
- Stepper (8 steps, numbered buttons; URL `#/company?step=N`): `Business`, `Contact`, `Tax and reporting`, `Payroll`, `Workers comp`, `Banking`, `Numbering`, `Review`. Steps can be done in any order and over several sittings.
- Buttons per step: `Back` (not on step 1) and `Save and continue` (saves and moves to next step). Flash `Saving…` → `Saved.`
- Save = API `company_save` (perm `org.manage`) → SQL `company_settings_save` (rechecks `org.manage`), audited `company_settings_saved` with old and new values of changed fields. No ledger posting; no second person.
- Browser form validation (native) also applies to `required`, `type=email`, `type=url` fields (browser's own wording).

### Step 1 Business — heading `Business details`
| Label | Req | Hint | Validation (JS / SQL) |
|---|---|---|---|
| Legal name | * | "As registered with ASIC" | <2 chars: "Enter the legal name." (JS); API: "Enter the company's legal name." |
| Trading name | | | ≤160 |
| ABN | * | "11 digits. Checked against the ATO check-digit rule." | "That ABN isn't valid. Check the 11 digits." (JS); SQL: "That ABN is not valid. Check the 11 digits." |
| ACN | | "9 digits, for a company" | "That ACN isn't valid. Check the 9 digits." (JS); SQL: "That ACN is not valid. Check the 9 digits." |
- Logo row: current logo (alt `Current logo`) or `No logo`; button `Upload logo`; hint "PNG, JPG, WebP or SVG, up to 2 MB. Used on invoices, quotes and payslips." Uploads immediately on file choice (API `logo_prepare_upload` + `logo_attach`, perm `org.manage`). Flash `Uploading logo…` → `Logo updated.` Errors: "The logo must be a PNG, JPG, WebP or SVG image."; "The logo must be under 2 MB."; "The upload failed (<status>). Please try again."; "The upload didn't arrive. Please try again."; "Invalid upload path." Old logo is archived, audited `company_logo_changed`. Stored in private bucket; shown via 10-minute signed link.

### Step 2 Contact — heading `Contact and addresses`
- `Business address` block: `Street address`, `Suburb`, `State` (Choose…/ACT NSW NT QLD SA TAS VIC WA), `Postcode` (4 digits).
- Checkbox `Postal address is the same` (when unticked shows `Postal address` block with same fields).
- `Phone` *, `Accounts email` * (hint "Shown on invoices; replies come here"), `Website`.
- Errors (JS): "Enter the street address."; "A postcode is 4 digits."; "Choose a state."; "Enter a phone number."; "Enter a valid email address." API also: "A postcode is 4 digits." / "Choose a state."

### Step 3 Tax — heading `Tax and reporting`
- `Registered for GST` Yes/No (default Yes).
- `GST reporting basis`: `Accrual (invoice date)` / `Cash (payment date)`; hint "Cash basis is only for GST turnover under $10 million".
- `BAS lodgement`: Quarterly / Monthly / Annual; hint "Monthly is required at $20 million GST turnover or more". Default quarterly.
- `Accounting basis`: Accrual / Cash.
- `Financial year starts`: month list (default July).
- `Time zone`: "Sydney, Canberra, Melbourne, Hobart" / Brisbane / Adelaide / Darwin / Perth.
- Note: "Currency is Australian dollars (AUD). Your accountant should confirm these settings before the first BAS."

### Step 4 Payroll — heading `Payroll and operations`
- `States where Panalo employs people or sends workers` * (checkboxes ACT…WA); hint "Drives payroll tax, workers compensation, labour hire licensing and portable long service leave."; error "Choose at least one state."
- `Pay frequency` Weekly/Fortnightly/Monthly (default weekly); `Pay day` Monday–Friday (default Thursday); `Super clearing house` (hint "The ATO's free clearing house closed on 1 July 2026").
- `Payroll contact`: `Name` * ("Enter the payroll contact's name."), `Email` ("Enter a valid email address."), `Phone`.
- Note: "Single Touch Payroll: export only. Panalo Accounts prepares and checks STP data; a registered provider sends it to the ATO. Super is due at the fund within 7 business days of each payday (Payday Super)."

### Step 5 Workers comp — heading `Workers compensation`
- "One policy for each state where Panalo has workers. Expiry dates trigger reminders in a later phase." (Verification required: no reminder found in code.)
- Table per chosen state (default NSW if none chosen): `State`, `Insurer`, `Policy number`, `Expires` (date). If no states chosen: "Choose your states in the Payroll step to add more rows."

### Step 6 Banking — heading `Banking and payment terms`
- `Default payment terms (days)` (0–120, default 30); button `Save terms` (stays on step). Error "Between 0 and 120 days."
- `Company bank accounts`: "A new account stays inactive until someone else with banking permission approves it. This stops a single person (or a fake email) redirecting payments."
- Table columns: `Account` (nickname + account name, "· shown on invoices"), `BSB`, `Number`, `Use`, `Status`, action. Empty: `No bank accounts yet.`
- Status values: `pending` → `Waiting for approval`; `active` → `Active`; `rejected` → `Rejected` (also set when the request is cancelled); `retired` → `Retired`. Transitions: pending → active (approved) / rejected (rejected or cancelled); active → retired.
- `Retire` (active accounts, `org.manage`): prompt "Retire this bank account? It stays on record. Give a reason:"; API `bank_account_retire`; SQL errors "Give a reason for retiring it." (<3 chars), "Only an active account can be retired.", "Bank account not found."; flash `Account retired.`; also turns off "shown on invoices"; audited `company_bank_account_retired` with reason. No approval needed to retire.
- Form `Add a bank account`:
  | Label | Req | Hint/placeholder | Error |
  |---|---|---|---|
  | Name in Panalo Accounts | * | placeholder `Main operating` | "Give the account a name." |
  | Account name (as the bank has it) | * | | "Enter the account name." |
  | Used for | | Operating / Payroll / Customer receipts / Tax (GST/PAYG) / Other | |
  | BSB | * | placeholder `062-000` | "A BSB is 6 digits, like 062-000." (JS and SQL) |
  | Account number | * | | "An account number is 5 to 10 digits." (JS and SQL) |
  | APCA user ID (optional) | | "6 digits from your bank, for ABA payment files" | "The APCA user ID is 6 digits." |
  Checkbox `Show this account on invoices for customers to pay into`. Button `Send for approval` → API `bank_account_request` (perm `org.manage`) → SQL `company_bank_account_request` creates the account as `pending` plus an approval request (kind `company_bank_account`, title "New company bank account: <name> (BSB xxx-xxx)", decided by `bank.manage`). Holders of `bank.manage` (except requester) get notification "Approval needed: <title>" / "Requested by <name>". Flash: "Sent for approval. Someone else with banking permission must approve it before it can be used."
- Only one active account can be shown on invoices: approving a new "show on invoices" account turns the flag off on the previous one.
- `Back` / `Continue` buttons (no save).

### Step 7 Numbering — heading `Document numbering`
- "Numbers only move forward, so an issued number is never reused."
- Columns `Document`, `Prefix` (max 10), `Next number`, `Digits` (1–10), `Next will be` (live preview, e.g. `INV-1001`), `Save` link per row → API `numbering_save` (perm `org.manage`); flash "<Document> numbering saved."; audited `number_sequence_saved`.
- Seeded rows: Invoices `INV-` 1001/4; Quotes `QU-` 1001/4; Purchase orders `PO-` 1001/4; Credit notes `CN-` 1001/4; Supplier bills `BILL-` 1001/4; Journals `JE-` 1/6; Pay runs `PR-` 1/5; later migrations add `project` `JOB-` 1001/4, `payment_batch` `PB-` 1/4, `asset` `FA-` 1/4 (these three show their raw key name as the label and sort first — no friendly label in KIND_LABEL; Verification required).
- Errors: "Numbers can only move forward, so issued numbers are never reused." (SQL); "The next number must be a whole number."; "Digits must be between 1 and 10." (API); prefix is upper-cased; prefix allowed chars A–Z, 0–9, `-` (else "One of the values is outside what is allowed."); "Unknown numbering."

### Step 8 Review — heading `Review`
- Message: "Still needed before setup is complete: <list>." (warn) / "Setup complete." / "Everything required is in place."
- Key–value table: Legal name, Trading name, ABN, ACN, Business address, Postal address, Phone, Email, Website, GST ("Registered, <basis> basis, BAS <frequency>" or "Not registered"), Financial year ("Starts <Month>"), Accounting basis, States, Pay cycle ("<frequency>, paid <day>"), Payroll contact, Super clearing house, Workers compensation ("<state>: <insurer or ?>"), Payment terms ("<n> days"), Active bank accounts (count).
- Buttons (`org.manage` only): `Back`, `Finish setup` (disabled while items missing; shows `Saved` once completed) → API `company_complete` → SQL `company_setup_complete`; error "Still needed: <list>."; flash `Company setup complete.`; audited `company_setup_completed`.
- Required for completion: ABN, business address (street + postcode), email, phone, at least one state, payroll contact name.

---

## 6. Users and roles (`#/users`, menu `Users and roles`, perm `access.manage`; APIs `roles_catalogue`, `users_list`, `role_set`, all `access.manage`)

- Header eyebrow `ADMINISTRATION`, heading `Users and roles`. Intro: "Roles add permissions on top of a person's position. Changes apply at their next page load and are recorded in the audit log. You can't change your own roles."
- Search: label `Find a person`, placeholder `Name, email or position` (filters name, email, position as you type).
- Button/link `People register, logins and personal overrides` → `../training/admin/?view=people-management` (portal admin).
- Grid: first column `Person` (name; email · position; chip `System admin` if portal role admin; chip `Sign-in disabled` if inactive, row greyed), then one checkbox column per role (column title tooltip = role description). Empty: `No one matches.`
- Ticking/unticking a box saves immediately (API `role_set` → SQL `app_set_profile_role`). Flash "Added <Role> for <Name>." / "Removed <Role> for <Name>." On error the box reverts.
- Own row: checkboxes disabled, tooltip "Someone else must change your roles". SQL: "Someone else must change your own roles."; other SQL errors "Person not found.", "Unknown role.". Audited `role_granted` / `role_removed` (entity `profile_role`, subject = the person).
- Section `What each role includes`: one card per role (name, description, list of permission display names).
- Footer note: "System administrators automatically hold every permission except payroll pay, tax and bank details, which need the Payroll admin role. Anyone holding finance or payroll permissions must use two-step sign-in in Panalo Accounts."
  - Code fact: system admins get every key with `admin_default = true`; `payroll.sensitive` **and** `payroll.self` have `admin_default = false`.

### 6.1 Roles (app_roles) and default permissions (app_role_permissions, all migrations combined)
| Role key | Name | Description | Permissions |
|---|---|---|---|
| super_admin | Super admin | "System configuration, users and every finance area except payroll details." | org.manage, access.manage, ledger.manage, ledger.journal, ledger.post, ledger.reopen, sales.manage, purchases.manage, purchases.raise, purchases.bank, bank.manage, projects.manage, time.approve, tax.bas, tax.review, reports.view, audit.view, data.export, assets.manage |
| director | Director / owner | "Reports, approvals and management dashboards." | ledger.post, ledger.reopen, sales.manage, purchases.manage, purchases.bank, bank.manage, payroll.approve, payroll.self, tax.bas, tax.review, reports.view, audit.view, data.export, assets.manage |
| finance_admin | Finance admin | "Invoices, bills, payments, bank reconciliation, journals, customers, suppliers and reports." | ledger.manage, ledger.journal, ledger.post, sales.manage, purchases.manage, purchases.raise, bank.manage, tax.bas, reports.view, audit.view, data.export, assets.manage, payroll.self |
| payroll_admin | Payroll admin | "Employee pay data, pay runs, leave, PAYG, super and payroll reports." | payroll.sensitive, payroll.run, leave.approve, time.approve, people.view, reports.view, audit.view, data.export, payroll.self |
| project_manager | Project manager | "Assigned projects, timesheets, labour and costs. No private payroll details." | projects.manage, time.approve, time.submit, purchases.raise, reports.view, payroll.self |
| supervisor | Supervisor | "Approves their team's timesheets and leave." | time.approve, leave.approve, competency.team, time.submit, payroll.self |
| accountant | Accountant / auditor | "Reads the ledger, reports and audit log; prepares adjusting journals." | ledger.journal, reports.view, audit.view, data.export, tax.review, tax.bas |

Note: no role includes `payroll.approve` except Director; Payroll admin cannot approve pay runs.

### 6.2 Permission catalogue (app_permissions: key → display name — area — MFA — admin default)
Portal area (no MFA unless noted): `training.manage` Training administration; `people.view` View the people register; `people.manage` Manage the people register; `hr.manage` HR onboarding and records; `competency.all` Competency matrix: everyone; `competency.team` Competency matrix: own team; `access.manage` Sign-in and access (**MFA**; "Create logins, issue temporary passwords, disable sign-in and set permissions and document groups.").

| Key | Display name | Area | MFA | Admin default | Description |
|---|---|---|---|---|---|
| org.manage | Company settings | Accounts | yes | yes | Edit company details, tax settings, numbering and integrations; request bank account changes. |
| ledger.manage | Chart of accounts and tax codes | Accounts | yes | yes | Create and edit accounts, tax codes and posting rules. |
| ledger.journal | Create journals | Accounts | yes | yes | Prepare manual and adjusting journals. |
| ledger.post | Approve and post journals | Accounts | yes | yes | Approve and post journals to the general ledger. |
| ledger.reopen | Reopen closed periods | Accounts | yes | yes | Reopen a closed accounting period. Every reopen is logged. |
| sales.manage | Sales | Accounts | yes | yes | Customers, quotes, invoices, credit notes and receipts. |
| purchases.manage | Purchases | Accounts | yes | yes | Suppliers, purchase orders, bills and supplier payments. |
| purchases.raise | Raise purchase orders | Accounts | no | yes | Create purchase orders and record goods received; someone with Purchases approves them. |
| purchases.bank | Approve supplier bank changes | Accounts | yes | yes | Approve changes to supplier bank details. |
| bank.manage | Banking | Accounts | yes | yes | Bank accounts, payments, imports and reconciliation; approve company bank accounts. |
| projects.manage | Projects and job costing | Accounts | no | yes | Projects, budgets, cost codes and job costing. |
| time.approve | Approve timesheets | Accounts | no | yes | Approve timesheets for the people and projects you manage. |
| time.submit | Enter my timesheets | Accounts | no | yes | Record your own hours against projects and submit them for approval. |
| leave.approve | Approve leave | Accounts | no | yes | Approve leave requests for the people you manage. |
| payroll.sensitive | Payroll: pay, tax and bank details | Payroll | yes | **no** | See and edit employees' pay rates, TFNs, bank and super details. Not given to system administrators automatically. |
| payroll.run | Prepare pay runs | Payroll | yes | yes | Prepare and calculate pay runs. |
| assets.manage | Fixed assets | Accounts | yes | yes | Keep the asset register, run depreciation and record disposals. |
| payroll.approve | Approve pay runs | Payroll | yes | yes | Approve and finalise pay runs. |
| payroll.self | My pay | Payroll | no | **no** | See your own payslips and leave balances, and request leave. |
| tax.bas | BAS and tax reporting | Accounts | yes | yes | Prepare BAS workpapers and tax reports. |
| tax.review | Review BAS | Accounts | yes | yes | Review a BAS workpaper someone else prepared before it is lodged. |
| reports.view | Financial reports | Accounts | no | yes | View financial reports and dashboards. |
| audit.view | Audit log | Accounts | yes | yes | View the audit log. |
| data.export | Export data | Accounts | yes | yes | Export reports and records. Every export is logged. |

### 6.3 How effective permissions are worked out (SQL `app_permissions_for`)
Position defaults (employee status active/on_leave/applicant) ∪ assigned roles ∪ (system admin → all `admin_default` keys), minus personal "deny", plus personal "allow". Inactive sign-in → no permissions. Position defaults and personal allow/deny are set only in the portal (Admin › People), not in Accounts.

### 6.4 Creating / disabling users — only in the portal admin (admin-api), not in Accounts
- Accounts has **no** create, invite, disable, reset-password or MFA-reset function. Users and roles only assigns roles to existing sign-ins.
- Portal Admin › People › person › `Sign-in and access` (training/admin/people.js):
  - `Email an invitation link` (admin-api `account_create` mode invite; perm `access.manage` or `hr.manage`) — message "Invitation emailed to <email>."
  - `Create temporary password` (only with `access.manage`) — shown once; message "Sign-in created." (or "Linked to their existing sign-in."). Error without permission: "Issuing temporary passwords needs the Sign-in and access permission."
  - Status chips: `Sign-in disabled` / `Must change temporary password` / `Active`.
  - `Issue new temporary password` — confirm "Issue a new temporary password for <name>? Their current password stops working." (`account_reset_password`, `access.manage`; audited `temporary_password_issued`).
  - `Disable sign-in` / `Enable sign-in` — confirm on disable "Disable <name>'s sign-in? They are signed out of everything and their records are kept." (`account_set_active`, `access.manage`; also bans the Supabase login; SQL "You cannot disable your own sign-in."; audited `sign_in_disabled`/`sign_in_enabled`).
  - Personal permission allow/deny/default (`permission_set`; SQL "You cannot remove your own access management."; audited `person_permission_set`) and position permissions (`position_permission_set`; audited `position_permission_added/removed`).
- Verification required: docs/PAYROLL.md says to give `payroll.self` "to every employee in Users and roles, by position", but Users and roles in Accounts only assigns roles; position defaults are set in the portal.

---

## 7. Approvals (`#/approvals`, menu `Approvals`, everyone; APIs `approvals_list`, `approval_decide`, `approval_cancel`, perm none at API, checked in SQL)

- Header eyebrow `ADMINISTRATION`, heading `Approvals`. Intro: "Some changes need a second person: you can never approve your own request. Every decision is recorded with the previous and new values."
- Sections: `Waiting for you (<n>)` (empty: `Nothing waiting for you.`); `Your requests` (empty: `You have not requested anything.`; last 50); `Recent decisions` (only with `audit.view`; last 50 decided; hidden if none).
- Card: title; "Requested by <name> · <date time>" and, if decided, " · <approved/rejected/cancelled> by <name> <date time>"; status chip; "Comment: <text>".
- Status: `pending` → `Waiting`; `approved` → `Approved`; `rejected` → `Rejected`; `cancelled` → `Cancelled`. Transitions: pending → approved / rejected (decider) / cancelled (requester). Decided requests are final.

### 7.1 Approval kinds
| Kind | Raised by (perm) | Title | Decided by (perm) | Effect on approve | Effect on reject/cancel |
|---|---|---|---|---|---|
| company_bank_account | Company settings › Banking `Send for approval` (`org.manage`) | "New company bank account: <name> (BSB xxx-xxx)" | `bank.manage` | account → Active (and becomes the invoice account if flagged) | account → Rejected |
| supplier_bank | Supplier bank change (`purchases.manage`) | "Bank details for supplier <name>" | `purchases.bank` | supplier bank details replaced | nothing changes |
| employee_bank | Employee bank change (`payroll.sensitive`) | "Bank details for <employee name>" | `payroll.approve` | employee's pay bank details replaced | nothing changes |
- Only one pending request per kind per record (unique index). Supplier: "A bank change for this supplier is already waiting for approval."
- Details shown to the decider:
  - Company bank account: `Name`, `Account name`, `BSB`, `Account number`, `Used for` (+ "· shown on invoices"); note "Before approving, confirm these details with the bank or the requester by phone, using a number you already know. Never approve from an email request alone."
  - Supplier bank: `Account name`, `BSB`, `Account number`, `Replaces` (old BSB · number, or "No bank details on file"); note "Changed supplier bank details are the most common way businesses are defrauded. Phone the supplier on a number you already have (not one from the request or an email) and confirm the BSB and account number before approving."
  - Employee bank: **no details panel is rendered** in approvals.js (only title) — Verification required (may be shown on the employee screen instead).
- Full account numbers only to the person who can decide and the requester; others see masked. Audit log stores masked bank values.

### 7.2 Buttons and dialogs
- `Approve` → prompt "Approve this change? Add a note for the record (for example, how you checked it):" (note optional) → flash `Approved.`
- `Reject` → prompt "Reject this change? Give a reason; the requester will see it:" → flash `Rejected.`; SQL requires ≥3 characters: "Give a reason for rejecting it."
- `Cancel request` (own pending, no confirm) → flash `Request cancelled.`
- SQL errors: "Approval not found."; "This has already been decided."; "Someone else must approve a change you requested."; "Someone else must approve a change to your own bank details." (employee_bank where you are the employee); missing permission → "You need the "<name>" permission for this."
- Notifications: on request, every holder of the required permission except the requester gets "Approval needed: <title>" (body "Requested by <name>", link approvals). On decision the requester gets "Approved: <title>" or "Rejected: <title>" with the comment.
- Audit events: `approval_requested`, `approval_approved`, `approval_rejected`, `approval_cancelled`.
- Verification required: an employee_bank request about yourself still appears under "Waiting for you" if you hold `payroll.approve` (list does not filter it), but approving is refused by SQL.

---

## 8. Integrations (`#/integrations`, menu `Integrations`, everyone; API `company_get`)
- Header eyebrow `ADMINISTRATION`, heading `Integrations`, intro "What Panalo Accounts connects to, and what it deliberately does not do yet."
- Read-only table `Connection` / `Status` / `Details` (no buttons):
| Connection | Status chip | Details (exact) |
|---|---|---|
| Single Touch Payroll (ATO) | `Export only` | "Panalo Accounts will prepare and validate STP Phase 2 data from Phase 5. Sending it to the ATO needs an ATO-registered Sending Service Provider; transmission stays switched off until that arrangement exists." |
| Super contributions (Payday Super) | `Provider named` if a clearing house is set, else `Not set` | "[Clearing house: <name>. ]Contributions will be calculated and exported per pay run; the clearing house sends money and data to funds on the same day." |
| Bank payments (ABA files) | `Live` if any active company bank account has an APCA user ID, else `Not set` | "Pay runs and supplier payment batches produce ABA files to upload to your bank. Add the APCA user ID, bank code and user name in Banking › Bank accounts." |
| Bank statements | `Live` | "CSV, OFX/QFX and QIF import with matching suggestions and rules. A paid bank feed is optional later." |
| Email | `Portal email` | "Emails currently use Supabase's built-in sender, which only reaches Panalo's Supabase team. Connect Panalo's own mail (Microsoft 365, Google Workspace or a sending service) in Supabase before invoices or payslip notices go out." |
| ABN Lookup | `Phase 3` | "Supplier ABNs will be checked when suppliers and bills are entered; ABN check digits are already validated." |
- Nothing here is a live outside connection: STP sending is locked off (docs/SECURITY.md); ABA and statements are file upload/download only. Texts "from Phase 5" and `Phase 3` are stale versus the dashboard's "Live" phases (Verification required whether ABN Lookup was ever built — no code found).

---

## 9. Audit log (`#/audit`, menu `Audit log`, perm `audit.view`; API `audit_list`, perm `audit.view`, MFA)
- Header eyebrow `ADMINISTRATION`, heading `Audit log`, intro "Every change across the portal and Panalo Accounts. Records can't be edited or deleted, by anyone."
- Filters (button `Filter`): `Area` — Everything / Company settings / Company bank accounts / Approvals / Roles / Numbering / Audit log views (only these foundation types are offered; other record types appear under Everything); `Event contains` (placeholder `e.g. approved`, partial match); `From`, `To` (dates).
- Columns: `When` (date time), `Who` (person or `System`; "about <person>" for the subject), `Event` (code, e.g. `company_settings_saved`), `Record` (entity type + first 8 characters of id), `Change` (field: ~~old~~ → new; values over 80 characters cut with `…`; or details JSON). Empty: `No events match.`
- 50 per page, newest first; pager `Newer` / `Older`, "Page X of Y" (max page 500).
- Each load of the audit log writes an `audit_log_viewed` event (with page and filters).
- Append-only: SQL trigger refuses changes/deletes ("Audit records cannot be changed." / "Audit records cannot be deleted.").
- Event names in this area: `company_settings_saved`, `company_logo_changed`, `company_setup_completed`, `number_sequence_saved`, `company_bank_account_retired`, `approval_requested/approved/rejected/cancelled`, `role_granted`, `role_removed`, `audit_log_viewed`, `leave_requested`, `leave_approved/rejected/cancelled`, `document_archived`, `document_pdf_generated`, `payslip_generated`; portal: `login_created_with_temporary_password`, `temporary_password_issued`, `password_changed`, `sign_in_enabled`, `sign_in_disabled`, `sign_in_invitation_sent`, `sign_in_linked_to_register`, `person_permission_set`, `position_permission_added/removed`, plus training/HR events.
- Error: "The audit log could not be loaded."

---

## 10. My pay (`#/my-pay`, menu `My pay`, perm `payroll.self`; APIs `my_pay`, `my_payslip`, `leave_request`, `leave_decide`)
- If the user isn't linked to an employee: header `MY PAY` / `My pay` and the message "You aren't set up in payroll yet. Ask the payroll officer." (API).
- Header eyebrow `MY PAY`, heading = employee name, intro "Your payslips, leave balances and leave requests."
- Leave balance cards: one per active leave type that accrues or has a balance: "<hours> h", "≈ <days> days of 7.6 hours".
- `Payslips` table: `Paid`, `Period` ("<start> to <end>"), `Gross`, `Tax`, `Net` (bold), `Download` link → PDF `Payslip-<date>.pdf` (audited `payslip_generated`). Only pay runs with status approved or paid. Empty: `No payslips yet.`
- `Request leave` form: `Type` (active leave types; casual employees only see unpaid types), `First day` (default today), `Last day` (default today), `Hours` (hint "A full day is usually 7.6 hours"), `Note (optional)` (max 500). Button `Send request` → flash "Sent. You'll get a notification when it's decided." Approvers (`leave.approve`, except requester) are notified "Leave to approve: <name>" / "<type>, DD Mon to DD Mon (<h> h)".
- SQL errors: "You're not set up in payroll yet."; "Choose a type of leave."; "Choose the first and last day of leave."; "A leave request can cover at most a year."; "Enter the hours of leave."; "Casual employees don't get paid leave of this type."; date format: "The first day must be a date." / "The last day must be a date." (API).
- `My requests` table (last 30): type, dates, "<h> h", status chip + decision comment, `Cancel` link (for Waiting or Approved). Confirm "Cancel this leave request?" → flash `Cancelled.` SQL: "This request can't be cancelled now."; "This leave is in a pay run waiting for approval. Ask payroll to send the pay run back first."
- Leave status: `submitted` → `Waiting`; `approved` → `Approved`; `rejected` → `Declined`; `cancelled` → `Cancelled`; `paid` → `Taken and paid`. Transitions: submitted → approved/rejected (approver, not the employee) or cancelled (employee or approver); approved → cancelled (unless in a non-draft pay run) or paid (via pay run).
- Employee is notified "Leave approved: …" / "Leave declined: …" / "Leave cancelled: …" (link my-pay) when someone else decides.
- Approved leave is paid and deducted in the next pay run (Leave screen intro).

---

## 11. Segregation-of-duties rules (this area)
- Nobody changes their own roles (UI disabled + SQL).
- Nobody disables their own sign-in or removes their own `access.manage` (portal, SQL).
- Nobody decides an approval they requested (DB check `decided_by <> requested_by` + SQL).
- Nobody approves a change to their own bank details (employee_bank).
- Company bank account: requested with `org.manage`, approved by a different person with `bank.manage`.
- Supplier bank change: requested with `purchases.manage`, approved by another person with `purchases.bank`.
- Employee bank change: requested with `payroll.sensitive`, approved by another person with `payroll.approve`.
- Leave: you can't approve/decline your own leave ("Someone else must approve your own leave."); if you recorded leave for someone else, a third person must decide ("You recorded this leave, so someone else must approve it."); declining needs a reason ≥3 characters ("Give a reason for declining it.").
- System admins don't automatically get `payroll.sensitive` (or `payroll.self`).
- MFA for every holder of a sensitive key.

## 12. High-risk actions (this area)
- Adding/approving a company bank account (payment redirection) — four-eyes, phone-check note.
- Approving supplier/employee bank changes.
- Retiring a company bank account (single person, reason required, audited).
- Assigning roles, especially Super admin / Director / Payroll admin (immediate effect at next page load; audited).
- Portal: issuing temporary passwords, enabling/disabling sign-in, personal allow/deny overrides.
- Changing tax settings (GST basis, BAS frequency, FY start) and document numbering (cannot go backwards).
- Viewing the audit log is itself logged.

## 13. Present in code but not reachable / inconsistencies (Verification required)
- `renderPlanned` and menu `Phase N` tags: no menu item has a phase, so never shown.
- `notifications_read` supports marking specific ids, but UI only offers `Mark all read`; clicking a notification does not mark it read.
- Integrations texts reference "from Phase 5" and `Phase 3` (ABN Lookup) — no ABN Lookup code found.
- Workers comp "Expiry dates trigger reminders in a later phase" — no reminder code found.
- Numbering rows `project`, `payment_batch`, `asset` show raw keys (no friendly label).
- Employee bank approval shows no details panel in Approvals.
- Dashboard "Leave to approve" includes your own requests; the menu badge excludes them.
- No in-app MFA reset; done in the Supabase dashboard.
- Sign-in expiry mid-session shows `Something went wrong` rather than the Sign in gate.
- `Finish setup` stays clickable as `Saved` after completion; clicking it again re-audits `company_setup_completed` (setup date unchanged).
- `exports`: `data.export` permission exists; not used by any admin screen in this area.
