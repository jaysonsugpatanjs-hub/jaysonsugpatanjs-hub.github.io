# Panalo Accounts manual — writer's and capture guide

You are writing part of **Panalo Accounts — User Training, Operating & Troubleshooting Manual** for Panalo Pipes & Structurals Pty Ltd (structural steel fabrication, pipework, coded welding, shutdowns and maintenance; workshop in regional Victoria). The full brief is `BRIEF.md` in this folder. Read sections 3, 4, 6, 41–46, 51–53 of it before you start.

Everything you write must be true of the **current code** in `/home/claude/jaysonsugpatanjs-hub.github.io` (`accounts/`, `training/auth.js`, `supabase/functions/finance-api/`, `supabase/migrations/`). The inventories in this folder (`inv-*.md` and `inv/*.md`) are research notes, written by other agents, and can be wrong: **check every button label, field label, status name, permission and message you quote against the source before you write it.** If something exists in code but you could not see it on screen, mark it with a `:::verify` box. Never invent a screen, button, field, status, report, permission or workflow. Do not modify any file in the repository.

## The training environment (where screenshots come from)

The real `/accounts/` code runs locally against a **training database** with fictional people and organisations ("Demo ..." customers and suppliers, `@training.panalo.test` people). Static site: `http://localhost:8000/accounts/`. You have your **own private copy** of the database and API — use only the ports in your brief (`PANALO_REST`, `PANALO_API`). Never run `setup.sh`, `reset.sh`, `ui-restart.sh` or anything that drops or recreates databases, except `bash train/env.sh <your N> reset`, which restores **your** copy to the starting state if you break it.

Training people (use the short name with `shotlib.Session`):

| Short name | Person | Role |
|---|---|---|
| alex | Alex Admin | System administrator (portal admin) |
| dana | Dana Director | Director / owner |
| fran | Fran Finance | Finance admin |
| pat | Pat Payroll | Payroll admin |
| morgan | Morgan Project-Manager | Project manager |
| sam | Sam Supervisor | Supervisor (approves team timesheets and leave) |
| chris | Chris Accountant | Accountant / auditor |
| tom | Tom Welder | Employee (welder/fabricator): timesheets, My pay |
| olivia | Olivia Office | Employee (office): My pay only |
| casey | Casey Rigger | Employee (casual rigger) |
| jamie | Jamie Apprentice | Employee (apprentice) |

What the data contains is in `train/seed1.py` … `train/seed5.py` and `train/foundation.sql` (customers, suppliers, projects, quotes, invoices, receipts, POs, bills, payments, assets, timesheets, pay runs, leave, STP, bank statement lines, rules, reconciliation, payment batch, journals, BAS, periods July and August soft-locked). Today in the training data is 8 Oct 2026. Read them so you can pick good records to show. You may create more records **through the UI** to demonstrate a procedure (that is the best way — fill the form, capture it, then save and capture the result). Name anything you create so it is obviously training data (for example "Demo …").

Do **not** close or lock the September or October 2026 periods, and don't change company settings in ways that break other screens — even in your own copy, the screenshots should show a normal working company.

## Capturing screenshots — `shotlib.py`

```python
import os, sys
os.environ["PANALO_REST"] = "http://127.0.0.1:399N"; os.environ["PANALO_API"] = "http://127.0.0.1:878N"   # your N
M = "/tmp/claude-0/-home-claude-jaysonsugpatanjs-hub-github-io/bec2506f-192b-577d-8c27-2271b2dd611e/scratchpad/manual"
sys.path.insert(0, M)
from shotlib import *
with sync_playwright() as p:
    s = Session(p, "fran", area="sales")          # area = your register file name
    s.go("customers")                              # hash route; waits for ".main h1"
    s.shot("5.1", "The customer list", callouts=[("a.btn.primary", "New customer"), ("#c-search", "Search")])
    s.page.click("a.btn.primary"); s.page.wait_for_selector("#cu-name")
    s.page.fill("#cu-name", "Demo Fabrication Client Pty Ltd")
    s.shot("5.2", "Entering a new customer", callouts=[...], mask=["#cu-bsb"])
    s.dialog_answers = ["Reason text"]             # answers for the next prompt()/confirm() boxes
    s.close()
```

- `shot(fig, title, callouts=[(selector, label), ...], mask=[selectors], clip="main"|"viewport"|"full"|selector)`. Callouts are numbered ①②③ in the order given and drawn as red numbered badges with a red box around the element. `clip="main"` (default) crops to the content area without the menu; use `"viewport"` when the menu or header matters; use a selector to crop to one panel or form.
- Figure ids: `<module>.<n>` — `5.1`, `5.2` … File: `shots/fig-5.1.png`. Register entry goes to `register/<area>.json` automatically (title, callouts, route, user, number of masks).
- `Session(p, who, mfa="setup"|"confirm"|"signed_out")` shows the MFA set-up screen (demo QR and key only), the "Confirm it's you" screen, or no session. `Session(p, None)` is a signed-out browser. The portal sign-in page is `PORTAL` (`http://localhost:8000/training/`); a wrong password there always returns "invalid credentials".
- Use 3–6 callouts per figure, only on things the text tells the trainee to look at or click, in the order they will use them. Keep callout labels short (2–5 words); they become the legend under the figure.
- **Look at every image you produce** (Read the PNG). Re-shoot if a callout is on the wrong thing, the screen is still "Loading…", a message from a previous step is showing, or something confidential is visible.

### Masking (brief section 4) — even though the data is fictional

Always mask: bank BSBs and account numbers (company, supplier, employee), TFNs, employee dates of birth and home addresses, MFA QR codes or keys other than the demo, individual employees' pay rates and pay amounts unless the step is about them (pay run totals are fine), and anything that looks like a credential. Pass the element selectors in `mask=[...]`. Say in the figure text that the field is masked ("bank details are masked in this manual").

## Writing the module files

One file per module: `modules/M05.md` (two digits). Plain Markdown with these conventions (a converter turns it into the controlled Word document, so stick to them exactly):

- `# Module 5 — Customers` once at the top. `##` and `###` for sections. No deeper levels.
- Paragraphs, `- ` bullets, `1. ` numbered steps, pipe tables with a header row. **Bold** for on-screen labels exactly as shown (**Save and continue**, **Customers**), menu paths with › (**Sales › Customers**).
- A figure goes on its own line as `[[FIG 5.2]]`. The converter inserts the image, the caption "Figure 5.2 — <title>" and the numbered callout legend from the register. Directly after it write the three lines:
  `**What you are looking at:** …`
  `**What you need to click:** …` (refer to callouts as ①②③)
  `**Why this step matters:** …`
- A diagram goes on its own line as `[[DIAGRAM name]]`. Available names: `system-map`, `sales-flow`, `po-flow`, `payrun-flow`, `jobcost`, `bank-recon`, `account-groups`, `month-end`, `decision-tree`, `approvals-map`, `stp-status`. Ask for another in your notes file if you need it.
- Boxes (on their own lines, closed with `:::`):
  - `:::before` … `:::` — BEFORE YOU CLICK checklist; write the items as `- [ ] Correct supplier`.
  - `:::mistake Short title` … `:::` — COMMON MISTAKE.
  - `:::why` … `:::` — WHY THIS MATTERS.
  - `:::next` … `:::` — WHAT HAPPENS NEXT? (what the system does after the action: status change, ledger entry, notification, approval request, audit record).
  - `:::warning` … `:::` — a hard stop or risk.
  - `:::trouble` … `:::` — a short troubleshooting box (problem → check → fix).
  - `:::verify` … `:::` — VERIFICATION REQUIRED (exists in code, not verified on screen, or depends on the live configuration).
  - `:::law` … `:::` — WHAT AUSTRALIAN LAW REQUIRES, kept separate from "how Panalo Accounts works". Only for GST, BAS, PAYG, super, STP, Fair Work, record keeping. Cite an authoritative source (ato.gov.au, fairwork.gov.au, legislation.gov.au) as a Markdown link, and end with "Confirm with Panalo's accountant or registered tax agent before relying on this." If you can't check a figure or date with a search, leave it out.
  - `:::known` … `:::` — KNOWN SYSTEM ISSUE (something odd in the current release a user will notice, such as stale wording or a confusing message). Factual, no blame.
- End every module with:
  - `## Knowledge check` — 3–5 numbered questions built on Panalo work situations (not "What does the Save button do?").
  - `## Trainer answer key` — the answers, numbered to match (this moves to the trainer appendix).
  - `## Practical task` — one task a trainee does in the training environment, with the stopping point.
  - `[[COMPETENCY]]` on its own line (the converter adds the competency sign-off block).

### Voice

An experienced Panalo office manager teaching a new starter. Plain Australian business English. Short explanations with context and consequences. Use Panalo work examples (fabrication jobs, coded welding, shutdowns at a demo client site, welding consumables, steel, crane hire, NDT). Vary sentences. Explain an accounting term in plain words the first time it appears. Avoid: "It is important to note", "Navigate to", "This ensures", "This module provides", "Users should ensure", "seamless", "robust", "leverage", and filler intros. Don't describe the app as ATO approved, STP certified, or as lodging anything with the ATO, a bank or a super fund: it prepares, records and exports; people lodge and pay outside it. Distinguish **prepared**, **marked lodged/sent**, and **accepted** carefully.

Length: as long as the module needs — roughly 1,200–3,000 words, 4–12 figures. Every procedure a user performs gets at least one screenshot; every complex workflow gets a screenshot or diagram.

## Notes file

Also write `notes/<area>.md` with these sections (the troubleshooting manual, quick guides and admin appendix are compiled from them):

1. **Troubleshooting rows** — a pipe table: Problem | Likely cause | First check | Corrective action | Escalate when. Cover the problems the brief lists for your area (Part L) plus anything you found. Base causes on real behaviour and real messages.
2. **Error messages** — pipe table: Message shown (exact) | What it normally means | What the user should check | What not to do | When to contact the administrator. The important ones for your area (15–40 rows), verified in source.
3. **Quick reference guide drafts** — for the guides in brief section 47 that belong to your area: title, 4–8 numbered steps, and the figure id to use.
4. **Admin technical notes** — for each main screen: route, source file, main functions, API actions called (name → permission), SQL functions behind them, typical symptoms and diagnostic steps, safe remediation, when code changes are needed. No secrets.
5. **Known issues and Verification Required items** — anything odd or unfinished you found (stale text, quirks, buttons that error), with file and line.
6. **Role matrix** — which roles (Super admin/system admin, Director, Finance admin, Payroll admin, Project manager, Supervisor, Accountant/auditor, Employee) can view / do / approve each activity in your modules.
7. **Competency checklist items** — 3–6 observable practical items per module ("Enters a supplier bill with the supplier invoice number, PO and project, and stops at Submit").
