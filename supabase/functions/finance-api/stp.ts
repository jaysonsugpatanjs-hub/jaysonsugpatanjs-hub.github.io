// Phase 8: Single Touch Payroll Phase 2 information. Pay items are mapped to
// STP categories, each approved pay run gets a pay event with year-to-date
// amounts per employee, checked against the reporting rules, plus update and
// finalisation events. Events can be exported for checking or for an STP
// product. Sending to the ATO is switched off (stp_event_submit refuses):
// see docs/STP_ROADMAP.md. Writes go through SQL functions that re-check
// permissions and audit. TFNs are only in the export (payroll.sensitive).
import { httpError, rpc } from "../_shared/http.ts";
import { date, has, names, optDate, text, uuid, type Actor, type Client, type Handler } from "./docs.ts";
import { todaySydney } from "./ledger.ts";

const READ = ["payroll.run", "payroll.approve", "payroll.sensitive"];
const CATEGORIES = ["gross", "overtime", "bonus", "directors_fees", "paid_leave", "allowance", "deduction", "not_reported"];
const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA", "OTH"];

function yearStart(today: string, fyMonth: number) {
  const [y, m] = today.split("-").map(Number);
  return `${m >= fyMonth ? y : y - 1}-${String(fyMonth).padStart(2, "0")}-01`;
}

async function overview(admin: Client, actor: Actor) {
  const org = actor.organization_id;
  const [cs, st, items, events, runs] = await Promise.all([
    admin.from("company_settings").select("legal_name,abn,financial_year_start_month").eq("organization_id", org).maybeSingle(),
    admin.from("stp_settings").select("*").eq("organization_id", org).maybeSingle(),
    admin.from("pay_items").select("id,code,name,kind,stp_category,stp_code,active").eq("organization_id", org).order("sort"),
    admin.from("stp_events").select("id,kind,status,as_at,year_start,totals,created_by,created_at,ready_by,ready_at,pay_run_id,pay_runs(number)")
      .eq("organization_id", org).order("as_at", { ascending: false }).order("created_at", { ascending: false }).limit(100),
    admin.from("pay_runs").select("id,number,payment_date,status").eq("organization_id", org).in("status", ["approved", "paid"]).order("payment_date", { ascending: false }).limit(60)
  ]);
  const withEvent = new Set((events.data || []).filter((e: any) => e.kind === "pay").map((e: any) => e.pay_run_id));
  const who = await names(admin, (events.data || []).flatMap((e: any) => [e.created_by, e.ready_by]));
  const fy = Number(cs.data?.financial_year_start_month || 7);
  const current = yearStart(todaySydney(), fy);
  const s = st.data || {};
  return {
    settings: { bmsId: s.bms_id, branch: s.branch || "001", contactName: s.contact_name, contactPhone: s.contact_phone, contactEmail: s.contact_email,
      transmissionEnabled: Boolean(s.transmission_enabled), employer: { name: cs.data?.legal_name, abn: cs.data?.abn } },
    items: (items.data || []).map((i: any) => ({ id: i.id, code: i.code, name: i.name, kind: i.kind, category: i.stp_category, stpCode: i.stp_code, active: i.active })),
    events: (events.data || []).map((e: any) => ({ id: e.id, kind: e.kind, status: e.status, asAt: e.as_at, yearStart: e.year_start, payRun: e.pay_runs?.number || null,
      payees: Number(e.totals?.payees || 0), gross: Number(e.totals?.gross || 0), payg: Number(e.totals?.payg || 0), withErrors: Number(e.totals?.withErrors || 0),
      createdBy: who.get(e.created_by) || null, readyBy: who.get(e.ready_by) || null })),
    runsWithoutEvent: (runs.data || []).filter((r: any) => !withEvent.has(r.id)).map((r: any) => ({ id: r.id, number: r.number, paymentDate: r.payment_date })),
    years: [0, 1, 2].map(i => { const y = `${Number(current.slice(0, 4)) - i}${current.slice(4)}`; return { start: y, label: `${y.slice(0, 4)}-${String(Number(y.slice(0, 4)) + 1).slice(2)}` }; }),
    can: { prepare: has(actor, "payroll.run"), ready: has(actor, "payroll.approve"), settings: has(actor, "payroll.sensitive"), export: has(actor, "payroll.sensitive") }
  };
}

async function eventGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "STP event");
  const { data: e } = await admin.from("stp_events").select("*,pay_runs(number,period_start,period_end)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!e) throw httpError(404, "STP event not found.");
  const { data: recs } = await admin.from("stp_employee_records").select("employee_id,payee,ytd,final,errors,warnings,payroll_employees(employees(full_name,employee_number))")
    .eq("event_id", id);
  const who = await names(admin, [e.created_by, e.ready_by]);
  // Dates of birth, addresses and TFN digits are for payroll.sensitive only.
  const sensitive = has(actor, "payroll.sensitive");
  const limited = (p: any) => {
    const { dateOfBirth: _d, address: _a, homeAddress: _h, tfn: _t, ...rest } = p || {};
    return { ...rest, hidden: true };
  };
  return {
    event: { id: e.id, kind: e.kind, status: e.status, asAt: e.as_at, yearStart: e.year_start, employer: e.employer, errors: e.errors, totals: e.totals,
      payRun: e.pay_runs ? { id: e.pay_run_id, number: e.pay_runs.number, from: e.pay_runs.period_start, to: e.pay_runs.period_end } : null,
      createdBy: who.get(e.created_by) || null, createdAt: e.created_at, readyBy: who.get(e.ready_by) || null, readyAt: e.ready_at },
    records: (recs || []).map((r: any) => ({ employeeId: r.employee_id, name: r.payroll_employees?.employees?.full_name, number: r.payroll_employees?.employees?.employee_number,
      payee: sensitive ? r.payee : limited(r.payee), ytd: r.ytd, final: r.final, errors: r.errors || [], warnings: r.warnings || [] }))
      .sort((a: any, b: any) => (b.errors.length - a.errors.length) || String(a.name).localeCompare(String(b.name))),
    can: {
      check: ["draft", "validated"].includes(e.status) && has(actor, "payroll.run"),
      ready: e.status === "validated" && has(actor, "payroll.approve") && e.created_by !== actor.id,
      delete: ["draft", "validated"].includes(e.status) && has(actor, "payroll.run"),
      export: has(actor, "payroll.sensitive"),
      send: false
    }
  };
}

/** The event with full TFNs, for checking against the STP product or handing to it. Audited. */
async function exportEvent(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "STP event");
  const { data: e } = await admin.from("stp_events").select("*").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!e) throw httpError(404, "STP event not found.");
  const { data: recs } = await admin.from("stp_employee_records").select("employee_id,payee,ytd,final,errors").eq("event_id", id);
  const ids = (recs || []).map((r: any) => r.employee_id);
  const { data: pes } = ids.length ? await admin.from("payroll_employees").select("employee_id,tfn,tfn_status").in("employee_id", ids) : { data: [] };
  const tfn = new Map((pes || []).map((p: any) => [p.employee_id, p]));
  const payees = (recs || []).map((r: any) => {
    const pe: any = tfn.get(r.employee_id) || {};
    return { ...r.payee, tfn: pe.tfn_status === "provided" && pe.tfn ? pe.tfn : r.payee.tfn, final: r.final, ytd: r.ytd, errors: r.errors };
  });
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "stp_event_exported", p_entity_type: "stp_event", p_entity_id: id, p_old: null, p_new: null,
    p_details: { payees: payees.length }, p_subject: null });
  const file = {
    note: "STP Phase 2 information prepared in Panalo Accounts for checking or for an STP-enabled product. Not lodged with the ATO by this system.",
    event: { kind: e.kind, status: e.status, runDate: e.as_at, financialYear: `${e.year_start.slice(0, 4)}-${String(Number(e.year_start.slice(0, 4)) + 1).slice(2)}` },
    payer: e.employer, payees
  };
  const csvRows = [["Payroll ID", "Family name", "Given names", "TFN", "Date of birth", "Start", "Finish", "Cessation", "Employment basis", "Tax treatment", "Income type",
    "Gross", "Overtime", "Bonuses", "Directors' fees", "Paid leave", "Allowances", "Salary sacrifice (S)", "PAYG withheld", "Deductions", "Super liability (L)", "OTE", "RESC", "Final"]];
  for (const p of payees) {
    const y = p.ytd || {};
    const pairs = (o: any) => Object.entries(o || {}).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join("; ");
    csvRows.push([p.payrollId, p.familyName, p.givenNames, p.tfn, p.dateOfBirth || "", p.startDate || "", p.endDate || "", p.cessationType || "", p.employmentBasis || "",
      p.taxTreatment, p.incomeType, y.gross, y.overtime, y.bonus, y.directorsFees, pairs(y.paidLeave), pairs(y.allowances), y.salarySacrifice?.S, y.payg, pairs(y.deductions),
      y.super?.L, y.super?.OTE, y.super?.RESC, p.final ? "Y" : ""].map((v: any) => (v == null ? "" : String(v))));
  }
  return { fileName: `STP-${e.kind}-${e.as_at}`, json: JSON.stringify(file, null, 2), csv: csvRows };
}

async function itemMap(admin: Client, actor: Actor, body: any) {
  const category = CATEGORIES.includes(body.category) ? body.category : "";
  if (!category) throw httpError(400, "Choose the STP category.");
  await rpc(admin, "stp_pay_item_map", { p_actor: actor.id, p_item: uuid(body.id, "Pay item"), p_category: category, p_code: text(body.code, 4).toUpperCase() || null });
  return { ok: true };
}

async function employeeStpSave(admin: Client, actor: Actor, body: any) {
  const a = body.homeAddress || {};
  const state = text(a.state, 3).toUpperCase();
  if (state && !STATES.includes(state)) throw httpError(400, "Choose the state.");
  await rpc(admin, "payroll_employee_stp_save", { p_actor: actor.id, p_employee: uuid(body.id, "Employee"), p: {
    family_name: text(body.familyName, 40), given_names: text(body.givenNames, 80),
    home_address: { street: text(a.street, 120), street2: text(a.street2, 120), suburb: text(a.suburb, 60), state, postcode: String(a.postcode ?? "").trim() },
    stp_income_type: text(body.incomeType, 3).toUpperCase(), stp_country: text(body.country, 2).toLowerCase(), cessation_type: text(body.cessationType, 1).toUpperCase()
  } });
  return { saved: true };
}

export const stpActions: Record<string, { perm: string[] | null; run: Handler }> = {
  stp_overview: { perm: READ, run: overview },
  stp_event_get: { perm: READ, run: eventGet },
  stp_event_export: { perm: ["payroll.sensitive"], run: exportEvent },
  stp_settings_save: { perm: ["payroll.sensitive"], run: async (admin, actor, body) => {
    await rpc(admin, "stp_settings_save", { p_actor: actor.id, p: { branch: text(body.branch, 3), contact_name: text(body.contactName, 120),
      contact_phone: text(body.contactPhone, 30), contact_email: text(body.contactEmail, 200) } });
    return { ok: true };
  } },
  stp_item_map: { perm: ["payroll.sensitive"], run: itemMap },
  payroll_employee_stp_save: { perm: ["payroll.sensitive"], run: employeeStpSave },
  stp_event_pay: { perm: ["payroll.run"], run: async (admin, actor, body) => ({ id: await rpc(admin, "stp_event_pay", { p_actor: actor.id, p_run: uuid(body.runId, "Pay run") }) }) },
  stp_event_year: { perm: ["payroll.run"], run: async (admin, actor, body) => ({
    id: await rpc(admin, "stp_event_year", { p_actor: actor.id, p_kind: body.kind === "finalisation" ? "finalisation" : "update",
      p_year_start: date(body.yearStart, "The financial year"), p_as_at: optDate(body.asAt) })
  }) },
  stp_event_check: { perm: ["payroll.run"], run: async (admin, actor, body) => ({ status: await rpc(admin, "stp_event_check", { p_actor: actor.id, p_id: uuid(body.id, "STP event") }) }) },
  stp_event_ready: { perm: ["payroll.approve"], run: async (admin, actor, body) => { await rpc(admin, "stp_event_ready", { p_actor: actor.id, p_id: uuid(body.id, "STP event") }); return { ok: true }; } },
  stp_event_submit: { perm: ["payroll.approve"], run: async (admin, actor, body) => { await rpc(admin, "stp_event_submit", { p_actor: actor.id, p_id: uuid(body.id, "STP event") }); return { ok: true }; } },
  stp_event_delete: { perm: ["payroll.run"], run: async (admin, actor, body) => { await rpc(admin, "stp_event_delete", { p_actor: actor.id, p_id: uuid(body.id, "STP event") }); return { ok: true }; } }
};
