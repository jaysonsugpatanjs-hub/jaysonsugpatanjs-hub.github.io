// Phase 5: payroll. Employees' pay, tax, super and bank details
// (payroll.sensitive), leave, pay runs (prepare: payroll.run; approve:
// payroll.approve, never the preparer), payments, payslips, and "My pay"
// for employees (payroll.self). Writes are SQL functions that re-check
// permissions and audit. TFNs are never returned in full.
import { httpError, rpc } from "../_shared/http.ts";
import { createPayslipPdf } from "../_shared/payslip-pdf.ts";
import { addressLines } from "../_shared/finance-pdf.ts";
import { toBase64 } from "../_shared/finance-pdf.ts";
import { cents, date, dollars, has, names, optDate, optUuid, text, uuid, type Actor, type Client, type Handler } from "./docs.ts";
import { todaySydney } from "./ledger.ts";

const RUN_READ = ["payroll.run", "payroll.approve", "payroll.sensitive"];
const PEOPLE_READ = ["payroll.sensitive", "payroll.run", "payroll.approve", "leave.approve"];
const FREQ = ["weekly", "fortnightly", "monthly"];
const maskTfn = (t?: string | null) => (t ? `••• ••• ${t.slice(-3)}` : null);
const maskAcct = (n?: string | null) => (n ? `•••${n.slice(-3)}` : null);
const fmtBsb = (b?: string | null) => (b ? `${b.slice(0, 3)}-${b.slice(3)}` : null);
const num = (v: unknown) => (v == null ? null : Number(v));

async function compliance(admin: Client, rule: string, on: string) {
  return await rpc<any>(admin, "compliance_value", { p_rule: rule, p_date: on });
}

/* ---------------- Setup ---------------- */

async function payrollSetup(admin: Client, actor: Actor) {
  const today = todaySydney();
  const [items, types, accounts, settings, sg, nmw, mcb] = await Promise.all([
    admin.from("pay_items").select("id,code,name,kind,taxable,qualifying_earnings,ordinary_hours,rate_multiplier,payee,is_system,active,sort").eq("organization_id", actor.organization_id).order("sort"),
    admin.from("leave_types").select("id,code,name,paid,accrual_per_hour,notes,active").eq("organization_id", actor.organization_id).order("code"),
    admin.from("accounts").select("id,code,name,type,subtype,status").eq("organization_id", actor.organization_id).eq("status", "active").order("code"),
    admin.from("company_settings").select("pay_frequency,pay_day,super_clearing_house").eq("organization_id", actor.organization_id).maybeSingle(),
    compliance(admin, "super_guarantee_rate", today), compliance(admin, "national_minimum_wage_hourly", today), compliance(admin, "super_max_contribution_base", today)
  ]);
  return {
    today,
    payFrequency: settings.data?.pay_frequency || "weekly", payDay: settings.data?.pay_day || "Thursday",
    rules: { superGuaranteeRate: num(sg), nationalMinimumWage: num(nmw), maxContributionBase: num(mcb) },
    payItems: (items.data || []).map((i: any) => ({ id: i.id, code: i.code, name: i.name, kind: i.kind, taxable: i.taxable, qualifyingEarnings: i.qualifying_earnings,
      ordinaryHours: i.ordinary_hours, multiplier: Number(i.rate_multiplier), payee: i.payee, isSystem: i.is_system, active: i.active })),
    leaveTypes: (types.data || []).map((t: any) => ({ id: t.id, code: t.code, name: t.name, paid: t.paid, accrualPerHour: Number(t.accrual_per_hour), notes: t.notes, active: t.active })),
    wagesAccounts: (accounts.data || []).filter((a: any) => ["expense", "cost_of_sales"].includes(a.type)).map((a: any) => ({ id: a.id, code: a.code, name: a.name })),
    bankAccounts: (accounts.data || []).filter((a: any) => a.subtype === "bank").map((a: any) => ({ id: a.id, code: a.code, name: a.name })),
    can: { sensitive: has(actor, "payroll.sensitive"), run: has(actor, "payroll.run"), approve: has(actor, "payroll.approve"), leave: has(actor, "leave.approve"),
      pay: has(actor, "payroll.run") || has(actor, "bank.manage") }
  };
}

/* ---------------- Employees ---------------- */

function problems(pe: any) {
  if (!pe) return ["Pay details not set up"];
  return [
    !(Number(pe.hourly_rate) > 0 || Number(pe.annual_salary) > 0) ? "No pay rate" : "",
    pe.tfn_status === "not_provided" ? "No TFN: 47% withheld" : pe.tfn_status === "applied" ? "TFN applied for" : "",
    !pe.bank_bsb ? "No bank account" : "",
    !pe.super_fund_usi && !pe.super_fund_abn ? "No super fund" : "",
    pe.residency === "working_holiday" ? "Working holiday maker: withholding not automated" : ""
  ].filter(Boolean);
}

async function employeesList(admin: Client, actor: Actor, body: any) {
  const sensitive = has(actor, "payroll.sensitive");
  const [emps, pes] = await Promise.all([
    admin.from("employees").select("id,employee_number,full_name,email,employment_type,status,start_date,end_date,profile_id,positions(title)")
      .eq("organization_id", actor.organization_id).neq("employment_type", "contractor").order("full_name"),
    admin.from("payroll_employees").select("*").eq("organization_id", actor.organization_id)
  ]);
  if (emps.error) throw httpError(500, "Employees could not be loaded.");
  const pm = new Map((pes.data || []).map((p: any) => [p.employee_id, p]));
  const show = String(body.show || "payroll");
  return {
    employees: emps.data.filter((e: any) => show === "all" || pm.has(e.id) || e.status === "active").map((e: any) => {
      const pe: any = pm.get(e.id);
      return { id: e.id, number: e.employee_number, name: e.full_name, email: e.email, hrStatus: e.status, position: e.positions?.title || null,
        inPayroll: Boolean(pe), status: pe?.status || null, basis: pe?.employment_basis || null, payBasis: pe?.pay_basis || null, frequency: pe?.pay_frequency || null,
        ...(sensitive ? { hourlyRate: pe ? Number(pe.hourly_rate) : null, annualSalary: pe ? Number(pe.annual_salary) : null } : {}),
        problems: e.status === "active" ? problems(pe) : [] };
    })
  };
}

async function employeeGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Employee");
  const { data: e } = await admin.from("employees").select("id,employee_number,full_name,email,employment_type,status,start_date,end_date,profile_id,positions(title)")
    .eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!e) throw httpError(404, "Employee not found.");
  const [pe, types, txns, runs, pending, reqs] = await Promise.all([
    admin.from("payroll_employees").select("*").eq("employee_id", id).maybeSingle(),
    admin.from("leave_types").select("id,code,name,paid,accrual_per_hour").eq("organization_id", actor.organization_id).eq("active", true).order("code"),
    admin.from("leave_transactions").select("id,leave_type_id,txn_date,hours,kind,note,pay_run_id").eq("employee_id", id).order("txn_date", { ascending: false }).limit(200),
    admin.from("pay_run_employees").select("gross,payg,net,super_guarantee,salary_sacrifice,pay_runs!inner(id,number,payment_date,status)").eq("employee_id", id).limit(200),
    admin.from("approvals").select("id,requested_at").eq("kind", "employee_bank").eq("entity_id", id).eq("status", "pending").maybeSingle(),
    admin.from("leave_requests").select("id,leave_type_id,start_date,end_date,hours,status,reason").eq("employee_id", id).order("start_date", { ascending: false }).limit(30)
  ]);
  const p: any = pe.data;
  const balances = new Map<string, number>();
  for (const t of txns.data || []) balances.set(t.leave_type_id, (balances.get(t.leave_type_id) || 0) + Number(t.hours));
  const sensitive = has(actor, "payroll.sensitive");
  return {
    employee: { id: e.id, number: e.employee_number, name: e.full_name, email: e.email, type: e.employment_type, hrStatus: e.status, position: e.positions?.title || null,
      hrStart: e.start_date, linked: Boolean(e.profile_id) },
    pay: p && sensitive ? {
      status: p.status, basis: p.employment_basis, payBasis: p.pay_basis, frequency: p.pay_frequency, hourlyRate: Number(p.hourly_rate), annualSalary: Number(p.annual_salary),
      ordinaryHours: Number(p.ordinary_hours_per_week), casualLoading: Number(p.casual_loading_percent), leaveLoading: Number(p.leave_loading_percent),
      annualLeaveWeeks: Number(p.annual_leave_weeks), award: p.award, classification: p.classification, wagesAccountId: p.wages_account_id,
      dateOfBirth: p.date_of_birth, startDate: p.start_date, endDate: p.end_date,
      tfn: maskTfn(p.tfn), tfnStatus: p.tfn_status, residency: p.residency, taxFreeThreshold: p.tax_free_threshold, studyLoan: p.study_loan,
      medicareExemption: p.medicare_exemption, extraWithholding: Number(p.extra_withholding),
      fundName: p.super_fund_name, fundUsi: p.super_fund_usi, fundAbn: p.super_fund_abn, memberNumber: p.super_member_number, salarySacrifice: Number(p.salary_sacrifice),
      bank: p.bank_bsb ? { accountName: p.bank_account_name, bsb: fmtBsb(p.bank_bsb), accountNumber: maskAcct(p.bank_account_number), changedAt: p.bank_changed_at } : null,
      bankChangePending: Boolean(pending.data), notes: p.notes } : null,
    inPayroll: Boolean(p),
    problems: problems(p),
    leave: (types.data || []).map((t: any) => ({ id: t.id, code: t.code, name: t.name, paid: t.paid, balance: Math.round((balances.get(t.id) || 0) * 100) / 100 })),
    leaveHistory: (txns.data || []).slice(0, 50).map((t: any) => ({ id: t.id, typeId: t.leave_type_id, date: t.txn_date, hours: Number(t.hours), kind: t.kind, note: t.note })),
    leaveRequests: (reqs.data || []).map((r: any) => ({ id: r.id, typeId: r.leave_type_id, start: r.start_date, end: r.end_date, hours: Number(r.hours), status: r.status, reason: r.reason })),
    payHistory: (sensitive || has(actor, "payroll.run") || has(actor, "payroll.approve") ? runs.data || [] : []).filter((r: any) => ["approved", "paid"].includes(r.pay_runs.status)).map((r: any) => ({ runId: r.pay_runs.id, number: r.pay_runs.number,
      paymentDate: r.pay_runs.payment_date, gross: Number(r.gross), payg: Number(r.payg), net: Number(r.net), super: dollars(cents(r.super_guarantee) + cents(r.salary_sacrifice)) }))
      .sort((a: any, b: any) => b.paymentDate.localeCompare(a.paymentDate)),
    can: { edit: sensitive, leave: has(actor, "leave.approve"), adjust: sensitive }
  };
}

async function employeeSave(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Employee");
  const n = (v: unknown, label: string, max = 1e7) => {
    if (v === "" || v == null) return "";
    const x = Number(String(v).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(x) || x < 0 || x > max) throw httpError(400, `${label} must be a positive number.`);
    return String(x);
  };
  const p: Record<string, unknown> = {
    status: body.status === "terminated" ? "terminated" : "active",
    employment_basis: ["full_time", "part_time", "casual"].includes(body.basis) ? body.basis : "",
    pay_basis: ["hourly", "salary"].includes(body.payBasis) ? body.payBasis : "",
    pay_frequency: FREQ.includes(body.frequency) ? body.frequency : "",
    hourly_rate: n(body.hourlyRate, "The hourly rate", 10000), annual_salary: n(body.annualSalary, "The annual salary"),
    ordinary_hours_per_week: n(body.ordinaryHours, "Ordinary hours", 60), casual_loading_percent: n(body.casualLoading, "Casual loading", 100),
    leave_loading_percent: n(body.leaveLoading, "Leave loading", 100), annual_leave_weeks: body.annualLeaveWeeks === "5" || body.annualLeaveWeeks === 5 ? "5" : "4",
    award: text(body.award, 200), classification: text(body.classification, 120), wages_account_id: optUuid(body.wagesAccountId) || "",
    date_of_birth: optDate(body.dateOfBirth) || "", start_date: optDate(body.startDate) || "", end_date: optDate(body.endDate) || "",
    tfn_status: ["provided", "applied", "exempt", "not_provided"].includes(body.tfnStatus) ? body.tfnStatus : "",
    residency: ["resident", "foreign", "working_holiday"].includes(body.residency) ? body.residency : "",
    tax_free_threshold: body.taxFreeThreshold === true, study_loan: body.studyLoan === true,
    medicare_exemption: ["none", "half", "full"].includes(body.medicareExemption) ? body.medicareExemption : "",
    extra_withholding: n(body.extraWithholding, "Extra withholding", 100000),
    super_fund_name: text(body.fundName, 120), super_fund_usi: text(body.fundUsi, 20), super_fund_abn: text(body.fundAbn, 20), super_member_number: text(body.memberNumber, 30),
    salary_sacrifice: n(body.salarySacrifice, "Salary sacrifice", 100000), notes: text(body.notes, 2000)
  };
  // A TFN is only sent when it's being entered or replaced.
  if (body.tfn) p.tfn = String(body.tfn).replace(/\s/g, "").slice(0, 11);
  else if (body.tfnFromOnboarding === true) {
    const t = onboardingTfn(await onboardingAnswers(admin, actor, id));
    if (!t) throw httpError(409, "No TFN was found in their accepted onboarding forms.");
    p.tfn = t;
  }
  await rpc(admin, "payroll_employee_save", { p_actor: actor.id, p_employee: id, p });
  return { saved: true };
}

/** The latest accepted onboarding answers with pay details, by form. */
async function onboardingAnswers(admin: Client, actor: Actor, id: string) {
  const { data: e } = await admin.from("employees").select("id").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!e) throw httpError(404, "Employee not found.");
  const { data } = await admin.from("onboarding_items").select("doc_type,answers,reviewed_at,onboarding_requests!inner(employee_id)")
    .eq("onboarding_requests.employee_id", id).eq("status", "accepted").in("doc_type", ["tfn_declaration", "super_choice", "personal_details", "bank_details"])
    .order("reviewed_at", { ascending: false });
  const latest = new Map<string, any>();
  for (const i of data || []) if (!latest.has(i.doc_type) && i.answers) latest.set(i.doc_type, i.answers);
  return latest;
}
const onboardingTfn = (latest: Map<string, any>) => {
  const t = String(latest.get("tfn_declaration")?.tfn || "").replace(/\s/g, "");
  return /^\d{8,9}$/.test(t) ? t : null;
};
const onboardingBank = (latest: Map<string, any>) => {
  const b = latest.get("bank_details");
  if (!b) return null;
  return { accountName: String(b.account_name || ""), bsb: String(b.bsb || "").replace(/\D/g, ""), accountNumber: String(b.account_number || "").replace(/\D/g, "") };
};

/** What the person gave in onboarding (accepted items), to fill in the pay form. The TFN and account
 * number stay on the server: the browser gets them masked, and saving copies them across. */
async function importOnboarding(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Employee");
  const latest = await onboardingAnswers(admin, actor, id);
  const tfn = latest.get("tfn_declaration") || {}, sup = latest.get("super_choice") || {}, per = latest.get("personal_details") || {};
  const bank = onboardingBank(latest), fullTfn = onboardingTfn(latest);
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "payroll_onboarding_read", p_entity_type: "payroll_employee", p_entity_id: id, p_old: null, p_new: null,
    p_details: { found: [...latest.keys()] }, p_subject: null });
  const opt = String(tfn.tfn_option || "");
  return {
    found: [...latest.keys()],
    suggested: {
      ...(latest.has("tfn_declaration") ? {
        tfnFromOnboarding: Boolean(fullTfn), tfnMasked: fullTfn ? maskTfn(fullTfn) : null,
        tfnStatus: fullTfn ? "provided" : /applied/i.test(opt) ? "applied" : /exemption/i.test(opt) ? "exempt" : "not_provided",
        residency: /foreign/i.test(tfn.residency || "") ? "foreign" : /working holiday/i.test(tfn.residency || "") ? "working_holiday" : "resident",
        taxFreeThreshold: tfn.tax_free_threshold === "Yes", studyLoan: tfn.study_loan === "Yes",
        basis: /part/i.test(tfn.pay_basis || "") ? "part_time" : /casual/i.test(tfn.pay_basis || "") ? "casual" : /full/i.test(tfn.pay_basis || "") ? "full_time" : null
      } : {}),
      ...(latest.has("super_choice") ? { fundName: sup.fund_name || null, fundUsi: sup.usi || null, memberNumber: sup.member_number || null, defaultFund: !sup.fund_name } : {}),
      ...(latest.has("personal_details") ? { dateOfBirth: per.date_of_birth || null } : {}),
      ...(bank ? { bank: { accountName: bank.accountName, bsb: bank.bsb, accountNumber: maskAcct(bank.accountNumber), fromOnboarding: true } } : {})
    }
  };
}

async function bankRequest(admin: Client, actor: Actor, body: any) {
  const employee = uuid(body.id, "Employee");
  let account = text(body.accountNumber, 14);
  if (!account && body.fromOnboarding === true) {
    account = onboardingBank(await onboardingAnswers(admin, actor, employee))?.accountNumber || "";
    if (!account) throw httpError(409, "No bank account was found in their accepted onboarding forms.");
  }
  const id = await rpc<string>(admin, "payroll_bank_request", { p_actor: actor.id, p_employee: employee, p_name: text(body.accountName, 120),
    p_bsb: text(body.bsb, 10), p_account: account });
  return { approvalId: id, status: "pending" };
}

/* ---------------- Leave ---------------- */

async function leaveList(admin: Client, actor: Actor, body: any) {
  const status = ["submitted", "approved", "rejected", "cancelled", "paid"].includes(body.status) ? body.status : "submitted";
  const { data, error } = await admin.from("leave_requests").select("id,employee_id,leave_type_id,start_date,end_date,hours,reason,status,requested_at,requested_by,decided_by,decided_at,decision_comment,payroll_employees(employees(full_name,profile_id)),leave_types(name,code)")
    .eq("organization_id", actor.organization_id).eq("status", status).order("start_date", { ascending: status === "submitted" }).limit(300);
  if (error) throw httpError(500, "Leave requests could not be loaded.");
  const who = await names(admin, data.flatMap((r: any) => [r.decided_by]));
  const bal = new Map<string, number>();
  if (status === "submitted" && data.length) {
    const { data: t } = await admin.from("leave_transactions").select("employee_id,leave_type_id,hours").in("employee_id", [...new Set(data.map((r: any) => r.employee_id))]);
    for (const x of t || []) { const k = `${x.employee_id}:${x.leave_type_id}`; bal.set(k, (bal.get(k) || 0) + Number(x.hours)); }
  }
  return {
    status,
    requests: data.map((r: any) => ({ id: r.id, employeeId: r.employee_id, employee: r.payroll_employees?.employees?.full_name, type: r.leave_types?.name, typeCode: r.leave_types?.code,
      start: r.start_date, end: r.end_date, hours: Number(r.hours), reason: r.reason, status: r.status, requestedAt: r.requested_at,
      decidedBy: who.get(r.decided_by) || null, decidedAt: r.decided_at, comment: r.decision_comment, mine: r.payroll_employees?.employees?.profile_id === actor.id,
      balance: status === "submitted" ? Math.round((bal.get(`${r.employee_id}:${r.leave_type_id}`) || 0) * 100) / 100 : null }))
  };
}

async function leaveRequest(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "leave_request_save", { p_actor: actor.id, p_employee: optUuid(body.employeeId), p_type: uuid(body.typeId, "Leave type"),
    p_start: date(body.start, "The first day"), p_end: date(body.end, "The last day"), p_hours: Number(body.hours), p_reason: text(body.reason, 500) });
  return { id };
}

async function leaveDecide(admin: Client, actor: Actor, body: any) {
  if (!["approved", "rejected", "cancelled"].includes(body.decision)) throw httpError(400, "Choose a decision.");
  await rpc(admin, "leave_request_decide", { p_actor: actor.id, p_id: uuid(body.id, "Leave request"), p_decision: body.decision, p_comment: text(body.comment, 300) });
  return { saved: true };
}

async function leaveAdjust(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "leave_adjust", { p_actor: actor.id, p_employee: uuid(body.employeeId, "Employee"), p_type: uuid(body.typeId, "Leave type"), p_date: optDate(body.date),
    p_hours: Number(body.hours), p_kind: body.kind === "opening" ? "opening" : "adjustment", p_note: text(body.note, 300) });
  return { saved: true };
}

/* ---------------- Pay runs ---------------- */

async function runsList(admin: Client, actor: Actor) {
  const { data, error } = await admin.from("pay_runs").select("id,number,pay_frequency,period_start,period_end,payment_date,status,gross,payg,super,net,paid_at,super_paid_at,prepared_by,approved_by,pay_run_employees(id)")
    .eq("organization_id", actor.organization_id).order("payment_date", { ascending: false }).limit(200);
  if (error) throw httpError(500, "Pay runs could not be loaded.");
  const today = todaySydney();
  const due = await Promise.all(data.map((r: any) => rpc<string>(admin, "add_business_days", { p_date: r.payment_date, p_days: 7 })));
  const who = await names(admin, data.flatMap((r: any) => [r.prepared_by, r.approved_by]));
  return {
    runs: data.map((r: any, i: number) => ({ id: r.id, number: r.number, frequency: r.pay_frequency, periodStart: r.period_start, periodEnd: r.period_end, paymentDate: r.payment_date,
      status: r.status, employees: (r.pay_run_employees || []).length, gross: Number(r.gross), payg: Number(r.payg), super: Number(r.super), net: Number(r.net),
      paidAt: r.paid_at, superPaidAt: r.super_paid_at, superDue: due[i], superOverdue: ["approved", "paid"].includes(r.status) && !r.super_paid_at && Number(r.super) > 0 && due[i] < today,
      preparedBy: who.get(r.prepared_by) || null, approvedBy: who.get(r.approved_by) || null }))
  };
}

async function runGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Pay run");
  const { data: r } = await admin.from("pay_runs").select("*").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!r) throw httpError(404, "Pay run not found.");
  const [emps, items, journals, who, due] = await Promise.all([
    admin.from("pay_run_employees").select("*,payroll_employees(employees(full_name,employee_number,profile_id)),pay_run_lines(id,pay_item_id,description,hours,rate,amount,manual,project_id,leave_request_id,sort)")
      .eq("pay_run_id", id),
    admin.from("pay_items").select("id,code,name,kind").eq("organization_id", actor.organization_id),
    admin.from("journal_entries").select("id,number").in("id", [r.journal_id, r.payment_journal_id, r.super_journal_id].filter(Boolean).length ? [r.journal_id, r.payment_journal_id, r.super_journal_id].filter(Boolean) : ["00000000-0000-0000-0000-000000000000"]),
    names(admin, [r.prepared_by, r.approved_by]),
    rpc<string>(admin, "add_business_days", { p_date: r.payment_date, p_days: 7 })
  ]);
  if (emps.error) throw httpError(500, "The pay run could not be loaded.");
  for (const x of emps.data || []) x.employees = x.payroll_employees?.employees;
  const im = new Map((items.data || []).map((i: any) => [i.id, i]));
  const jn = new Map((journals.data || []).map((j: any) => [j.id, j.number]));
  const mine = (emps.data || []).some((x: any) => x.employees?.profile_id === actor.id);
  return {
    run: { id: r.id, number: r.number, frequency: r.pay_frequency, periodStart: r.period_start, periodEnd: r.period_end, paymentDate: r.payment_date, status: r.status,
      gross: Number(r.gross), payg: Number(r.payg), super: Number(r.super), net: Number(r.net), calculatedAt: r.calculated_at, preparedBy: who.get(r.prepared_by) || null,
      submittedAt: r.submitted_at, approvedBy: who.get(r.approved_by) || null, approvedAt: r.approved_at, paidAt: r.paid_at, superPaidAt: r.super_paid_at, superDue: due,
      journal: r.journal_id ? { id: r.journal_id, number: jn.get(r.journal_id) } : null,
      paymentJournal: r.payment_journal_id ? { id: r.payment_journal_id, number: jn.get(r.payment_journal_id) } : null,
      superJournal: r.super_journal_id ? { id: r.super_journal_id, number: jn.get(r.super_journal_id) } : null },
    employees: (emps.data || []).sort((a: any, b: any) => String(a.employees?.full_name).localeCompare(String(b.employees?.full_name))).map((x: any) => ({
      id: x.employee_id, name: x.employees?.full_name, number: x.employees?.employee_number, gross: Number(x.gross), taxable: Number(x.taxable), payg: Number(x.payg),
      stsl: Number(x.stsl), salarySacrifice: Number(x.salary_sacrifice), deductions: Number(x.deductions), reimbursements: Number(x.reimbursements),
      qualifyingEarnings: Number(x.qualifying_earnings), superGuarantee: Number(x.super_guarantee), net: Number(x.net), scale: x.tax_scale,
      ordinaryHours: Number(x.ordinary_hours), warnings: x.warnings || [],
      lines: (x.pay_run_lines || []).sort((a: any, b: any) => a.sort - b.sort).map((l: any) => ({ id: l.id, code: (im.get(l.pay_item_id) as any)?.code, kind: (im.get(l.pay_item_id) as any)?.kind,
        name: (im.get(l.pay_item_id) as any)?.name, description: l.description, hours: num(l.hours), rate: num(l.rate), amount: Number(l.amount), manual: l.manual })) })),
    can: {
      edit: r.status === "draft" && has(actor, "payroll.run"),
      submit: r.status === "draft" && has(actor, "payroll.run"),
      approve: r.status === "submitted" && has(actor, "payroll.approve") && r.prepared_by !== actor.id && !mine,
      sendBack: r.status === "submitted" && (has(actor, "payroll.approve") || r.prepared_by === actor.id),
      pay: r.status === "approved" && (has(actor, "payroll.run") || has(actor, "bank.manage")),
      paySuper: ["approved", "paid"].includes(r.status) && !r.super_paid_at && Number(r.super) > 0 && (has(actor, "payroll.run") || has(actor, "bank.manage")),
      delete: r.status === "draft" && has(actor, "payroll.run"),
      bankList: ["approved", "paid"].includes(r.status) && has(actor, "payroll.sensitive")
    }
  };
}

async function runCreate(admin: Client, actor: Actor, body: any) {
  if (!FREQ.includes(body.frequency)) throw httpError(400, "Choose how often this pay run pays.");
  const id = await rpc<string>(admin, "pay_run_create", { p_actor: actor.id, p_frequency: body.frequency, p_start: date(body.periodStart, "The period start"),
    p_end: date(body.periodEnd, "The period end"), p_payment: date(body.paymentDate, "The payment date") });
  return { id };
}
const runAction = (fn: string, extra?: (b: any) => Record<string, unknown>) => async (admin: Client, actor: Actor, body: any) => {
  await rpc(admin, fn, { p_actor: actor.id, p_run: uuid(body.id, "Pay run"), ...(extra ? extra(body) : {}) });
  return { saved: true };
};

async function lineAdd(admin: Client, actor: Actor, body: any) {
  const hours = body.hours === "" || body.hours == null ? null : Number(body.hours);
  const rate = body.rate === "" || body.rate == null ? null : Number(String(body.rate).replace(/[$,]/g, ""));
  const amount = body.amount === "" || body.amount == null ? null : Number(String(body.amount).replace(/[$,]/g, ""));
  if ([hours, rate, amount].some(v => v != null && !Number.isFinite(v))) throw httpError(400, "Hours, rate and amount must be numbers.");
  const id = await rpc<string>(admin, "pay_run_line_add", { p_actor: actor.id, p_run: uuid(body.id, "Pay run"), p_employee: uuid(body.employeeId, "Employee"),
    p_item: uuid(body.itemId, "Pay item"), p_description: text(body.description, 200), p_hours: hours, p_rate: rate, p_amount: amount });
  return { id };
}
async function lineRemove(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "pay_run_line_remove", { p_actor: actor.id, p_line: uuid(body.lineId, "Line") });
  return { saved: true };
}

/** Net pay by person with their bank details, for paying through internet banking (ABA files come in Phase 6). */
async function bankList(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Pay run");
  const { data: r } = await admin.from("pay_runs").select("id,number,status,payment_date").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!r || !["approved", "paid"].includes(r.status)) throw httpError(409, "Approve the pay run first.");
  const { data } = await admin.from("pay_run_employees").select("employee_id,net,payroll_employees(employees(full_name,employee_number))").eq("pay_run_id", id);
  for (const x of data || []) (x as any).employees = (x as any).payroll_employees?.employees;
  const ids = (data || []).map((x: any) => x.employee_id);
  const { data: banks } = await admin.from("payroll_employees").select("employee_id,bank_account_name,bank_bsb,bank_account_number").in("employee_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const bm = new Map((banks || []).map((b: any) => [b.employee_id, b]));
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "pay_run_bank_list_exported", p_entity_type: "pay_run", p_entity_id: id, p_old: null, p_new: null,
    p_details: { number: r.number, people: ids.length }, p_subject: null });
  return {
    number: r.number, paymentDate: r.payment_date,
    rows: (data || []).filter((x: any) => Number(x.net) > 0).map((x: any) => {
      const b: any = bm.get(x.employee_id) || {};
      return { name: x.employees?.full_name, number: x.employees?.employee_number, accountName: b.bank_account_name || "", bsb: fmtBsb(b.bank_bsb) || "", accountNumber: b.bank_account_number || "",
        net: Number(x.net), reference: `PAY ${r.number}` };
    })
  };
}

/* ---------------- Payslips ---------------- */

async function payslipData(admin: Client, actor: Actor, runId: string, employeeId: string) {
  const [{ data: r }, { data: x }, { data: c }] = await Promise.all([
    admin.from("pay_runs").select("id,number,period_start,period_end,payment_date,status,organization_id").eq("id", runId).eq("organization_id", actor.organization_id).maybeSingle(),
    admin.from("pay_run_employees").select("*").eq("pay_run_id", runId).eq("employee_id", employeeId).maybeSingle(),
    admin.from("company_settings").select("legal_name,trading_name,abn,business_address,phone,email").eq("organization_id", actor.organization_id).maybeSingle()
  ]);
  if (!r || !x) throw httpError(404, "Payslip not found.");
  if (!["approved", "paid"].includes(r.status) || !x.snapshot) throw httpError(409, "Payslips are available once the pay run is approved.");
  const s = x.snapshot;
  return createPayslipPdf({
    employer: { legalName: c?.legal_name || "", tradingName: c?.trading_name, abn: c?.abn, address: addressLines(c?.business_address).join(", "), phone: c?.phone, email: c?.email },
    payRun: { number: r.number, periodStart: r.period_start, periodEnd: r.period_end, paymentDate: r.payment_date },
    employee: s.employee || { name: "" },
    lines: (s.lines || []).map((l: any) => ({ ...l, hours: num(l.hours), rate: num(l.rate), amount: Number(l.amount) })),
    totals: { gross: Number(x.gross), payg: Number(x.payg), stsl: Number(x.stsl), salarySacrifice: Number(x.salary_sacrifice), deductions: Number(x.deductions),
      reimbursements: Number(x.reimbursements), superGuarantee: Number(x.super_guarantee), net: Number(x.net) },
    ytd: s.ytd ? { gross: Number(s.ytd.gross), payg: Number(s.ytd.payg), super: Number(s.ytd.super), net: Number(s.ytd.net) } : null,
    leave: (s.leave || []).map((l: any) => ({ type: l.type, balance: Number(l.balance) }))
  }).then(bytes => ({ bytes, number: r.number, name: s.employee?.name || "employee", date: r.payment_date }));
}

async function payslip(admin: Client, actor: Actor, body: any) {
  const runId = uuid(body.id, "Pay run"), employeeId = uuid(body.employeeId, "Employee");
  const p = await payslipData(admin, actor, runId, employeeId);
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "payslip_generated", p_entity_type: "pay_run", p_entity_id: runId, p_old: null, p_new: null,
    p_details: { employee: employeeId }, p_subject: null });
  return { fileName: `Payslip-${p.name.replace(/[^A-Za-z0-9]+/g, "-")}-${p.date}.pdf`, base64: toBase64(p.bytes) };
}

/* ---------------- My pay ---------------- */

async function myEmployee(admin: Client, actor: Actor) {
  const { data } = await admin.from("employees").select("id,full_name,employee_number").eq("profile_id", actor.id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!data) throw httpError(404, "You aren't set up in payroll yet. Ask the payroll officer.");
  return data;
}

async function myPay(admin: Client, actor: Actor) {
  const e = await myEmployee(admin, actor);
  const [types, txns, runs, reqs, pe] = await Promise.all([
    admin.from("leave_types").select("id,code,name,paid,accrual_per_hour").eq("organization_id", actor.organization_id).eq("active", true).order("code"),
    admin.from("leave_transactions").select("leave_type_id,hours").eq("employee_id", e.id),
    admin.from("pay_run_employees").select("gross,payg,net,pay_runs!inner(id,number,payment_date,period_start,period_end,status)").eq("employee_id", e.id).in("pay_runs.status", ["approved", "paid"]).limit(200),
    admin.from("leave_requests").select("id,leave_type_id,start_date,end_date,hours,status,reason,decision_comment").eq("employee_id", e.id).order("start_date", { ascending: false }).limit(30),
    admin.from("payroll_employees").select("employment_basis,status").eq("employee_id", e.id).maybeSingle()
  ]);
  const bal = new Map<string, number>();
  for (const t of txns.data || []) bal.set(t.leave_type_id, (bal.get(t.leave_type_id) || 0) + Number(t.hours));
  return {
    employee: { id: e.id, name: e.full_name, number: e.employee_number, basis: pe.data?.employment_basis || null, inPayroll: Boolean(pe.data) },
    leave: (types.data || []).filter((t: any) => t.accrual_per_hour > 0 || bal.has(t.id)).map((t: any) => ({ id: t.id, name: t.name, balance: Math.round((bal.get(t.id) || 0) * 100) / 100 })),
    leaveTypes: (types.data || []).filter((t: any) => pe.data?.employment_basis !== "casual" || !t.paid).map((t: any) => ({ id: t.id, name: t.name })),
    payslips: (runs.data || []).map((r: any) => ({ runId: r.pay_runs.id, number: r.pay_runs.number, paymentDate: r.pay_runs.payment_date, periodStart: r.pay_runs.period_start,
      periodEnd: r.pay_runs.period_end, gross: Number(r.gross), payg: Number(r.payg), net: Number(r.net) })).sort((a: any, b: any) => b.paymentDate.localeCompare(a.paymentDate)),
    leaveRequests: (reqs.data || []).map((r: any) => ({ id: r.id, typeId: r.leave_type_id, start: r.start_date, end: r.end_date, hours: Number(r.hours), status: r.status,
      reason: r.reason, comment: r.decision_comment }))
  };
}

async function myPayslip(admin: Client, actor: Actor, body: any) {
  const e = await myEmployee(admin, actor);
  const p = await payslipData(admin, actor, uuid(body.id, "Pay run"), e.id);
  return { fileName: `Payslip-${p.date}.pdf`, base64: toBase64(p.bytes) };
}

/* ---------------- Reports ---------------- */

async function payrollSummary(admin: Client, actor: Actor, body: any) {
  const to = optDate(body.to) || todaySydney();
  const from = optDate(body.from) || `${Number(to.slice(5, 7)) >= 7 ? to.slice(0, 4) : Number(to.slice(0, 4)) - 1}-07-01`;
  const { data, error } = await admin.from("pay_run_employees").select("employee_id,gross,payg,stsl,salary_sacrifice,deductions,reimbursements,super_guarantee,net,payroll_employees(employees(full_name,employee_number)),pay_runs!inner(payment_date,status,organization_id)")
    .eq("pay_runs.organization_id", actor.organization_id).in("pay_runs.status", ["approved", "paid"]).gte("pay_runs.payment_date", from).lte("pay_runs.payment_date", to);
  if (error) throw httpError(500, "The payroll summary could not be loaded.");
  for (const x of data || []) (x as any).employees = (x as any).payroll_employees?.employees;
  const m = new Map<string, any>();
  for (const x of data || []) {
    const k = x.employee_id;
    const cur = m.get(k) || { employeeId: k, name: x.employees?.full_name, number: x.employees?.employee_number, gross: 0, payg: 0, stsl: 0, salarySacrifice: 0, deductions: 0, reimbursements: 0, superGuarantee: 0, net: 0, pays: 0 };
    for (const [f, c] of [["gross", "gross"], ["payg", "payg"], ["stsl", "stsl"], ["salarySacrifice", "salary_sacrifice"], ["deductions", "deductions"], ["reimbursements", "reimbursements"], ["superGuarantee", "super_guarantee"], ["net", "net"]]) {
      cur[f] = dollars(cents(cur[f]) + cents(x[c]));
    }
    cur.pays += 1;
    m.set(k, cur);
  }
  if (body.export === true) {
    if (!has(actor, "data.export")) throw httpError(403, "Exporting needs the data export permission.");
    await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "report_exported", p_entity_type: "report", p_entity_id: "payroll_summary", p_old: null, p_new: null,
      p_details: { from, to, format: "csv" }, p_subject: null });
  }
  return { from, to, rows: [...m.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Headline payroll figures for the dashboard. */
export async function payrollHeadlines(admin: Client, actor: Actor) {
  const out: any = {};
  if (RUN_READ.some(k => has(actor, k))) {
    const [waiting, unpaidSuper] = await Promise.all([
      admin.from("pay_runs").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).eq("status", "submitted"),
      admin.from("pay_runs").select("id,payment_date,super").eq("organization_id", actor.organization_id).in("status", ["approved", "paid"]).is("super_paid_at", null).gt("super", 0)
    ]);
    out.payRunsToApprove = has(actor, "payroll.approve") ? waiting.count ?? 0 : null;
    out.superUnpaid = dollars((unpaidSuper.data || []).reduce((s: number, r: any) => s + cents(r.super), 0));
  }
  if (has(actor, "leave.approve")) {
    const { count } = await admin.from("leave_requests").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).eq("status", "submitted");
    out.leaveToApprove = count ?? 0;
  }
  return Object.keys(out).length ? out : null;
}

export const payrollActions: Record<string, { perm: string[] | null; run: Handler }> = {
  payroll_setup: { perm: [...PEOPLE_READ, "payroll.self"], run: payrollSetup },
  payroll_employees: { perm: PEOPLE_READ, run: employeesList },
  payroll_employee_get: { perm: PEOPLE_READ, run: employeeGet },
  payroll_employee_save: { perm: ["payroll.sensitive"], run: employeeSave },
  payroll_import_onboarding: { perm: ["payroll.sensitive"], run: importOnboarding },
  payroll_bank_request: { perm: ["payroll.sensitive"], run: bankRequest },
  leave_list: { perm: ["leave.approve", "payroll.sensitive", "payroll.run"], run: leaveList },
  leave_request: { perm: ["payroll.self", "leave.approve"], run: leaveRequest },
  leave_decide: { perm: ["payroll.self", "leave.approve"], run: leaveDecide },
  leave_adjust: { perm: ["payroll.sensitive"], run: leaveAdjust },
  pay_runs_list: { perm: RUN_READ, run: (a, b) => runsList(a, b) },
  pay_run_get: { perm: RUN_READ, run: runGet },
  pay_run_create: { perm: ["payroll.run"], run: runCreate },
  pay_run_recalculate: { perm: ["payroll.run"], run: runAction("pay_run_calculate") },
  pay_run_line_add: { perm: ["payroll.run"], run: lineAdd },
  pay_run_line_remove: { perm: ["payroll.run"], run: lineRemove },
  pay_run_submit: { perm: ["payroll.run"], run: runAction("pay_run_submit") },
  pay_run_return: { perm: ["payroll.run", "payroll.approve"], run: runAction("pay_run_return", b => ({ p_reason: text(b.reason, 300) })) },
  pay_run_approve: { perm: ["payroll.approve"], run: runAction("pay_run_approve") },
  pay_run_delete: { perm: ["payroll.run"], run: runAction("pay_run_delete") },
  pay_run_record_payment: { perm: ["payroll.run", "bank.manage"], run: runAction("pay_run_record_payment", b => ({ p_bank: uuid(b.bankAccountId, "Bank account"), p_date: optDate(b.date) })) },
  pay_run_record_super: { perm: ["payroll.run", "bank.manage"], run: runAction("pay_run_record_super", b => ({ p_bank: uuid(b.bankAccountId, "Bank account"), p_date: optDate(b.date) })) },
  pay_run_bank_list: { perm: ["payroll.sensitive"], run: bankList },
  payslip_pdf: { perm: RUN_READ, run: payslip },
  my_pay: { perm: ["payroll.self"], run: (a, b) => myPay(a, b) },
  my_payslip: { perm: ["payroll.self"], run: myPayslip },
  payroll_summary: { perm: RUN_READ, run: payrollSummary }
};
