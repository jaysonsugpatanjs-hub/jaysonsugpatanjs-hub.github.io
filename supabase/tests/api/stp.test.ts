// End-to-end tests for Phase 8 STP in finance-api: overview, a pay event for
// the paid October pay run, details fixed through the API, checked, made
// ready by a second person, exported, and sending refused.
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

const PAYROLL = await profile("payroll@fin.test");
const DIRECTOR = await profile("director@fin.test");
const FINANCE = await profile("finance@fin.test");
const STAFF = await profile("staff@fin.test");

Deno.test("STP: pay event, checks, ready, export; sending stays off", async () => {
  expectStatus(await call(FINANCE, { action: "stp_overview" }), 403, "finance can't see STP");
  expectStatus(await call(STAFF, { action: "stp_overview" }), 403, "staff can't see STP");
  const o = await ok(PAYROLL, { action: "stp_overview" });
  assert(o.settings.transmissionEnabled === false && o.settings.bmsId && o.items.some((i: any) => i.code === "TOOL" && i.category === "allowance" && i.stpCode === "TD"), "settings and mapping");
  const run = o.runsWithoutEvent.find((r: any) => r.paymentDate === "2026-10-14");
  assert(run, "the paid October run has no event yet");

  const { id } = await ok(PAYROLL, { action: "stp_event_pay", runId: run.id });
  let e = await ok(PAYROLL, { action: "stp_event_get", id });
  assert(e.event.status === "draft" && e.records.length === 4 && e.records[0].errors.length > 0, "errors to fix");
  const tom = e.records.find((r: any) => r.number === "PAY-001");
  assert(tom.payee.taxTreatment === "RTXXXX" && tom.ytd.overtime === 120 && tom.payee.tfn === "••• ••• 782", `Tom ${JSON.stringify(tom).slice(0, 300)}`);

  await ok(PAYROLL, { action: "stp_settings_save", contactName: "Pat Payroll", contactPhone: "02 4200 0000", branch: "001" });
  for (const r of e.records) {
    expectStatus(await call(PAYROLL, { action: "payroll_employee_stp_save", id: r.employeeId, familyName: "X", homeAddress: { state: "XX" } }), 400, "state checked");
    await ok(PAYROLL, { action: "payroll_employee_stp_save", id: r.employeeId, familyName: r.payee.familyName || "Surname", givenNames: r.payee.givenNames || "Given",
      homeAddress: { street: "1 Main St", suburb: "Wollongong", state: "NSW", postcode: "2500" }, incomeType: "SAW" });
  }
  // Dates of birth are entered on the pay form; the test fixtures lack some.
  const emp = await ok(PAYROLL, { action: "payroll_employee_get", id: tom.employeeId });
  assert(emp.pay.stp.homeAddress.postcode === "2500" && emp.pay.stp.incomeType === "SAW", "STP details on the employee");
  const checked = await ok(PAYROLL, { action: "stp_event_check", id });
  e = await ok(PAYROLL, { action: "stp_event_get", id });
  const left = e.records.flatMap((r: any) => r.errors);
  assert(left.every((x: string) => /Date of birth/.test(x)), `only dates of birth left: ${JSON.stringify(left)} (${checked.status})`);

  const exp = await ok(PAYROLL, { action: "stp_event_export", id });
  assert(exp.json.includes("123456782") && exp.csv.length === 5 && exp.csv[0][0] === "Payroll ID", "export has the TFN and a row each");
  expectStatus(await call(DIRECTOR, { action: "stp_event_submit", id }), 409, "sending is off");
  expectStatus(await call(PAYROLL, { action: "stp_event_ready", id }), 403, "payroll officer can't mark ready");
  await ok(PAYROLL, { action: "stp_event_delete", id });
});
