// End-to-end tests for Phase 3 (sales and purchasing) in finance-api.
// Fixtures: @fin.test people with roles (pm@fin.test is a project manager, from
// sales_purchasing.test.sql) and the documents that test file posted.
import { pdfText } from "./pdf-lib-stub.ts";
import { storageCalls } from "./client.ts";

const BASE = Deno.env.get("POSTGREST_URL") || "http://127.0.0.1:3999";
const fns = new URL("../../functions/", import.meta.url);
const financeApi = (await import(new URL("finance-api/index.ts", fns).href)).default;

async function rest(path: string) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return await res.json();
}
const profile = async (email: string) => (await rest(`training_profiles?select=id&email=eq.${encodeURIComponent(email)}`))[0].id;

async function call(user: string, body: Record<string, unknown>) {
  const res = await financeApi.fetch(new Request("https://x.test/fn", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jaysonsugpatanjs-hub.github.io", "x-test-user": user, "x-test-aal": "aal2" },
    body: JSON.stringify(body)
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function expectStatus(r: { status: number; body: any }, expected: number, label: string) {
  if (r.status !== expected) throw new Error(`${label}: expected ${expected}, got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}
const ok = async (user: string, body: Record<string, unknown>) => expectStatus(await call(user, body), 200, String(body.action));
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const FIN = await profile("finance@fin.test");
const DIR = await profile("director@fin.test");
const PAY = await profile("payroll@fin.test");
const STAFF = await profile("staff@fin.test");
const PM = await profile("pm@fin.test");

const sales = await ok(FIN, { action: "sales_setup" });
const purch = await ok(FIN, { action: "purchases_setup" });
const acc = (list: any[], code: string) => list.find((a: any) => a.code === code)?.id;
const tax = (list: any[], code: string) => list.find((t: any) => t.code === code)?.id;
const BANK = acc(sales.bankAccounts, "1000");

Deno.test("sales setup: only income accounts and sales tax codes are offered", () => {
  assert(sales.accounts.every((a: any) => ["revenue", "other_income"].includes(a.type)), "non-income account offered on sales");
  assert(!sales.accounts.some((a: any) => a.code === "1100"), "control account offered");
  assert(BANK, "bank account missing");
  assert(sales.can.manage && sales.can.bank, "finance admin flags");
  assert(purch.accounts.every((a: any) => !["revenue", "other_income", "equity"].includes(a.type)), "income account offered on purchases");
  assert(purch.noAbnWithholdingRate === 0.47, "no-ABN rate comes from the compliance rules");
});

Deno.test("permissions: read-only roles can look but not change", async () => {
  expectStatus(await call(PAY, { action: "customer_save", name: "Nope Pty Ltd" }), 403, "payroll can't add customers");
  expectStatus(await call(PAY, { action: "receipt_record", customerId: "00000000-0000-4000-8000-000000000001", amount: 1 }), 403, "payroll can't record receipts");
  await ok(PAY, { action: "invoices_list" });
  expectStatus(await call(PM, { action: "bill_save" }), 403, "project manager can't enter bills");
  expectStatus(await call(STAFF, { action: "invoices_list" }), 403, "no finance keys, no access");
});

Deno.test("customer, invoice, PDF, receipt and statement", async () => {
  expectStatus(await call(FIN, { action: "customer_save", name: "Bad ABN Co", abn: "12 345 678 901" }), 409, "invalid ABN refused");
  const { id: cust } = await ok(FIN, { action: "customer_save", name: "Orica Kooragang", abn: "51 824 753 556", email: "ap@orica.test", termsDays: 30,
    billingAddress: { street: "1 Greenleaf Rd", suburb: "Kooragang", state: "nsw", postcode: "2304" } });
  const lines = [
    { description: "Pipe spool fabrication", quantity: 4, unitPrice: 1250, accountId: acc(sales.accounts, "4000"), taxCodeId: tax(sales.taxCodes, "GST"), kind: "labour" },
    { description: "Export crating", quantity: 1, unitPrice: 300, accountId: acc(sales.accounts, "4800"), taxCodeId: tax(sales.taxCodes, "FRE"), kind: "other" }
  ];
  expectStatus(await call(FIN, { action: "invoice_save", customerId: cust, date: "2026-09-01", lines: [{ ...lines[0], accountId: acc(purch.accounts, "6300") }] }), 409, "expense account refused on a sale");
  const saved = await ok(FIN, { action: "invoice_save", customerId: cust, date: "2026-09-01", reference: "4500012345", lines, approve: true });
  assert(saved.status === "approved" && /^INV-/.test(saved.number), `approved with a number: ${JSON.stringify(saved)}`);
  const got = await ok(FIN, { action: "invoice_get", id: saved.id });
  // 4 x 1,250 = 5,000 + 500 GST; 300 GST-free. Total 5,800.
  assert(got.invoice.subtotal === 5300 && got.invoice.gst === 500 && got.invoice.total === 5800, `totals ${JSON.stringify(got.invoice)}`);
  assert(got.invoice.dueDate === "2026-10-01", "due date from 30-day terms");
  assert(got.invoice.journal?.number, "linked journal");
  assert(!got.can.edit && got.can.void && got.can.receive, `flags ${JSON.stringify(got.can)}`);
  expectStatus(await call(FIN, { action: "invoice_save", id: saved.id, customerId: cust, date: "2026-09-01", lines }), 409, "approved invoices are locked");

  pdfText.length = 0;
  const pdf = await ok(FIN, { action: "invoice_pdf", id: saved.id });
  assert(pdf.fileName === `Tax-invoice-${saved.number}.pdf` && pdf.base64.length > 10, "PDF returned");
  assert(pdfText.includes("TAX INVOICE"), "says Tax invoice");
  assert(pdfText.some(t => t.includes("ABN 51 824 753 556")), "shows seller ABN");
  assert(pdfText.includes("Orica Kooragang"), "shows buyer (required at $1,000 or more)");
  assert(pdfText.includes("$500.00") && pdfText.includes("$5,800.00"), "GST and total shown");
  assert(pdfText.some(t => t.startsWith("Export crating *")) && pdfText.includes("* No GST applies to this item."), "GST-free item marked");

  // Part payment, then the rest.
  expectStatus(await call(FIN, { action: "receipt_record", customerId: cust, date: "2026-09-10", amount: "100.001", bankAccountId: BANK, allocations: [] }), 400, "cents only");
  await ok(FIN, { action: "receipt_record", customerId: cust, date: "2026-09-10", amount: "2,000.00", bankAccountId: BANK, reference: "EFT 881",
    allocations: [{ invoiceId: saved.id, amount: 2000 }] });
  let list = await ok(FIN, { action: "invoices_list", view: "unpaid", customerId: cust });
  assert(list.invoices.length === 1 && list.invoices[0].owing === 3800, `owing after part payment ${JSON.stringify(list.invoices[0])}`);
  const r2 = await ok(FIN, { action: "receipt_record", customerId: cust, date: "2026-09-20", amount: 4000, bankAccountId: BANK, reference: "EFT 902",
    allocations: [{ invoiceId: saved.id, amount: 3800 }] });
  list = await ok(FIN, { action: "invoices_list", view: "paid", customerId: cust });
  assert(list.invoices.length === 1, "paid in full");
  const cg = await ok(FIN, { action: "customer_get", id: cust });
  assert(cg.payments.find((p: any) => p.id === r2.id).unallocated === 200, "overpayment held");
  expectStatus(await call(FIN, { action: "receipt_void", id: r2.id, reason: "" }), 400, "void needs a reason");

  const st = await ok(FIN, { action: "customer_statement", customerId: cust, from: "2026-09-01", to: "2026-09-30" });
  assert(st.openingBalance === 0 && st.closingBalance === -200 && st.rows.length === 3, `statement ${JSON.stringify(st).slice(0, 300)}`);
  pdfText.length = 0;
  const stPdf = await ok(FIN, { action: "customer_statement", customerId: cust, from: "2026-09-01", to: "2026-09-30", pdf: true });
  assert(stPdf.fileName.startsWith("Statement-Orica-Kooragang") && pdfText.includes("STATEMENT"), "statement PDF");

  // Ageing agrees with the Accounts Receivable control account.
  const aged = await ok(FIN, { action: "aged_receivables" });
  const ledger = await ok(FIN, { action: "ledger_setup" });
  const ar = ledger.accounts.find((a: any) => a.code === "1100").balance;
  assert(Math.abs(aged.totals.total - ar) < 0.005, `ageing ${aged.totals.total} vs AR ${ar}`);
});

Deno.test("quote to invoice, credit note", async () => {
  const cust = (await ok(FIN, { action: "customers_list", search: "Orica" })).customers[0].id;
  const { id: q } = await ok(FIN, { action: "quote_save", customerId: cust, date: "2026-09-02", expiryDate: "2026-10-02", title: "Shutdown pipework",
    scope: "Supply and install 12 m of DN150 spool.", lines: [{ description: "Install", quantity: 2, unitPrice: 900, accountId: acc(sales.accounts, "4300"), taxCodeId: tax(sales.taxCodes, "GST") }] });
  expectStatus(await call(FIN, { action: "quote_to_invoice", id: q }), 409, "draft quotes can't be invoiced");
  await ok(FIN, { action: "quote_status", id: q, status: "approved" });
  pdfText.length = 0;
  await ok(FIN, { action: "quote_pdf", id: q });
  assert(pdfText.includes("QUOTE") && pdfText.includes("SCOPE OF WORK"), "quote PDF");
  await ok(FIN, { action: "quote_status", id: q, status: "accepted" });
  const { id: inv } = await ok(FIN, { action: "quote_to_invoice", id: q });
  const got = await ok(FIN, { action: "invoice_get", id: inv });
  assert(got.invoice.status === "draft" && got.invoice.total === 1980 && got.invoice.quoteId === q, "draft from quote");
  const approved = await ok(FIN, { action: "invoice_approve", id: inv });
  assert((await ok(FIN, { action: "quote_get", id: q })).quote.status === "converted", "quote converted");
  // Credit note for 198 inc GST, applied to the invoice.
  const cn = await ok(FIN, { action: "invoice_save", kind: "credit_note", customerId: cust, date: "2026-09-05", amountsAre: "inclusive", originalInvoiceId: inv,
    lines: [{ description: "Price adjustment", quantity: 1, unitPrice: 198, accountId: acc(sales.accounts, "4300"), taxCodeId: tax(sales.taxCodes, "GST") }], approve: true });
  assert(/^CN-/.test(cn.number), "credit note number");
  pdfText.length = 0;
  await ok(FIN, { action: "invoice_pdf", id: cn.id });
  assert(pdfText.includes("ADJUSTMENT NOTE") && pdfText.includes(approved.number), "adjustment note refers to the invoice");
  const before = await ok(FIN, { action: "invoice_get", id: inv });
  assert(before.available.some((a: any) => a.id === cn.id && a.available === 198), "credit offered on the invoice");
  await ok(FIN, { action: "credit_apply", creditNoteId: cn.id, invoiceId: inv, amount: 198 });
  assert((await ok(FIN, { action: "invoice_get", id: inv })).invoice.owing === 1782, "credit applied");
  expectStatus(await call(FIN, { action: "invoice_void", id: inv, reason: "x" }), 409, "can't void with credits applied");
});

Deno.test("suppliers, purchase orders, bills, withholding and payments", async () => {
  const { id: sup } = await ok(FIN, { action: "supplier_save", name: "Steel Supplies Hexham", abn: "51 824 753 556", termsDays: 30, subcontractor: false,
    insuranceExpiry: "2026-10-20" });
  const { id: sub } = await ok(FIN, { action: "supplier_save", name: "Casual Rigger (no ABN)", subcontractor: true, gstRegistered: false });
  const sl = await ok(FIN, { action: "suppliers_list" });
  assert(sl.suppliers.find((s: any) => s.id === sub).warnings.some((w: string) => w.includes("47%")), "no-ABN warning");
  assert(sl.suppliers.find((s: any) => s.id === sup).warnings.some((w: string) => w.includes("Insurance expires")), "insurance warning");

  // Bank change: requested, hidden until a second person approves.
  const { approvalId } = await ok(FIN, { action: "supplier_bank_request", supplierId: sup, accountName: "Steel Supplies", bsb: "062-000", accountNumber: "12345678" });
  assert((await ok(FIN, { action: "supplier_get", id: sup })).supplier.bank === null, "bank not set yet");
  expectStatus(await call(FIN, { action: "approval_decide", approvalId, approve: true }), 403, "can't approve own request");
  await ok(DIR, { action: "approval_decide", approvalId, approve: true, comment: "Verified by phone" });
  assert((await ok(FIN, { action: "supplier_get", id: sup })).supplier.bank.bsb === "062-000", "bank set after approval");

  // PO raised by a project manager, approved by finance.
  const lines = [{ description: "DN150 Sch40 pipe, 6 m", quantity: 10, unit: "len", unitPrice: 210, accountId: acc(purch.accounts, "5100"), taxCodeId: tax(purch.taxCodes, "GSTE") }];
  const { id: po } = await ok(PM, { action: "po_save", supplierId: sup, date: "2026-09-10", deliveryAddress: "Panalo workshop, Tomago", lines, submit: true });
  expectStatus(await call(PM, { action: "po_status", id: po, status: "approved" }), 403, "requester can't approve");
  await ok(FIN, { action: "po_status", id: po, status: "approved" });
  await ok(FIN, { action: "po_status", id: po, status: "issued" });
  pdfText.length = 0;
  await ok(PM, { action: "po_pdf", id: po });
  assert(pdfText.includes("PURCHASE ORDER") && pdfText.includes("DELIVER TO"), "PO PDF");
  const pg = await ok(PM, { action: "po_get", id: po });
  assert(pg.can.receive && !pg.can.approve, "project manager can receive");
  expectStatus(await call(PM, { action: "po_receive", id: po, lines: [{ lineId: pg.lines[0].id, quantity: 11 }] }), 409, "can't over-receive");
  assert((await ok(PM, { action: "po_receive", id: po, lines: [{ lineId: pg.lines[0].id, quantity: 6 }] })).status === "partially_received", "part received");

  // Bill from what was received: 6 x 210 = 1,260 + 126 GST.
  const { draft } = await ok(FIN, { action: "bill_from_po", purchaseOrderId: po });
  assert(draft.lines.length === 1 && draft.lines[0].quantity === 6, "bill drafted from received quantity");
  const bill = await ok(FIN, { action: "bill_save", ...draft, date: "2026-09-12", supplierReference: "SS-77001" });
  expectStatus(await call(FIN, { action: "supplier_payment_record", supplierId: sup, date: "2026-09-15", bankAccountId: BANK, allocations: [{ billId: bill.id, amount: 100 }] }),
    409, "unapproved bill can't be paid");
  await ok(FIN, { action: "bill_approve", id: bill.id });
  const bg = await ok(FIN, { action: "bill_get", id: bill.id });
  assert(bg.bill.total === 1386 && bg.bill.withholding === 0 && bg.match?.differences[0].ok, `three-way match ${JSON.stringify(bg.match)}`);

  // Attachment (the supplier's invoice).
  const prep = await ok(FIN, { action: "attachment_prepare_upload", entityType: "bill", entityId: bill.id, fileName: "SS-77001.pdf", size: 5000 });
  expectStatus(await call(FIN, { action: "attachment_prepare_upload", entityType: "bill", entityId: bill.id, fileName: "run.exe", size: 5000 }), 400, "only PDFs and photos");
  await ok(FIN, { action: "attachment_attach", entityType: "bill", entityId: bill.id, path: prep.path, fileName: "SS-77001.pdf" });
  const withFile = await ok(FIN, { action: "bill_get", id: bill.id });
  assert(withFile.attachments.length === 1, "attachment listed");
  assert((await ok(FIN, { action: "attachment_open", id: withFile.attachments[0].id })).url, "attachment opens");
  assert(storageCalls.some(c => c.startsWith(`upload finance-documents/org/`) && c.includes(`/bill/${bill.id}/`)), "stored under the bill");

  // No-ABN subcontractor: 47% withheld.
  const nb = await ok(FIN, { action: "bill_save", supplierId: sub, date: "2026-09-14", supplierReference: "Week 37",
    lines: [{ description: "Rigging labour", quantity: 1, unitPrice: 800, accountId: acc(purch.accounts, "5300"), taxCodeId: tax(purch.taxCodes, "FRE") }], then: "approve" });
  const nbg = await ok(FIN, { action: "bill_get", id: nb.id });
  assert(nbg.bill.withholding === 376 && nbg.bill.owing === 424, `withholding ${JSON.stringify(nbg.bill)}`);

  await ok(FIN, { action: "supplier_payment_record", supplierId: sup, date: "2026-09-25", bankAccountId: BANK, reference: "Sept run", allocations: [{ billId: bill.id, amount: 1386 }] });
  assert((await ok(FIN, { action: "bill_get", id: bill.id })).bill.owing === 0, "bill paid");
  const aged = await ok(FIN, { action: "aged_payables" });
  const ledger = await ok(FIN, { action: "ledger_setup" });
  const ap = ledger.accounts.find((a: any) => a.code === "2000").balance;
  assert(Math.abs(aged.totals.total + ap) < 0.005, `aged payables ${aged.totals.total} vs AP ${ap}`);

  const dash = await ok(FIN, { action: "dashboard" });
  assert(dash.sales && typeof dash.sales.owed === "number" && dash.purchases && typeof dash.purchases.owing === "number", "dashboard headlines");
});
