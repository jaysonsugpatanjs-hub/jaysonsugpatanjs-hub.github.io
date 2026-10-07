# Banking (Panalo Accounts, Phase 6)

Bank statement imports, matching statement lines to the ledger, bank rules,
bank reconciliation, and paying by bank file (ABA): payment batches for
supplier bills and the net pay of a pay run. There is no live bank feed:
statements are downloaded from internet banking and imported. Bank feeds need
an accredited data recipient under the Consumer Data Right, which this system
isn't.

## Bank accounts

**Banking > Bank accounts** lists every ledger account of type bank with its
ledger balance today, the latest statement balance imported, the lines still
to match and the date it was last reconciled.

Company bank accounts (the real accounts, set up in Company settings with a
second person's approval, Phase 1) are linked to their ledger account here,
and given the details the bank issues for direct entry files:

| Setting | What it is |
| --- | --- |
| Ledger account | The bank account in the chart of accounts this real account is |
| APCA user ID | 6 digits, issued by the bank for direct entry (sometimes "user ID" or "DE ID") |
| Bank code | 3 letters: CBA, WBC, NAB, ANZ, and so on |
| User name for bank files | Up to 26 characters, as registered with the bank |
| Balancing record | Some banks want a final debit line to the paying account; ask yours |

An account is "ready for bank files" when all four are set. The BSB and account
number can only be changed in Company settings, with approval.

## Importing statements

**Import statement** on an account reads, in the browser:

- **CSV** in any column layout. The columns are guessed and can be changed:
  date, one amount column (money out negative) or separate money out and in
  columns, description, reference, balance. Dates are day/month/year unless
  changed. "Swap money in and out" handles files that show spending as
  positive.
- **OFX / QFX** (SGML or XML), with the bank's transaction IDs and the closing
  balance.
- **QIF**, with day/month/year or month/day/year dates (Quicken uses
  month/day/year: check the preview).

Lines that can't be read are listed and left out. Up to 5,000 lines and 5 MB a
file. The closing balance and its date (from the file, or typed in) are kept
to check the reconciliation.

**Duplicates.** Overlapping downloads are normal, so a line is skipped when
the account already has a line with the same bank transaction ID, or the
same date, amount and description (case and spacing ignored). Identical
lines on the same day (two $15 fees) are counted, so the second is kept the
first time and skipped the next time. A new line dated on or before the last
reconciliation is flagged after the import: that reconciliation missed it,
or it is a duplicate worded differently.

**Undo.** An import can be undone while none of its lines is matched or
excluded, and no later import covering the same dates relies on its lines.

## Matching

Every statement line is matched to what it is in the ledger, or excluded.
**Reconciliation > To match** shows each line with suggestions:

- **Existing ledger lines** on the same bank account with the same amount,
  within 14 days, ranked by date and shared words (receipts, supplier
  payments, pay run net pay and super, journals). Several ledger lines can be
  ticked to make up one statement line (a deposit of several cheques, say).
- **An invoice or bill** owing that amount, or whose number or reference is in
  the description: the receipt or supplier payment is recorded from the line
  and matched in one step.
- **A pay run's** net pay or super, recorded as paid from the line.
- **A bank rule** (below), which fills in a "spend or receive money" entry.

Or **spend / receive money** creates a journal from the line, split over up
to five accounts with GST (amounts include GST), and matches it. Or
**exclude** it with a reason (a duplicate, a line that isn't in the books).

A ledger line can match one statement line only, on the same bank account.
Matching can be undone until the line is reconciled. A journal with matched
or reconciled bank lines can't be reversed: unmatch it first.

## Bank rules

A rule says "lines whose description contains this text (and optionally:
money in or out, an amount range, one bank account) are usually this account
and tax code, paid to this payee". Rules are checked in priority order and
only **suggest**: a person still accepts each entry. Rules never post anything
on their own.

## Reconciliation

**Reconciliation > Reconcile** at a statement date:

    ledger balance at the date
    − entries not yet through the bank (unpresented)
    + entries in the bank by then but dated after it
    = what the statement should show

It can be completed when every statement line up to the date is matched or
excluded, and that equals the closing balance on the statement. The first
reconciliation can treat ledger entries before a cut-off date as already
through the bank (the opening position), so history from before the first
imported statement doesn't have to be matched line by line.

A completed reconciliation locks its statement lines, and the report
(balance per statement, unpresented items, lines reconciled) can be printed.
Only the latest reconciliation of an account can be undone, with a reason.

## Paying by bank file (ABA)

### Payment batches (supplier bills)

1. **Make** (`bank.manage`): choose the paying account (one ready for bank
   files), the payment date and the bills. Only approved bills whose supplier
   has an approved bank account can be paid; each bill once across open
   batches; at most what's owing. The supplier bank details, the amounts and
   the ledger bank account are fixed in the batch now.
2. **Approve**: someone other than the person who made it. Approval checks
   again that each bill still owes that much, the supplier's bank details
   haven't changed since, and the paying account is still active and linked.
3. **Download the bank file** (only after approval; every download is
   logged) and upload it in internet banking. The file holds bank details:
   delete it after uploading.
4. **Mark as paid** once the bank has processed it: one supplier payment per
   supplier is recorded from the ledger bank account (Dr trade creditors,
   Cr bank), and the bills are paid. Match the statement line to those
   payments when it arrives.

While a bill is in a batch waiting for approval or payment it can't be paid,
credited or voided any other way, so a supplier is never paid twice.
**Cancel** a batch to free its bills; once the file has been downloaded,
someone other than the person who downloaded it must cancel it, after
checking with the bank that it wasn't processed.

### Pay runs

On an approved pay run, **Bank file (ABA)** (`payroll.sensitive`) makes a file
paying each employee's net pay to their approved bank account, from the
company account marked for payroll (or the only one ready for bank files). It
is refused if anyone being paid has no approved bank account. Then record the
net pay as paid, or match the statement line.

### File format

The Australian direct entry (ABA, "Cemtex") format: fixed 120-character
records, CRLF line ends.

| Record | Contents |
| --- | --- |
| 0 descriptive | Reel 01, bank code, user name, APCA user ID, description (12), processing date DDMMYY |
| 1 detail, one per payment | BSB, account number (9), transaction code (50 general credit for suppliers, 53 pay for wages), amount in cents, account name (32), lodgement reference (18: the bill's supplier reference or number, or "PAY" and the pay run), trace BSB and account (the paying account), remitter name (16) |
| 1 balancing, optional | Code 13 debit to the paying account for the total |
| 7 file total | Net, credit and debit totals and the count of detail records |

Text is upper-cased and limited to the characters banks accept. Account
numbers longer than 9 digits can't be carried in the format; those payees
must be paid separately.

**Test with your bank first**: upload a small batch (one payment of a few
dollars) and check it in internet banking before relying on it. Banks differ
on the balancing record and on the description field.

## Who can do what

| Action | Permission |
| --- | --- |
| See bank accounts, statement lines, reconciliations | `bank.manage` or `reports.view` |
| Import, match, create entries, rules, reconcile, undo | `bank.manage` |
| Make, approve (not your own), download, mark paid, cancel payment batches | `bank.manage` |
| Pay run bank file | `payroll.sensitive` |

All of these need two-step sign-in, and every change is in the audit log.

## Database changes (`20261012000000_banking.sql`)

- Current structure: company bank accounts (Phase 1) without a ledger link;
  supplier payments recorded by hand (Phase 3); pay run payments recorded by
  hand (Phase 5).
- Change: company bank accounts get a ledger link and ABA settings; new
  tables `bank_imports`, `bank_transactions`, `bank_matches`,
  `bank_cleared_lines`, `bank_reconciliations`, `bank_rules`,
  `payment_batches`, `payment_batch_items`; numbering `PB-`; guards that stop
  reversing a journal with matched or reconciled bank lines, and paying,
  crediting or voiding a bill in an open payment batch any other way.
- Reason: Phase 6 of the brief.
- Affected modules: journals (reversal guard), bills and supplier payments
  (batch guard), company bank accounts, pay runs (bank file), dashboard.
- Migration strategy: additive; existing rows unchanged. Existing bank
  history is brought in by the first reconciliation's cut-off date.
