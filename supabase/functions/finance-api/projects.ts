// Phase 4: projects, cost codes, labour rates, timesheets and job costing.
// Writes go through SQL functions that re-check permissions and audit.
// Labour rates are visible only to people who manage projects; someone who
// only enters their own time sees projects, cost codes and their own hours.
import { httpError, rpc } from "../_shared/http.ts";
import { cents, dollars, has, names, optDate, optUuid, text, uuid, type Actor, type Client, type Handler } from "./docs.ts";
import { todaySydney } from "./ledger.ts";

const PROJECT_READ = ["projects.manage", "reports.view"];
const TIME_REVIEW = ["time.approve", "projects.manage", "payroll.run"];
const STATUSES = ["tender", "active", "on_hold", "completed", "closed", "cancelled"];
const CATEGORIES = ["labour", "materials", "equipment", "subcontract", "travel", "consumables", "freight", "other"];
const HOUR_TYPES = ["ordinary", "overtime_150", "overtime_200", "travel"];
const BILLING = ["fixed_price", "schedule_of_rates", "cost_plus", "internal"];

export function mondayOf(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
const weekArg = (v: unknown) => {
  const d = optDate(v);
  return d ? mondayOf(d) : mondayOf(todaySydney());
};
const time = (v: unknown) => {
  const t = String(v ?? "").trim();
  if (!t) return "";
  if (!/^([01]?\d|2[0-3]):[0-5]\d(:00)?$/.test(t)) throw httpError(400, "Times are like 07:00 or 15:30.");
  return t.slice(0, 5);
};

/* ---------------- Setup ---------------- */

async function projectsSetup(admin: Client, actor: Actor) {
  const manage = has(actor, "projects.manage");
  const [codes, classes, projects, customers] = await Promise.all([
    admin.from("cost_codes").select("id,code,name,category,active,sort").eq("organization_id", actor.organization_id).order("sort"),
    admin.from("labour_classes").select("id,code,name,cost_rate,charge_rate,active").eq("organization_id", actor.organization_id).order("code"),
    admin.from("projects").select("id,number,name,status,site").eq("organization_id", actor.organization_id).not("status", "in", "(closed,cancelled)").order("number", { ascending: false }),
    manage ? admin.from("customers").select("id,name").eq("organization_id", actor.organization_id).eq("status", "active").order("name") : Promise.resolve({ data: [] })
  ]);
  if (codes.error || classes.error || projects.error) throw httpError(500, "Project settings could not be loaded.");
  return {
    today: todaySydney(),
    weekStart: mondayOf(todaySydney()),
    costCodes: codes.data.map((c: any) => ({ id: c.id, code: c.code, name: c.name, category: c.category, active: c.active })),
    labourClasses: classes.data.map((c: any) => ({ id: c.id, code: c.code, name: c.name, active: c.active,
      ...(manage ? { costRate: Number(c.cost_rate), chargeRate: Number(c.charge_rate) } : {}) })),
    projects: projects.data.map((p: any) => ({ id: p.id, number: p.number, name: p.name, status: p.status, site: p.site })),
    customers: (customers as any).data || [],
    can: { manage, approve: has(actor, "time.approve"), submit: has(actor, "time.submit") || has(actor, "time.approve"),
      reports: has(actor, "reports.view") || manage, payroll: has(actor, "payroll.run") }
  };
}

/* ---------------- Projects ---------------- */

async function projectsList(admin: Client, actor: Actor, body: any) {
  const status = body.status === "all" ? null : STATUSES.includes(body.status) ? body.status : "open";
  const [rows, extra] = await Promise.all([
    rpc<any[]>(admin, "report_projects_summary", { p_actor: actor.id, p_status: status }),
    admin.from("projects").select("id,site,manager_id,customer_id,start_date,end_date,customers(name)").eq("organization_id", actor.organization_id)
  ]);
  const ex = new Map((extra.data || []).map((p: any) => [p.id, p]));
  const who = await names(admin, (extra.data || []).map((p: any) => p.manager_id));
  if (body.export === true) {
    if (!has(actor, "data.export")) throw httpError(403, "Exporting needs the data export permission.");
    await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "report_exported", p_entity_type: "report", p_entity_id: "job_costing",
      p_old: null, p_new: null, p_details: { status, format: "csv" }, p_subject: null });
  }
  const q = String(body.search || "").toLowerCase().slice(0, 60);
  return {
    projects: (rows || []).filter((r: any) => !q || `${r.number} ${r.name}`.toLowerCase().includes(q)).map((r: any) => {
      const p: any = ex.get(r.id) || {};
      return { ...r, site: p.site || "", customer: p.customers?.name || null, manager: who.get(p.manager_id) || null, startDate: p.start_date, endDate: p.end_date };
    })
  };
}

async function projectGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Project");
  const { data: p } = await admin.from("projects").select("*,customers(name),project_budgets(cost_code_id,budget_hours,budget_amount)")
    .eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!p) throw httpError(404, "Project not found.");
  const asAt = optDate(body.asAt) || todaySydney();
  const [costing, who, quote, invLines, billLines, hours] = await Promise.all([
    rpc<any>(admin, "report_project_costing", { p_actor: actor.id, p_project: id, p_to: asAt }),
    names(admin, [p.manager_id, p.created_by]),
    p.quote_id ? admin.from("quotes").select("id,number").eq("id", p.quote_id).maybeSingle() : Promise.resolve({ data: null }),
    admin.from("invoice_lines").select("amount,gst,invoices!inner(id,kind,number,invoice_date,status,amounts_are)").eq("project_id", id).limit(500),
    admin.from("bill_lines").select("amount,gst,cost_code_id,bills!inner(id,kind,number,supplier_reference,bill_date,status,amounts_are,suppliers(name))").eq("project_id", id).limit(500),
    admin.from("timesheet_entries").select("hours,cost_amount,timesheets!inner(profile_id,status)").eq("project_id", id).limit(5000)
  ]);
  // Documents on this project (net of GST, credit notes negative), one row per document.
  const docs = (rows: any[], key: string) => {
    const m = new Map<string, any>();
    for (const l of rows || []) {
      const d = l[key];
      if (!d || d.status === "void") continue;
      const net = cents(l.amount) - (d.amounts_are === "inclusive" ? cents(l.gst) : 0);
      const cur = m.get(d.id) || { ...d, net: 0 };
      cur.net += (d.kind === "credit_note" ? -1 : 1) * net;
      m.set(d.id, cur);
    }
    return [...m.values()].map(d => ({ id: d.id, kind: d.kind, number: d.number, reference: d.supplier_reference || null, supplier: d.suppliers?.name || null,
      date: d.invoice_date || d.bill_date, status: d.status, amount: dollars(d.net) })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  };
  const byPerson = new Map<string, { hours: number; cost: number; pending: number }>();
  for (const e of hours.data || []) {
    const k = e.timesheets.profile_id;
    const cur = byPerson.get(k) || { hours: 0, cost: 0, pending: 0 };
    if (e.timesheets.status === "approved") { cur.hours += Number(e.hours); cur.cost += cents(e.cost_amount); } else cur.pending += Number(e.hours);
    byPerson.set(k, cur);
  }
  const people = await names(admin, [...byPerson.keys()]);
  return {
    project: { id: p.id, number: p.number, name: p.name, customerId: p.customer_id, customer: p.customers?.name || null, quoteId: p.quote_id,
      quote: (quote as any).data, site: p.site, customerReference: p.customer_reference, managerId: p.manager_id, manager: who.get(p.manager_id) || null,
      billingType: p.billing_type, contractValue: Number(p.contract_value), startDate: p.start_date, endDate: p.end_date, status: p.status, notes: p.notes,
      createdBy: who.get(p.created_by) || null },
    budgets: (p.project_budgets || []).map((b: any) => ({ costCodeId: b.cost_code_id, hours: Number(b.budget_hours), amount: Number(b.budget_amount) })),
    costing,
    invoices: docs(invLines.data, "invoices"),
    bills: docs(billLines.data, "bills"),
    labour: [...byPerson.entries()].map(([id, v]) => ({ id, name: people.get(id) || "Unknown", hours: Math.round(v.hours * 100) / 100,
      ...(has(actor, "projects.manage") ? { cost: dollars(v.cost) } : {}), pendingHours: Math.round(v.pending * 100) / 100 })).sort((a, b) => b.hours - a.hours),
    can: { manage: has(actor, "projects.manage") }
  };
}

async function projectSave(admin: Client, actor: Actor, body: any) {
  const name = text(body.name, 160);
  if (name.length < 2) throw httpError(400, "Give the project a name.");
  const contract = body.contractValue === "" || body.contractValue == null ? 0 : Number(String(body.contractValue).replace(/[$,]/g, ""));
  if (!Number.isFinite(contract) || contract < 0) throw httpError(400, "The contract value must be a positive amount.");
  const budgets = Array.isArray(body.budgets) ? body.budgets.slice(0, 100).map((b: any) => ({
    costCodeId: uuid(b?.costCodeId, "Cost code"),
    hours: b?.hours === "" || b?.hours == null ? 0 : Number(b.hours),
    amount: b?.amount === "" || b?.amount == null ? 0 : Number(String(b.amount).replace(/[$,]/g, ""))
  })) : null;
  if (budgets?.some((b: any) => !Number.isFinite(b.hours) || !Number.isFinite(b.amount))) throw httpError(400, "Budget hours and amounts must be numbers.");
  const id = await rpc<string>(admin, "project_save", {
    p_actor: actor.id, p_id: optUuid(body.id),
    p: { name, customer_id: optUuid(body.customerId) || "", quote_id: optUuid(body.quoteId) || "", site: text(body.site, 300), customer_reference: text(body.customerReference, 120),
      manager_id: optUuid(body.managerId) || "", billing_type: BILLING.includes(body.billingType) ? body.billingType : "fixed_price", contract_value: String(Math.round(contract * 100) / 100),
      start_date: optDate(body.startDate) || "", end_date: optDate(body.endDate) || "", notes: text(body.notes, 3000) },
    p_budgets: budgets
  });
  return { id };
}

async function projectStatus(admin: Client, actor: Actor, body: any) {
  if (!STATUSES.includes(body.status)) throw httpError(400, "Choose a project status.");
  await rpc(admin, "project_set_status", { p_actor: actor.id, p_id: uuid(body.id, "Project"), p_status: body.status });
  return { saved: true };
}

async function projectManagers(admin: Client, actor: Actor) {
  const { data } = await admin.from("training_profiles").select("id,full_name,email").eq("organization_id", actor.organization_id).eq("active", true).order("full_name");
  return { people: (data || []).map((p: any) => ({ id: p.id, name: p.full_name || p.email })) };
}

/* ---------------- Cost codes and labour rates ---------------- */

async function costCodeSave(admin: Client, actor: Actor, body: any) {
  const code = text(body.code, 10).toUpperCase();
  if (!/^[0-9A-Z][0-9A-Z.-]{0,9}$/.test(code)) throw httpError(400, "Cost codes are 1 to 10 letters, digits, dots or dashes.");
  if (text(body.name, 80).length < 2) throw httpError(400, "Give the cost code a name.");
  if (!CATEGORIES.includes(body.category)) throw httpError(400, "Choose a category.");
  return { id: await rpc<string>(admin, "cost_code_save", { p_actor: actor.id, p_id: optUuid(body.id), p_code: code, p_name: text(body.name, 80), p_category: body.category, p_active: body.active !== false }) };
}

async function labourClassSave(admin: Client, actor: Actor, body: any) {
  const code = text(body.code, 12).toUpperCase();
  if (!/^[A-Z0-9-]{1,12}$/.test(code)) throw httpError(400, "Codes are up to 12 capital letters, digits or dashes.");
  const cost = Number(String(body.costRate ?? "").replace(/[$,]/g, ""));
  const charge = Number(String(body.chargeRate ?? "").replace(/[$,]/g, "") || 0);
  if (!Number.isFinite(cost) || !Number.isFinite(charge)) throw httpError(400, "Rates are dollars per hour.");
  return { id: await rpc<string>(admin, "labour_class_save", { p_actor: actor.id, p_id: optUuid(body.id), p_code: code, p_name: text(body.name, 80),
    p_cost: Math.round(cost * 100) / 100, p_charge: Math.round(charge * 100) / 100, p_active: body.active !== false }) };
}

async function labourPeople(admin: Client, actor: Actor) {
  return { people: await rpc<any[]>(admin, "timesheet_people", { p_actor: actor.id }) };
}

async function labourAssign(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "labour_profile_set", { p_actor: actor.id, p_profile: uuid(body.profileId, "Person"), p_class: optUuid(body.classId) });
  return { saved: true };
}

/* ---------------- Timesheets ---------------- */

function shapeEntries(rows: any[], showCost: boolean) {
  return (rows || []).sort((a, b) => a.line_no - b.line_no).map((e: any) => ({
    id: e.id, date: e.work_date, projectId: e.project_id, costCodeId: e.cost_code_id, start: e.start_time ? e.start_time.slice(0, 5) : "",
    end: e.end_time ? e.end_time.slice(0, 5) : "", breakMinutes: e.break_minutes, hours: Number(e.hours), hourType: e.hour_type, notes: e.notes,
    ...(showCost ? { costRate: e.cost_rate == null ? null : Number(e.cost_rate), cost: e.cost_amount == null ? null : Number(e.cost_amount) } : {})
  }));
}

async function canSeeTimesheetOf(admin: Client, actor: Actor, profileId: string) {
  if (profileId === actor.id) return;
  if (!TIME_REVIEW.some(k => has(actor, k))) throw httpError(403, "You can only see your own timesheets.");
  const { data } = await admin.from("training_profiles").select("organization_id").eq("id", profileId).maybeSingle();
  if (!data || data.organization_id !== actor.organization_id) throw httpError(404, "Person not found.");
}

async function timesheetWeek(admin: Client, actor: Actor, body: any) {
  const week = weekArg(body.weekStart);
  const profileId = optUuid(body.profileId) || actor.id;
  await canSeeTimesheetOf(admin, actor, profileId);
  const { data: ts } = await admin.from("timesheets").select("*,timesheet_entries(*)").eq("profile_id", profileId).eq("week_start", week).maybeSingle();
  const [who, recent] = await Promise.all([
    names(admin, [profileId, ts?.decided_by, ts?.created_by].filter(Boolean) as string[]),
    admin.from("timesheets").select("id,week_start,status,total_hours").eq("profile_id", profileId).order("week_start", { ascending: false }).limit(8)
  ]);
  const editable = !ts || ["draft", "rejected"].includes(ts.status);
  return {
    weekStart: week, profileId, person: who.get(profileId) || "",
    timesheet: ts ? { id: ts.id, status: ts.status, totalHours: Number(ts.total_hours), submittedAt: ts.submitted_at, decidedAt: ts.decided_at,
      decidedBy: who.get(ts.decided_by) || null, comment: ts.decision_comment, enteredBy: ts.created_by !== profileId ? who.get(ts.created_by) || null : null } : null,
    entries: shapeEntries(ts?.timesheet_entries, has(actor, "projects.manage")),
    recent: (recent.data || []).map((r: any) => ({ id: r.id, weekStart: r.week_start, status: r.status, totalHours: Number(r.total_hours) })),
    can: {
      edit: editable && (profileId === actor.id ? (has(actor, "time.submit") || has(actor, "time.approve")) : has(actor, "time.approve")),
      recall: ts?.status === "submitted" && profileId === actor.id,
      decide: ts?.status === "submitted" && profileId !== actor.id && has(actor, "time.approve"),
      reopen: ts?.status === "approved" && profileId !== actor.id && has(actor, "time.approve") && !ts.payroll_locked_at
    }
  };
}

function cleanEntries(list: unknown) {
  if (!Array.isArray(list)) throw httpError(400, "Add the hours for the week.");
  if (list.length > 100) throw httpError(400, "A week can have up to 100 entries.");
  return list.map((e: any) => {
    const hours = e?.hours === "" || e?.hours == null ? null : Number(e.hours);
    if (hours != null && !Number.isFinite(hours)) throw httpError(400, "Hours must be a number.");
    return {
      date: optDate(e?.date) || "", projectId: optUuid(e?.projectId), costCodeId: optUuid(e?.costCodeId), start: time(e?.start), end: time(e?.end),
      breakMinutes: Math.max(0, Math.min(600, Math.round(Number(e?.breakMinutes) || 0))), hours: hours == null ? null : Math.round(hours * 100) / 100,
      hourType: HOUR_TYPES.includes(e?.hourType) ? e.hourType : "ordinary", notes: text(e?.notes, 300)
    };
  });
}

async function timesheetSave(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "timesheet_save", {
    p_actor: actor.id, p_profile: optUuid(body.profileId), p_week: weekArg(body.weekStart), p_entries: cleanEntries(body.entries), p_submit: body.submit === true
  });
  return { id, status: body.submit === true ? "submitted" : "draft" };
}

async function timesheetReopen(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "timesheet_reopen", { p_actor: actor.id, p_id: uuid(body.id, "Timesheet"), p_reason: text(body.reason, 300) });
  return { saved: true };
}

async function timesheetDecide(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "timesheet_decide", { p_actor: actor.id, p_id: uuid(body.id, "Timesheet"), p_approve: body.approve === true, p_comment: text(body.comment, 300) });
  return { saved: true };
}

async function timesheetsReview(admin: Client, actor: Actor, body: any) {
  const status = ["submitted", "approved", "rejected", "draft"].includes(body.status) ? body.status : "submitted";
  let q = admin.from("timesheets").select("id,profile_id,week_start,status,total_hours,submitted_at,decided_at,decided_by,timesheet_entries(hours,hour_type,project_id)")
    .eq("organization_id", actor.organization_id).eq("status", status).order("week_start", { ascending: false }).limit(200);
  if (optDate(body.weekStart)) q = q.eq("week_start", mondayOf(body.weekStart));
  const { data, error } = await q;
  if (error) throw httpError(500, "Timesheets could not be loaded.");
  const who = await names(admin, data.flatMap((t: any) => [t.profile_id, t.decided_by]));
  return {
    status,
    timesheets: data.map((t: any) => {
      const ot = (t.timesheet_entries || []).filter((e: any) => e.hour_type.startsWith("overtime")).reduce((s: number, e: any) => s + Number(e.hours), 0);
      return { id: t.id, profileId: t.profile_id, person: who.get(t.profile_id) || "Unknown", weekStart: t.week_start, status: t.status, totalHours: Number(t.total_hours),
        overtimeHours: Math.round(ot * 100) / 100, projects: new Set((t.timesheet_entries || []).map((e: any) => e.project_id).filter(Boolean)).size,
        submittedAt: t.submitted_at, decidedAt: t.decided_at, decidedBy: who.get(t.decided_by) || null, mine: t.profile_id === actor.id };
    })
  };
}

async function timesheetHours(admin: Client, actor: Actor, body: any) {
  const from = optDate(body.from), to = optDate(body.to);
  if (!from || !to || from > to) throw httpError(400, "Choose a date range.");
  const rows = await rpc<any[]>(admin, "report_timesheet_hours", { p_actor: actor.id, p_from: from, p_to: to });
  if (body.export === true) {
    await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "report_exported", p_entity_type: "report", p_entity_id: "timesheet_hours",
      p_old: null, p_new: null, p_details: { from, to, rows: rows.length, format: "csv" }, p_subject: null });
  }
  return { from, to, rows };
}

/** Headline project figures for the dashboard. */
export async function projectsHeadlines(admin: Client, actor: Actor) {
  if (!["projects.manage", "time.approve"].some(k => has(actor, k))) return null;
  const [open, waiting] = await Promise.all([
    has(actor, "projects.manage") ? admin.from("projects").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).in("status", ["active", "on_hold"]) : Promise.resolve({ count: null }),
    admin.from("timesheets").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).eq("status", "submitted").neq("profile_id", actor.id)
  ]);
  return { activeProjects: (open as any).count ?? null, timesheetsToApprove: has(actor, "time.approve") ? waiting.count ?? 0 : null };
}

export const projectsActions: Record<string, { perm: string[] | null; run: Handler }> = {
  projects_setup: { perm: ["projects.manage", "reports.view", "time.submit", "time.approve", "payroll.run"], run: projectsSetup },
  projects_list: { perm: PROJECT_READ, run: projectsList },
  project_get: { perm: PROJECT_READ, run: projectGet },
  project_save: { perm: ["projects.manage"], run: projectSave },
  project_status: { perm: ["projects.manage"], run: projectStatus },
  project_people: { perm: ["projects.manage"], run: projectManagers },
  cost_code_save: { perm: ["projects.manage"], run: costCodeSave },
  labour_class_save: { perm: ["projects.manage"], run: labourClassSave },
  labour_people: { perm: ["projects.manage", "time.approve"], run: labourPeople },
  labour_assign: { perm: ["projects.manage"], run: labourAssign },
  timesheet_week: { perm: ["time.submit", ...TIME_REVIEW], run: timesheetWeek },
  timesheet_save: { perm: ["time.submit", "time.approve"], run: timesheetSave },
  timesheet_reopen: { perm: ["time.submit", "time.approve"], run: timesheetReopen },
  timesheet_decide: { perm: ["time.approve"], run: timesheetDecide },
  timesheets_review: { perm: TIME_REVIEW, run: timesheetsReview },
  timesheet_hours: { perm: TIME_REVIEW, run: timesheetHours }
};
