// End-to-end tests for the Phase 2 ledger actions of finance-api.
// Fixtures: @fin.test people with roles, and the journals posted by
// ledger_core.test.sql.
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

const FIN = await profile("finance@fin.test");
const DIR = await profile("director@fin.test");
const PAY = await profile("payroll@fin.test");
const STAFF = await profile("staff@fin.test");

const setup = await ok(FIN, { action: "ledger_setup" });
const acc = (code: string) => setup.accounts.find((a: any) => a.code === code).id;
const tax = (code: string) => setup.taxCodes.find((t: any) => t.code === code).id;

Deno.test("chart, tax codes and who can see them", async () => {
  if (setup.accounts.length < 63 || setup.taxCodes.length < 10) throw new Error("chart or tax codes missing");
  if (!setup.can.post || setup.can.reopen) throw new Error(`finance admin flags wrong: ${JSON.stringify(setup.can)}`);
  const bank = setup.accounts.find((a: any) => a.code === "1000");
  if (typeof bank.balance !== "number") throw new Error("balances missing");
  await ok(PAY, { action: "ledger_setup" });
  expectStatus(await call(STAFF, { action: "ledger_setup" }), 403, "staff without finance access");
  expectStatus(await call(PAY, { action: "account_save", code: "4950", name: "x", type: "revenue" }), 403, "payroll cannot edit the chart");
  expectStatus(await call(FIN, { action: "account_save", code: "bad code!", name: "x", type: "revenue" }), 400, "invalid code");
  const created = await ok(FIN, { action: "account_save", code: "4950", name: "Testing Revenue", type: "revenue", defaultTaxCodeId: tax("GST") });
  await ok(FIN, { action: "account_set_status", id: created.id, active: false });
  await ok(FIN, { action: "tax_code_save", code: "GST5", name: "Test 5%", kind: "gst_income", ratePercent: 5, appliesTo: "sales" });
  const after = await ok(FIN, { action: "ledger_setup" });
  if (after.taxCodes.find((t: any) => t.code === "GST5").rate !== 0.05) throw new Error("tax rate not stored as a fraction");
});

Deno.test("journals: draft, post, view, reverse", async () => {
  expectStatus(await call(PAY, { action: "journal_save", date: "2026-09-01", lines: [] }), 403, "payroll cannot journal");
  const unbalanced = await ok(FIN, { action: "journal_save", date: "2026-09-02", memo: "Typo", amountsAre: "exclusive", post: true,
    lines: [{ accountId: acc("1000"), debit: "100" }, { accountId: acc("4000"), credit: "99" }] });
  if (unbalanced.status !== "draft" || !/must be equal/.test(unbalanced.postError)) throw new Error(`unbalanced post should stay a draft: ${JSON.stringify(unbalanced)}`);
  const drafts = await ok(FIN, { action: "journals_list", status: "draft" });
  if (!drafts.journals.some((j: any) => j.id === unbalanced.id)) throw new Error("draft not listed");
  await ok(FIN, { action: "journal_delete", id: unbalanced.id });

  const posted = await ok(FIN, { action: "journal_save", date: "2026-09-03", memo: "Shutdown job 3101", amountsAre: "exclusive", post: true,
    lines: [{ accountId: acc("1000"), debit: "2,200.00", description: "Receipt" }, { accountId: acc("4200"), credit: "2000", taxCodeId: tax("GST") }] });
  if (posted.status !== "posted" || !/^JE-\d{6}$/.test(posted.number)) throw new Error(`not posted: ${JSON.stringify(posted)}`);
  const view = await ok(DIR, { action: "journal_get", id: posted.id });
  const gst = view.lines.find((l: any) => l.isTaxLine);
  if (!gst || gst.credit !== 200 || gst.accountCode !== "2300") throw new Error("GST line wrong");
  if (view.journal.totalDebit !== view.journal.totalCredit || view.journal.totalDebit !== 2200) throw new Error("totals wrong");
  if (!view.can.reverse || view.can.edit) throw new Error(`director flags wrong: ${JSON.stringify(view.can)}`);
  expectStatus(await call(FIN, { action: "journal_save", id: posted.id, date: "2026-09-03", lines: [] }), 409, "posted journals can't be edited");
  expectStatus(await call(FIN, { action: "journal_reverse", id: posted.id, reason: "" }), 409, "reversal needs a reason");
  const rev = await ok(DIR, { action: "journal_reverse", id: posted.id, reason: "Billed to the wrong job" });
  const revView = await ok(FIN, { action: "journal_get", id: rev.id });
  if (revView.journal.reverses?.id !== posted.id) throw new Error("reversal not linked");
  const original = await ok(FIN, { action: "journal_get", id: posted.id });
  if (original.journal.status !== "reversed" || original.journal.reversedBy?.id !== rev.id) throw new Error("original not marked reversed");
});

Deno.test("periods: lock, close and reopen", async () => {
  const p = await ok(FIN, { action: "periods_list" });
  const fy = p.years.find((y: any) => y.name === "FY2026-27");
  const sep = fy.periods.find((x: any) => x.start === "2026-09-01");
  await ok(FIN, { action: "period_set_status", id: sep.id, status: "closed" });
  const blocked = await ok(FIN, { action: "journal_save", date: "2026-09-10", amountsAre: "no_tax", post: true,
    lines: [{ accountId: acc("1000"), debit: 1 }, { accountId: acc("4800"), credit: 1 }] });
  if (blocked.status !== "draft" || !/closed/.test(blocked.postError)) throw new Error("closed period should block posting");
  await ok(FIN, { action: "journal_delete", id: blocked.id });
  expectStatus(await call(FIN, { action: "period_set_status", id: sep.id, status: "open", reason: "fix" }), 403, "finance admin cannot reopen");
  await ok(DIR, { action: "period_set_status", id: sep.id, status: "open", reason: "Late supplier invoice" });
  expectStatus(await call(PAY, { action: "period_set_status", id: sep.id, status: "closed" }), 403, "payroll cannot lock periods");
});

Deno.test("reports balance and exports are logged", async () => {
  const tb = await ok(DIR, { action: "report", kind: "trial_balance", asAt: "2026-12-31" });
  if (Math.abs(tb.totalDebit - tb.totalCredit) > 0.001) throw new Error(`TB out of balance ${tb.totalDebit} ${tb.totalCredit}`);
  const bs = await ok(DIR, { action: "report", kind: "balance_sheet", asAt: "2026-12-31" });
  if (!bs.totals.balanced) throw new Error("balance sheet does not balance");
  const pl = await ok(DIR, { action: "report", kind: "profit_loss", from: "2026-07-01", to: "2026-12-31" });
  if (Math.abs(pl.totals.netProfit - bs.currentYearEarnings) > 0.001) throw new Error("P&L net profit should equal current year earnings");
  expectStatus(await call(DIR, { action: "report", kind: "profit_loss", from: "2026-13-01", to: "2026-12-31" }), 400, "bad date");
  const tx = await ok(FIN, { action: "report", kind: "account_transactions", accountId: acc("1000"), from: "2026-07-01", to: "2026-12-31" });
  if (tx.account.code !== "1000" || !tx.rows.length) throw new Error("account transactions empty");
  expectStatus(await call(STAFF, { action: "report", kind: "trial_balance", asAt: "2026-12-31" }), 403, "staff cannot see reports");
  await ok(FIN, { action: "report_export", kind: "trial_balance", asAt: "2026-12-31" });
  const audit = await rest("training_audit_events?select=event_type&event_type=eq.report_exported");
  if (!audit.length) throw new Error("export not audited");
  const dash = await ok(DIR, { action: "dashboard" });
  if (!dash.ledger || typeof dash.ledger.bank !== "number") throw new Error("dashboard ledger figures missing");
});
