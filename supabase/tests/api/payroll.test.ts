// End-to-end tests for Phase 5 (payroll) in finance-api. Fixtures come from
// workforce_payroll.test.sql: Tom (hourly), Olivia (salaried), Casey (casual,
// no TFN), Jamie (junior), and one approved and paid weekly pay run.
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
const employee = async (no: string) => (await rest(`employees?select=id&employee_number=eq.${no}`))[0].id;

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
const TRADIE = await profile("tradie@fin.test");
const OFFICE = await profile("office@fin.test");
const TOM = await employee("PAY-001");
const OLIVIA = await employee("PAY-002");

Deno.test("who sees what: staff see their own pay only, TFNs are masked", async () => {
  expectStatus(await call(TRADIE, { action: "payroll_employees" }), 403, "staff can't list payroll");
  expectStatus(await call(TRADIE, { action: "payroll_employee_get", id: OLIVIA }), 403, "staff can't see others");
  expectStatus(await call(FINANCE, { action: "payroll_employees" }), 403, "finance admin isn't in payroll");
  const me = await ok(TRADIE, { action: "my_pay" });
  assert(me.employee.name === "Tom Tradie" && me.payslips.length === 1 && me.payslips[0].net === 1297, `my pay ${JSON.stringify(me).slice(0, 300)}`);
  assert(me.leave.some((l: any) => l.name === "Annual leave" && l.balance === 2.92), "own leave balance");

  pdfText.length = 0;
  const slip = await ok(TRADIE, { action: "my_payslip", id: me.payslips[0].runId });
  assert(slip.fileName.startsWith("Payslip-") && pdfText.includes("PAYSLIP"), "payslip PDF");
  assert(pdfText.includes("ABN 51 824 753 556"), "employer ABN on the payslip");
  assert(pdfText.includes("$1,640.00") && pdfText.includes("$1,297.00") && pdfText.some(t => t.includes("Overtime at 150%")), "gross, net and overtime itemised");
  assert(pdfText.some(t => t.includes("Super guarantee (employer): $182.40")) && pdfText.some(t => t.includes("AustralianSuper")), "super and fund on the payslip");

  const list = await ok(PAYROLL, { action: "payroll_employees" });
  const tom = list.employees.find((e: any) => e.id === TOM);
  assert(tom.inPayroll && tom.hourlyRate === 40, "payroll officer sees the rate");
  const got = await ok(PAYROLL, { action: "payroll_employee_get", id: TOM });
  assert(got.pay.tfn === "••• ••• 782" && !JSON.stringify(got).includes("123456782"), "TFN masked");
  assert(got.pay.bank.accountNumber === "•••678", "bank number masked");
  const dir = await ok(DIRECTOR, { action: "payroll_employee_get", id: TOM });
  assert(dir.pay === null, "approvers without payroll details access see no pay details");
});

Deno.test("a second pay run: prepare, approve, pay, payslip with year to date", async () => {
  const setup = await ok(PAYROLL, { action: "payroll_setup" });
  const bonus = setup.payItems.find((i: any) => i.code === "BONUS").id;
  const bank = setup.bankAccounts.find((a: any) => a.code === "1000").id;
  assert(setup.rules.superGuaranteeRate === 0.12 && setup.rules.nationalMinimumWage === 26.44, `rules ${JSON.stringify(setup.rules)}`);
  expectStatus(await call(PAYROLL, { action: "pay_run_create", frequency: "weekly", periodStart: "2026-10-12", periodEnd: "2026-10-17", paymentDate: "2026-10-21" }), 409, "a week is 7 days");
  const { id } = await ok(PAYROLL, { action: "pay_run_create", frequency: "weekly", periodStart: "2026-10-12", periodEnd: "2026-10-18", paymentDate: "2026-10-21" });
  await ok(PAYROLL, { action: "pay_run_line_add", id, employeeId: TOM, itemId: bonus, description: "Safety bonus", amount: "200" });
  let run = await ok(PAYROLL, { action: "pay_run_get", id });
  // Olivia: salary 1,500.00; taxable 1,400 after sacrifice; scale 1 x = 1,400.99: 0.32x - 71.6508 = 376.67 -> 377; STSL 0.15x - 148.0615 = 62.09 -> 62. Net 1,500 - 439 - 100 = 961.
  const olivia = run.employees.find((e: any) => e.id === OLIVIA);
  assert(olivia.gross === 1500 && olivia.payg === 439 && olivia.net === 961, `Olivia ${JSON.stringify(olivia).slice(0, 200)}`);
  // Tom: a $200 bonus only: under the tax-free threshold, so no tax. Bonuses for ordinary work are qualifying earnings: super 24.00.
  const tom = run.employees.find((e: any) => e.id === TOM);
  assert(tom.gross === 200 && tom.payg === 0 && tom.net === 200 && tom.superGuarantee === 24, `Tom ${JSON.stringify(tom).slice(0, 200)}`);
  assert(run.can.edit && !run.can.approve, "preparer flags");

  await ok(PAYROLL, { action: "pay_run_submit", id });
  expectStatus(await call(PAYROLL, { action: "pay_run_approve", id }), 403, "payroll officer can't approve");
  run = await ok(DIRECTOR, { action: "pay_run_get", id });
  assert(run.can.approve, "director can approve");
  await ok(DIRECTOR, { action: "pay_run_approve", id });
  run = await ok(DIRECTOR, { action: "pay_run_get", id });
  assert(run.run.status === "approved" && run.run.journal?.number, "approved and posted");
  assert(run.run.superDue === "2026-10-30", `super due 7 business days after payday: ${run.run.superDue}`);

  pdfText.length = 0;
  await ok(PAYROLL, { action: "payslip_pdf", id, employeeId: OLIVIA });
  assert(pdfText.some(t => t.includes("Gross $3,052.50")), "year to date across both pays");
  assert(pdfText.some(t => t.includes("annual salary $78,000.00")), "annual salary shown");

  expectStatus(await call(FINANCE, { action: "pay_run_bank_list", id }), 403, "bank list needs payroll details access");
  const bl = await ok(PAYROLL, { action: "pay_run_bank_list", id });
  assert(bl.rows.some((r: any) => r.accountNumber === "12345678" && r.net === 200), "bank list for paying");

  await ok(FINANCE, { action: "pay_run_record_payment", id, bankAccountId: bank, date: "2026-10-21" });
  await ok(FINANCE, { action: "pay_run_record_super", id, bankAccountId: bank, date: "2026-10-23" });
  const runs = await ok(PAYROLL, { action: "pay_runs_list" });
  const mine = runs.runs.find((r: any) => r.id === id);
  assert(mine.status === "paid" && mine.superPaidAt === "2026-10-23" && !mine.superOverdue, "paid and super recorded");
});

Deno.test("leave requests and the payroll summary", async () => {
  const me = await ok(OFFICE, { action: "my_pay" });
  const annual = me.leaveTypes.find((t: any) => t.name === "Annual leave").id;
  const { id } = await ok(OFFICE, { action: "leave_request", typeId: annual, start: "2026-11-02", end: "2026-11-03", hours: 15.2, reason: "Family visit" });
  expectStatus(await call(OFFICE, { action: "leave_decide", id, decision: "approved" }), 403, "can't approve your own leave");
  const waiting = await ok(PAYROLL, { action: "leave_list", status: "submitted" });
  const req = waiting.requests.find((r: any) => r.id === id);
  assert(req && req.balance === 38.25, `balance shown to the approver: ${JSON.stringify(req)}`);
  expectStatus(await call(PAYROLL, { action: "leave_decide", id, decision: "rejected", comment: "" }), 409, "declining needs a reason");
  await ok(PAYROLL, { action: "leave_decide", id, decision: "approved" });

  const sum = await ok(PAYROLL, { action: "payroll_summary", from: "2026-07-01", to: "2026-10-31" });
  const o = sum.rows.find((r: any) => r.employeeId === OLIVIA);
  assert(o.gross === 3052.5 && o.pays === 2, `summary ${JSON.stringify(o)}`);
  const dash = await ok(DIRECTOR, { action: "dashboard" });
  assert(dash.payroll && typeof dash.payroll.payRunsToApprove === "number", "dashboard payroll headline");
});
