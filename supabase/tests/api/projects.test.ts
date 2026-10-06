// End-to-end tests for Phase 4 (projects, timesheets, job costing) in
// finance-api. Fixtures from the database tests: welder1/welder2@fin.test
// (enter their own time only), pm@fin.test (project manager), finance@fin.test,
// and project JOB-1001 with approved hours, bills and an invoice.
const BASE = Deno.env.get("POSTGREST_URL") || "http://127.0.0.1:3999";
const fns = new URL("../../functions/", import.meta.url);
const financeApi = (await import(new URL("finance-api/index.ts", fns).href)).default;

async function rest(path: string) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return await res.json();
}
const profile = async (email: string) => (await rest(`training_profiles?select=id&email=eq.${encodeURIComponent(email)}`))[0].id;

async function call(user: string, body: Record<string, unknown>, aal = "aal2") {
  const res = await financeApi.fetch(new Request("https://x.test/fn", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jaysonsugpatanjs-hub.github.io", "x-test-user": user, "x-test-aal": aal },
    body: JSON.stringify(body)
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function expectStatus(r: { status: number; body: any }, expected: number, label: string) {
  if (r.status !== expected) throw new Error(`${label}: expected ${expected}, got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}
const ok = async (user: string, body: Record<string, unknown>, aal = "aal2") => expectStatus(await call(user, body, aal), 200, String(body.action));
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const W1 = await profile("welder1@fin.test");
const W2 = await profile("welder2@fin.test");
const PM = await profile("pm@fin.test");
const FIN = await profile("finance@fin.test");
const PAY = await profile("payroll@fin.test");

Deno.test("a tradesperson sees only their own time, without rates or MFA", async () => {
  const me = await ok(W1, { action: "whoami" }, "aal1");
  assert(!me.mfa.required && me.mfa.satisfied, "no authenticator needed just to enter time");
  const setup = await ok(W1, { action: "projects_setup" }, "aal1");
  assert(setup.projects.some((p: any) => p.number === "JOB-1001"), "open projects listed");
  assert(setup.labourClasses.every((c: any) => c.costRate === undefined), "rates hidden from workers");
  assert(setup.can.submit && !setup.can.approve && !setup.can.manage, `flags ${JSON.stringify(setup.can)}`);
  expectStatus(await call(W1, { action: "projects_list" }, "aal1"), 403, "no project figures");
  expectStatus(await call(W1, { action: "invoices_list" }, "aal1"), 403, "no sales");
  expectStatus(await call(W1, { action: "timesheet_week", profileId: W2, weekStart: "2026-09-07" }, "aal1"), 403, "not someone else's week");
  const week = await ok(W1, { action: "timesheet_week", weekStart: "2026-09-09" }, "aal1");
  assert(week.weekStart === "2026-09-07" && week.timesheet.status === "approved" && !week.can.edit, "approved week is read-only");
  assert(week.entries.every((e: any) => e.cost === undefined), "no costs shown to the worker");
});

Deno.test("enter, submit, recall, approve and reject a week", async () => {
  const setup = await ok(W1, { action: "projects_setup" }, "aal1");
  const job = setup.projects.find((p: any) => p.number === "JOB-1001").id;
  const welding = setup.costCodes.find((c: any) => c.code === "110").id;
  expectStatus(await call(W1, { action: "timesheet_save", weekStart: "2026-09-21", entries: [{ date: "2026-09-21", projectId: job, start: "7am", end: "15:00" }] }, "aal1"), 400, "bad time");
  const entries = [
    { date: "2026-09-21", projectId: job, costCodeId: welding, start: "06:30", end: "15:00", breakMinutes: 30 },
    { date: "2026-09-22", projectId: job, costCodeId: welding, hours: 9.5, hourType: "ordinary", notes: "Hydro test" }
  ];
  const saved = await ok(W1, { action: "timesheet_save", weekStart: "2026-09-23", entries, submit: true }, "aal1");
  assert(saved.status === "submitted", "submitted");
  let week = await ok(W1, { action: "timesheet_week", weekStart: "2026-09-21" }, "aal1");
  assert(week.timesheet.totalHours === 17.5 && week.can.recall && !week.can.edit, `week ${JSON.stringify(week.timesheet)}`);
  await ok(W1, { action: "timesheet_reopen", id: week.timesheet.id }, "aal1");
  week = await ok(W1, { action: "timesheet_week", weekStart: "2026-09-21" }, "aal1");
  assert(week.timesheet.status === "draft" && week.can.edit, "recalled to draft");
  await ok(W1, { action: "timesheet_save", weekStart: "2026-09-21", entries, submit: true }, "aal1");

  // The project manager reviews.
  const review = await ok(PM, { action: "timesheets_review", status: "submitted" });
  const item = review.timesheets.find((t: any) => t.profileId === W1 && t.weekStart === "2026-09-21");
  assert(item && item.totalHours === 17.5, "waiting for approval");
  expectStatus(await call(W1, { action: "timesheet_decide", id: item.id, approve: true }, "aal1"), 403, "workers can't approve");
  await ok(PM, { action: "timesheet_decide", id: item.id, approve: true, comment: "OK" });
  const pmView = await ok(PM, { action: "timesheet_week", profileId: W1, weekStart: "2026-09-21" });
  // 17.5 hours at the Welder cost rate of $65 = $1,137.50.
  assert(pmView.entries.reduce((s: number, e: any) => s + e.cost, 0) === 1137.5 && pmView.can.reopen, `costed ${JSON.stringify(pmView.entries)}`);

  // Crew entry by the supervisor, then rejection back to the worker.
  const crew = await ok(PM, { action: "timesheet_save", profileId: W2, weekStart: "2026-09-21", entries: [{ date: "2026-09-23", projectId: job, costCodeId: welding, hours: 8 }], submit: false });
  expectStatus(await call(W2, { action: "timesheet_save", profileId: W1, weekStart: "2026-09-21", entries: [] }, "aal1"), 403, "workers can't enter for others");
  await ok(W2, { action: "timesheet_save", weekStart: "2026-09-21", entries: [{ date: "2026-09-23", projectId: job, costCodeId: welding, hours: 8 }], submit: true }, "aal1");
  expectStatus(await call(PM, { action: "timesheet_decide", id: crew.id, approve: false, comment: "" }), 409, "reason needed");
  await ok(PM, { action: "timesheet_decide", id: crew.id, approve: false, comment: "Wrong day" });
  const w2 = await ok(W2, { action: "timesheet_week", weekStart: "2026-09-21" }, "aal1");
  assert(w2.timesheet.status === "rejected" && w2.timesheet.comment === "Wrong day" && w2.can.edit, "sent back with the reason");
});

Deno.test("projects, budgets, labour rates and job costing", async () => {
  const setup = await ok(PM, { action: "projects_setup" });
  assert(setup.labourClasses.find((c: any) => c.code === "WELDER").costRate === 65, "manager sees rates");
  expectStatus(await call(FIN, { action: "project_save", name: "x" }), 403, "finance admin doesn't manage projects");
  const customer = setup.customers.find((c: any) => c.name === "Hunter Refinery Pty Ltd").id;
  const pipe = setup.costCodes.find((c: any) => c.code === "200").id;
  const { id } = await ok(PM, { action: "project_save", name: "Tank 7 repairs", customerId: customer, contractValue: "12,500", site: "Tank farm",
    budgets: [{ costCodeId: pipe, amount: "4,000" }] });
  let got = await ok(PM, { action: "project_get", id });
  assert(/^JOB-/.test(got.project.number) && got.project.contractValue === 12500 && got.budgets[0].amount === 4000, `project ${JSON.stringify(got.project)}`);

  // Finance tags an invoice line to it; revenue shows on the project.
  const sales = await ok(FIN, { action: "sales_setup" });
  assert(sales.projects.some((p: any) => p.id === id), "sales lines can pick the project");
  const inv = await ok(FIN, { action: "invoice_save", customerId: customer, date: "2026-09-25", approve: true,
    lines: [{ description: "Deposit", quantity: 1, unitPrice: 2500, accountId: sales.accounts.find((a: any) => a.code === "4300").id,
      taxCodeId: sales.taxCodes.find((t: any) => t.code === "GST").id, projectId: id }] });
  const invGot = await ok(FIN, { action: "invoice_get", id: inv.id });
  assert(invGot.lines[0].projectNumber === got.project.number, "line shows the project");
  got = await ok(PM, { action: "project_get", id, asAt: "2026-09-30" });
  assert(got.costing.revenue.invoiced === 2500 && got.invoices.length === 1, `revenue ${JSON.stringify(got.costing.revenue)}`);

  // The main job: figures from the database fixtures plus this week's approved 17.5 hours ($1,137.50).
  const list = await ok(PM, { action: "projects_list" });
  const main = list.projects.find((p: any) => p.number === "JOB-1001");
  assert(main.cost === 4372.5 + 1137.5 && main.customer === "Hunter Refinery Pty Ltd", `summary ${JSON.stringify(main)}`);
  const job = await ok(PM, { action: "project_get", id: main.id });
  assert(job.labour.some((l: any) => l.hours === 43 && l.cost === 2860), `labour by person ${JSON.stringify(job.labour)}`);
  expectStatus(await call(PM, { action: "project_status", id: main.id, status: "closed" }), 409, "can't close with hours waiting");

  // Labour classes and people.
  const people = await ok(PM, { action: "labour_people" });
  assert(people.people.some((p: any) => p.id === W2 && !p.labourClassId), "welder2 has no class yet");
  await ok(PM, { action: "labour_assign", profileId: W2, classId: setup.labourClasses.find((c: any) => c.code === "LAB").id });
  expectStatus(await call(PM, { action: "labour_class_save", code: "WELDER", name: "Welder", costRate: "abc" }), 400, "rates are numbers");
});

Deno.test("hours for payroll, exported and logged; dashboard", async () => {
  const r = await ok(PAY, { action: "timesheet_hours", from: "2026-09-01", to: "2026-09-30", export: true });
  assert(r.rows.length >= 6 && r.rows.every((x: any) => x.hours > 0), "approved hours listed");
  const audit = await rest("training_audit_events?select=details&event_type=eq.report_exported&entity_id=eq.timesheet_hours");
  assert(audit.length >= 1, "export logged");
  expectStatus(await call(W1, { action: "timesheet_hours", from: "2026-09-01", to: "2026-09-30" }, "aal1"), 403, "workers can't export everyone's hours");
  const dash = await ok(PM, { action: "dashboard" });
  assert(dash.projects && dash.projects.activeProjects >= 2, `dashboard ${JSON.stringify(dash.projects)}`);
});
