// End-to-end tests for Phase 8 fixed assets in finance-api: register an
// asset, run depreciation for a month, the edit lock, undo, dispose with GST
// on the sale, the reconciliation, and who can see what.
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

Deno.test("Fixed assets: register, depreciate, undo, dispose, reconcile", async () => {
  expectStatus(await call(STAFF, { action: "assets_list" }), 403, "staff can't see the register");
  expectStatus(await call(STAFF, { action: "asset_save", name: "Drill", categoryId: "x" }), 403, "staff can't add assets");

  const l0 = await ok(FINANCE, { action: "assets_list" });
  const tools = l0.categories.find((c: any) => c.name === "Tools and equipment");
  assert(tools && tools.method === "straight_line" && tools.lifeMonths === 60 && l0.can.manage, "seeded categories");
  const fromBills = await ok(FINANCE, { action: "asset_from_bills" });
  assert(Array.isArray(fromBills.lines), "bill lines on fixed asset accounts");

  expectStatus(await call(FINANCE, { action: "asset_save", name: "Welder", categoryId: tools.id, purchaseDate: "2026-10-01", cost: "-5" }), 400, "cost checked");
  const { id } = await ok(FINANCE, { action: "asset_save", name: "MIG welder", categoryId: tools.id, purchaseDate: "2026-10-01", cost: "6000", gst: "600",
    serial: "MW-2210", location: "Workshop", taxMethod: "diminishing_value", taxLife: "10", taxNotes: "Accountant to confirm" });
  let a = await ok(FINANCE, { action: "asset_get", id });
  assert(/^FA-\d{4}$/.test(a.asset.number) && a.asset.method === "straight_line" && a.asset.lifeMonths === 60 && a.asset.bookValue === 6000, `defaults ${JSON.stringify(a.asset).slice(0, 300)}`);
  assert(a.asset.taxMethod === "diminishing_value" && a.asset.taxLife === 10, "tax treatment recorded");

  // October: 6000 / 60 = 100 a month.
  const pv = await ok(FINANCE, { action: "depreciation_preview", periodEnd: "2026-10-31" });
  const mine = pv.rows.find((r: any) => r.id === id);
  assert(mine && mine.amount === 100, `preview ${JSON.stringify(pv)}`);
  expectStatus(await call(FINANCE, { action: "depreciation_run", periodEnd: "2026-10-30" }), 409, "month end only");
  const { id: runId } = await ok(FINANCE, { action: "depreciation_run", periodEnd: "2026-10-31" });
  a = await ok(FINANCE, { action: "asset_get", id });
  assert(a.asset.accumulated === 100 && a.asset.bookValue === 5900 && a.depreciation.length === 1 && a.can.locked, `depreciated ${JSON.stringify({ asset: a.asset, dep: a.depreciation, can: a.can })}`);
  expectStatus(await call(FINANCE, { action: "asset_save", id, name: "MIG welder", categoryId: tools.id, purchaseDate: "2026-10-01", cost: "6500" }), 409, "cost locked");
  await ok(FINANCE, { action: "asset_save", id, name: "MIG welder 250A", categoryId: tools.id, purchaseDate: "2026-10-01", cost: "6000", gst: "600", location: "Site van" });

  let l = await ok(FINANCE, { action: "assets_list" });
  assert(l.lastRun === "2026-10-31" && l.nextRun === "2026-11-30" && l.runs[0].journal, "run listed with its journal");
  let rec = await ok(DIRECTOR, { action: "asset_reconciliation", asAt: "2026-10-31" });
  const r = rec.rows.find((x: any) => x.categoryId === tools.id);
  assert(r && r.registerAccumulated >= 100, `reconciliation ${JSON.stringify(rec)}`);

  // Undo, then run again.
  expectStatus(await call(FINANCE, { action: "depreciation_undo", id: runId, reason: "" }), 409, "reason needed");
  await ok(FINANCE, { action: "depreciation_undo", id: runId, reason: "Wrong month" });
  a = await ok(FINANCE, { action: "asset_get", id });
  assert(a.asset.accumulated === 0 && !a.can.locked, "undone");
  await ok(FINANCE, { action: "depreciation_run", periodEnd: "2026-10-31" });

  // Sold on 15 November for $5,500 plus GST.
  const gst = (await rest("tax_codes?select=id,code&code=eq.GST"))[0];
  const bank = (await rest("accounts?select=id&code=eq.1000"))[0];
  expectStatus(await call(FINANCE, { action: "asset_dispose", id, date: "2026-11-15", proceeds: "5500", reason: "Sold" }), 409, "where the money went");
  const { journalId } = await ok(FINANCE, { action: "asset_dispose", id, date: "2026-11-15", proceeds: "5500", taxCodeId: gst.id, receivedInto: bank.id, reason: "Sold to a contractor" });
  assert(journalId, "disposal journal");
  a = await ok(FINANCE, { action: "asset_get", id });
  assert(a.asset.status === "disposed" && a.asset.proceeds === 5500 && a.asset.disposalGst === 550 && a.asset.bookValue === 0 && !a.can.edit && a.asset.disposalJournal, `disposed ${JSON.stringify(a.asset).slice(0, 400)}`);
  const lines = await rest(`journal_lines?select=debit,credit,tax_amount,is_tax_line,accounts(code)&journal_id=eq.${journalId}`);
  const sum = (code: string, side: "debit" | "credit") => lines.filter((x: any) => x.accounts.code === code && !x.is_tax_line).reduce((t: number, x: any) => t + Number(x[side]), 0);
  assert(sum("1000", "debit") === 6050 && sum("4950", "credit") === 5500 && sum("1500", "credit") === 6000, `journal ${JSON.stringify(lines)}`);
  expectStatus(await call(FINANCE, { action: "asset_dispose", id, date: "2026-11-20", proceeds: "0", reason: "Again" }), 409, "only once");
  l = await ok(FINANCE, { action: "assets_list" });
  assert(l.assets.find((x: any) => x.id === id).status === "disposed", "register shows disposed");
});
