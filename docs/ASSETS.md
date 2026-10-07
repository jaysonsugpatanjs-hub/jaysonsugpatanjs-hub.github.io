# Fixed assets (Panalo Accounts, Phase 8)

A register of tools, vehicles, plant and office equipment, with accounting
depreciation posted to the ledger each month, disposals, documents, and a
check that the register agrees with the ledger.

**Accounting depreciation and tax depreciation are kept apart.** The register
posts accounting depreciation (your estimate of how the asset is used up).
Tax treatment (prime cost or diminishing value, effective life, instant asset
write-off, small business pool) is recorded on each asset as a note for the
accountant. It isn't posted, claimed or reported from here.

## Categories

| Category | Cost | Accumulated depreciation | Method | Useful life |
| --- | --- | --- | --- | --- |
| Tools and equipment | 1500 | 1510 | Straight line | 5 years |
| Vehicles | 1600 | 1610 | Diminishing value | 8 years |
| Plant and machinery | 1700 | 1710 | Straight line | 10 years |
| Office equipment | 1800 | 1810 | Straight line | 3 years |

All post the expense to 7800 Depreciation. Each asset can override the method,
useful life and residual value. A category's cost and accumulated
depreciation accounts can't change once assets use it.

## Adding an asset

- **From a bill.** Approved bills with lines on a fixed asset account are
  listed on the register ("not in the register yet"). Adding one fills in the
  supplier, bill, date, cost before GST, GST and category.
- **By hand.** For anything else. Adding an asset doesn't post its cost: the
  purchase reaches the ledger through its bill, or a journal for opening
  balances.
- **Brought in from another system.** Enter the opening depreciation and the
  date it is at. Depreciation runs from the day after.

Numbers are FA-0001 onwards. Once an asset has been depreciated, its cost,
category, in-service date and opening depreciation are fixed (undo the runs
to change them). Photos, invoices and registration papers can be attached.

## Depreciation

- **Straight line:** (cost − residual value) ÷ useful life, each month.
- **Diminishing value:** book value at the start of the month × 200% ÷ useful
  life ÷ 12.
- Part months are by days (first month in service, month of disposal).
- Never below the residual value.

Runs go to a month end, month by month. One run posts one journal, with an
expense line and an accumulated depreciation line for each category, coded
NG (no GST) so the BAS checks leave them alone. Only the latest run can be
undone; its journal is reversed on its own date. The journal can't be
reversed any other way. The period must be open (a soft-locked period needs
`ledger.reopen`).

## Disposal

Sell, trade in, scrap or write off. Depreciation is worked out to the
disposal date and posted with it. The journal:

| Account | Debit | Credit |
| --- | --- | --- |
| Accumulated depreciation | Depreciation to date | |
| Asset at cost | | Cost |
| 7800 Depreciation, and accumulated depreciation | Part month | Part month |
| 7810 Book Value of Assets Disposed | Book value | |
| Bank (or a clearing account) | Proceeds + GST | |
| 4950 Proceeds from Sale of Assets | | Proceeds (with the tax code) |
| GST collected | | GST |

A taxable sale's GST goes to the BAS (G1 and 1A). The profit or loss is
4950 less 7810. Disposals can't be undone from the register; a correcting
journal would be needed.

## Reconciliation

For each category, at a date: the register's cost and accumulated
depreciation against the ledger balances of the category's accounts. A
difference usually means a bill or journal on a fixed asset account that
isn't in the register, a cost different from the bill, or opening balances
not brought in. Categories that share accounts show the shared balance.

## Who can do what

| Permission | Can |
| --- | --- |
| `assets.manage` ("Fixed assets": super admin, director, finance admin) | Add and edit assets and categories, run and undo depreciation, dispose, attach documents |
| `reports.view` | See the register, assets, runs and reconciliation, open documents |

Every change is audited with old and new values.

## Database changes (`20261015000000_assets.sql`)

- Current structure: fixed asset and accumulated depreciation accounts (1500
  to 1810) and 7800 Depreciation in the chart; no register.
- Change: permission `assets.manage`; accounts 4950 Proceeds from Sale of
  Assets and 7810 Book Value of Assets Disposed; number sequence FA-;
  `asset_categories`, `assets`, `asset_depreciation_runs`,
  `asset_depreciation`; functions to save, depreciate, undo, dispose and
  reconcile; asset documents; a guard on depreciation and disposal journals.
- Reason: Phase 8 of the brief (fixed asset register, depreciation separate
  from tax treatment, disposals, documents).
- Affected modules: ledger (chart, journals, reversal), documents, BAS
  (proceeds GST).
- Migration strategy: additive; no existing rows change.

## Not included

Tax depreciation schedules, balancing adjustments, the small business pool,
revaluations, impairment, leases (AASB 16), and asset transfers between
categories. Have the accountant confirm the useful lives and methods.
