# Panalo Accounts: Access, Shell and Administration (investigation 1)

Source of truth: repo /home/claude/jaysonsugpatanjs-hub.github.io at the time of reading (no files modified).
Key files: accounts/app.js, accounts/index.html, accounts/views/{dashboard,company,users,approvals,integrations,audit,planned}.js, accounts/lib/{ui,docs,validate}.js, training/{auth.js,app.js,index.html,config.js}, supabase/functions/finance-api/{index,docs}.ts (+ module files), supabase/functions/_shared/{http,accounts}.ts, supabase/migrations/20261002..20261015, supabase/tests/db/*.test.sql, docs/SECURITY.md.

Conventions in this file: "quoted text" is exact UI text. Dates display in en-AU, Australia/Sydney time (e.g. "8 Oct 2026", "8 Oct 2026, 3:45 pm"). Money displays "1,234.50"; negatives in brackets "(1,234.50)". The app is a dark theme (black/charcoal, Panalo gold #f5b400 accents).

---------------------------------------------------------------------------------------------------

## 1. Reaching the app, sign-in, MFA, session

### 1.1 URL and where sign-in happens
- App URL: `https://jaysonsugpatanjs-hub.github.io/accounts/` (relative `/accounts/`). Browser tab title: "Panalo Accounts". Page has `noindex`. Screens are hash routes `/accounts/#/dashboard`, `#/company`, etc.
- There is NO password form on the Accounts page. Sign-in is on the Panalo portal: `/training/` (title "Panalo Pipes Training Portal"). Accounts and the portal share one session (same origin; stored in browser localStorage key `panalo-training-session-v1`; Supabase access token + refresh token).
- Typical path: open /accounts/ -> gate "Sign in to Panalo Accounts" -> click "Sign in" -> goes to `../training/?next=/accounts/` -> portal sign-in form -> after a successful sign-in the portal immediately redirects back to /accounts/ (only `next` values beginning `/accounts/` or `/training/` are honoured). If already signed in at the portal, opening `/training/?next=/accounts/` redirects straight away.
- Portal also has link "Portal" in the Accounts header (to `../training/`) which shows the training dashboard (with an "Administration" header link for people with admin access, and "IMS documents").

### 1.2 Portal sign-in screen (shared; exact text)
- Eyebrow "SIGN IN"; heading "Sign in to the Panalo portal"; intro "Use the email address Panalo invited and your password. If you were given a temporary password, you'll choose your own straight after signing in."
- Fields: "Email address" (placeholder name@example.com), "Password". Buttons: "Sign in" (primary), "Forgot password?" (text button).
- Forgot-password form: field "Email address"; buttons "Email me a reset link" and "Back to sign in". Success message (always, whether or not the account exists): "If that email has a Panalo account, a reset link is on its way. It works once and expires soon."
- Footer note: "Access is limited to people invited by Panalo. Your email, training activity, results and any documents you upload are kept for training and HR administration."
- Messages: "Signing in…" while working; wrong credentials: "That email and password don't match. Check them, or use Forgot password."; blank password "Enter your password."; bad email "Enter a valid email address."; rate limit on reset "Too many requests. Wait a minute and try again."; not configured "The secure training service has not been connected yet."
- Portal "Choose your password" panel (shown for invite link, reset link, or temporary password): eyebrow "YOUR PASSWORD"; heading changes: invite = "Welcome to Panalo" / "Choose the password you'll use to sign in from now on."; recovery = "Reset your password" / "Choose a new password. It replaces your old one straight away."; temporary = "Choose your own password" / "You signed in with a temporary password. Choose your own to continue." Rules list: "At least 12 characters", "A mix of at least three: lower-case, capitals, numbers, symbols", "Not a common password, and not your email name". Fields "New password", "Type it again"; button "Save password". Errors: "The two passwords don't match."; server: "Use at least 12 characters.", "Use 128 characters or fewer.", "Don't start or end the password with a space.", "Mix at least three of: lower-case letters, capitals, numbers and symbols.", "That password is too common. Choose something harder to guess.", "Don't include your email name in the password.", "Avoid repeating the same character four or more times.", "That password could not be set. Try a different one."

### 1.3 Temporary password rule (password_change_required)
- Administrators create a login with a temporary password (Portal > Administration > People > Sign-in and access: "Create temporary password", "Issue new temporary password"; also "Email an invitation link"). That sets `must_change_password`.
- When such a user opens /accounts/ the API answers 403 code `password_change_required` ("Change your temporary password on the portal first."). The app shows gate:
  - Title: "Change your temporary password first"
  - Body: "You signed in with a temporary password. Choose your own on the portal, then come back."
  - Button: "Open the portal" (-> `../training/`; no `next`, so the user must re-open /accounts/ after saving the new password).
- On the portal the same user sees the "Choose your own password" panel before anything else.

### 1.4 Gate screens in accounts/app.js (all exact)
The gate is a centred card: eyebrow "PANALO ACCOUNTS", H1 title, body. While a gate shows, the top bar (bell, name, Portal, Sign out) and left menu are hidden. NOTE: gates have no Sign out button.
| Situation | Gate title | Body / buttons |
|---|---|---|
| First paint, before checks finish | "Checking your access…" | empty body (loading state) |
| Config missing (`supabaseUrl`/`publishableKey` not valid) | "Not connected yet" | "The secure service has not been configured." |
| No stored session, or session refresh failed, or API returns 401 | "Sign in to Panalo Accounts" | "Sign in on the Panalo portal with your email and password, then you'll come straight back here." + button "Sign in" (primary) |
| Temporary password | "Change your temporary password first" | see 1.3, button "Open the portal" |
| No finance permission (API code `no_access`) | "No access to Panalo Accounts" | shows the server text: "Your account doesn't include Panalo Accounts. Ask an administrator if you need it." + button "Back to the portal" |
| Any other failure at start (e.g. 403 "This account is not active.", 500, network) | "Panalo Accounts is unavailable" | red message from friendlyError (see section 8) |
| MFA, factor already enrolled | "Confirm it's you" | see 1.5 |
| MFA, no factor yet | "Set up two-step sign-in" | see 1.5 |
- Inside the app (after the gate) while a screen loads: the content area shows "Loading…" (muted). If a screen fails: panel with H1 "Something went wrong" and red message (friendlyError text). If the failure is `mfa_required` the MFA gate shows instead.
- Who gets "No access": anyone who holds no permission from the finance set. Definition (finance-api index.ts): any permission whose area is not "Portal", plus `access.manage`. Portal-only permissions (training.manage, people.view, people.manage, hr.manage, competency.all, competency.team) do NOT qualify. `payroll.self` (area Payroll) DOES qualify, so ordinary employees with "My pay" get in (to a very small menu).

### 1.5 MFA (two-step sign-in with an authenticator app)
- MFA is required (checked on the server on every action) if the user holds ANY permission marked requires_mfa (list in section 6). Required session level is `aal2` (password + authenticator code). Portal sign-in itself is password only (aal1); MFA is requested only inside Accounts. Users who hold only non-MFA permissions (e.g. Project manager, Supervisor, payroll.self only) are never asked.
- whoami returns `mfa: {required, aal, satisfied}`. If required and not satisfied -> MFA gate. Any other API action returns 403 code `mfa_required`: "Confirm your sign-in with your authenticator app to continue."
- First time (no verified TOTP factor): gate "Set up two-step sign-in":
  - Intro: "Your access includes company finances, so Panalo Accounts needs a second step at sign-in. This is required for administrators, directors, finance and payroll staff."
  - Numbered steps: 1 "Install an authenticator app on your phone, such as Microsoft Authenticator or Google Authenticator." 2 "In the app, add an account and scan this code." (QR image, alt "QR code for your authenticator app", 180x180) and "Can't scan? Enter this key instead:" followed by the secret key (monospace gold `code.secret`). 3 "Type the 6-digit code the app shows."
  - Field label "6-digit code" (`#mfa-code`, numeric, one-time-code autocomplete, max length 7 so a space "123 456" is accepted); button "Turn on two-step sign-in".
  - Behind the scenes: any earlier abandoned (unverified) factor is deleted and a new one named "Panalo Accounts" is created every time the gate is shown, so a refresh gives a NEW QR code/secret; scan the latest one.
- Subsequent sign-ins (verified factor exists): gate "Confirm it's you":
  - "Your access includes company finances, so Panalo Accounts asks for the 6-digit code from your authenticator app each time you sign in."
  - Field "6-digit code"; button "Verify"; footer "Lost your phone? Ask a Panalo administrator to reset your authenticator."
  - Reset procedure (docs/SECURITY.md): there is NO button in the app or portal. An administrator removes the factor in the Supabase dashboard (Authentication > Users > the user > MFA factors); the user then sees "Set up two-step sign-in" again at next visit.
- Status/error text under the form (`[data-mfa-msg]`): "Checking…" while verifying; "Enter the 6-digit code from your authenticator app." (not 6 digits); "That code didn't work. Codes change every 30 seconds; try the current one." (wrong/expired code). On success the page continues straight into the dashboard.

### 1.6 Session expiry and sign-out
- Access tokens last as set by Supabase (default 1 hour); the app refreshes automatically when within 60 seconds of expiry and retries once after a 401. Refresh tokens keep users signed in across visits. There is no idle-timeout in the app code.
- If the refresh fails or the session is gone at page load: gate "Sign in to Panalo Accounts" (section 1.4). If it expires while a screen is open, actions show red message "Your sign-in has expired. Please sign in again." (no automatic redirect; reload the page to reach the sign-in gate).
- Sign out: header button "Sign out" -> ends the session at Supabase and clears local storage, then goes to the portal (`../training/`), which shows its sign-in form. This signs the person out of the portal as well (shared session). The aal2 status ends with the session; next sign-in requires the authenticator code again ("each time you sign in").
- Disabled login: Portal "Disable sign-in" signs the person out everywhere (portal dialog text: "Disable <name>'s sign-in? They are signed out of everything and their records are kept."). Server also refuses an inactive profile: 403 "This account is not active." -> gate "Panalo Accounts is unavailable".

---------------------------------------------------------------------------------------------------

## 2. App shell

### 2.1 Header (always black bar with gold underline; sticky)
- Left: brand link (to `#/dashboard`): gold square "P", bold "PANALO ACCOUNTS", small gold line = company name (`[data-org]`) from the organisation record ("Panalo Pipes & Structurals Pty Ltd"; fallback "Panalo Pipes & Structurals").
- Right (`[data-top]`, only after a successful start): bell button (aria-label "Notifications"), user's name (`[data-who]`: full name, or email if no name), link "Portal", button "Sign out".
- Bell behaviour: gold round count badge (`[data-bell-count]`) shows the number of unread notifications, hidden when 0. Clicking the bell toggles a dropdown panel (`[data-notes]`, role dialog "Notifications"): header "Notifications" and, only if unread > 0, a link-button "Mark all read"; list of up to the latest 50 notifications, unread ones in bold; each shows a link (title) + small text "<body> · <date time>" (body omitted if empty). Empty state: "Nothing yet."
  - Clicking a notification title navigates to its screen (`#/<link>`, falls back to dashboard) and closes the panel. It does NOT mark that one read. "Mark all read" marks all unread read and refreshes the badge. Clicking outside, or changing screen, closes the panel.
  - The badge/list/menu counts load once when the app starts and after actions that call refreshCounts (approving/rejecting/cancelling an approval, requesting a bank account, finishing company setup, etc.); there is no polling, so reload to see new notifications.
  - Notification examples (title text): "Approval needed: <title>" (link approvals), "Approved: <title>"/"Rejected: <title>" (approvals), "Timesheet to approve: <name>" (timesheets/review), "Timesheet approved: week of 06 Oct"/"Timesheet sent back: …"/"Timesheet reopened: …" (timesheets), "Leave to approve: <name>" (leave), "Leave approved/declined: 06 Oct to 08 Oct" (my-pay), "Pay run to approve: PR-00001" (pay-runs), "Pay run sent back: …", "Pay run approved: …" (pay-runs), "Payment batch to approve: PB-0001" / "Payment batch approved: …" (payment-batches), "BAS reviewed: Jul 2026 to Sep 2026" (bas). Requesters never get notified about their own request; holders of the required permission (except the requester) do.
- If loading counts/notifications fails, it is silently ignored (bell and badges simply stay blank).

### 2.2 Left menu (`nav[aria-label="Panalo Accounts"]`, 236 px column) - exact MENU from app.js
Rules: an item shows only if the user passes `perm` (must hold that key) AND `any` (must hold at least one of the list), when set. Groups with no visible items are hidden. Active item: gold text with gold left bar. Count badge: gold pill with number, shown only if > 0.

Permission sets used: LEDGER = reports.view, ledger.manage, ledger.journal, ledger.post, audit.view. SALES = sales.manage, bank.manage, reports.view. PURCHASES = purchases.manage, purchases.raise, bank.manage, reports.view. RUNS = payroll.run, payroll.approve, payroll.sensitive.

| Group (heading) | Item label | route | Visible when | Count badge |
|---|---|---|---|---|
| (no heading) | Dashboard | #/dashboard | everyone | none |
| (no heading) | My pay | #/my-pay | perm payroll.self | none |
| Sales | Customers | #/customers | any SALES | none |
| Sales | Quotes | #/quotes | any SALES | |
| Sales | Invoices | #/invoices | any SALES | |
| Sales | Payments received | #/receipts | any SALES | |
| Purchases | Suppliers | #/suppliers | any PURCHASES | |
| Purchases | Purchase orders | #/purchase-orders | any PURCHASES | |
| Purchases | Bills | #/bills | purchases.manage, bank.manage, reports.view | |
| Purchases | Supplier payments | #/supplier-payments | purchases.manage, bank.manage, reports.view | |
| Projects | Projects | #/projects | projects.manage, reports.view | |
| Projects | Job costing | #/job-costing | projects.manage, reports.view | |
| Projects | Timesheets | #/timesheets | time.submit, time.approve, projects.manage, payroll.run | timesheets (needs time.approve): submitted timesheets that are not the user's own |
| Payroll | Employees | #/employees | payroll.sensitive, payroll.run, payroll.approve, leave.approve | |
| Payroll | Pay runs | #/pay-runs | any RUNS | payRuns (needs payroll.approve): pay runs with status "submitted" |
| Payroll | Leave | #/leave | leave.approve, payroll.sensitive, payroll.run | leave (needs leave.approve): submitted leave requests that are not the user's own |
| Payroll | Super | #/super | any RUNS | |
| Payroll | STP | #/stp | any RUNS | |
| Payroll | Payroll reports | #/payroll-reports | any RUNS | |
| Accounting | Reports | #/reports | any LEDGER | |
| Accounting | Journals | #/journals | any LEDGER | |
| Accounting | Chart of accounts | #/chart-of-accounts | any LEDGER | |
| Accounting | Tax codes | #/tax-codes | any LEDGER | |
| Accounting | Periods | #/periods | any LEDGER | |
| Accounting | Fixed assets | #/assets | assets.manage, reports.view | |
| Tax | BAS | #/bas | tax.bas, tax.review | bas: (tax.review ? BAS drafts prepared by someone else : 0) + (tax.bas ? BAS reviewed and waiting to lodge : 0) |
| Tax | TPAR | #/tpar | tax.bas, tax.review | |
| Banking | Bank accounts | #/bank-accounts | bank.manage, reports.view | |
| Banking | Reconciliation | #/reconciliation | bank.manage, reports.view | bankLines (needs bank.manage): bank lines with status "new" (not yet matched) |
| Banking | Payment batches | #/payment-batches | perm bank.manage | batches: draft payment batches created by someone else |
| Banking | Bank rules | #/bank-rules | perm bank.manage | |
| Administration | Company settings | #/company | everyone (read-only unless org.manage) | |
| Administration | Users and roles | #/users | perm access.manage | |
| Administration | Approvals | #/approvals | everyone | approvals: items "Waiting for you" (pending, not requested by you, you hold the required permission) |
| Administration | Integrations | #/integrations | everyone | |
| Administration | Audit log | #/audit | perm audit.view | |
- Missing permission behaviour: the item simply does not appear. Typing a route the user may not use (or an unknown route) silently redirects to `#/dashboard` (no error). The server re-checks every action regardless; a forbidden call returns "Your access doesn't include this area. Ask an administrator if you need it."
- Menu items with `phase` tags ("Phase N" pill, greyed) and the "Arrives in Phase N" placeholder page (`planned.js`) exist in code but NO current menu item uses them (all phases built). See "Surprises".
- Visibility for the test users (computed from MENU against the permission sets in section 6):
  - sysadmin@fin.test (system admin): Dashboard; every group; all four Administration items (Company settings, Users and roles, Approvals, Integrations, Audit log); NOT "My pay".
  - finance@fin.test (Finance admin): Dashboard, My pay; Sales; Purchases; Projects (Projects, Job costing; no Timesheets); Accounting (all six); Tax; Banking (all four); Administration (Company settings, Approvals, Integrations, Audit log; no Users and roles). No Payroll group.
  - director@fin.test (Director / owner): like finance plus Payroll (Employees, Pay runs, Super, STP, Payroll reports; no Leave); no Timesheets; Administration without Users and roles.
  - payroll@fin.test (Payroll admin): Dashboard, My pay; Sales, Purchases, Projects (incl. Timesheets), Payroll (all six), Accounting (all six) because of reports.view; Banking (Bank accounts, Reconciliation only); no Tax; Administration (Company settings, Approvals, Integrations, Audit log).
  - pm@fin.test (Project manager): Dashboard, My pay, Sales/Purchases/Accounting/Banking read-only entries (via reports.view), Projects incl. Timesheets; Administration (Company settings, Approvals, Integrations).
  - staff@fin.test: holds no permission in the test fixtures -> sees the "No access to Panalo Accounts" gate, not the app.
  - office@fin.test (payroll.self only): Dashboard, My pay, Company settings, Approvals, Integrations.
  - tradie@fin.test (time.submit + payroll.self): Dashboard, My pay, Projects > Timesheets, Company settings, Approvals, Integrations.

### 2.3 Main area
- Status line `#app-msg` (aria-live) sits above each screen; cleared on every navigation; screens use their own `[data-msg]` line under their content ("flash" messages, green for good, red for bad).
- Navigating changes `#/route`; the content area is rebuilt each time and focus moves to the main region.
- Deep links: `#/invoices/<id>`, `#/reports?type=pl`, `#/company?step=3` (company wizard step number 1-8).

---------------------------------------------------------------------------------------------------

## 3. Dashboard (`#/dashboard`)

API: finance-api action `dashboard` (no permission needed; each block is only returned if the user holds the relevant permission, otherwise it is null and the cards are not drawn). Computed server-side as at today (Sydney date).

Header: eyebrow "DASHBOARD"; H1 = trading name, else legal name, else "Panalo Accounts" (seed: "Panalo Pipes"); subline = legal name + " · ABN 51 824 753 556" format; company logo (alt "Company logo") at the right if one is uploaded. Gold border (`.card.attention`) = something needs doing.

Rows of cards (in this order; each row appears only if its data block exists):

Row A "ledger" (permission reports.view):
1. "Bank" - sum of all ledger accounts of subtype bank in the balance sheet as at today. Sub-text "Bank accounts in the ledger, as at <date>". Link "Transactions" -> #/reports?type=account.
2. "Net profit this financial year" - current-year earnings from the balance sheet (income less costs since the financial year start). Sub-text "From <FY start date>". Link "Profit and loss" -> #/reports?type=pl.
3. "GST owed (estimate)" - balance of the ledger account(s) of subtype gst. Sub-text "Balance of the GST account; bracketed means a refund is due".
4. "Draft journals" - count of journal entries with status draft (gold border if > 0). Sub-text "Not in the ledger until posted". Link "Review drafts" -> #/journals?status=draft.

Row B "sales/purchases" (sales needs sales.manage, bank.manage or reports.view; purchases needs purchases.manage, purchases.raise, bank.manage or reports.view):
5. "Customers owe" - total of aged receivables (approved invoices outstanding less credits and unapplied receipts). Sub-text "<amount> overdue" (sum of 1-30, 31-60, 61-90, 90+ days past due date buckets) or "Nothing overdue". Link "Aged receivables" -> #/reports?type=ar.
6. "Draft invoices" - count of invoices with status draft. "Not sent or posted until approved". Link "Review" -> #/invoices?view=draft.
7. "Panalo owes suppliers" - aged payables total; "<amount> overdue" or "Nothing overdue". Link "Aged payables" -> #/reports?type=ap.
8. "Waiting on purchasing" - bills with status draft or submitted PLUS purchase orders with status submitted. Sub-text "<n> bill(s) to review · <n> order(s) to approve". Links "Bills" (#/bills?view=draft) · "Orders" (#/purchase-orders).

Row C (bank.manage):
9. "Bank lines to match" - imported bank lines with status new. Link "Reconciliation".
10. "Payment batches to approve" - draft batches created by someone else. Link "Payment batches".

Row D tax (tax.bas or tax.review):
11. "Next BAS" - due date of the earliest BAS in draft/reviewed (not yet lodged); sub-text "<from> to <to>"; otherwise "None in progress". Gold border if the due date is before today. Link "BAS".
12. "BAS to review" - BAS in draft not prepared by you.
13. "To lodge / to pay" - "<reviewed count> / <lodged-awaiting-payment count>".

Row E payroll (cards individually permission-gated; row appears if any):
14. "Pay runs to approve" - runs with status submitted (needs payroll.approve). Link "Pay runs".
15. "Super not yet paid" - total super of approved/paid pay runs not yet marked super paid. "Due within 7 business days of each payday". Link "Super". (needs payroll.run, payroll.approve or payroll.sensitive)
16. "Leave to approve" - submitted leave requests (needs leave.approve). Link "Leave".

Row F projects (projects.manage or time.approve):
17. "Active projects" - projects with status active or on_hold (needs projects.manage). "Active or on hold". Link "Job costing".
18. "Timesheets to approve" - submitted timesheets that are not yours (needs time.approve). "Submitted and waiting for you or another approver". Link "Review" -> #/timesheets/review.

Row G (everyone):
19. "Company setup" - if complete: "Complete" (green) + "Change details any time in Company settings." + button "View settings". If not: "<6 minus missing> of 6" + "Still needed: ABN, business address, email, phone, states you operate in, payroll contact." (only the missing ones) + button "Continue setup" (if user can edit company, i.e. org.manage) or "View settings"; gold border while incomplete.
20. "Approvals waiting for you" - count of pending approvals you can decide. Sub-text: "<n> of your own requests waiting for someone else." (if you have pending requests) else "Changes that need a second person, such as new bank accounts." Button "Open approvals".
21. "Notifications" - unread count and "unread" (no link; use the bell).

Panel "What's being built" (roadmap): intro "Panalo Accounts is delivered in phases, each tested before the next starts. Menu items marked with a phase arrive then." Table columns "Phase", "Module", "Includes", "Status". Rows (status is hard-coded: phases 1-8 = chip "Live", 9 = "Next"):
1 Foundation - Company setup, roles, two-step sign-in, approvals, audit log - Live
2 Accounting core - Chart of accounts, tax codes, journals, posting engine, trial balance, P&L, balance sheet - Live
3 Sales and purchasing - Customers, suppliers, quotes, invoices, purchase orders, bills - Live
4 Projects - Projects, cost codes, timesheets, job costing - Live
5 Payroll - Pay settings, PAYG, super, leave, pay runs, payslips - Live
6 Banking - Bank import, matching, rules, reconciliation - Live
7 BAS - GST and PAYG reconciliation, BAS workpaper, TPAR - Live
8 STP and assets - STP Phase 2 data and exports, fixed assets - Live
9 Hardening - Security review, backups, restore tests, user acceptance - Next
Footer (only with audit.view): "Every change in Panalo Accounts is recorded in the audit log." (link to #/audit).

Suggested actions: gold-bordered cards are to-dos: post/review drafts, approve invoices, review bills/POs, match bank lines, approve payment batches, review/lodge BAS, approve pay runs, pay super, approve leave/timesheets, finish company setup, decide approvals.
What a user with minimal rights sees (e.g. office@fin.test): only row G (Company setup, Approvals waiting for you, Notifications) and the roadmap.

---------------------------------------------------------------------------------------------------

## 4. Administration screens

### 4.1 Company settings (`#/company`, optional `?step=1..8`)
Access: everyone can open (API `company_get` has no permission). Editing needs `org.manage` (Super admin role or system admin). Without it the page shows a "Read only" chip, no step bar, and only the Review summary. Bank account numbers are shown masked ("•••• 678", last 3 digits) and APCA IDs hidden unless the viewer holds org.manage or bank.manage.
Header: eyebrow "ADMINISTRATION", H1 "Company settings"; sub-text before setup completes: "Set up the company once; every invoice, payslip and report uses these details."; after: "Setup completed <date>. Changes save straight away and are recorded in the audit log."
Step bar (8 numbered buttons, `.stepper button[data-step=0..7]`, current one gold): 1 Business, 2 Contact, 3 Tax and reporting, 4 Payroll, 5 Workers comp, 6 Banking, 7 Numbering, 8 Review. Each step saves on its own, so setup can be finished in several sittings. Save buttons read "Save and continue" (goes to next step, green "Saved." line) and "Back" returns. Failed save shows red message and re-enables the button. While saving: "Saving…".

Step 1 Business ("Business details", form `data-form=business`)
- "Legal name" * (hint "As registered with ASIC", `#legal_name`) - error "Enter the legal name." if under 2 chars.
- "Trading name" (`#trading_name`).
- "ABN" * (hint "11 digits. Checked against the ATO check-digit rule.", `#abn`, shown formatted 51 824 753 556) - error "That ABN isn't valid. Check the 11 digits."
- "ACN" (hint "9 digits, for a company", `#acn`) - error "That ACN isn't valid. Check the 9 digits."
- Logo row: current logo image (alt "Current logo") or box "No logo"; button "Upload logo" (file input `[data-logo]`; PNG, JPG, WebP or SVG, max 2 MB; note "PNG, JPG, WebP or SVG, up to 2 MB. Used on invoices, quotes and payslips."). Status "Uploading logo…" then "Logo updated." Logo uploads immediately (separately from the Save button), replaces and archives the previous logo, audit event company_logo_changed. (PDFs only embed PNG/JPG logos; SVG/WebP show on screen only.)
- Server errors: "The logo must be a PNG, JPG, WebP or SVG image.", "The logo must be under 2 MB.", "A secure upload link could not be created.", "The upload failed (<status>). Please try again.", "The upload didn't arrive. Please try again.", "Invalid upload path."

Step 2 Contact ("Contact and addresses")
- "Business address": "Street address", "Suburb", "State" (Choose… ACT NSW NT QLD SA TAS VIC WA), "Postcode" (ids ba_street, ba_suburb, ba_state, ba_postcode).
- Checkbox "Postal address is the same" (`[data-same]`); when unticked, "Postal address" block (pa_*) appears.
- "Phone" * , "Accounts email" * (hint "Shown on invoices; replies come here"), "Website".
- Errors: "Enter the street address.", "A postcode is 4 digits.", "Choose a state.", "Enter a phone number.", "Enter a valid email address."

Step 3 Tax and reporting
- "Registered for GST" (Yes/No), "GST reporting basis" (Accrual (invoice date) / Cash (payment date); hint "Cash basis is only for GST turnover under $10 million"), "BAS lodgement" (Quarterly/Monthly/Annual; hint "Monthly is required at $20 million GST turnover or more"), "Accounting basis" (Accrual/Cash), "Financial year starts" (January-December; default July), "Time zone" (Sydney, Canberra, Melbourne, Hobart / Brisbane / Adelaide / Darwin / Perth).
- Note: "Currency is Australian dollars (AUD). Your accountant should confirm these settings before the first BAS." (Currency fixed AUD.)

Step 4 Payroll ("Payroll and operations")
- Checkboxes legend "States where Panalo employs people or sends workers *": ACT NSW NT QLD SA TAS VIC WA (hint "Drives payroll tax, workers compensation, labour hire licensing and portable long service leave."). Error "Choose at least one state."
- "Pay frequency" (Weekly/Fortnightly/Monthly), "Pay day" (Monday-Friday), "Super clearing house" (hint "The ATO's free clearing house closed on 1 July 2026").
- "Payroll contact": "Name" * , "Email", "Phone". Errors "Enter the payroll contact's name.", "Enter a valid email address."
- Note box: "Single Touch Payroll: export only. Panalo Accounts prepares and checks STP data; a registered provider sends it to the ATO. Super is due at the fund within 7 business days of each payday (Payday Super)."

Step 5 Workers comp ("Workers compensation")
- "One policy for each state where Panalo has workers. Expiry dates trigger reminders in a later phase." (No reminders exist yet.) Table columns "State", "Insurer", "Policy number", "Expires" - one row per state ticked in step 4 (defaults to NSW if none). If no states: "Choose your states in the Payroll step to add more rows."

Step 6 Banking ("Banking and payment terms")
- Mini form: "Default payment terms (days)" (0-120; error "Between 0 and 120 days."), button "Save terms" (stays on the step).
- "Company bank accounts": "A new account stays inactive until someone else with banking permission approves it. This stops a single person (or a fake email) redirecting payments."
- Table columns "Account", "BSB", "Number", "Use", "Status", (actions). Cell shows nickname with small "<account name> · shown on invoices". Use labels: Operating, Payroll, Customer receipts, "Tax (GST/PAYG)", Other. Status chips: "Waiting for approval" (amber), "Active" (green), "Rejected" (red), "Retired" (grey). Empty: "No bank accounts yet." Active accounts show a link-button "Retire" (org.manage only).
- "Retire" opens a browser prompt "Retire this bank account? It stays on record. Give a reason:"; reason needs 3+ characters ("Give a reason for retiring it."); then "Account retired." and the account is no longer shown on invoices. Only active accounts can be retired ("Only an active account can be retired."). Retired accounts cannot be re-activated here.
- "Add a bank account" form: "Name in Panalo Accounts" * (placeholder Main operating), "Account name (as the bank has it)" *, "Used for" (Operating/Payroll/Customer receipts/Tax (GST/PAYG)/Other), "BSB" * (placeholder 062-000), "Account number" *, "APCA user ID (optional)" (hint "6 digits from your bank, for ABA payment files"), checkbox "Show this account on invoices for customers to pay into", button "Send for approval".
  - Client errors: "Give the account a name.", "Enter the account name.", "A BSB is 6 digits, like 062-000.", "An account number is 5 to 10 digits.", "The APCA user ID is 6 digits."
  - Result: account is created with status "Waiting for approval"; an approval request is created (title "New company bank account: <name> (BSB 062-000)", requires bank.manage), everyone else holding bank.manage gets the notification "Approval needed: …"; audit event approval_requested. Success line: "Sent for approval. Someone else with banking permission must approve it before it can be used." No ledger posting. Once approved the account can be linked to a ledger bank account on Banking > Bank accounts (another section).
  - Only one active account can be "shown on invoices": approving a new one that has that tick silently turns the tick off for the previous active one.
- Buttons "Back" and "Continue".

Step 7 Numbering ("Document numbering")
- "Numbers only move forward, so an issued number is never reused." Table columns "Document", "Prefix", "Next number", "Digits", "Next will be", Save. Per row: input Prefix (max 10; saved upper-case, allowed A-Z 0-9 hyphen), Next number (number, cannot be lowered), Digits (1-10), live preview (e.g. "INV-1001"), link-button "Save" (per row; message "<Kind> numbering saved.").
- Defaults: Invoices INV- 1001 (4 digits); Quotes QU- 1001; Purchase orders PO- 1001; Credit notes CN- 1001; Supplier bills BILL- 1001; Journals JE- 1 (6 digits); Pay runs PR- 1 (5 digits).
- Errors: "The next number must be a whole number.", "Digits must be between 1 and 10.", "Numbers can only move forward, so issued numbers are never reused.", "Unknown numbering."
- QUIRK: the database also holds numbering rows for project (JOB- 1001, 4), payment_batch (PB- 1, 4) and asset (FA- 1, 4), but the screen has labels for only the first seven kinds. Those three rows appear at the TOP of the table with the raw lower-case names "project", "payment_batch", "asset" (and "undefined numbering saved." in the success message). They work.

Step 8 Review
- Red-amber/green line: "Still needed before setup is complete: <list>." or "Everything required is in place." or "Setup complete."
- Summary table (read-only): Legal name, Trading name, ABN, ACN, Business address, Postal address, Phone, Email, Website, GST ("Registered, <basis> basis, BAS <frequency>" or "Not registered"), Financial year ("Starts <month>"), Accounting basis, States, Pay cycle ("<frequency>, paid <day>"), Payroll contact, Super clearing house, Workers compensation, Payment terms ("30 days"), Active bank accounts (count).
- Required to finish (checked client and server): ABN, business address (street and postcode), email, phone, at least one state, payroll contact name. Button "Finish setup" (disabled while anything is missing; after completion its label is "Saved"). Server error if something is missing: "Still needed: ABN, phone." Success "Company setup complete." Records setup_completed_at once; audit event company_setup_completed; dashboard card turns to "Complete".
- Server error texts for company_save: "Unknown setting: <name>", "Nothing to save.", "Enter the company's legal name.", "A postcode is 4 digits.", "Choose a state.", "That ABN is not valid. Check the 11 digits.", "That ACN is not valid. Check the 9 digits.", "One of the values is outside what is allowed." (database check, e.g. invalid enumerated value), "You need the "Company settings" permission for this." (user lacks org.manage; also API-level "Your access doesn't include this area. Ask an administrator if you need it.").
- Audit: every Save writes event `company_settings_saved` with old and new values of the fields saved (entity "company_settings"). Stored values: ABN/ACN digits only, email lower-cased.

### 4.2 Users and roles (`#/users`)
Access: permission `access.manage` (system admin or Super admin role). API: roles_catalogue, users_list, role_set. Header: eyebrow "ADMINISTRATION", H1 "Users and roles", text "Roles add permissions on top of a person's position. Changes apply at their next page load and are recorded in the audit log. You can't change your own roles."
- Toolbar: search "Find a person" (`#u-search`, placeholder "Name, email or position", filters the list live) and button/link "People register, logins and personal overrides" (to `../training/admin/?view=people-management`).
- Matrix table (`table.roles`): first column "Person" (name; small "email · position"; chip "System admin" for portal admins; red chip "Sign-in disabled" with dimmed row for inactive logins); then one column per role (header hover shows the role description): Super admin, Director / owner, Finance admin, Payroll admin, Project manager, Supervisor, Accountant / auditor. Each cell is a checkbox (aria-label "<Role> for <Person>", `input[data-role][data-user]`); ticking = add role, unticking = remove role, saved immediately (one box at a time).
  - Success line (green): "Added <Role> for <Person>." / "Removed <Role> for <Person>." On failure the box reverts and a red message appears.
  - Own row: all boxes disabled (tooltip "Someone else must change your roles").
  - Empty search: "No one matches."
  - Audit events: `role_granted` / `role_removed` (entity "profile_role", subject = the person).
  - Errors: "Someone else must change your own roles." (server), "Person not found.", "Unknown role.", `You need the "Sign-in and access" permission for this.`
- Panel "What each role includes": a card per role with its description and list of included permission display names (see section 6). Footer: "System administrators automatically hold every permission except payroll pay, tax and bank details, which need the Payroll admin role. Anyone holding finance or payroll permissions must use two-step sign-in in Panalo Accounts."
- What it CANNOT do: create users, issue/reset passwords, disable/enable sign-in, personal allow/deny overrides, position defaults, reset MFA. Those are in Portal > Administration > People (link above): "Email an invitation link", "Create temporary password", "Issue new temporary password", "Disable sign-in"/"Enable sign-in", per-permission "Position default / Allow / Deny" selector, document folder groups. The list shows everybody in the organisation (up to 2000), including inactive logins.
- Roles are added on top of position permissions and personal allow; a personal "Deny" beats a role.

### 4.3 Approvals (`#/approvals`)
Access: everyone (menu always shown); what appears depends on permissions. Header: eyebrow "ADMINISTRATION", H1 "Approvals", text "Some changes need a second person: you can never approve your own request. Every decision is recorded with the previous and new values."
Kinds of approval that flow here (the four-eyes engine):
| Kind | Raised from | Needs permission to decide | What approving does |
|---|---|---|---|
| company_bank_account (title "New company bank account: <name> (BSB xxx-xxx)") | Company settings > Banking > "Send for approval" | bank.manage | Account becomes Active (and replaces the previous "shown on invoices" account if ticked). Rejecting/cancelling sets it to Rejected. |
| supplier_bank (title "Bank details for supplier <name>") | Suppliers screen (needs purchases.manage to request; only one pending per supplier: "A bank change for this supplier is already waiting for approval.") | purchases.bank | Supplier's bank name/BSB/account number are replaced. |
| employee_bank (title "Bank details for <employee>") | Employees pay settings (needs payroll.sensitive) | payroll.approve | Employee's pay bank details replaced. Nobody can approve a change to their own bank details. |
Sections (panels):
1. "Waiting for you (<n>)" - pending items you can decide (you did not request them and hold the required permission). Empty: "Nothing waiting for you." Each item (article.approval): title, "Requested by <name> · <date time>", status chip "Waiting", and a detail block:
   - company bank account: facts list "Name", "Account name", "BSB", "Account number", "Used for" (+ " · shown on invoices"); caution: "Before approving, confirm these details with the bank or the requester by phone, using a number you already know. Never approve from an email request alone."
   - supplier bank: "Account name", "BSB", "Account number", "Replaces" (old BSB · number, or "No bank details on file"); caution: "Changed supplier bank details are the most common way businesses are defrauded. Phone the supplier on a number you already have (not one from the request or an email) and confirm the BSB and account number before approving."
   - employee bank: NO detail block is drawn (only the title) - see Surprises.
   - Buttons: "Approve" (primary, `[data-approve]`) and "Reject" (red, `[data-reject]`).
   - Approve: browser prompt "Approve this change? Add a note for the record (for example, how you checked it):" (note optional; Cancel aborts). Result "Approved." (green).
   - Reject: browser prompt "Reject this change? Give a reason; the requester will see it:" - reason required (3+ characters) else error "Give a reason for rejecting it." Result "Rejected."
2. "Your requests" - your last 50 requests with any status. Empty: "You have not requested anything." Pending ones show link-button "Cancel request" (-> "Request cancelled."; the bank account becomes Rejected). Status chips: "Waiting" (amber), "Approved" (green), "Rejected" (red), "Cancelled" (grey). Decided items show " · approved/rejected by <name> <date time>" and "Comment: <text>".
3. "Recent decisions" - only shown to people with audit.view and only if any exist: the latest 50 decided (non-pending) items of anyone, read-only.
- Account numbers: the approver (and requester) see full numbers; everyone else sees "•••• 678" style masks; audit log stores them masked ("***678").
- After a decision the requester is notified ("Approved: <title>" / "Rejected: <title>" with the comment as body) and the badge counts refresh. Audit events approval_approved / approval_rejected (details include kind, title, comment; subject = requester); approval_requested; approval_cancelled.
- Errors: "Approval not found.", "This has already been decided." (someone else got there first), "Someone else must approve a change you requested.", "Someone else must approve a change to your own bank details.", "Give a reason for rejecting it.", and `You need the "Banking" permission for this.` (names: Banking / Approve supplier bank changes / Approve pay runs).
- No ledger posting happens from approvals.

### 4.4 Integrations (`#/integrations`)
Access: everyone. It is a read-only status table with no buttons. Eyebrow "ADMINISTRATION", H1 "Integrations", text "What Panalo Accounts connects to, and what it deliberately does not do yet." Columns "Connection", "Status", "Details". Six rows (status computed from company settings and bank accounts):
1. "Single Touch Payroll (ATO)" - chip "Export only" - "Panalo Accounts will prepare and validate STP Phase 2 data from Phase 5. Sending it to the ATO needs an ATO-registered Sending Service Provider; transmission stays switched off until that arrangement exists." (Sending is genuinely disabled in the database and the API; the "from Phase 5" wording is stale since STP is now built.)
2. "Super contributions (Payday Super)" - chip "Provider named" (blue, if "Super clearing house" is filled in company settings) else "Not set" (amber). Details: ["Clearing house: <name>. "] "Contributions will be calculated and exported per pay run; the clearing house sends money and data to funds on the same day."
3. "Bank payments (ABA files)" - chip "Live" (green) when at least one ACTIVE company bank account has an APCA user ID, else "Not set". NOTE: users without org.manage/bank.manage never receive APCA IDs, so they always see "Not set". Details: "Pay runs and supplier payment batches produce ABA files to upload to your bank. Add the APCA user ID, bank code and user name in Banking › Bank accounts."
4. "Bank statements" - chip "Live" - "CSV, OFX/QFX and QIF import with matching suggestions and rules. A paid bank feed is optional later."
5. "Email" - chip "Portal email" (amber) - "Emails currently use Supabase's built-in sender, which only reaches Panalo's Supabase team. Connect Panalo's own mail (Microsoft 365, Google Workspace or a sending service) in Supabase before invoices or payslip notices go out."
6. "ABN Lookup" - chip "Phase 3" (grey) - "Supplier ABNs will be checked when suppliers and bills are entered; ABN check digits are already validated." (stale: Phase 3 is built but no ABN Lookup service exists; only check digits)
Nothing here is a live external connection: no ATO, bank feed, email or ABN Lookup integration actually runs. Everything is manual file exchange (ABA download, statement upload, STP export file, PDFs downloaded).

### 4.5 Audit log (`#/audit`)
Access: `audit.view` (Super admin, Director, Finance admin, Payroll admin, Accountant roles, and system admins). Viewing is itself logged (event `audit_log_viewed`, entity "Audit log views", with page and filters), so opening the log creates a new entry each time.
Header: eyebrow "ADMINISTRATION", H1 "Audit log", text "Every change across the portal and Panalo Accounts. Records can't be edited or deleted, by anyone." (Enforced by database triggers: "Audit records cannot be deleted." / cannot be changed.)
Filter form: "Area" select (Everything, Company settings, Company bank accounts, Approvals, Roles, Numbering, Audit log views) [maps to entity types company_settings, company_bank_account, approval, profile_role, number_sequence, audit_log]; "Event contains" text (placeholder "e.g. approved", case-insensitive substring of the event name such as invoice, journal, pay_run); "From" and "To" dates (inclusive, Sydney time); button "Filter" (resets to page 1).
Table columns "When" (date + time), "Who" (the person who did it, with small "about <name>" when the action concerned another person, e.g. role changes or an approval for a requester; "System" for automatic events), "Event" (code, e.g. company_settings_saved), "Record" (entity type plus first 8 characters of the record id), "Change" (list of changed fields: field name, old value struck through in red -> new value in green; values truncated at 80 characters; if there are no old/new values the details are shown as small JSON). Empty: "No events match."
Paging: 50 rows per page; buttons "Newer" and "Older", text "Page n of N".
Typical events: company_settings_saved, company_setup_completed, company_logo_changed, company_bank_account_retired, number_sequence_saved, approval_requested / approval_approved / approval_rejected / approval_cancelled, role_granted / role_removed, audit_log_viewed, document_attached / document_archived / document_pdf_generated, plus events from every other module (invoice_approved, journal_posted, pay_run_approved, period reopen, etc.) and portal events (logins created, permissions changed, etc.).
How to investigate "who changed this": 1) open Audit log; 2) set Area (if the record is company-related) or type part of the event name in "Event contains" (e.g. "invoice", "bank", "reopen"); 3) narrow by From/To dates; 4) read "Who" and "When", then "Change" for the before -> after values; 5) use the 8-character Record id to find all events for the same record (type nothing, scan "Record" column across pages) and "Event" to see the sequence (created -> approved -> voided). Area filter only covers seven entity types; everything else (invoices, journals, pay runs, etc.) must be found via "Event contains". Bank account numbers, TFNs are never stored in clear in the log (masked).
Errors: "The audit log could not be loaded." (500) and the standard permission message if audit.view is missing.

---------------------------------------------------------------------------------------------------

## 5. Shared UI behaviours (lib/ui.js, lib/docs.js)

- Flash messages: `flash()` writes into the screen's `[data-msg]` line (or the top `#app-msg`) with a tone: green "good" for success (e.g. "Saved.", "Approved."), red "bad" for errors, amber "warn" for cautions, plain for progress ("Saving…", "Uploading…"). Messages are polite live-region announcements; not auto-dismissed, replaced by the next message or cleared on navigation.
- Field errors: red small text under a field (`small.err[data-err=<id>]`), field gets a red border (`.invalid`) and keyboard focus. Cleared when you re-submit. Required fields have a gold asterisk and the browser also blocks empty required fields with its own bubble (forms are not novalidate).
- friendlyError (training/auth.js): HTTP 401 -> "Your sign-in has expired. Please sign in again."; HTTP 403 -> the server's message (or "This account does not have access to that training." if none); otherwise the server/browser message, or "Something went wrong. Please try again." Server 5xx always arrive as "The secure training service could not complete the request." Browser network failure shows the browser text (e.g. "Failed to fetch"). Database-originated messages (raise exception) are passed through verbatim, with these generic replacements: duplicate -> "That record already exists."; check constraint -> "One of the values is outside what is allowed."; bad id/date format -> "One of the values is not in a valid format." Status mapping: no permission 403; not found 404; invalid state/parameter 409; unique/foreign key 409; check/format 400.
- Browser dialogs: reasons and comments are collected with the browser's own prompt boxes ("OK"/"Cancel"; Cancel aborts, nothing happens); confirmations use the browser confirm box.
- Status chips (`.chip`): grey = neutral/cancelled/draft, amber (pending) = waiting/needs attention, green (good) = done/active/live, red (bad) = rejected/disabled/error, blue (info) = informational.
- Buttons: `.btn.primary` (gold fill) = the main action of the screen; `.btn` (dark) = secondary; `.btn.danger` (red outline) = destructive such as Reject; `.link` (gold bold text button) = small row actions (Retire, Cancel request, Remove, Save in a table row, Mark all read); `.btn.file` = file chooser dressed as a button ("Upload logo", "Attach a PDF or photo"). Disabled (greyed) buttons are not available now (e.g. Finish setup with items missing, Newer on page 1).
- Dates and money: see conventions at top. Empty values show "—".
- Attachments panel (lib/docs.js `attachmentsPanel`, used on Customer, Quote, Invoice, Supplier, Purchase order, Bill and Fixed asset detail screens; entity types customer, quote, invoice, supplier, purchase_order, bill, asset):
  - Panel heading "Attachments". Empty state "Nothing attached." Each file: file name (link-button, opens the file in a new tab through a 2-minute signed link), small "<size> KB · <date>", and (if the user may edit) link "Remove".
  - Button "Attach a PDF or photo" (PDF, JPG, PNG, WebP; max 15 MB). Progress "Uploading…", success "Attached <file name>."
  - "Remove" asks "Remove this attachment? It is kept in the archive for the audit trail." (file is archived, not deleted; audit event document_archived; attach = document_attached).
  - Who may add: sales.manage (customer/quote/invoice), purchases.manage (supplier/bill/purchase order; purchases.raise too for purchase orders), assets.manage (asset). Who may remove: sales.manage, purchases.manage, assets.manage (purchases.raise cannot remove). Who may open: any of those, purchases.raise, or reports.view (read-only roles can open files).
  - Errors: "Attachments are not available here.", "Attach a PDF or a photo (JPG, PNG or WebP).", "Attachments must be under 15 MB.", "A secure upload link could not be created.", "The upload didn't go through. Please try again.", "The upload didn't arrive. Please try again.", "Invalid upload path.", "Attach a PDF or a photo.", "Record not found.", "Attachment not found.", "The file could not be opened.", and the standard "Your access doesn't include this area. Ask an administrator if you need it."

---------------------------------------------------------------------------------------------------

## 6. Roles and permissions

### 6.1 How effective permissions are worked out (SQL `app_permissions_for`)
Effective = (position permissions of an active/on-leave/applicant employee record) + (permissions of assigned roles) + (for system admins: every permission with admin_default = true) - (personal Deny) + (personal Allow). Inactive logins hold nothing. System administrator = portal profile role "admin" (shown as chip "System admin"). System admins do NOT get payroll.sensitive or payroll.self.

### 6.2 Permission keys (exact display name = what the role cards show; area; MFA)
| Key | Display name | Area | MFA | Admin default | What it is |
|---|---|---|---|---|---|
| training.manage | Training administration | Portal | no | yes | Invite learners, assign, revoke and publish training modules. |
| people.view | View the people register | Portal | no | yes | See employees, positions, sites and licences. |
| people.manage | Manage the people register | Portal | no | yes | Add and edit people, licences, positions, sites and training requirements. |
| hr.manage | HR onboarding and records | Portal | no | yes | Send onboarding requests and review HR documents, including tax, bank and identity documents. |
| competency.all | Competency matrix: everyone | Portal | no | yes | See everyone's competency and record practical verifications. |
| competency.team | Competency matrix: own team | Portal | no | yes | See direct reports' competency and record their practicals. |
| access.manage | Sign-in and access | Portal | YES | yes | Create logins, issue temporary passwords, disable sign-in and set permissions and document groups. (Counts as a finance key for Accounts access.) |
| org.manage | Company settings | Accounts | YES | yes | Edit company details, tax settings, numbering and integrations; request bank account changes. |
| ledger.manage | Chart of accounts and tax codes | Accounts | YES | yes | Create and edit accounts, tax codes and posting rules. |
| ledger.journal | Create journals | Accounts | YES | yes | Prepare manual and adjusting journals. |
| ledger.post | Approve and post journals | Accounts | YES | yes | Approve and post journals to the general ledger. |
| ledger.reopen | Reopen closed periods | Accounts | YES | yes | Reopen a closed accounting period. Every reopen is logged. |
| sales.manage | Sales | Accounts | YES | yes | Customers, quotes, invoices, credit notes and receipts. |
| purchases.manage | Purchases | Accounts | YES | yes | Suppliers, purchase orders, bills and supplier payments. |
| purchases.raise | Raise purchase orders | Accounts | no | yes | Create purchase orders and record goods received; someone with Purchases approves them. |
| purchases.bank | Approve supplier bank changes | Accounts | YES | yes | Approve changes to supplier bank details. |
| bank.manage | Banking | Accounts | YES | yes | Bank accounts, payments, imports and reconciliation; approve company bank accounts. |
| projects.manage | Projects and job costing | Accounts | no | yes | Projects, budgets, cost codes and job costing. |
| time.submit | Enter my timesheets | Accounts | no | yes | Record your own hours against projects and submit them for approval. |
| time.approve | Approve timesheets | Accounts | no | yes | Approve timesheets for the people and projects you manage. |
| leave.approve | Approve leave | Accounts | no | yes | Approve leave requests for the people you manage. |
| assets.manage | Fixed assets | Accounts | YES | yes | Keep the asset register, run depreciation and record disposals. |
| payroll.sensitive | Payroll: pay, tax and bank details | Payroll | YES | NO | See and edit employees' pay rates, TFNs, bank and super details. Not given to system administrators automatically. |
| payroll.run | Prepare pay runs | Payroll | YES | yes | Prepare and calculate pay runs. |
| payroll.approve | Approve pay runs | Payroll | YES | yes | Approve and finalise pay runs. |
| payroll.self | My pay | Payroll | no | NO | See your own payslips and leave balances, and request leave. |
| tax.bas | BAS and tax reporting | Accounts | YES | yes | Prepare BAS workpapers and tax reports. |
| tax.review | Review BAS | Accounts | YES | yes | Review a BAS workpaper someone else prepared before it is lodged. |
| reports.view | Financial reports | Accounts | no | yes | View financial reports and dashboards. |
| audit.view | Audit log | Accounts | YES | yes | View the audit log. |
| data.export | Export data | Accounts | YES | yes | Export reports and records. Every export is logged. |
(Permission order in the database sort column: training 10..access 70, org 100, ledger.* 110-140, sales 150, purchases.manage 160, purchases.raise 165, purchases.bank 170, bank 180, projects 190, time.approve 200, time.submit 205, leave 210, payroll.sensitive 220, payroll.run 230, assets 236, payroll.approve 240, payroll.self 245, tax.bas 250, tax.review 252, reports 260, audit 270, export 280.)

### 6.3 Default roles (assignable on Users and roles) and their permissions
| Role (key) | Description shown | Permissions held | Needs MFA? |
|---|---|---|---|
| Super admin (super_admin) | System configuration, users and every finance area except payroll details. | org.manage, access.manage, ledger.manage, ledger.journal, ledger.post, ledger.reopen, sales.manage, purchases.manage, purchases.raise, purchases.bank, bank.manage, projects.manage, time.approve, assets.manage, tax.bas, tax.review, reports.view, audit.view, data.export | yes |
| Director / owner (director) | Reports, approvals and management dashboards. | ledger.post, ledger.reopen, sales.manage, purchases.manage, purchases.bank, bank.manage, payroll.approve, payroll.self, tax.bas, tax.review, assets.manage, reports.view, audit.view, data.export | yes |
| Finance admin (finance_admin) | Invoices, bills, payments, bank reconciliation, journals, customers, suppliers and reports. | ledger.manage, ledger.journal, ledger.post, sales.manage, purchases.manage, purchases.raise, bank.manage, payroll.self, tax.bas, assets.manage, reports.view, audit.view, data.export | yes |
| Payroll admin (payroll_admin) | Employee pay data, pay runs, leave, PAYG, super and payroll reports. | payroll.sensitive, payroll.run, payroll.self, leave.approve, time.approve, people.view, reports.view, audit.view, data.export | yes |
| Project manager (project_manager) | Assigned projects, timesheets, labour and costs. No private payroll details. | projects.manage, time.approve, time.submit, purchases.raise, payroll.self, reports.view | no |
| Supervisor (supervisor) | Approves their team's timesheets and leave. | time.approve, time.submit, leave.approve, payroll.self, competency.team | no |
| Accountant / auditor (accountant) | Reads the ledger, reports and audit log; prepares adjusting journals. | ledger.journal, tax.bas, tax.review, reports.view, audit.view, data.export | yes |
Key consequences: Director cannot edit company settings (no org.manage) and cannot open Users and roles; only Director (and system admin) hold payroll.approve; Payroll admin cannot approve pay runs or post journals; only payroll_admin holds payroll.sensitive; Finance admin cannot reopen periods; Super admin lacks all payroll keys, leave.approve and time.submit but system admin accounts hold payroll.run/approve, leave.approve, time.submit.
Four-eyes rule: you can never approve your own approval request, and pay runs/journals/BAS/payment batches have similar "someone else" checks (other investigators cover these).

### 6.4 Test users (supabase/tests/db fixtures)
| Email | Holds |
|---|---|
| sysadmin@fin.test | Portal role "admin" (System admin): all admin_default keys (everything except payroll.sensitive and payroll.self). MFA needed. |
| finance@fin.test | Role Finance admin. MFA needed. |
| director@fin.test | Role Director / owner. MFA needed. (Test also grants personal payroll.run in one payroll test only.) |
| payroll@fin.test | Role Payroll admin. MFA needed. |
| pm@fin.test | Role Project manager. No MFA. |
| staff@fin.test | No roles, no permissions (ordinary employee) -> "No access" gate. |
| office@fin.test | Employee record "Olivia Office" + personal permission payroll.self. No MFA. |
| tradie@fin.test | Employee record "Tom Tradie" + personal permissions time.submit and payroll.self. No MFA. |
(In a real environment these accounts may differ; confirm on Users and roles before shooting. Passwords are not in the repo.)

---------------------------------------------------------------------------------------------------

## 7. API gatekeeping (finance-api/index.ts) - order of checks and exact errors
Every request: verified Supabase session -> profile exists and active -> must_change_password -> any finance permission -> MFA (aal2) when required -> action permission -> SQL function re-checks permission and writes audit in the same transaction.
| Trigger | HTTP | code | Message |
|---|---|---|---|
| Browser origin not allowed | 403 | | "This website is not permitted to call Panalo Accounts." |
| Not POST | 405 | | "Method not allowed." |
| No verified session | 401 | | "A verified session is required." |
| Profile lookup error | 500 | | "Profile lookup failed." (shown as the generic 5xx message) |
| Disabled login | 403 | | "This account is not active." |
| Temporary password still set | 403 | password_change_required | "Change your temporary password on the portal first." |
| No finance permission | 403 | no_access | "Your account doesn't include Panalo Accounts. Ask an administrator if you need it." |
| MFA needed, session only aal1 | 403 | mfa_required | "Confirm your sign-in with your authenticator app to continue." |
| Unknown action | 400 | | "Unknown Panalo Accounts action." |
| Action permission missing | 403 | | "Your access doesn't include this area. Ask an administrator if you need it." |
| SQL permission check | 403 | | `You need the "<Permission display name>" permission for this.` |
| Bad id | 400 | | "<Label> is not valid." |
| Permissions catalogue / roles / users / approvals / notifications / audit / company load failures | 500 | | "Permissions could not be loaded.", "Roles could not be loaded.", "Users could not be loaded.", "Approvals could not be loaded.", "Notifications could not be loaded.", "Notifications could not be updated.", "The audit log could not be loaded.", "Company settings could not be loaded." (all reach the user as "The secure training service could not complete the request.") |

### Action -> permission (any-of) map, foundation (index.ts)
dashboard, company_get, approvals_list, approval_decide, approval_cancel, notifications_list, notifications_read, whoami: any signed-in user with finance access (decide/cancel also enforced in SQL). company_save, company_complete, numbering_save, bank_account_request, bank_account_retire, logo_prepare_upload, logo_attach: org.manage. roles_catalogue, users_list, role_set: access.manage. audit_list: audit.view. attachment_prepare_upload/attachment_attach: sales.manage | purchases.manage | purchases.raise | assets.manage (entity-specific rule in code). attachment_open: those plus reports.view. attachment_archive: sales.manage | purchases.manage | assets.manage.
### Other modules (for cross-reference; owned by other sections)
ledger: ledger_setup, journals_list, journal_get, periods_list = reports.view|ledger.manage|ledger.journal|ledger.post|audit.view; account_save, account_set_status, tax_code_save, financial_year_add = ledger.manage; journal_save = ledger.journal; journal_post, journal_reverse = ledger.post; journal_delete = ledger.journal|ledger.post; period_set_status = ledger.post|ledger.reopen; report = reports.view; report_export = data.export.
sales: *_list/_get/_pdf, customer_statement, sales_setup = sales.manage|bank.manage|reports.view; customer_save, quote_save, quote_status, quote_to_invoice, invoice_save, invoice_approve, invoice_void, invoice_mark_sent, credit_apply = sales.manage; receipt_record, receipt_allocate, receipt_void = bank.manage; aged_receivables = reports.view|sales.manage.
purchases: reads = purchases.manage|purchases.raise|bank.manage|reports.view; supplier_save, supplier_bank_request, bill_*, supplier_credit_apply = purchases.manage; po_save, po_status, po_receive = purchases.raise|purchases.manage; supplier_payment_record/void = bank.manage; aged_payables = reports.view|purchases.manage.
projects: reads = projects.manage|reports.view; saves/status/cost_code/labour = projects.manage; timesheet_week = time.submit + (time.approve|projects.manage|payroll.run); timesheet_save/reopen = time.submit|time.approve; timesheet_decide = time.approve; timesheets_review/timesheet_hours = time.approve|projects.manage|payroll.run.
payroll: payroll_employees/_get = payroll.sensitive|payroll.run|payroll.approve|leave.approve; payroll_employee_save, payroll_import_onboarding, payroll_bank_request, leave_adjust, pay_run_bank_list = payroll.sensitive; leave_list = leave.approve|payroll.sensitive|payroll.run; leave_request/leave_decide = payroll.self|leave.approve; pay_run reads/payslip_pdf/payroll_summary = payroll.run|payroll.approve|payroll.sensitive; pay_run_create/recalculate/line_add/line_remove/submit/delete = payroll.run; pay_run_return = payroll.run|payroll.approve; pay_run_approve = payroll.approve; pay_run_record_payment/super = payroll.run|bank.manage; my_pay, my_payslip = payroll.self.
banking: all = bank.manage except reads (bank_lines, banking_overview, bank_imports_list, bank_reconcile_preview, bank_reconciliations, bank_reconciliation_get) = bank.manage|reports.view; pay_run_aba = payroll.sensitive; banking_counts = bank.manage.
tax: reads (bas_list, bas_counts, bas_get, bas_lines, bas_pdf, tpar_get) = tax.bas|tax.review; bas_create/save/reopen/delete/lodge, tpar_lodge = tax.bas; bas_review = tax.review; bas_record_payment/bas_payment_void = tax.bas|bank.manage.
stp: reads = payroll.run|payroll.approve|payroll.sensitive; stp_event_export, stp_settings_save, stp_item_map, payroll_employee_stp_save = payroll.sensitive; stp_event_pay/year/check/delete = payroll.run; stp_event_ready/submit = payroll.approve (submit always refuses: sending to ATO is switched off).
assets: reads = assets.manage|reports.view; all writes = assets.manage.

---------------------------------------------------------------------------------------------------

## 8. All user-facing messages in this area (alphabetical groups)
Gate/MFA/session: see 1.2-1.6 and section 7.
Company settings client: "Enter the legal name.", "That ABN isn't valid. Check the 11 digits.", "That ACN isn't valid. Check the 9 digits.", "Enter the street address.", "A postcode is 4 digits.", "Choose a state.", "Enter a phone number.", "Enter a valid email address.", "Choose at least one state.", "Enter the payroll contact's name.", "Between 0 and 120 days.", "Give the account a name.", "Enter the account name.", "A BSB is 6 digits, like 062-000.", "An account number is 5 to 10 digits.", "The APCA user ID is 6 digits.", "Saving…", "Saved.", "Uploading logo…", "Logo updated.", "Account retired.", "<Kind> numbering saved.", "Company setup complete.", "Sent for approval. Someone else with banking permission must approve it before it can be used."
Company settings server: see 4.1 (plus "Bank account not found.", "Only an active account can be retired.", "Give a reason for retiring it.", "A BSB is 6 digits, like 062-000.", "An account number is 5 to 10 digits.").
Users: "Added <Role> for <Person>.", "Removed <Role> for <Person>.", "No one matches.", "Someone else must change your own roles.", "Person not found.", "Unknown role."
Approvals: "Approved.", "Rejected.", "Request cancelled.", "Nothing waiting for you.", "You have not requested anything.", plus the SQL texts in 4.3.
Audit: "No events match.", "The audit log could not be loaded."
Dashboard/shell: "Loading…", "Nothing yet.", "Something went wrong".

---------------------------------------------------------------------------------------------------

## 9. Screenshots to capture
Viewport: 1440x900 desktop for most; one mobile (390 px) of the dashboard/menu if wanted (menu column stacks). All selectors are CSS. Numbered callouts suggested in order listed.

S1. Portal sign-in (start of the journey)
- Route: /training/?next=/accounts/ ; signed out; any user (use finance@fin.test).
- Highlight: 1 `#email`, 2 `#password`, 3 `#sign-in-form button[type=submit]` ("Sign in"), 4 `#forgot-link` ("Forgot password?").
S2. Accounts gate "Sign in to Panalo Accounts"
- Route: /accounts/ signed out. Highlight: 1 `[data-gate-title]`, 2 `[data-gate-body] a.btn.primary` ("Sign in").
S3. Gate "Checking your access…" (optional; transient - throttle network to catch it). Highlight `[data-gate-title]`.
S4. Change temporary password
- User: a freshly created login with a temporary password (create via Portal > Administration > People > Create temporary password for e.g. office@fin.test). Route: /accounts/ -> gate "Change your temporary password first": 1 `[data-gate-title]`, 2 `[data-gate-body] a.btn.primary` ("Open the portal"). Then portal `#password-panel`: 3 `#new-password`, 4 `#confirm-password`, 5 `#password-form button[type=submit]`, 6 `.password-rules`.
S5. MFA set-up
- User: finance@fin.test (or sysadmin@fin.test) with no authenticator factor yet. Route: /accounts/ after sign-in. Highlight: 1 `[data-gate-title]` ("Set up two-step sign-in"), 2 `.qr img`, 3 `code.secret`, 4 `#mfa-code`, 5 `[data-mfa-form] button[type=submit]`. Blur the real QR/secret before publishing.
S6. MFA code entry
- Same user after factor enrolled, new sign-in. Highlight: 1 `#mfa-code`, 2 `[data-mfa-form] button` ("Verify"), 3 `[data-mfa-msg]` (capture the error "That code didn't work…" with a wrong code).
S7. No access
- User: staff@fin.test. Route /accounts/. Highlight: 1 `[data-gate-title]` ("No access to Panalo Accounts"), 2 `[data-gate-body] p`, 3 `[data-gate-body] a.btn` ("Back to the portal").
S8. App shell overview + dashboard
- User: sysadmin@fin.test (or director@fin.test) after MFA; route #/dashboard; data present (some drafts/approvals so cards show gold borders; ideally one unread notification and one pending approval). Highlight: 1 `.brand` / `[data-org]`, 2 `[data-bell]` + `[data-bell-count]`, 3 `[data-who]`, 4 `a.top-link[href="../training/"]` (Portal), 5 `[data-signout]`, 6 `[data-nav]` groups (`.nav-title`), 7 `.nav-item.active`, 8 a `.nav-item .count` badge (e.g. Approvals), 9 `[data-view] .cards.figures` first row, 10 a `.card.attention`, 11 the roadmap `.panel .tbl`.
S9. Notifications dropdown
- User: director@fin.test with an unread "Approval needed: New company bank account…" notification. Route any; click `[data-bell]`. Highlight: 1 `[data-bell-count]`, 2 `[data-notes] .notes-head`, 3 `[data-read-all]` ("Mark all read"), 4 first `[data-notes] li.unread a`.
S10. Minimal-access dashboard & menu: office@fin.test (or tradie@fin.test) #/dashboard - shows only Dashboard, My pay and the three Administration items and the three bottom cards. Highlight `[data-nav]`, `.card` x3.
S11. Menu differences by role: finance@fin.test vs payroll@fin.test side-by-side crops of `[data-nav]`.
S12. Dashboard figures: finance@fin.test #/dashboard crop `.cards.figures` rows (Bank, Net profit, GST owed, Draft journals; Customers owe, Draft invoices, ...). Callout per card h2.
S13. Company settings, editable: sysadmin@fin.test #/company?step=1. Highlight: 1 `.stepper` (`button[data-step="0"]`..`"7"`), 2 `#legal_name`, 3 `#trading_name`, 4 `#abn`, 5 `#acn`, 6 `label.btn.file` (Upload logo), 7 `[data-form=business] button[type=submit]`.
S14. Company settings step 2: #/company?step=2: `#ba_street`, `#ba_state`, `#ba_postcode`, `[data-same]`, `#phone`, `#email`, `#website`.
S15. Step 3: #/company?step=3: `#gst_registered`, `#gst_basis`, `#bas_frequency`, `#accounting_basis`, `#financial_year_start_month`, `#timezone`.
S16. Step 4: #/company?step=4: `fieldset.states`, `#pay_frequency`, `#pay_day`, `#super_clearing_house`, `#pc_name`, `#pc_email`, `#pc_phone`, `.note`.
S17. Step 5: #/company?step=5: `[data-form=wc] table`, `[data-wc="NSW"] input[name=insurer]`, `input[name=policy]`, `input[name=expires]`.
S18. Step 6 Banking: #/company?step=6 with one Active and one "Waiting for approval" account: `#payment_terms_days`, the accounts `table.tbl`, a `.chip` Status, `[data-retire]`, `#b_nickname`, `#b_account_name`, `#b_purpose`, `#b_bsb`, `#b_account_number`, `#b_apca`, `#b_show`, `form[data-form=bank] button[type=submit]` ("Send for approval"). Use fake account details.
S19. Step 7 Numbering: #/company?step=7: first `tr[data-kind="invoice"]` with `input[name=prefix]`, `input[name=next]`, `input[name=padding]`, `[data-preview]`, `[data-save-number]`; also show the three raw-named rows at top if documenting the quirk.
S20. Step 8 Review: #/company?step=8 with something missing: `.msg.warn`, `.tbl.kv`, `[data-finish]` (disabled). And the complete state with "Setup complete."
S21. Company settings read-only: director@fin.test #/company: `.chip` "Read only", `.tbl.kv`, masked account numbers if visible.
S22. Users and roles: sysadmin@fin.test #/users; at least one person with a role ticked and one "Sign-in disabled" person if available. Highlight: 1 `#u-search`, 2 `a.btn[href^="../training/admin"]`, 3 role column headers `table.roles thead th.c`, 4 a checked `input[data-role][data-user]`, 5 own row's disabled checkboxes (`input[data-role][disabled]`), 6 `.chip` "System admin", 7 `[data-msg]` after toggling ("Added Finance admin for …"), 8 `.role-cards .role-card`.
S23. Approvals, approver view: requester sysadmin@fin.test submits a company bank account (Company settings step 6); then director@fin.test or finance@fin.test opens #/approvals. Highlight: 1 `section.panel:nth-of-type(1) h2` ("Waiting for you (1)"), 2 `article.approval h3` title, 3 `.facts` details, 4 `.note` caution, 5 `[data-approve]`, 6 `[data-reject]`, 7 the browser prompt (capture separately, native dialog) .
S24. Approvals, requester view: sysadmin@fin.test #/approvals: "Your requests" with chip "Waiting" and `[data-cancel]` ("Cancel request"); then after decision "Approved" chip with "Comment:".
S25. Approvals "Recent decisions": director@fin.test (has audit.view) after a decision.
S26. Integrations: any user (finance@fin.test) #/integrations: `table.tbl` rows, `.chip` status column (point out "Export only", "Provider named"/"Not set", "Live", "Portal email", "Phase 3"). Take a second shot after an active bank account with an APCA user ID exists so "Bank payments (ABA files)" shows "Live".
S27. Audit log: director@fin.test (or finance@fin.test) #/audit after generating events (company save, approval, role change). Highlight: 1 `#a-ent`, 2 `#a-ev`, 3 `#a-from`, 4 `#a-to`, 5 `form[data-filter] button[type=submit]`, 6 first table row "When"/"Who"/"Event"/"Record" cells, 7 `ul.diff` (old struck-through -> new), 8 `.pager` `[data-page="-1"]` / `[data-page="1"]`. A second shot filtered by Area = "Approvals".
S28. Attachments panel: finance@fin.test on an invoice detail (#/invoices/<id>) or supplier: `section[data-attachments]`, `h2`, `[data-open-file]`, `[data-archive-file]` ("Remove"), `label.btn.file` ("Attach a PDF or photo"); also the empty state "Nothing attached."
S29. Flash message states: a green `[data-msg]` (e.g. "Saved." on Company settings) and a red one (e.g. try Add a bank account with BSB "12" to show "A BSB is 6 digits, like 062-000." under `#b_bsb` via `small.err[data-err="b_bsb"]`).
S30. "Something went wrong" panel / error: only reproducible by forcing a failure; optional.
S31. Header "Sign out" result: portal sign-in form after sign out (same as S1).

---------------------------------------------------------------------------------------------------

## 10. Surprises, placeholders and inconsistencies (for the manual writer)
1. Sign-in is not on the Accounts page at all; it hands off to the portal and returns via `?next=`. After a temporary-password change the user must reopen /accounts/ manually ("Open the portal" link has no next).
2. Gate screens (MFA, no access, password change) have no "Sign out" button; the header is hidden. Only the portal has a way to sign out from there.
3. "Lost your phone? Ask a Panalo administrator to reset your authenticator." - there is no reset function in the app or the portal; admin must remove the factor in the Supabase dashboard (documented in docs/SECURITY.md).
4. The MFA enrolment recreates the factor each time the set-up gate is shown (refreshing mid-set-up invalidates the first QR code).
5. Integrations is a status/explanation table only; no integration is configured or live except local file import/export. Stale wording: STP row says STP data is prepared "from Phase 5" (already built); "ABN Lookup" shows chip "Phase 3" although Phase 3 is built and there is no live lookup. Email row says invoices/payslip emails are not yet going out through Panalo's own mail.
6. Menu "phase" tags / the "Arrives in Phase N" page (`planned.js`) are unused dead code now; the dashboard intro still says "Menu items marked with a phase arrive then."
7. Roadmap statuses on the dashboard are hard-coded (phase 9 "Hardening" = "Next"); not data-driven.
8. Company settings Workers comp step promises "Expiry dates trigger reminders in a later phase": no reminders exist.
9. Numbering step: project, payment_batch and asset sequences appear unlabelled (raw names) at the top and show "undefined numbering saved." after saving.
10. Approvals page draws no details for employee_bank approvals (approver sees only the title, not the BSB/account), although the API supplies the data; the title is "Bank details for <employee>". Approve/Reject use browser prompt boxes rather than on-page forms.
11. Notifications are not individually marked read; clicking one just navigates. No live updating; counts/bell refresh on load and after some actions only.
12. Users and roles can only toggle roles. User creation, temp passwords, disable/enable and personal allow/deny live in Portal > Administration > People. Super admin role does not include payroll permissions; Director cannot manage users or edit company settings.
13. Audit "Area" filter only knows seven entity types; invoices, journals, pay runs etc. must be found with "Event contains". Opening the audit log writes an "audit_log_viewed" event.
14. Every user with any finance permission sees Company settings, Approvals and Integrations (read access); only editing is gated. Company bank account numbers are masked for users without org.manage/bank.manage.
15. Dashboard "GST owed (estimate)" and "Bank" depend on ledger account subtypes (gst, bank); wrong subtypes on the chart of accounts would skew them.
16. A system administrator (portal role admin) holds almost all finance permissions automatically but not payroll.sensitive/payroll.self (no "My pay", no pay details); separation of duties.
