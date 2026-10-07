// Phase 7: BAS and TPAR. A BAS is prepared (tax.bas), reviewed by someone
// else (tax.review), then marked lodged once it has been lodged with the ATO
// outside this system, and paid. Figures, reconciliation and exceptions are
// worked out in SQL (bas_figures, bas_reconciliation, bas_exceptions); writes
// go through SQL functions that re-check permissions and audit. Nothing here
// talks to the ATO.
import { httpError, rpc } from "../_shared/http.ts";
import { createBasPdf } from "../_shared/bas-pdf.ts";
import { addressLines, toBase64 } from "../_shared/finance-pdf.ts";
import { date, has, names, optDate, text, uuid, type Actor, type Client, type Handler } from "./docs.ts";
import { todaySydney } from "./ledger.ts";

const READ = ["tax.bas", "tax.review"];
const num = (v: unknown) => (v == null ? null : Number(v));
const monthEnd = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const addMonths = (iso: string, n: number) => {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
const numbers = (o: any) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, Number(v)]));

async function settings(admin: Client, actor: Actor) {
  const { data } = await admin.from("company_settings").select("legal_name,trading_name,abn,business_address,gst_registered,gst_basis,bas_frequency,financial_year_start_month")
    .eq("organization_id", actor.organization_id).maybeSingle();
  return data || {};
}

/** The period after the latest BAS, or the current one if there is none. */
function nextPeriod(s: any, last: any) {
  const freq = s.bas_frequency || "quarterly";
  const fy = Number(s.financial_year_start_month || 7);
  const months = freq === "monthly" ? 1 : freq === "quarterly" ? 3 : 12;
  let start: string;
  if (last) start = addMonths(last.period_end.slice(0, 7) + "-01", 1);
  else {
    // The period that has most recently ended.
    const today = todaySydney();
    let s0 = today.slice(0, 7) + "-01";
    const [, m] = s0.split("-").map(Number);
    const offset = ((m - fy) % months + months) % months;
    s0 = addMonths(s0, -offset);
    start = addMonths(s0, -months);
  }
  return { start, end: monthEnd(addMonths(start, months - 1)), frequency: freq };
}

async function list(admin: Client, actor: Actor) {
  const [s, rows] = await Promise.all([
    settings(admin, actor),
    admin.from("bas_returns").select("id,period_start,period_end,frequency,gst_basis,gst_method,status,due_date,payable,settled_amount,lodged_on,lodgement_reference,prepared_by,reviewed_by")
      .eq("organization_id", actor.organization_id).order("period_start", { ascending: false }).limit(60)
  ]);
  const data = rows.data || [];
  const who = await names(admin, data.flatMap((r: any) => [r.prepared_by, r.reviewed_by]));
  return {
    settings: { gstRegistered: s.gst_registered !== false, basis: s.gst_basis || "accrual", frequency: s.bas_frequency || "quarterly", fyStartMonth: Number(s.financial_year_start_month || 7) },
    next: nextPeriod(s, data[0]),
    returns: data.map((r: any) => ({ id: r.id, from: r.period_start, to: r.period_end, frequency: r.frequency, basis: r.gst_basis, method: r.gst_method, status: r.status,
      due: r.due_date, payable: num(r.payable), settled: Number(r.settled_amount), lodgedOn: r.lodged_on, reference: r.lodgement_reference,
      preparedBy: who.get(r.prepared_by) || null, reviewedBy: who.get(r.reviewed_by) || null,
      overdue: !["lodged", "settled"].includes(r.status) && r.due_date < todaySydney() })),
    can: { prepare: has(actor, "tax.bas"), review: has(actor, "tax.review") }
  };
}

async function load(admin: Client, actor: Actor, id: string) {
  const { data: b } = await admin.from("bas_returns").select("*").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!b) throw httpError(404, "BAS not found.");
  return b;
}

async function live(admin: Client, actor: Actor, b: any) {
  const f = await rpc<any>(admin, "bas_figures", { p_org: actor.organization_id, p_from: b.period_start, p_to: b.period_end, p_basis: b.gst_basis,
    p_5a: b.instalment_5a, p_7d: b.fuel_credit_7d });
  const [rec, ex] = await Promise.all([
    rpc<any>(admin, "bas_reconciliation", { p_org: actor.organization_id, p_from: b.period_start, p_to: b.period_end, p_figures: f }),
    rpc<any>(admin, "bas_exceptions", { p_org: actor.organization_id, p_from: b.period_start, p_to: b.period_end })
  ]);
  return { ...f, reconciliation: rec, exceptions: ex };
}

function figuresOut(f: any) {
  return {
    labels: numbers(f.labels), exact: numbers(f.exact),
    codes: (f.codes || []).map((c: any) => ({ id: c.id, code: c.code, name: c.name, kind: c.kind, labels: c.labels, sale: c.sale, base: Number(c.base), gst: Number(c.gst), gross: Number(c.gross) })),
    reconciliation: f.reconciliation, exceptions: (f.exceptions || []).map((e: any) => ({ ...e, amount: num(e.amount) }))
  };
}

async function get(admin: Client, actor: Actor, body: any) {
  const b = await load(admin, actor, uuid(body.id, "BAS"));
  const fixed = b.status !== "draft" && b.figures;
  const now = await live(admin, actor, b);
  const shown = fixed ? b.figures : now;
  // After the figures are fixed, what has changed in the books since (to include in the next BAS).
  let changes: any[] = [];
  if (fixed) {
    const was = numbers(b.figures.exact), is = numbers(now.exact);
    changes = Object.keys(is).filter(k => Math.abs((is[k] || 0) - (was[k] || 0)) >= 0.01).map(k => ({ label: k, fixed: was[k] || 0, now: is[k], change: Math.round(((is[k] || 0) - (was[k] || 0)) * 100) / 100 }));
  }
  const [who, pays, journal] = await Promise.all([
    names(admin, [b.prepared_by, b.reviewed_by, b.lodged_by]),
    admin.from("bas_payments").select("id,payment_date,amount,journal_id,journal_entries(number),accounts(code,name)").eq("bas_id", b.id).order("payment_date"),
    b.journal_id ? admin.from("journal_entries").select("id,number").eq("id", b.journal_id).maybeSingle() : Promise.resolve({ data: null })
  ]);
  const { data: banks } = await admin.from("accounts").select("id,code,name").eq("organization_id", actor.organization_id).eq("subtype", "bank").eq("status", "active").order("code");
  const prepare = has(actor, "tax.bas");
  return {
    bas: { id: b.id, from: b.period_start, to: b.period_end, frequency: b.frequency, basis: b.gst_basis, method: b.gst_method, status: b.status, due: b.due_date,
      instalment5A: Number(b.instalment_5a), fuelCredit7D: Number(b.fuel_credit_7d), notes: b.notes, payable: num(b.payable), settled: Number(b.settled_amount),
      preparedBy: who.get(b.prepared_by) || null, preparedAt: b.prepared_at, reviewedBy: who.get(b.reviewed_by) || null, reviewedAt: b.reviewed_at, reviewComment: b.review_comment,
      lodgedBy: who.get(b.lodged_by) || null, lodgedOn: b.lodged_on, reference: b.lodgement_reference, journal: journal.data ? { id: journal.data.id, number: journal.data.number } : null,
      lockedPeriods: (b.locked_periods || []).length, fixedAt: b.figures?.fixedAt || null },
    figures: figuresOut(shown),
    // Exceptions are always shown as they are now: they're what to fix.
    exceptionsNow: figuresOut(now).exceptions,
    changes,
    payments: (pays.data || []).map((p: any) => ({ id: p.id, date: p.payment_date, amount: Number(p.amount), journal: p.journal_entries?.number, journalId: p.journal_id,
      bank: p.accounts ? `${p.accounts.code} ${p.accounts.name}` : "" })),
    bankAccounts: (banks || []).map((a: any) => ({ id: a.id, code: a.code, name: a.name })),
    can: {
      edit: b.status === "draft" && prepare,
      review: b.status === "draft" && has(actor, "tax.review") && b.prepared_by !== actor.id,
      reopen: b.status === "reviewed" && prepare,
      lodge: b.status === "reviewed" && prepare,
      pay: b.status === "lodged" && (prepare || has(actor, "bank.manage")),
      delete: b.status === "draft" && prepare
    }
  };
}

/** The ledger lines behind one tax code in the period (accrual), or the documents paid (cash). */
async function lines(admin: Client, actor: Actor, body: any) {
  const b = await load(admin, actor, uuid(body.id, "BAS"));
  const code = uuid(body.taxCodeId, "Tax code");
  const { data, error } = await admin.from("journal_lines")
    .select("debit,credit,is_tax_line,description,accounts(code,name),journal_entries!inner(id,number,entry_date,memo,source_type,status,organization_id)")
    .eq("tax_code_id", code).eq("journal_entries.organization_id", actor.organization_id)
    .gte("journal_entries.entry_date", b.period_start).lte("journal_entries.entry_date", b.period_end).in("journal_entries.status", ["posted", "reversed"]).limit(2000);
  if (error) throw httpError(500, "The lines could not be loaded.");
  const { data: tc } = await admin.from("tax_codes").select("kind").eq("id", code).maybeSingle();
  const sale = ["gst_income", "gst_free_income", "export", "input_taxed_income"].includes(tc?.kind);
  const byJournal = new Map<string, any>();
  for (const l of data || []) {
    const je = l.journal_entries;
    if (b.gst_basis === "cash" && ["invoice", "credit_note", "bill", "supplier_credit"].includes(je.source_type)) continue;
    const v = sale ? Number(l.credit) - Number(l.debit) : Number(l.debit) - Number(l.credit);
    const row = byJournal.get(je.id) || { journalId: je.id, number: je.number, date: je.entry_date, memo: je.memo, source: je.source_type, base: 0, gst: 0, accounts: new Set<string>() };
    if (l.is_tax_line) row.gst += v; else { row.base += v; row.accounts.add(`${l.accounts?.code} ${l.accounts?.name}`); }
    byJournal.set(je.id, row);
  }
  if (b.gst_basis === "cash") {
    // Invoices and bills count by the share paid in the period.
    const docs = await rpc<any[]>(admin, "gst_cash_documents", { p_org: actor.organization_id, p_from: b.period_start, p_to: b.period_end, p_code: code });
    if (docs?.length) {
      const { data: js } = await admin.from("journal_entries").select("id,number,entry_date,memo,source_type").in("id", docs.map((x: any) => x.journal_id));
      const jm = new Map((js || []).map((j: any) => [j.id, j]));
      for (const x of docs) {
        const je: any = jm.get(x.journal_id) || {};
        byJournal.set(x.journal_id, { journalId: x.journal_id, number: je.number, date: je.entry_date, memo: `${je.memo || ""} · ${Math.round(Number(x.share) * 1000) / 10}% paid in the period`,
          source: je.source_type, base: Number(x.base), gst: Number(x.gst), accounts: new Set<string>() });
      }
    }
  }
  const rows = [...byJournal.values()].map(r => ({ ...r, base: Math.round(r.base * 100) / 100, gst: Math.round(r.gst * 100) / 100, accounts: [...r.accounts].join(", ") }))
    .filter(r => r.base || r.gst).sort((a, b2) => a.date.localeCompare(b2.date) || String(a.number).localeCompare(String(b2.number)));
  return { rows, cashNote: b.gst_basis === "cash" ? "Cash basis: invoices and bills are listed with the share paid in the period; other entries in full." : null };
}

async function create(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "bas_create", { p_actor: actor.id, p_start: date(body.from, "The start of the period"), p_end: date(body.to, "The end of the period"),
    p_frequency: text(body.frequency, 12), p_method: body.method === "full" ? "full" : "simpler" });
  return { id };
}

async function save(admin: Client, actor: Actor, body: any) {
  const whole = (v: unknown, label: string) => {
    if (v === "" || v == null) return 0;
    const n = Number(String(v).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n !== Math.trunc(n)) throw httpError(400, `${label} is in whole dollars.`);
    return n;
  };
  await rpc(admin, "bas_save", { p_actor: actor.id, p_id: uuid(body.id, "BAS"), p_5a: whole(body.instalment5A, "5A"), p_7d: whole(body.fuelCredit7D, "7D"),
    p_method: body.method === "full" ? "full" : body.method === "simpler" ? "simpler" : null, p_notes: text(body.notes, 2000) });
  return { saved: true };
}

async function pdfOut(admin: Client, actor: Actor, body: any) {
  const b = await load(admin, actor, uuid(body.id, "BAS"));
  const [s, f, who] = await Promise.all([settings(admin, actor), b.status !== "draft" && b.figures ? Promise.resolve(b.figures) : live(admin, actor, b),
    names(admin, [b.prepared_by, b.reviewed_by, b.lodged_by])]);
  const dt = (t?: string | null) => (t ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" }).format(new Date(t)) : "");
  const out = figuresOut(f);
  const bytes = await createBasPdf({
    company: { legalName: s.legal_name || "", abn: s.abn },
    period: { from: b.period_start, to: b.period_end, frequency: b.frequency, basis: b.gst_basis, method: b.gst_method, due: b.due_date },
    status: { draft: "Draft: figures can still change", reviewed: "Reviewed", lodged: "Lodged", settled: "Lodged and settled" }[b.status as string] || b.status,
    labels: out.labels, exact: out.exact, codes: out.codes, reconciliation: out.reconciliation, exceptions: out.exceptions,
    people: { prepared: `${who.get(b.prepared_by) || ""} ${dt(b.prepared_at)}`.trim(), reviewed: b.reviewed_by ? `${who.get(b.reviewed_by) || ""} ${dt(b.reviewed_at)}`.trim() : "",
      reviewComment: b.review_comment, lodged: b.lodged_on ? `${who.get(b.lodged_by) || ""}, lodged ${b.lodged_on}`.trim() : "", reference: b.lodgement_reference },
    notes: b.notes
  });
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "bas_workpaper_generated", p_entity_type: "bas_return", p_entity_id: b.id, p_old: null, p_new: null, p_details: {}, p_subject: null });
  return { fileName: `BAS-workpaper-${b.period_start}-to-${b.period_end}.pdf`, base64: toBase64(bytes) };
}

/* ---------------- TPAR ---------------- */

async function tparGet(admin: Client, actor: Actor, body: any) {
  const s = await settings(admin, actor);
  const fy = Number(s.financial_year_start_month || 7);
  const today = todaySydney();
  // Default: the last financial year that has ended.
  const [ty, tm] = today.split("-").map(Number);
  const currentStart = `${tm >= fy ? ty : ty - 1}-${String(fy).padStart(2, "0")}-01`;
  const start = optDate(body.yearStart) || addMonths(currentStart, -12);
  const end = monthEnd(addMonths(start, 11));
  const [f, lodged] = await Promise.all([
    rpc<any>(admin, "tpar_figures", { p_org: actor.organization_id, p_from: start, p_to: end }),
    admin.from("tpar_lodgements").select("lodged_on,reference,lodged_by,lodged_at,figures").eq("organization_id", actor.organization_id).eq("year_start", start).maybeSingle()
  ]);
  const who = await names(admin, [lodged.data?.lodged_by]);
  const years = [0, 1, 2, 3].map(i => addMonths(currentStart, -12 * i));
  return {
    year: { start, end, due: `${end.slice(0, 4)}-08-28`, ended: end < today },
    years: years.map(y => ({ start: y, label: `${y.slice(0, 4)}-${String(Number(y.slice(0, 4)) + 1).slice(2)}` })),
    company: { name: s.legal_name, abn: s.abn, address: addressLines(s.business_address).join(", ") },
    rows: (f.rows || []).map((r: any) => ({ ...r, address: addressLines(r.address).join(", "), gross: Number(r.gross), gst: Number(r.gst), withheld: Number(r.withheld), unapplied: Number(r.unapplied) })),
    totals: numbers(f.totals),
    notMarked: (f.notMarked || []).map((n: any) => ({ ...n, paid: Number(n.paid) })),
    lodged: lodged.data ? { on: lodged.data.lodged_on, reference: lodged.data.reference, by: who.get(lodged.data.lodged_by) || null,
      totals: numbers(lodged.data.figures?.totals) } : null,
    can: { lodge: has(actor, "tax.bas") && !lodged.data && end < today }
  };
}

/* ---------------- Dashboard ---------------- */

export async function taxHeadlines(admin: Client, actor: Actor) {
  if (!READ.some(k => has(actor, k))) return null;
  const { data } = await admin.from("bas_returns").select("id,period_start,period_end,status,due_date,prepared_by").eq("organization_id", actor.organization_id)
    .in("status", ["draft", "reviewed", "lodged"]).order("period_start").limit(10);
  const open = data || [];
  return {
    toReview: open.filter((b: any) => b.status === "draft" && b.prepared_by !== actor.id).length,
    toLodge: open.filter((b: any) => b.status === "reviewed").length,
    toPay: open.filter((b: any) => b.status === "lodged").length,
    nextDue: open.filter((b: any) => b.status !== "lodged").map((b: any) => ({ id: b.id, from: b.period_start, to: b.period_end, due: b.due_date, status: b.status }))[0] || null
  };
}

export const taxActions: Record<string, { perm: string[] | null; run: Handler }> = {
  bas_list: { perm: READ, run: list },
  bas_counts: { perm: READ, run: taxHeadlines },
  bas_get: { perm: READ, run: get },
  bas_lines: { perm: READ, run: lines },
  bas_pdf: { perm: READ, run: pdfOut },
  bas_create: { perm: ["tax.bas"], run: create },
  bas_save: { perm: ["tax.bas"], run: save },
  bas_review: { perm: ["tax.review"], run: async (admin, actor, body) => { await rpc(admin, "bas_review", { p_actor: actor.id, p_id: uuid(body.id, "BAS"), p_comment: text(body.comment, 1000) }); return { ok: true }; } },
  bas_reopen: { perm: ["tax.bas"], run: async (admin, actor, body) => { await rpc(admin, "bas_reopen", { p_actor: actor.id, p_id: uuid(body.id, "BAS"), p_reason: text(body.reason, 300) }); return { ok: true }; } },
  bas_delete: { perm: ["tax.bas"], run: async (admin, actor, body) => { await rpc(admin, "bas_delete", { p_actor: actor.id, p_id: uuid(body.id, "BAS") }); return { ok: true }; } },
  bas_lodge: { perm: ["tax.bas"], run: async (admin, actor, body) => {
    const journalId = await rpc(admin, "bas_lodge", { p_actor: actor.id, p_id: uuid(body.id, "BAS"), p_lodged_on: date(body.lodgedOn, "The lodgement date"),
      p_reference: text(body.reference, 60), p_lock: body.lock !== false });
    return { journalId };
  } },
  bas_record_payment: { perm: ["tax.bas", "bank.manage"], run: async (admin, actor, body) => {
    const amt = body.amount === "" || body.amount == null ? null : Number(String(body.amount).replace(/[$,\s]/g, ""));
    if (amt != null && !Number.isFinite(amt)) throw httpError(400, "Enter the amount.");
    const journalId = await rpc(admin, "bas_record_payment", { p_actor: actor.id, p_id: uuid(body.id, "BAS"), p_bank: uuid(body.bankAccountId, "Bank account"),
      p_date: date(body.date, "The date"), p_amount: amt });
    return { journalId };
  } },
  tpar_get: { perm: READ, run: tparGet },
  tpar_lodge: { perm: ["tax.bas"], run: async (admin, actor, body) => {
    const id = await rpc(admin, "tpar_lodge", { p_actor: actor.id, p_year_start: date(body.yearStart, "The financial year"), p_lodged_on: date(body.lodgedOn, "The lodgement date"),
      p_reference: text(body.reference, 60) });
    return { id };
  } }
};
