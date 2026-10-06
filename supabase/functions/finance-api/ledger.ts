// Phase 2 ledger actions: chart of accounts, tax codes, journals, periods and
// reports. Every write goes through a SQL function that re-checks the
// permission; the posting engine (ledger_post_entry / journal_post) is the
// only way lines reach the ledger.
import { httpError, rpc } from "../_shared/http.ts";

type Client = any;
type Actor = { id: string; organization_id: string; permissions: string[] };
type Handler = (admin: Client, actor: Actor, body: any) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "cost_of_sales", "expense", "other_income", "other_expense"];
const TAX_KINDS = ["gst_income", "gst_expense", "gst_capital", "gst_free_income", "gst_free_expense", "export", "input_taxed_income", "input_taxed_expense", "no_gst", "out_of_scope"];

function uuid(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID.test(text)) throw httpError(400, `${label} is not valid.`);
  return text;
}
function date(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!DATE.test(text) || Number.isNaN(Date.parse(text))) throw httpError(400, `${label} must be a date.`);
  return text;
}
export function todaySydney() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}
const has = (a: Actor, k: string) => a.permissions.includes(k);

async function names(admin: Client, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, string>();
  const { data } = await admin.from("training_profiles").select("id,full_name,email").in("id", unique);
  return new Map((data || []).map((p: any) => [p.id, p.full_name || p.email]));
}

/* ---------------- Chart and tax codes ---------------- */

async function taxCodes(admin: Client, actor: Actor) {
  const { data, error } = await admin.from("tax_codes").select("id,code,name,kind,rate,applies_to,bas_labels,description,is_system,active,sort")
    .eq("organization_id", actor.organization_id).order("sort");
  if (error) throw httpError(500, "Tax codes could not be loaded.");
  return data.map((t: any) => ({ id: t.id, code: t.code, name: t.name, kind: t.kind, rate: Number(t.rate), appliesTo: t.applies_to,
    basLabels: t.bas_labels, description: t.description, isSystem: t.is_system, active: t.active }));
}

async function ledgerSetup(admin: Client, actor: Actor) {
  const asAt = todaySydney();
  const [accounts, codes, tb, fyStart] = await Promise.all([
    admin.from("accounts").select("id,code,name,type,subtype,description,default_tax_code_id,is_system,allow_manual,status")
      .eq("organization_id", actor.organization_id).order("code"),
    taxCodes(admin, actor),
    rpc<any>(admin, "report_trial_balance", { p_actor: actor.id, p_as_at: asAt }),
    rpc<string>(admin, "ledger_fy_start", { p_org: actor.organization_id, p_date: asAt })
  ]);
  if (accounts.error) throw httpError(500, "The chart of accounts could not be loaded.");
  const bal = new Map<string, number>((tb.rows || []).map((r: any) => [r.accountId, Number(r.debit) - Number(r.credit)]));
  return {
    asAt, financialYearStart: fyStart,
    accounts: accounts.data.map((a: any) => ({
      id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, description: a.description, defaultTaxCodeId: a.default_tax_code_id,
      isSystem: a.is_system, allowManual: a.allow_manual, status: a.status, balance: bal.get(a.id) ?? 0
    })),
    taxCodes: codes,
    can: { manage: has(actor, "ledger.manage"), journal: has(actor, "ledger.journal"), post: has(actor, "ledger.post"), reopen: has(actor, "ledger.reopen"),
      reports: has(actor, "reports.view"), export: has(actor, "data.export") }
  };
}

async function accountSave(admin: Client, actor: Actor, body: any) {
  const code = String(body.code || "").trim().toUpperCase();
  if (!/^[0-9A-Z][0-9A-Z.-]{0,11}$/.test(code)) throw httpError(400, "Account codes are 1 to 12 letters, digits, dots or dashes.");
  const name = String(body.name || "").trim();
  if (name.length < 2) throw httpError(400, "Give the account a name.");
  if (!ACCOUNT_TYPES.includes(body.type)) throw httpError(400, "Choose an account type.");
  const id = await rpc<string>(admin, "account_save", {
    p_actor: actor.id, p_id: body.id ? uuid(body.id, "Account") : null, p_code: code, p_name: name.slice(0, 120), p_type: body.type,
    p_subtype: String(body.subtype || "general"), p_description: String(body.description || "").slice(0, 500),
    p_default_tax: body.defaultTaxCodeId ? uuid(body.defaultTaxCodeId, "Tax code") : null, p_allow_manual: body.allowManual !== false
  });
  return { id };
}

async function accountStatus(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "account_set_status", { p_actor: actor.id, p_id: uuid(body.id, "Account"), p_active: body.active === true });
  return { saved: true };
}

async function taxCodeSave(admin: Client, actor: Actor, body: any) {
  const code = String(body.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,12}$/.test(code)) throw httpError(400, "Tax codes are 1 to 12 capital letters, digits or dashes.");
  if (!TAX_KINDS.includes(body.kind)) throw httpError(400, "Choose what kind of tax code this is.");
  const rate = Number(body.ratePercent ?? 0) / 100;
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) throw httpError(400, "The rate must be between 0 and 99%.");
  const id = await rpc<string>(admin, "tax_code_save", {
    p_actor: actor.id, p_id: body.id ? uuid(body.id, "Tax code") : null, p_code: code, p_name: String(body.name || "").trim().slice(0, 80),
    p_kind: body.kind, p_rate: Math.round(rate * 10000) / 10000, p_applies_to: ["sales", "purchases", "both"].includes(body.appliesTo) ? body.appliesTo : "both",
    p_description: String(body.description || "").slice(0, 300), p_active: body.active !== false
  });
  return { id };
}

/* ---------------- Journals ---------------- */

function cleanLines(lines: unknown) {
  if (!Array.isArray(lines)) throw httpError(400, "Add the journal lines.");
  if (lines.length > 200) throw httpError(400, "A journal can have at most 200 lines.");
  return lines.map((l: any) => ({
    accountId: l?.accountId && UUID.test(String(l.accountId)) ? String(l.accountId) : null,
    description: String(l?.description || "").slice(0, 300),
    debit: l?.debit === "" || l?.debit == null ? 0 : String(l.debit).replace(/,/g, ""),
    credit: l?.credit === "" || l?.credit == null ? 0 : String(l.credit).replace(/,/g, ""),
    taxCodeId: l?.taxCodeId && UUID.test(String(l.taxCodeId)) ? String(l.taxCodeId) : null
  }));
}

async function journalsList(admin: Client, actor: Actor, body: any) {
  const page = Math.max(1, Math.min(1000, Number(body.page) || 1));
  const size = 50;
  let q = admin.from("journal_entries")
    .select("id,number,entry_date,memo,status,source_type,source_ref,created_by,posted_at,reverses_id,reversed_by_id,journal_lines(debit)", { count: "exact" })
    .eq("organization_id", actor.organization_id)
    .order("entry_date", { ascending: false }).order("created_at", { ascending: false })
    .range((page - 1) * size, page * size - 1);
  if (["draft", "posted", "reversed"].includes(body.status)) q = q.eq("status", body.status);
  if (body.from && DATE.test(body.from)) q = q.gte("entry_date", body.from);
  if (body.to && DATE.test(body.to)) q = q.lte("entry_date", body.to);
  if (body.search) q = q.ilike("memo", `%${String(body.search).replace(/[%*]/g, "").slice(0, 60)}%`);
  const { data, error, count } = await q;
  if (error) throw httpError(500, "Journals could not be loaded.");
  const who = await names(admin, data.map((j: any) => j.created_by));
  return {
    page, pageSize: size, total: count ?? null,
    journals: data.map((j: any) => ({
      id: j.id, number: j.number, date: j.entry_date, memo: j.memo, status: j.status, source: j.source_type, sourceRef: j.source_ref,
      createdBy: who.get(j.created_by) || null, postedAt: j.posted_at, isReversal: Boolean(j.reverses_id), reversed: Boolean(j.reversed_by_id),
      total: Math.round((j.journal_lines || []).reduce((s: number, l: any) => s + Number(l.debit) * 100, 0)) / 100
    }))
  };
}

async function journalGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Journal");
  const { data, error } = await admin.from("journal_entries")
    .select("id,number,entry_date,memo,amounts_are,status,source_type,source_id,source_ref,reverses_id,reversed_by_id,reversal_reason,created_by,created_at,posted_by,posted_at,period_id,journal_lines(line_no,account_id,description,debit,credit,tax_code_id,tax_amount,entered_amount,is_tax_line,source_line_no)")
    .eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (error) throw httpError(500, "The journal could not be loaded.");
  if (!data) throw httpError(404, "Journal not found.");
  const [accounts, codes, links, who] = await Promise.all([
    admin.from("accounts").select("id,code,name").eq("organization_id", actor.organization_id),
    admin.from("tax_codes").select("id,code").eq("organization_id", actor.organization_id),
    admin.from("journal_entries").select("id,number").in("id", [data.reverses_id, data.reversed_by_id].filter(Boolean).length ? [data.reverses_id, data.reversed_by_id].filter(Boolean) : ["00000000-0000-0000-0000-000000000000"]),
    names(admin, [data.created_by, data.posted_by])
  ]);
  const acc = new Map((accounts.data || []).map((a: any) => [a.id, a]));
  const tax = new Map((codes.data || []).map((t: any) => [t.id, t.code]));
  const num = new Map((links.data || []).map((j: any) => [j.id, j.number]));
  const lines = (data.journal_lines || []).sort((a: any, b: any) => a.line_no - b.line_no).map((l: any) => ({
    lineNo: l.line_no, accountId: l.account_id, accountCode: (acc.get(l.account_id) as any)?.code, accountName: (acc.get(l.account_id) as any)?.name,
    description: l.description, debit: Number(l.debit), credit: Number(l.credit), taxCodeId: l.tax_code_id, taxCode: tax.get(l.tax_code_id) || null,
    taxAmount: Number(l.tax_amount), enteredAmount: l.entered_amount == null ? null : Number(l.entered_amount), isTaxLine: l.is_tax_line
  }));
  return {
    journal: {
      id: data.id, number: data.number, date: data.entry_date, memo: data.memo, amountsAre: data.amounts_are, status: data.status,
      source: data.source_type, sourceRef: data.source_ref, reverses: data.reverses_id ? { id: data.reverses_id, number: num.get(data.reverses_id) } : null,
      reversedBy: data.reversed_by_id ? { id: data.reversed_by_id, number: num.get(data.reversed_by_id) } : null, reversalReason: data.reversal_reason,
      createdBy: who.get(data.created_by) || null, createdAt: data.created_at, postedBy: who.get(data.posted_by) || null, postedAt: data.posted_at,
      totalDebit: Math.round(lines.reduce((s: number, l: any) => s + l.debit * 100, 0)) / 100,
      totalCredit: Math.round(lines.reduce((s: number, l: any) => s + l.credit * 100, 0)) / 100
    },
    lines,
    can: {
      edit: data.status === "draft" && has(actor, "ledger.journal"),
      post: data.status === "draft" && has(actor, "ledger.post"),
      delete: data.status === "draft" && (has(actor, "ledger.post") || (data.created_by === actor.id && has(actor, "ledger.journal"))),
      reverse: data.status === "posted" && !data.reverses_id && has(actor, "ledger.post")
    }
  };
}

async function journalSave(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "journal_save_draft", {
    p_actor: actor.id, p_id: body.id ? uuid(body.id, "Journal") : null, p_date: date(body.date, "The journal date"),
    p_memo: String(body.memo || "").slice(0, 500), p_amounts_are: ["exclusive", "inclusive", "no_tax"].includes(body.amountsAre) ? body.amountsAre : "exclusive",
    p_lines: cleanLines(body.lines)
  });
  if (body.post === true) {
    try {
      const number = await rpc<string>(admin, "journal_post", { p_actor: actor.id, p_id: id });
      return { id, number, status: "posted" };
    } catch (error: any) {
      // The draft is kept so nothing typed is lost; say why it didn't post.
      if (Number(error?.status) >= 500) throw error;
      return { id, status: "draft", postError: error?.message || "The journal could not be posted." };
    }
  }
  return { id, status: "draft" };
}

async function journalPost(admin: Client, actor: Actor, body: any) {
  const number = await rpc<string>(admin, "journal_post", { p_actor: actor.id, p_id: uuid(body.id, "Journal") });
  return { number };
}
async function journalDelete(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "journal_delete_draft", { p_actor: actor.id, p_id: uuid(body.id, "Journal") });
  return { deleted: true };
}
async function journalReverse(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "journal_reverse", {
    p_actor: actor.id, p_id: uuid(body.id, "Journal"), p_date: body.date ? date(body.date, "The reversal date") : null, p_reason: String(body.reason || "").slice(0, 300)
  });
  return { id };
}

/* ---------------- Periods ---------------- */

async function periodsList(admin: Client, actor: Actor) {
  const [years, periods] = await Promise.all([
    admin.from("financial_years").select("id,name,start_date,end_date").eq("organization_id", actor.organization_id).order("start_date", { ascending: false }),
    admin.from("accounting_periods").select("id,financial_year_id,period_no,start_date,end_date,status,status_changed_by,status_changed_at").eq("organization_id", actor.organization_id)
  ]);
  if (years.error || periods.error) throw httpError(500, "Periods could not be loaded.");
  const who = await names(admin, periods.data.map((p: any) => p.status_changed_by));
  return {
    today: todaySydney(),
    years: years.data.map((y: any) => ({
      id: y.id, name: y.name, start: y.start_date, end: y.end_date,
      periods: periods.data.filter((p: any) => p.financial_year_id === y.id).sort((a: any, b: any) => a.period_no - b.period_no).map((p: any) => ({
        id: p.id, no: p.period_no, start: p.start_date, end: p.end_date, status: p.status, changedBy: who.get(p.status_changed_by) || null, changedAt: p.status_changed_at
      }))
    })),
    can: { post: has(actor, "ledger.post"), reopen: has(actor, "ledger.reopen"), manage: has(actor, "ledger.manage") }
  };
}

async function periodSetStatus(admin: Client, actor: Actor, body: any) {
  if (!["open", "soft_locked", "closed"].includes(body.status)) throw httpError(400, "Choose a period status.");
  await rpc(admin, "period_set_status", { p_actor: actor.id, p_period: uuid(body.id, "Period"), p_status: body.status, p_reason: String(body.reason || "").slice(0, 300) });
  return { saved: true };
}

async function yearAdd(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "financial_year_add", { p_actor: actor.id, p_date: date(body.date, "A date in the year") });
  return { id };
}

/* ---------------- Reports ---------------- */

async function runReport(admin: Client, actor: Actor, body: any) {
  switch (body.kind) {
    case "trial_balance": return await rpc(admin, "report_trial_balance", { p_actor: actor.id, p_as_at: date(body.asAt, "The report date") });
    case "balance_sheet": return await rpc(admin, "report_balance_sheet", { p_actor: actor.id, p_as_at: date(body.asAt, "The report date") });
    case "profit_loss": return await rpc(admin, "report_profit_loss", { p_actor: actor.id, p_from: date(body.from, "The start date"), p_to: date(body.to, "The end date") });
    case "account_transactions": return await rpc(admin, "report_account_transactions", {
      p_actor: actor.id, p_account: uuid(body.accountId, "Account"), p_from: date(body.from, "The start date"), p_to: date(body.to, "The end date") });
    case "aged_receivables": return await rpc(admin, "report_aged_receivables", { p_actor: actor.id, p_as_at: date(body.asAt, "The report date") });
    case "aged_payables": return await rpc(admin, "report_aged_payables", { p_actor: actor.id, p_as_at: date(body.asAt, "The report date") });
    default: throw httpError(400, "Unknown report.");
  }
}

async function report(admin: Client, actor: Actor, body: any) {
  return await runReport(admin, actor, body);
}

// Same data as report(), with the export recorded in the audit log.
async function reportExport(admin: Client, actor: Actor, body: any) {
  const data = await runReport(admin, actor, body);
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "report_exported", p_entity_type: "report", p_entity_id: String(body.kind),
    p_old: null, p_new: null, p_details: { kind: body.kind, asAt: body.asAt ?? null, from: body.from ?? null, to: body.to ?? null, accountId: body.accountId ?? null, format: "csv" }, p_subject: null });
  return data;
}

/** Headline ledger figures for the dashboard (only for people who can see reports). */
export async function ledgerHeadlines(admin: Client, actor: Actor) {
  if (!has(actor, "reports.view")) return null;
  const today = todaySydney();
  const [bs, drafts, fyStart] = await Promise.all([
    rpc<any>(admin, "report_balance_sheet", { p_actor: actor.id, p_as_at: today }),
    admin.from("journal_entries").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).eq("status", "draft"),
    rpc<string>(admin, "ledger_fy_start", { p_org: actor.organization_id, p_date: today })
  ]);
  const rows = bs.rows || [];
  const sum = (f: (r: any) => boolean) => Math.round(rows.filter(f).reduce((s: number, r: any) => s + Number(r.amount) * 100, 0)) / 100;
  return {
    asAt: today, financialYearStart: fyStart,
    bank: sum((r: any) => r.subtype === "bank"),
    gstOwed: sum((r: any) => r.subtype === "gst"),
    netProfitYearToDate: Number(bs.currentYearEarnings),
    draftJournals: drafts.count ?? 0
  };
}

const LEDGER_READ = ["reports.view", "ledger.manage", "ledger.journal", "ledger.post", "audit.view"];

export const ledgerActions: Record<string, { perm: string[] | null; run: Handler }> = {
  ledger_setup: { perm: LEDGER_READ, run: ledgerSetup },
  account_save: { perm: ["ledger.manage"], run: accountSave },
  account_set_status: { perm: ["ledger.manage"], run: accountStatus },
  tax_code_save: { perm: ["ledger.manage"], run: taxCodeSave },
  journals_list: { perm: LEDGER_READ, run: journalsList },
  journal_get: { perm: LEDGER_READ, run: journalGet },
  journal_save: { perm: ["ledger.journal"], run: journalSave },
  journal_post: { perm: ["ledger.post"], run: journalPost },
  journal_delete: { perm: ["ledger.journal", "ledger.post"], run: journalDelete },
  journal_reverse: { perm: ["ledger.post"], run: journalReverse },
  periods_list: { perm: LEDGER_READ, run: periodsList },
  period_set_status: { perm: ["ledger.post", "ledger.reopen"], run: periodSetStatus },
  financial_year_add: { perm: ["ledger.manage"], run: yearAdd },
  report: { perm: ["reports.view"], run: report },
  report_export: { perm: ["data.export"], run: reportExport }
};
