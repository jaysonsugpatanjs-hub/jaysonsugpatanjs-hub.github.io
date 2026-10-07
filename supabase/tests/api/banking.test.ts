// End-to-end tests for Phase 6 (banking) in finance-api. Fixtures come from
// zz_banking.test.sql: ledger bank account 1010 linked to the "New operating"
// company account (CBA, APCA 301500, balancing record), batch PB-0001 paid,
// and the account reconciled to 12 Oct 2026 at $3,515.00.
import { buildAba } from "../../functions/_shared/aba.ts";

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

const FINANCE = await profile("finance@fin.test");
const DIRECTOR = await profile("director@fin.test");
const STAFF = await profile("staff@fin.test");
const PAYROLL = await profile("payroll@fin.test");
const ACC1010 = (await rest("accounts?select=id&code=eq.1010"))[0].id;

Deno.test("ABA format: fixed width, totals, balancing record", () => {
  const src = { bankCode: "WBC", userName: "Panalo Pipes", apcaUserId: "123456", bsb: "032000", accountNumber: "123456", accountTitle: "Panalo Pipes & Structurals",
    remitter: "Panalo Pipes & Structurals", balancing: false };
  const f = buildAba(src, [
    { bsb: "062-000", accountNumber: "12345678", accountName: "Jo Bloggs Rigging", amountCents: 123456, reference: "INV 12" },
    { bsb: "082001", accountNumber: "98765", accountName: "BOC Ltd", amountCents: 1, reference: "BOC-5531" }
  ], { date: "2026-10-20", description: "Suppliers", code: "50" });
  const recs = f.content.split("\r\n").filter(Boolean);
  assert(recs.length === 4 && recs.every(r => r.length === 120), "four 120-character records");
  assert(recs[0].startsWith("0" + " ".repeat(17) + "01WBC") && recs[0].slice(30, 56) === "PANALO PIPES".padEnd(26) && recs[0].slice(56, 62) === "123456"
    && recs[0].slice(62, 74) === "SUPPLIERS   " && recs[0].slice(74, 80) === "201026", `descriptive record: ${recs[0]}`);
  assert(recs[1].slice(0, 30) === "1062-000 12345678 500000123456", `detail: ${recs[1].slice(0, 30)}`);
  assert(recs[1].slice(30, 62) === "JO BLOGGS RIGGING".padEnd(32) && recs[1].slice(62, 80) === "INV 12".padEnd(18), "title and reference");
  assert(recs[1].slice(80, 96) === "032-000   123456" && recs[1].slice(96, 112) === "PANALO PIPES & S" && recs[1].slice(112) === "00000000", "trace account and remitter");
  assert(recs[2].slice(1, 17) === "082-001    98765", "short account numbers are right-justified");
  assert(recs[3] === "7999-999" + " ".repeat(12) + "0000123457" + "0000123457" + "0000000000" + " ".repeat(24) + "000002" + " ".repeat(40), `total record: ${recs[3]}`);
  const bal = buildAba({ ...src, balancing: true }, [{ bsb: "062000", accountNumber: "12345678", accountName: "X", amountCents: 500, reference: "R" }],
    { date: "2026-10-20", description: "PAY", code: "53" });
  const b = bal.content.split("\r\n").filter(Boolean);
  assert(b[2].slice(0, 30) === "1032-000   123456 130000000500" && b[3].slice(20, 50) === "000000000000000005000000000500" && b[3].slice(74, 80) === "000002", "balancing debit");
  let threw = "";
  try { buildAba(src, [{ bsb: "062000", accountNumber: "1234567890", accountName: "X", amountCents: 5, reference: "R" }], { date: "2026-10-20", description: "X", code: "50" }); }
  catch (e) { threw = (e as Error).message; }
  assert(/5 to 9 digits/.test(threw), "10-digit accounts refused");
});

Deno.test("overview, permissions and the batch's ABA file", async () => {
  expectStatus(await call(STAFF, { action: "banking_overview" }), 403, "staff can't see banking");
  const o = await ok(FINANCE, { action: "banking_overview" });
  const a = o.accounts.find((x: any) => x.id === ACC1010);
  assert(a && a.toMatch === 0 && a.lastReconciled === "2026-10-12" && a.reconciledBalance === 3515 && a.statementBalance === 3815 && a.linked, `account ${JSON.stringify(a)}`);
  // The ledger balance is as at today: 3,815 before the 8 Oct cheque's date, 3,515 after it.
  assert([3515, 3815].includes(a.ledgerBalance), `ledger balance ${a.ledgerBalance}`);
  const cba = o.companyAccounts.find((c: any) => c.ledgerAccountId === ACC1010);
  assert(cba.abaReady && cba.abaBankCode === "CBA", "company account ready for bank files");

  const list = await ok(FINANCE, { action: "payment_batches_list" });
  const pb = list.batches.find((b: any) => b.number === "PB-0001");
  const got = await ok(FINANCE, { action: "payment_batch_get", id: pb.id });
  assert(got.items[0].accountNumber === "•••455" && !JSON.stringify(got).includes("22334455"), "supplier account masked on screen");
  const f = await ok(FINANCE, { action: "payment_batch_aba", id: pb.id });
  const recs = f.content.split("\r\n").filter(Boolean);
  assert(f.fileName === "PB-0001.aba" && recs.length === 4 && recs.every((r: string) => r.length === 120), "batch file: header, payment, balancing, total");
  assert(recs[0].slice(20, 23) === "CBA" && recs[0].slice(56, 62) === "301500" && recs[0].slice(74, 80) === "061026", "header from the account settings");
  assert(recs[1].startsWith("1062-111 22334455 500000220000STEEL SUPPLIES CO"), `payment record ${recs[1]}`);
  assert(recs[2].startsWith("1063-000 87654321 130000220000"), "balancing debit from the paying account");
  const audit = await rest("training_audit_events?select=event_type&event_type=eq.payment_batch_file_downloaded");
  assert(audit.length >= 2, "each download is audited");
});

Deno.test("import, suggestions, coding from a rule, paying a bill from the statement, reconciling", async () => {
  const imp = await ok(FINANCE, { action: "bank_import", accountId: ACC1010, fileName: "oct-4.csv", format: "csv", statementBalance: "3382.00", balanceDate: "2026-10-20",
    rows: [{ date: "2026-10-14", amount: "-33.00", description: "BP EXPRESS 999 FUEL", balance: "3482.00" },
           { date: "2026-10-15", amount: "-100.00", description: "STEEL SUPPLIES SS-9003", balance: "3382.00" }] });
  assert(imp.added === 2, "imported");
  const again = await ok(FINANCE, { action: "bank_import", accountId: ACC1010, fileName: "oct-4.csv", format: "csv",
    rows: [{ date: "2026-10-14", amount: "-33.00", description: "BP EXPRESS 999 FUEL" }] });
  assert(again.added === 0 && again.skipped === 1, "same file twice adds nothing");

  const l = await ok(FINANCE, { action: "bank_lines", accountId: ACC1010, status: "new" });
  const fuel = l.lines.find((x: any) => x.description === "BP EXPRESS 999 FUEL");
  const steel = l.lines.find((x: any) => x.description === "STEEL SUPPLIES SS-9003");
  const rule = fuel.suggestions.find((s: any) => s.type === "rule");
  assert(rule && rule.label === "Fuel - BP", `rule suggested ${JSON.stringify(fuel.suggestions)}`);
  const bill = steel.suggestions.find((s: any) => s.type === "bill");
  assert(bill && bill.label.startsWith("BILL-") && bill.label.includes("SS-9003"), `bill suggested ${JSON.stringify(steel.suggestions)}`);

  // A batch for that bill is refused approval by its maker, then cancelled.
  const opts = await ok(FINANCE, { action: "payment_batch_options" });
  assert(opts.bills.some((b: any) => b.id === bill.billId && !b.problem && b.payTo === "062-111 •••455"), "bill can go in a batch");
  const src = opts.sources.find((s: any) => s.ready).id;
  const made = await ok(FINANCE, { action: "payment_batch_create", sourceId: src, date: "2026-10-15", description: "Steel", items: [{ billId: bill.billId }] });
  expectStatus(await call(FINANCE, { action: "payment_batch_approve", id: made.id }), 403, "maker can't approve");
  expectStatus(await call(FINANCE, { action: "payment_batch_aba", id: made.id }), 409, "no file before approval");
  await ok(FINANCE, { action: "payment_batch_cancel", id: made.id, reason: "Paid by card instead" });

  await ok(FINANCE, { action: "bank_create_entry", id: fuel.id, payee: rule.payee, lines: [{ accountId: rule.accountId, taxCodeId: rule.taxCodeId, amount: 33 }] });
  await ok(FINANCE, { action: "bank_pay_bills", id: steel.id, supplierId: bill.supplierId, allocations: [{ billId: bill.billId, amount: 100 }] });
  const matched = await ok(FINANCE, { action: "bank_lines", accountId: ACC1010, status: "matched", from: "2026-10-14" });
  assert(matched.lines.length === 2 && matched.lines.every((x: any) => x.matchedTo.length === 1), "both matched");

  const pre = await ok(FINANCE, { action: "bank_reconcile_preview", accountId: ACC1010, date: "2026-10-20" });
  assert(pre.openLines === 0 && pre.expectedStatementBalance === 3382 && pre.statementBalanceFromFile === 3382 && pre.itemCount === 0, `preview ${JSON.stringify(pre).slice(0, 300)}`);
  expectStatus(await call(FINANCE, { action: "bank_reconcile", accountId: ACC1010, date: "2026-10-20", balance: "3,380.00" }), 409, "out of balance");
  const rec = await ok(FINANCE, { action: "bank_reconcile", accountId: ACC1010, date: "2026-10-20", balance: "3,382.00", notes: "Statement 2" });
  const r = await ok(DIRECTOR, { action: "bank_reconciliation_get", id: rec.id });
  assert(r.reconciliation.balance === 3382 && r.statementLines.length === 2 && r.can.undo, "reconciliation report");
});

Deno.test("pay run bank file needs payroll details access and every bank account", async () => {
  const runs = await rest("pay_runs?select=id,number,status&status=eq.paid&order=payment_date");
  const src = (await rest("company_bank_accounts?select=id&account_number=eq.87654321&status=eq.active"))[0].id;
  expectStatus(await call(FINANCE, { action: "pay_run_aba", id: runs[0].id, sourceId: src }), 403, "finance can't see pay bank details");
  const r = await call(PAYROLL, { action: "pay_run_aba", id: runs[0].id });
  expectStatus(r, 409, "missing bank accounts");
  assert(/No approved bank account for/.test(r.body.message), r.body.message);
});
