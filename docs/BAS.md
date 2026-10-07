# BAS and TPAR (Panalo Accounts, Phase 7)

Workpapers for the business activity statement (BAS) and the taxable payments
annual report (TPAR), worked out from the ledger. **This is a preparation
system: nothing is sent to the ATO.** The BAS is lodged through ATO online
services for business or the tax agent, then marked lodged here. Have the
accountant check the first few against what they would lodge.

## Where the figures come from

Every tax code carries the BAS labels it reports at (set up in Phase 2):

| Code | Kind | Labels |
| --- | --- | --- |
| GST | GST on income | G1, 1A |
| FRE | GST-free income | G1, G3 |
| EXP | Exports | G1, G2 |
| ITS | Input-taxed sales | G1, G4 |
| GSTE | GST on expenses | G11, 1B |
| CAP | GST on capital purchases | G10, 1B |
| FREE | GST-free expenses | G11, G14 |
| ITP | Input-taxed purchases | G11, G13 |
| NG, OOS | Not reported | none |

- **G labels** are GST-inclusive totals: the amounts on lines with the code,
  plus the GST lines the posting engine wrote for them.
- **1A and 1B** are the GST actually charged and paid (the GST lines), not
  G9 or G20. The calculation worksheet (G5 to G20) is shown to check them:
  G9 and G20 should be close to 1A and 1B.
- Amounts are signed by the code: credit notes, refunds and reversals reduce
  the labels in the period they're dated.
- **Accrual basis:** by the date of the invoice, bill or journal.
- **Cash basis:** invoices and bills count in proportion to what is paid in
  the period. The payment counts when it is both received and allocated, and
  a voided payment counts back out when it is voided. Bills are measured
  against what's payable to the supplier (total less no-ABN withholding).
  Other entries (spend and receive money from the bank, journals) count by
  their date. The GST on unpaid invoices and bills stays in the GST account.

The basis comes from Company settings when the BAS is made, and stays with it.

**PAYG withholding** is reported when the payment is made, on either basis:

- **W1:** pay subject to withholding from pay runs paid in the period, after
  salary sacrifice (as the ATO asks).
- **W2:** PAYG withheld by those pay runs, including study loan amounts.
- **W4:** no-ABN withholding (47%), in proportion to what was paid on each
  bill in the period.
- **W3** isn't used by Panalo.
- **W5** = W2 + W4 + W3, and goes to label 4.

**Entered by hand:** 5A PAYG income tax instalment (from the instalment
notice) and 7D fuel tax credits (from the ATO calculator).

**Summary:** 8A = 1A + 4 + 5A; 8B = 1B + 7D; 9 = 8A − 8B (payment due, or a
refund if negative). Labels are in whole dollars: cents are dropped from each
reported amount, and totals such as W5 and 8A are added up from the reported
amounts.

**Simpler BAS** (turnover under $10 million) reports only G1, 1A and 1B for
GST; **full reporting** reports G1 to G20. Choose per BAS; the workpaper shows
everything either way.

Not supported: GST instalments (option 3), the 1C to 1G, 5B and 7C labels,
wine equalisation tax, luxury car tax, deferred GST on imports, and G7/G15/G18
adjustments by hand (make them as journals with a tax code instead).

## Checking before lodging

- **Reconciliation:** the GST account's movement in the period (BAS transfers
  left out) against 1A less 1B. On the cash basis the accrual figure is
  shown, plus the cash figure for this BAS. PAYG withholding posted by pay
  runs is compared with W2, and no-ABN withholding posted on bills with W4
  (the part paid).
- **To check:**
  - income, cost and asset lines with no tax code;
  - a sales code on a cost, or a purchase code on income;
  - capital or non-capital purchases at the wrong label;
  - GST that isn't 10% of the coded amount;
  - entries made straight to the GST account;
  - GST claimed from suppliers with no ABN or not registered for GST;
  - draft invoices and bills, and unapproved pay runs, in the period;
  - unmatched bank lines.

  Warnings come first, up to 500.
- **Drill-down:** under GST by tax code, the entries behind each code. On the
  cash basis, each invoice and bill is shown with the share paid in the period.

## Prepare, review, lodge, pay

1. **Prepare** (`tax.bas`): choose the period. Monthly is a calendar month;
   quarterly is July to September, October to December, January to March or
   April to June; annual is the financial year. Periods can't overlap. Enter
   5A and 7D and notes.
2. **Review** (`tax.review`): by someone who didn't prepare or change it, and
   only once every earlier BAS is lodged. The figures are fixed at review:
   what is reviewed is what is lodged. If the books for the period change
   afterwards, it can't be marked lodged until it is sent back to draft and
   reviewed again.
3. **Lodge** with the ATO, then **mark lodged** (`tax.bas`) with the date and
   the ATO reference. This posts the transfer journal, dated when lodged:
   - Dr GST account (1A − 1B, exact);
   - Dr PAYG withholding (W5, exact);
   - Dr 1450 PAYG instalments (5A);
   - Cr 4850 fuel tax credits (7D);
   - Cr 2350 ATO integrated client account (9, or Dr for a refund);
   - the cents dropped go to 7950 BAS rounding.

   Optionally the months of the period are soft-locked, so only people who
   can reopen periods can post into them. The journal can't be reversed.
4. **Pay** (or receive the refund): record it against the BAS (Dr 2350,
   Cr bank), then match the bank statement line to it in Reconciliation.
   A payment recorded by mistake can be voided (unless it is already matched
   to a bank line).

Due dates are the ATO's for lodging yourself:

| Frequency | Due |
| --- | --- |
| Monthly | 21st of the next month |
| Quarter ending September | 28 October |
| Quarter ending December | 28 February |
| Quarter ending March | 28 April |
| Quarter ending June | 28 July |
| Annual | 31 October |

Tax agents may have later dates under the lodgment program, and a due date
on a weekend or public holiday moves to the next business day.

### Changes after lodgement

Entries can still land in a lodged period:

- someone who can reopen periods posts into it;
- an invoice or bill is voided later, which reverses it on its own date;
- a payment is allocated later.

Each lodged BAS is worked out again; what changed since it was lodged, and
hasn't been carried yet, is added to the next BAS prepared as adjustments,
by label, and shown on its workpaper ("Includes changes to earlier BAS").
The lodged BAS shows what is still to carry. If a change is large, revise the
earlier BAS with the ATO instead (your accountant will advise).

## TPAR

**Tax > TPAR** lists, for a financial year, payments made to suppliers
marked "Report on the TPAR" (set on the supplier: building and construction
subcontractors).

| Field | What is reported |
| --- | --- |
| ABN, name, address | From the supplier |
| Gross amount paid | Including GST and any no-ABN tax withheld, in proportion to the bills paid in the year |
| Total GST | The GST in those payments |
| Tax withheld | No-ABN withholding in those payments |

Payments not applied to a bill are included in full, and flagged because
their GST isn't known. Suppliers with a missing address or no ABN and no
withholding are flagged too. Subcontractors paid in the year but not marked
are listed, so none is missed. Payments for materials only shouldn't be
reported: leave those suppliers unmarked.

Download the list (CSV) and report it through ATO online services or the tax
agent by **28 August**. Then mark the year lodged here (only after it ends).
TPAR electronic files (the ATO's fixed-format specification) aren't produced.

## Who can do what

| Action | Permission |
| --- | --- |
| See BAS and TPAR | `tax.bas` or `tax.review` |
| Prepare, change, mark lodged, record payments, TPAR lodged | `tax.bas` (payments also `bank.manage`) |
| Review | `tax.review`: directors and accountants by default, never the preparer or anyone who changed it |

Both need two-step sign-in, and every step is in the audit log.

## Database changes (`20261013000000_bas.sql`)

- Current structure: tax codes with BAS labels and GST settings (Phases 1
  and 2); no BAS records.
- Change:
  - Permission `tax.review` (directors and accountants; accountants also get
    `tax.bas`).
  - Accounts 2350 ATO integrated client account, 1450 PAYG instalments paid,
    4850 fuel tax credits and 7950 BAS rounding.
  - Tables `bas_returns`, `bas_payments` and `tpar_lodgements`.
  - Functions for the figures, adjustments, reconciliation, exceptions, due
    dates, the BAS steps and TPAR.
  - A guard against reversing BAS journals.
- Reason: Phase 7 of the brief.
- Affected modules: ledger (new accounts, reversal guard, period locks),
  dashboard, menu.
- Migration strategy: additive; no existing rows change.

## Sources

- ATO, Business activity statements: PAYG withholding labels W1 to W5
- ATO, Due dates for lodging and paying your BAS
- ATO, Taxable payments annual report: payments to report, contractor details
  to report (due 28 August)
