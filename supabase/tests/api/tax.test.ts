// End-to-end tests for Phase 7 (BAS and TPAR) in finance-api. Runs last: it
// lodges the July to September 2026 BAS on the data the earlier tests left.
// The exact figures are tested in zzz_bas.test.sql; this checks the actions,
// permissions and the workpaper.
import { pdfText } from "./pdf-lib-stub.ts";

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
const BANK = (await rest("accounts?select=id&code=eq.1000"))[0].id;

Deno.test("BAS: prepare, second-person review, workpaper, lodge, pay", async () => {
  expectStatus(await call(STAFF, { action: "bas_list" }), 403, "staff can't see the BAS");
  const list = await ok(FINANCE, { action: "bas_list" });
  assert(list.can.prepare && !list.can.review && ["monthly", "quarterly", "annual"].includes(list.next.frequency), `list ${JSON.stringify(list).slice(0, 300)}`);

  expectStatus(await call(FINANCE, { action: "bas_create", from: "2026-08-01", to: "2026-10-31", frequency: "quarterly" }), 409, "not a quarter");
  const { id } = await ok(FINANCE, { action: "bas_create", from: "2026-07-01", to: "2026-09-30", frequency: "quarterly", method: "full" });
  let b = await ok(FINANCE, { action: "bas_get", id });
  assert(b.bas.status === "draft" && b.bas.due === "2026-10-28", `bas ${JSON.stringify(b.bas)}`);
  assert(typeof b.figures.labels["1A"] === "number" && typeof b.figures.labels.W5 === "number" && b.figures.labels["9"] === b.figures.labels["8A"] - b.figures.labels["8B"], "labels and summary");
  assert(b.figures.codes.length > 0 && b.figures.reconciliation.gst && Array.isArray(b.figures.exceptions), "codes, reconciliation and exceptions");
  assert(b.can.edit && !b.can.review, "the preparer can edit but not review");

  const code = b.figures.codes[0];
  const drill = await ok(FINANCE, { action: "bas_lines", id, taxCodeId: code.id });
  assert(Array.isArray(drill.rows), "drill-down lines");

  expectStatus(await call(FINANCE, { action: "bas_save", id, instalment5A: "12.50" }), 400, "5A in whole dollars");
  await ok(FINANCE, { action: "bas_save", id, instalment5A: "300", fuelCredit7D: "", method: "full", notes: "Instalment per notice" });
  b = await ok(FINANCE, { action: "bas_get", id });
  assert(b.figures.labels["5A"] === 300, "5A saved");

  pdfText.length = 0;
  const pdf = await ok(FINANCE, { action: "bas_pdf", id });
  assert(pdf.fileName === "BAS-workpaper-2026-07-01-to-2026-09-30.pdf" && pdfText.includes("BAS WORKPAPER"), "workpaper PDF");
  assert(pdfText.some(t => t.startsWith("1A  GST on sales")) && pdfText.some(t => t.startsWith("W5  Total amounts withheld")), "labels on the workpaper");

  expectStatus(await call(FINANCE, { action: "bas_review", id }), 403, "finance can't review");
  const d = await ok(DIRECTOR, { action: "bas_get", id });
  assert(d.can.review, "director can review");
  await ok(DIRECTOR, { action: "bas_review", id, comment: "Agreed to the GST account" });
  b = await ok(FINANCE, { action: "bas_get", id });
  assert(b.bas.status === "reviewed" && b.bas.reviewedBy && b.can.lodge && !b.can.edit && b.changes.length === 0, "reviewed and fixed");

  expectStatus(await call(FINANCE, { action: "bas_lodge", id, lodgedOn: "2026-09-30" }), 409, "lodged after the period");
  const lodged = await ok(FINANCE, { action: "bas_lodge", id, lodgedOn: "2026-10-20", reference: "4000000001", lock: false });
  assert(lodged.journalId, "transfer journal posted");
  b = await ok(FINANCE, { action: "bas_get", id });
  assert(b.bas.journal?.number && b.bas.lodgedOn === "2026-10-20" && b.bas.lockedPeriods === 0, "lodged without locking");
  if (b.bas.status === "lodged") {
    await ok(FINANCE, { action: "bas_record_payment", id, bankAccountId: BANK, date: "2026-10-27", amount: "" });
    b = await ok(FINANCE, { action: "bas_get", id });
  }
  assert(b.bas.status === "settled", `settled: ${b.bas.status}`);

  const dash = await ok(DIRECTOR, { action: "dashboard" });
  assert(dash.tax && typeof dash.tax.toReview === "number", "dashboard BAS headline");
});

Deno.test("TPAR: payments to reportable suppliers in the year", async () => {
  expectStatus(await call(STAFF, { action: "tpar_get" }), 403, "staff can't see the TPAR");
  // Steel Supplies Co was paid in October (batch PB-0001 and more): mark it reportable.
  const sid = (await rest("suppliers?select=id&name=eq.Steel%20Supplies%20Co"))[0].id;
  let t = await ok(FINANCE, { action: "tpar_get", yearStart: "2026-07-01" });
  assert(!t.rows.some((r: any) => r.supplierId === sid), "not reported until marked");
  const { supplier } = await ok(FINANCE, { action: "supplier_get", id: sid });
  await ok(FINANCE, { action: "supplier_save", ...supplier, id: sid, tpar: true, subcontractor: true, bank: undefined });
  t = await ok(FINANCE, { action: "tpar_get", yearStart: "2026-07-01" });
  assert(t.year.end === "2027-06-30" && t.year.due === "2027-08-28" && !t.can.lodge, `year ${JSON.stringify(t.year)}`);
  const row = t.rows.find((r: any) => r.supplierId === sid);
  assert(row && row.gross >= 2500 && row.gst > 0 && row.problems.includes("Address incomplete") && t.totals.count === t.rows.length, `Steel Supplies ${JSON.stringify(row)}`);
  expectStatus(await call(FINANCE, { action: "tpar_lodge", yearStart: "2026-07-01", lodgedOn: "2026-10-01" }), 409, "not before the year ends");
});
