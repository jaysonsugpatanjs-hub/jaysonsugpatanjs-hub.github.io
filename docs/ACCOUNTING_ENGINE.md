# Accounting engine

## One door to the ledger

`ledger_post_entry(actor, date, memo, source_type, source_id, source_ref, lines, amounts_are, manual)`
is the only function that writes posted journal lines. Manual journals use it
indirectly (`journal_post` rebuilds the lines with the same rules). From
Phase 3 every module (invoices, bills, payments, pay runs, depreciation) calls
it with its own `source_type` and `source_id`, so each journal links back to
the document that created it.

What it does, in one transaction:

1. Finds the accounting period for the date. Closed periods refuse every
   posting; soft-locked periods accept postings only from people holding
   `ledger.reopen`.
2. Builds the lines (`ledger_build_lines`): each line has an account, a debit
   or a credit (never both, never zero, at most 2 decimals) and an optional tax
   code. Archived accounts are refused; control accounts (receivables,
   payables, current year earnings) refuse manual lines.
3. Adds a GST line to the GST account (2300) for each taxed line, on the same
   side. GST is worked out per line and rounded to the cent, half up:
   - tax exclusive: GST = amount × rate; the line keeps its amount;
   - tax inclusive: GST = amount × rate ÷ (1 + rate); the line is reduced by
     the GST.
4. Refuses the entry unless total debits equal total credits.
5. Numbers it from the `journal` sequence (`JE-000001`), posts it and writes
   the audit row.

The database also refuses unbalanced journals on its own: a deferred
constraint trigger checks every journal as it becomes posted.

## Immutability and corrections

- Posted journals and their lines cannot be updated or deleted (triggers).
- `journal_reverse` posts the mirror image (debits and credits swapped,
  including GST lines), links both ways (`reverses_id`, `reversed_by_id`) and
  marks the original `reversed`. Both journals stay in the ledger, so the pair
  nets to nil.
- Drafts are not part of the ledger and can be edited or deleted.

## Who can do what

| Action | Permission |
| --- | --- |
| Create and edit draft journals | `ledger.journal` |
| Post, reverse, lock or close periods | `ledger.post` |
| Reopen a closed period (reason required) | `ledger.reopen` |
| Accounts, tax codes, add financial years | `ledger.manage` |
| Reports | `reports.view` |
| Export reports (logged) | `data.export` |

A draft from someone without `ledger.post` (for example the accountant role)
therefore always needs a second person to post it.

## Reports

All figures are summed in Postgres `numeric`; reversed journals and their
reversals both count, so they cancel.

- **Trial balance** as at a date: balance sheet accounts to date; profit and
  loss accounts for the financial year containing the date; profit from
  earlier years is added to retained earnings (3100).
- **Profit and loss** for a date range: trading income, cost of sales, gross
  profit (and margin), operating expenses, other income and expenses, net
  profit.
- **Balance sheet** as at a date: assets, liabilities, equity accounts, plus
  retained earnings (prior years' profit) and current year earnings. It
  reports whether net assets equal total equity.
- **Account transactions**: opening balance, each line with its journal, and a
  running balance.

## Seeded data

- The chart of accounts from the brief (section 39), plus 7850 "ATO interest
  and penalties (non-deductible)". It should be reviewed by Panalo's
  accountant; codes and names are configurable.
- Tax codes GST, GSTE, CAP, FRE, EXP, FREE, ITS, ITP, NG, OOS, each with the
  BAS labels it will feed in Phase 7.
- Financial years FY2025-26 and FY2026-27 with monthly periods, starting in
  the month set in company settings (July by default).
