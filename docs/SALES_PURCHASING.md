# Sales and purchasing (Panalo Accounts, Phase 3)

Customers, quotes, invoices, credit notes and receipts on the sales side;
suppliers, purchase orders, bills, supplier credits and payments on the
purchasing side. Every document that changes what someone owes posts through
the one ledger engine (`ledger_post_entry`, see `ACCOUNTING_ENGINE.md`), with
`source_type` and `source_id` pointing back at the document.

## Documents and their life cycle

| Document | Statuses | Posts to the ledger when |
| --- | --- | --- |
| Quote | Draft → Approved → Sent → Accepted / Declined → Invoiced (or Cancelled). "Expired" is shown when the valid-until date has passed. | Never |
| Invoice | Draft → Approved → (Void) | Approved |
| Credit note (adjustment note) | Draft → Approved → (Void) | Approved |
| Purchase order | Draft → Submitted → Approved → Issued → Part received → Completed (or Cancelled) | Never |
| Bill | Draft → For review → Approved → (Void) | Approved |
| Supplier credit | Draft → Approved → (Void) | Approved |
| Payment received / supplier payment | Banked or Paid → (Void) | When recorded |

"Paid" and "Overdue" are worked out from what is still owing, not stored.

- Invoice and credit note numbers are given **on approval**, from the
  numbering in Company settings, so drafts never leave gaps. Quotes, purchase
  orders and bills are numbered when created.
- An approved document can't be edited. It is corrected by **voiding** it
  (the journal is reversed and the number stays used) or, for invoices, by a
  **credit note**. A document can't be voided while payments or credits are
  applied to it; remove those first.
- Unapproved drafts can be deleted; they were never in the books.
- Manual journal reversal refuses journals that belong to a document ("void
  the invoice itself"), so the document and the ledger never disagree.

## What gets posted

Amounts are calculated per line, to the cent, half up, with the same rule as
the engine: `amount = round(qty × unit price × (1 − discount%), 2)`; GST is
`round(amount × rate, 2)` (exclusive) or `round(amount × rate ÷ (1 + rate), 2)`
(inclusive). The browser shows the same figures before saving.

| Event | Debit | Credit |
| --- | --- | --- |
| Invoice approved | 1100 Accounts Receivable (total) | Income lines (ex GST) and 2300 GST |
| Credit note approved | Income lines and 2300 GST | 1100 Accounts Receivable |
| Payment received | Bank | 1100 Accounts Receivable |
| Bill approved | Expense / cost / asset lines (ex GST) and 2300 GST | 2000 Accounts Payable (total less any withholding) and 2100 PAYG withholding (if any) |
| Supplier credit approved | 2000 Accounts Payable | Expense lines and 2300 GST |
| Supplier payment | 2000 Accounts Payable | Bank |
| Any void | The exact mirror of the original journal | |

Accounts Receivable, Accounts Payable and Current Year Earnings take no manual
journals, so their balances always come from these documents.

When a document is approved its lines are recalculated with the current
accounts and tax codes. If anything changed since it was saved (a rate, an
archived account), approval stops and asks for the document to be re-saved,
so the ledger always matches what was printed. Lines worth $0 (for example a
100% discount) are shown on the document but left out of the journal. A
document can have up to 150 lines.

### Tax codes must fit the side

Sales lines take codes that apply to sales or both (GST, FRE, EXP, ITS, NG,
OOS); purchase lines take purchase codes (GSTE, CAP, FREE, ITP, NG, OOS). A
purchase code on a sale would put the amount in the wrong BAS label, so the
database refuses it. Sales lines use income accounts; purchase lines use
expense, cost of sales or asset accounts.

## Tax invoices and adjustment notes

The invoice PDF shows what the ATO lists for a tax invoice: the words "Tax
invoice", Panalo's name and ABN, the issue date, each item's description,
quantity and price, the GST, and which items have no GST (marked `*`). The
customer's name (and ABN when known) is always shown, which covers the extra
requirement for invoices of $1,000 or more. An invoice can't be approved until
Panalo's ABN is in Company settings. If the company is set as not registered
for GST, the PDF says "Invoice" instead.

If Company settings say Panalo isn't registered for GST, invoices with GST
can't be approved. On the purchasing side, GST can only be claimed from a
supplier that has an ABN and is registered for GST.

Credit notes print as an **adjustment note** with the GST adjustment and the
invoice they adjust. Customers that need their purchase order number on every
invoice can be flagged; approval is then blocked without a reference.

The bank account printed on invoices is the one approved in Company settings
with "show on invoices" (a second person approved it).

Source: ATO, *Tax invoices* and *Adjustment notes* (ato.gov.au). Panalo's
accountant should confirm the layout meets their expectations.

## Payments, part payments and overpayments

A payment is entered once, for the amount that arrived in the bank, and then
**allocated** to one or more invoices (oldest first with one click). Rules:

- An allocation can't exceed what the invoice still owes, and the total
  allocated can't exceed the payment.
- An allocation is dated no earlier than the documents it joins (a payment
  received before its invoice is applied on the invoice date), so ageing at
  any past date agrees with the ledger.
- Money not allocated stays on the customer's account as a credit, shown in
  the ageing "Credits" column, and can be applied later from the payment or
  from the invoice.
- Credit notes are applied to invoices the same way.
- Voiding a payment reverses its bank entry and removes its allocations, so
  the invoices go back to owing.

Supplier payments work the same way, except that **only approved bills can be
paid**: unapproved bills aren't offered and the database refuses them.

## Withholding where a supplier quotes no ABN

If a supplier has no ABN on file (and isn't marked exempt), approving a bill
whose amount excluding GST is more than $75 withholds 47% of the total. The
bill then posts the withheld amount to 2100 PAYG Withholding Payable (owed to
the ATO, reported on the BAS) and only the rest to Accounts Payable. The
editor previews this before saving.

The rate and threshold are **dated compliance rules**
(`compliance_rules`: `no_abn_withholding_rate` 0.47 and
`no_abn_withholding_threshold` 75, effective 1 July 2024, with the source
noted). A future change is added as a new row with its own start date; past
bills keep the rule that applied on their date.

Source: ATO, *PAYG withholding where an ABN is not provided*. Exemptions
(for example a supplier's statement that the work is a private hobby) are the
accountant's call; the "withholding doesn't apply" flag records that decision.

## Suppliers and bank details

- Suppliers carry ABN, GST registration, trade type, subcontractor and TPAR
  flags, insurance and licence expiry dates. The list warns about missing
  ABNs and insurance or licences expiring within 30 days.
- **Bank details are never edited directly.** A change is a request that
  someone else with "Approve supplier bank changes" (`purchases.bank`) must
  approve; the approver sees the old and new details and a warning to confirm
  by phone. Account numbers are masked for people who don't handle payments.

## Purchase orders and three-way matching

- Project managers (`purchases.raise`) create and submit orders and record
  goods received; someone with `purchases.manage` approves, issues, closes or
  cancels them. A requester without `purchases.manage` can never approve their
  own order.
- Receiving more than was ordered is refused. The order moves to "Part
  received" and then "Completed" automatically.
- "Enter the bill" from an order pre-fills what has been received and not yet
  billed. Each bill line keeps a link to its order line, and the bill shows
  ordered, received and billed quantities and prices side by side, flagging
  any line billed beyond what was received or above the ordered price. The
  approver is asked to confirm before approving a bill that doesn't match.
- A bill can't reference an order for a different supplier or an unapproved
  order; a supplier's invoice number can't be entered twice for the same
  supplier.

Separation of duties: someone with `purchases.manage` can enter and approve
the same bill, and approve an order they raised. If Panalo wants a second
person for those too, that is a small rule change; say so.

## Reports

- **Aged receivables** and **aged payables** as at any date: Current, 1–30,
  31–60, 61–90 and over 90 days past the due date, plus unapplied credits.
  Allocations dated after the report date are ignored, so past dates are
  reproducible. The total agrees with the Accounts Receivable (1100) or
  Accounts Payable (2000) balance at the same date; the tests check this.
- **Customer statements** for a date range: opening balance, each invoice,
  credit note and payment with a running balance, closing balance and ageing;
  on screen or as a PDF.
- Quote, invoice, adjustment note, purchase order and statement PDFs are
  generated on request (each generation is logged); nothing is emailed yet.

## Who can do what

| Action | Permission |
| --- | --- |
| Customers, quotes, invoices, credit notes, applying credits | `sales.manage` |
| Suppliers, bills, supplier credits, approving purchase orders | `purchases.manage` |
| Raise purchase orders and record goods received | `purchases.raise` (project manager) or `purchases.manage` |
| Approve supplier bank changes (never your own request) | `purchases.bank` |
| Record or void payments received and supplier payments | `bank.manage` |
| See all of the above, ageing and statements | `reports.view` |
| Attach files | the permission for that record |

Attachments (supplier invoices, signed orders, remittances) are stored in the
private `finance-documents` bucket under the record they belong to and opened
with short-lived links.

## Database changes (`20261009000000_sales_purchasing.sql`)

- Current structure: ledger only; no customers, suppliers or documents.
- Change: `compliance_rules`; `customers`, `suppliers`; `quotes`, `invoices`,
  `purchase_orders`, `bills` with their line tables; `customer_payments`,
  `supplier_payments`, `receivable_allocations`, `payable_allocations`;
  security-definer functions for every action; ageing and statement reports;
  `purchases.raise` permission; approval kind `supplier_bank`;
  `ledger_reverse_entry` (internal) now shared by `journal_reverse` and
  document voids.
- Reason: Phase 3 of the brief.
- Affected modules: approvals (new kind), manual journal reversal (refuses
  document journals), dashboard (sales and purchasing figures).
- Migration strategy: additive. New tables have row-level security on and no
  browser access; everything goes through `finance-api`.

## Not in this phase

- **Emailing** invoices, statements and remittances: needs an email sender
  (SMTP or a provider) connected first. PDFs download today.
- **Bad-debt write-offs with approval** and the GST adjustment that goes with
  them: planned with the BAS work (Phase 7).
- **Expense claims**: planned with payroll (Phase 5), since they are paid with
  or like wages.
- **Scheduled payment batches and ABA bank files**: Phase 6 (banking). Today a
  payment is recorded after it has been made.
- Recurring invoices and retentions.
