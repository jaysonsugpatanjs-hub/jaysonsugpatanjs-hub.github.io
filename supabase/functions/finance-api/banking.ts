// Phase 6: banking. Statement imports, matching with suggestions, entries
// made from statement lines, bank rules, reconciliations, payment batches
// with ABA files, and the ABA file for a pay run. Writes go through SQL
// functions that re-check bank.manage and audit. Statement files are parsed
// in the browser (accounts/lib/bank-file.js); the database checks each row.
import { httpError, rpc } from "../_shared/http.ts";
import { buildAba, type AbaSource } from "../_shared/aba.ts";
import { accountOption, cents, date, dollars, has, lookups, names, optDate, optUuid, taxOption, text, uuid, type Actor, type Client, type Handler } from "./docs.ts";
import { todaySydney } from "./ledger.ts";

const BANK = ["bank.manage"];
const BANK_READ = ["bank.manage", "reports.view"];
const fmtBsb = (b?: string | null) => (b ? `${b.slice(0, 3)}-${b.slice(3)}` : null);
const mask = (n?: string | null) => (n ? `•••${n.slice(-3)}` : null);
const num = (v: unknown) => (v == null ? null : Number(v));
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const words = (s: string) => new Set(String(s || "").toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length >= 3));

async function bankAccount(admin: Client, actor: Actor, id: unknown) {
  const accountId = uuid(id, "Bank account");
  const { data } = await admin.from("accounts").select("id,code,name,subtype,status").eq("id", accountId).eq("organization_id", actor.organization_id).maybeSingle();
  if (!data || data.subtype !== "bank") throw httpError(404, "Bank account not found.");
  return data;
}

/* ---------------- Overview and settings ---------------- */

async function overview(admin: Client, actor: Actor) {
  const today = todaySydney();
  const [lk, company, imports, open, recs, balances, rules] = await Promise.all([
    lookups(admin, actor),
    admin.from("company_bank_accounts").select("id,nickname,account_name,bsb,account_number,apca_user_id,purpose,status,ledger_account_id,aba_bank_code,aba_user_name,aba_balancing_record")
      .eq("organization_id", actor.organization_id).in("status", ["pending", "active"]).order("created_at"),
    admin.from("bank_imports").select("account_id,statement_balance,statement_balance_date,imported_at,last_date").eq("organization_id", actor.organization_id)
      .is("undone_at", null).order("imported_at", { ascending: false }).limit(200),
    admin.from("bank_transactions").select("account_id,amount").eq("organization_id", actor.organization_id).eq("status", "new").limit(10000),
    admin.from("bank_reconciliations").select("account_id,statement_date,statement_balance").eq("organization_id", actor.organization_id).eq("status", "completed")
      .order("statement_date", { ascending: false }),
    rpc<any[]>(admin, "ledger_balances", { p_org: actor.organization_id, p_from: null, p_to: today }),
    admin.from("bank_rules").select("id,name,bank_account_id,direction,match_text,amount_min,amount_max,target_account_id,tax_code_id,payee,priority,active")
      .eq("organization_id", actor.organization_id).order("priority").order("name")
  ]);
  const bal = new Map((balances || []).map((b: any) => [b.account_id, Number(b.debit) - Number(b.credit)]));
  const full = has(actor, "bank.manage");
  const accounts = lk.accounts.filter((a: any) => a.subtype === "bank" && a.status === "active").map((a: any) => {
    const lastImport = (imports.data || []).find((i: any) => i.account_id === a.id);
    const withBalance = (imports.data || []).filter((i: any) => i.account_id === a.id && i.statement_balance != null)
      .sort((x: any, y: any) => String(y.statement_balance_date || "").localeCompare(String(x.statement_balance_date || "")))[0];
    const rec = (recs.data || []).find((r: any) => r.account_id === a.id);
    const lines = (open.data || []).filter((t: any) => t.account_id === a.id);
    const link = (company.data || []).find((c: any) => c.ledger_account_id === a.id);
    return {
      id: a.id, code: a.code, name: a.name, ledgerBalance: dollars(cents(bal.get(a.id) || 0)),
      statementBalance: withBalance ? Number(withBalance.statement_balance) : null, statementDate: withBalance?.statement_balance_date || null,
      lastImport: lastImport?.imported_at || null, importedTo: lastImport?.last_date || null,
      toMatch: lines.length, lastReconciled: rec?.statement_date || null, reconciledBalance: rec ? Number(rec.statement_balance) : null,
      linked: link ? { id: link.id, nickname: link.nickname } : null
    };
  });
  return {
    today,
    accounts,
    companyAccounts: (company.data || []).map((c: any) => ({
      id: c.id, nickname: c.nickname, accountName: c.account_name, bsb: fmtBsb(c.bsb), accountNumber: full ? c.account_number : mask(c.account_number),
      apcaUserId: c.apca_user_id, purpose: c.purpose, status: c.status, ledgerAccountId: c.ledger_account_id, abaBankCode: c.aba_bank_code,
      abaUserName: c.aba_user_name, abaBalancing: c.aba_balancing_record,
      abaReady: Boolean(c.status === "active" && c.ledger_account_id && c.apca_user_id && c.aba_bank_code && c.aba_user_name)
    })),
    codingAccounts: lk.accounts.filter((a: any) => a.status === "active" && a.allow_manual).map(accountOption),
    taxCodes: lk.taxCodes.filter((t: any) => t.active).map(taxOption),
    rules: (rules.data || []).map((r: any) => ({ id: r.id, name: r.name, bankAccountId: r.bank_account_id, direction: r.direction, matchText: r.match_text,
      amountMin: num(r.amount_min), amountMax: num(r.amount_max), targetAccountId: r.target_account_id, taxCodeId: r.tax_code_id, payee: r.payee,
      priority: r.priority, active: r.active })),
    can: { manage: full }
  };
}

async function settingsSave(admin: Client, actor: Actor, body: any) {
  const p: Record<string, unknown> = {};
  if ("ledgerAccountId" in body) p.ledger_account_id = optUuid(body.ledgerAccountId) || "";
  if ("apcaUserId" in body) p.apca_user_id = text(body.apcaUserId, 10);
  if ("abaBankCode" in body) p.aba_bank_code = text(body.abaBankCode, 3);
  if ("abaUserName" in body) p.aba_user_name = text(body.abaUserName, 40);
  if ("abaBalancing" in body) p.aba_balancing_record = body.abaBalancing === true;
  await rpc(admin, "company_bank_settings", { p_actor: actor.id, p_id: uuid(body.id, "Bank account"), p });
  return { saved: true };
}

/* ---------------- Statement lines ---------------- */

function rowOut(t: any) {
  return { id: t.id, date: t.txn_date, description: t.description, reference: t.reference, amount: Number(t.amount), balance: num(t.balance),
    status: t.status, matchKind: t.match_kind, excludedReason: t.excluded_reason, reconciled: Boolean(t.reconciliation_id), importId: t.import_id };
}

/** Unmatched, uncleared, posted ledger lines on a bank account in a date range. */
async function openLedgerLines(admin: Client, accountId: string, from: string, to: string) {
  const { data, error } = await admin.from("journal_lines")
    .select("id,debit,credit,description,journal_entries!inner(id,number,entry_date,memo,source_type,source_id,source_ref,status,reverses_id)")
    .eq("account_id", accountId).eq("journal_entries.status", "posted").is("journal_entries.reverses_id", null)
    .gte("journal_entries.entry_date", from).lte("journal_entries.entry_date", to).limit(2000);
  if (error) throw httpError(500, "Ledger lines could not be loaded.");
  const ids = (data || []).map((l: any) => l.id);
  if (!ids.length) return [];
  const used = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [m, c] = await Promise.all([
      admin.from("bank_matches").select("journal_line_id").in("journal_line_id", chunk),
      admin.from("bank_cleared_lines").select("journal_line_id").in("journal_line_id", chunk)
    ]);
    for (const r of [...(m.data || []), ...(c.data || [])]) used.add(r.journal_line_id);
  }
  return (data || []).filter((l: any) => !used.has(l.id)).map((l: any) => ({
    lineId: l.id, journalId: l.journal_entries.id, number: l.journal_entries.number, date: l.journal_entries.entry_date,
    memo: l.journal_entries.memo, source: l.journal_entries.source_type, sourceId: l.journal_entries.source_id, ref: l.journal_entries.source_ref,
    description: l.description, amount: dollars(cents(l.debit) - cents(l.credit))
  }));
}

async function openDocuments(admin: Client, actor: Actor) {
  const [inv, bills, invBal, billBal, runs] = await Promise.all([
    admin.from("invoices").select("id,number,reference,customer_id,invoice_date,due_date,customers(name)").eq("organization_id", actor.organization_id)
      .eq("kind", "invoice").eq("status", "approved").limit(2000),
    admin.from("bills").select("id,number,supplier_reference,supplier_id,bill_date,due_date,suppliers(name)").eq("organization_id", actor.organization_id)
      .eq("kind", "bill").eq("status", "approved").limit(2000),
    rpc<any[]>(admin, "invoice_balances", { p_org: actor.organization_id }),
    rpc<any[]>(admin, "bill_balances", { p_org: actor.organization_id }),
    admin.from("pay_runs").select("id,number,status,payment_date,net,super,super_paid_at").eq("organization_id", actor.organization_id).in("status", ["approved", "paid"])
      .order("payment_date", { ascending: false }).limit(60)
  ]);
  const ib = new Map((invBal || []).map((b: any) => [b.id, Number(b.owing)]));
  const bb = new Map((billBal || []).map((b: any) => [b.id, Number(b.owing)]));
  return {
    invoices: (inv.data || []).map((i: any) => ({ id: i.id, number: i.number, reference: i.reference, customerId: i.customer_id, customer: i.customers?.name || "",
      date: i.invoice_date, due: i.due_date, owing: ib.get(i.id) || 0 })).filter((i: any) => i.owing > 0),
    bills: (bills.data || []).map((b: any) => ({ id: b.id, number: b.number, reference: b.supplier_reference, supplierId: b.supplier_id, supplier: b.suppliers?.name || "",
      date: b.bill_date, due: b.due_date, owing: bb.get(b.id) || 0 })).filter((b: any) => b.owing > 0),
    payRuns: (runs.data || []).flatMap((r: any) => [
      ...(r.status === "approved" ? [{ id: r.id, number: r.number, what: "net", amount: Number(r.net), date: r.payment_date }] : []),
      ...(!r.super_paid_at && Number(r.super) > 0 ? [{ id: r.id, number: r.number, what: "super", amount: Number(r.super), date: r.payment_date }] : [])
    ])
  };
}

function ruleFor(rules: any[], t: any) {
  const desc = String(t.description || "").toLowerCase() + " " + String(t.reference || "").toLowerCase();
  return rules.find(r => r.active && (!r.bank_account_id || r.bank_account_id === t.account_id)
    && (r.direction === "any" || (r.direction === "in") === (Number(t.amount) > 0))
    && desc.includes(String(r.match_text).toLowerCase())
    && (r.amount_min == null || Math.abs(Number(t.amount)) >= Number(r.amount_min))
    && (r.amount_max == null || Math.abs(Number(t.amount)) <= Number(r.amount_max)));
}

/** Best guesses for each unmatched line: ledger entries of the same amount, open invoices or bills, pay runs, rules. */
function suggest(t: any, ledger: any[], docs: any, rules: any[]) {
  const amount = Number(t.amount);
  const tw = words(`${t.description} ${t.reference}`);
  const out: any[] = [];
  const scored = ledger.filter(l => l.amount === amount && dayGap(l.date, t.txn_date) <= 14)
    .map(l => ({ l, score: dayGap(l.date, t.txn_date) - [...words(`${l.memo} ${l.ref || ""} ${l.number}`)].filter(w => tw.has(w)).length * 3 }))
    .sort((a, b) => a.score - b.score).slice(0, 3);
  for (const { l } of scored) out.push({ type: "match", lineIds: [l.lineId], label: `${l.number} · ${l.memo}`, date: l.date, amount: l.amount });
  if (amount > 0) {
    for (const i of docs.invoices.filter((i: any) => i.owing === amount || tw.has(String(i.number).toUpperCase()) || (i.reference && tw.has(String(i.reference).toUpperCase())))
      .sort((a: any, b: any) => (b.owing === amount ? 1 : 0) - (a.owing === amount ? 1 : 0)).slice(0, 3)) {
      out.push({ type: "invoice", customerId: i.customerId, invoiceId: i.id, label: `${i.number} · ${i.customer}`, owing: i.owing, amount: Math.min(i.owing, amount) });
    }
  } else {
    for (const b of docs.bills.filter((b: any) => b.owing === -amount).slice(0, 3)) {
      out.push({ type: "bill", supplierId: b.supplierId, billId: b.id, label: `${b.number} · ${b.supplier}${b.reference ? ` (${b.reference})` : ""}`, owing: b.owing, amount: -amount });
    }
    for (const r of docs.payRuns.filter((r: any) => r.amount === -amount).slice(0, 2)) {
      out.push({ type: "payrun", runId: r.id, what: r.what, label: `${r.number} · ${r.what === "net" ? "net pay" : "super"}` });
    }
  }
  const rule = ruleFor(rules, t);
  if (rule) out.push({ type: "rule", ruleId: rule.id, label: rule.name, accountId: rule.target_account_id, taxCodeId: rule.tax_code_id, payee: rule.payee });
  return out;
}

async function lines(admin: Client, actor: Actor, body: any) {
  const acc = await bankAccount(admin, actor, body.accountId);
  const status = ["new", "matched", "excluded", "all"].includes(body.status) ? body.status : "new";
  let q = admin.from("bank_transactions").select("id,account_id,import_id,txn_date,description,reference,amount,balance,status,match_kind,excluded_reason,reconciliation_id")
    .eq("account_id", acc.id).order("txn_date", { ascending: status === "new" }).order("created_at").limit(500);
  if (status !== "all") q = q.eq("status", status);
  const from = optDate(body.from), to = optDate(body.to);
  if (from) q = q.gte("txn_date", from);
  if (to) q = q.lte("txn_date", to);
  if (body.search) q = q.ilike("description", `%${text(body.search, 60).replace(/[%_,()]/g, " ")}%`);
  const { data, error } = await q;
  if (error) throw httpError(500, "Statement lines could not be loaded.");
  const rows = data || [];
  const out = rows.map(rowOut);
  if (status === "new" && rows.length && has(actor, "bank.manage")) {
    const dates = rows.map((r: any) => r.txn_date).sort();
    const [ledger, docs, rules] = await Promise.all([
      openLedgerLines(admin, acc.id, addDays(dates[0], -14), addDays(dates[dates.length - 1], 14)),
      openDocuments(admin, actor),
      admin.from("bank_rules").select("*").eq("organization_id", actor.organization_id).eq("active", true).order("priority").order("name")
    ]);
    out.forEach((o: any, i: number) => { o.suggestions = suggest(rows[i], ledger, docs, rules.data || []); });
  } else if (rows.some((r: any) => r.status === "matched")) {
    const ids = rows.filter((r: any) => r.status === "matched").map((r: any) => r.id);
    const { data: m } = await admin.from("bank_matches").select("bank_transaction_id,journal_lines(journal_entries(id,number,memo,source_type,entry_date))").in("bank_transaction_id", ids.slice(0, 500));
    const by = new Map<string, any[]>();
    for (const x of m || []) {
      const je = x.journal_lines?.journal_entries;
      if (je) by.set(x.bank_transaction_id, [...(by.get(x.bank_transaction_id) || []), { id: je.id, number: je.number, memo: je.memo, source: je.source_type, date: je.entry_date }]);
    }
    out.forEach((o: any) => { if (o.status === "matched") o.matchedTo = by.get(o.id) || []; });
  }
  return { account: { id: acc.id, code: acc.code, name: acc.name }, status, lines: out };
}

/** Everything that could go with one line: ledger entries (any amount, ±60 days), open invoices or bills, pay runs. */
async function candidates(admin: Client, actor: Actor, body: any) {
  const { data: t } = await admin.from("bank_transactions").select("*").eq("id", uuid(body.id, "Statement line")).eq("organization_id", actor.organization_id).maybeSingle();
  if (!t) throw httpError(404, "Statement line not found.");
  const [ledger, docs] = await Promise.all([openLedgerLines(admin, t.account_id, addDays(t.txn_date, -60), addDays(t.txn_date, 60)), openDocuments(admin, actor)]);
  const amount = Number(t.amount);
  return {
    line: rowOut(t),
    ledger: ledger.filter(l => Math.sign(l.amount) === Math.sign(amount)).sort((a, b) => (a.amount === amount ? 0 : 1) - (b.amount === amount ? 0 : 1) || dayGap(a.date, t.txn_date) - dayGap(b.date, t.txn_date)),
    invoices: amount > 0 ? docs.invoices : [],
    bills: amount < 0 ? docs.bills : [],
    payRuns: amount < 0 ? docs.payRuns : []
  };
}

async function importStatement(admin: Client, actor: Actor, body: any) {
  const acc = await bankAccount(admin, actor, body.accountId);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > 5000) throw httpError(400, "Import at most 5,000 lines at a time.");
  const clean = rows.map((r: any) => ({
    date: String(r?.date || ""), amount: String(r?.amount ?? ""), description: text(r?.description, 300), reference: text(r?.reference, 120),
    balance: r?.balance == null || r?.balance === "" ? null : String(r.balance), externalId: r?.externalId ? text(r.externalId, 120) : null
  }));
  const balance = body.statementBalance === "" || body.statementBalance == null ? null : Number(body.statementBalance);
  if (balance != null && !Number.isFinite(balance)) throw httpError(400, "The statement balance must be a number.");
  return await rpc(admin, "bank_import", { p_actor: actor.id, p_account: acc.id, p_file_name: text(body.fileName, 200) || "statement",
    p_format: ["csv", "ofx", "qif"].includes(body.format) ? body.format : "csv", p_rows: clean, p_statement_balance: balance, p_balance_date: optDate(body.balanceDate) });
}

async function importsList(admin: Client, actor: Actor, body: any) {
  const acc = await bankAccount(admin, actor, body.accountId);
  const { data } = await admin.from("bank_imports").select("*").eq("account_id", acc.id).order("imported_at", { ascending: false }).limit(50);
  const who = await names(admin, (data || []).flatMap((i: any) => [i.imported_by, i.undone_by]));
  return { imports: (data || []).map((i: any) => ({ id: i.id, fileName: i.file_name, format: i.format, rows: i.rows_in_file, added: i.rows_added, from: i.first_date,
    to: i.last_date, statementBalance: num(i.statement_balance), at: i.imported_at, by: who.get(i.imported_by) || "", undoneAt: i.undone_at, undoneBy: who.get(i.undone_by) || null })) };
}

const lineAction = (fn: string, extra: (b: any) => Record<string, unknown>): Handler => async (admin, actor, body) => {
  const result = await rpc(admin, fn, { p_actor: actor.id, p_txn: uuid(body.id, "Statement line"), ...extra(body) });
  return { ok: true, result };
};
const lineIds = (v: unknown) => (Array.isArray(v) ? v : []).map(x => uuid(x, "Entry")).slice(0, 100);
const allocs = (v: unknown, key: string) => (Array.isArray(v) ? v : []).slice(0, 200).map((a: any) => ({ [key]: uuid(a?.[key], "Document"), amount: Number(a?.amount) }));

async function createEntry(admin: Client, actor: Actor, body: any) {
  const ls = (Array.isArray(body.lines) ? body.lines : []).slice(0, 20).map((l: any) => ({
    accountId: uuid(l?.accountId, "Account"), taxCodeId: optUuid(l?.taxCodeId), amount: Number(l?.amount), description: text(l?.description, 300)
  }));
  const journalId = await rpc(admin, "bank_create_entry", { p_actor: actor.id, p_txn: uuid(body.id, "Statement line"), p_payee: text(body.payee, 120), p_lines: ls });
  return { journalId };
}

/* ---------------- Rules ---------------- */

async function ruleSave(admin: Client, actor: Actor, body: any) {
  const n = (v: unknown) => (v === "" || v == null ? "" : String(Number(v)));
  const id = await rpc(admin, "bank_rule_save", { p_actor: actor.id, p_id: optUuid(body.id), p: {
    name: text(body.name, 80), bank_account_id: optUuid(body.bankAccountId) || "", direction: ["in", "out", "any"].includes(body.direction) ? body.direction : "any",
    match_text: text(body.matchText, 100), amount_min: n(body.amountMin), amount_max: n(body.amountMax), target_account_id: optUuid(body.targetAccountId) || "",
    tax_code_id: optUuid(body.taxCodeId) || "", payee: text(body.payee, 120), priority: n(body.priority), active: body.active !== false
  } });
  return { id };
}

/* ---------------- Reconciliation ---------------- */

async function unpresentedAt(admin: Client, accountId: string, asAt: string) {
  const rows = await rpc<any[]>(admin, "bank_ledger_lines", { p_account: accountId, p_as_at: asAt });
  return (rows || []).filter(r => !r.cleared).map(r => ({ lineId: r.journal_line_id, journalId: r.journal_id, number: r.number, date: r.entry_date, memo: r.memo,
    source: r.source_type, amount: Number(r.amount) })).sort((a, b) => a.date.localeCompare(b.date));
}

async function reconcilePreview(admin: Client, actor: Actor, body: any) {
  const acc = await bankAccount(admin, actor, body.accountId);
  const asAt = date(body.date, "Statement date");
  const clearedBefore = optDate(body.clearedBefore);
  const s = await rpc<any>(admin, "bank_reconcile_summary", { p_account: acc.id, p_as_at: asAt });
  let unpresented = await unpresentedAt(admin, acc.id, asAt);
  let cleared = 0;
  if (clearedBefore && s.firstReconciliation) {
    const before = unpresented.filter(u => u.date < clearedBefore);
    cleared = dollars(before.reduce((t, u) => t + cents(u.amount), 0));
    unpresented = unpresented.filter(u => u.date >= clearedBefore);
  }
  const unp = dollars(unpresented.reduce((t, u) => t + cents(u.amount), 0));
  const expected = dollars(cents(s.ledgerBalance) - cents(unp) + cents(s.recordedEarly));
  // The statement balance on the last imported line up to the date, if the file had balances.
  const { data: lastLine } = await admin.from("bank_transactions").select("balance,txn_date").eq("account_id", acc.id).lte("txn_date", asAt).not("balance", "is", null)
    .order("txn_date", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return {
    account: { id: acc.id, code: acc.code, name: acc.name }, date: asAt,
    ledgerBalance: Number(s.ledgerBalance), unpresented: unp, recordedEarly: Number(s.recordedEarly), clearedAsOpening: cleared, expectedStatementBalance: expected,
    openLines: Number(s.openLines), lastReconciled: s.lastReconciled, firstReconciliation: s.firstReconciliation,
    statementBalanceFromFile: lastLine ? Number(lastLine.balance) : null,
    items: unpresented.slice(0, 300), itemCount: unpresented.length
  };
}

async function reconcile(admin: Client, actor: Actor, body: any) {
  const acc = await bankAccount(admin, actor, body.accountId);
  const balance = Number(String(body.balance ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(balance)) throw httpError(400, "Enter the statement's closing balance.");
  const id = await rpc(admin, "bank_reconcile", { p_actor: actor.id, p_account: acc.id, p_date: date(body.date, "Statement date"), p_balance: balance,
    p_cleared_before: optDate(body.clearedBefore), p_notes: text(body.notes, 1000) });
  return { id };
}

async function reconciliationsList(admin: Client, actor: Actor, body: any) {
  const acc = await bankAccount(admin, actor, body.accountId);
  const { data } = await admin.from("bank_reconciliations").select("*").eq("account_id", acc.id).order("statement_date", { ascending: false }).limit(100);
  const who = await names(admin, (data || []).flatMap((r: any) => [r.completed_by, r.undone_by]));
  return { reconciliations: (data || []).map((r: any) => ({ id: r.id, date: r.statement_date, balance: Number(r.statement_balance), ledgerBalance: Number(r.ledger_balance),
    unpresented: Number(r.unpresented), recordedEarly: Number(r.recorded_early), clearedBefore: r.cleared_before, status: r.status, notes: r.notes,
    by: who.get(r.completed_by) || "", at: r.completed_at, undoneBy: who.get(r.undone_by) || null, undoneAt: r.undone_at, undoReason: r.undo_reason })) };
}

async function reconciliationGet(admin: Client, actor: Actor, body: any) {
  const { data: r } = await admin.from("bank_reconciliations").select("*").eq("id", uuid(body.id, "Reconciliation")).eq("organization_id", actor.organization_id).maybeSingle();
  if (!r) throw httpError(404, "Reconciliation not found.");
  const acc = await bankAccount(admin, actor, r.account_id);
  const [items, lines, who] = await Promise.all([
    unpresentedAt(admin, r.account_id, r.statement_date),
    admin.from("bank_transactions").select("id,txn_date,description,amount,status,excluded_reason").eq("reconciliation_id", r.id).order("txn_date").limit(2000),
    names(admin, [r.completed_by, r.undone_by])
  ]);
  return {
    account: { id: acc.id, code: acc.code, name: acc.name },
    reconciliation: { id: r.id, date: r.statement_date, balance: Number(r.statement_balance), ledgerBalance: Number(r.ledger_balance), unpresented: Number(r.unpresented),
      recordedEarly: Number(r.recorded_early), clearedBefore: r.cleared_before, status: r.status, notes: r.notes, by: who.get(r.completed_by) || "", at: r.completed_at,
      undoneBy: who.get(r.undone_by) || null, undoReason: r.undo_reason },
    unpresentedItems: r.status === "completed" ? items : [],
    statementLines: (lines.data || []).map((l: any) => ({ id: l.id, date: l.txn_date, description: l.description, amount: Number(l.amount), status: l.status, excludedReason: l.excluded_reason })),
    can: { undo: has(actor, "bank.manage") && r.status === "completed" }
  };
}

/* ---------------- Payment batches and ABA files ---------------- */

async function companyName(admin: Client, actor: Actor) {
  const { data } = await admin.from("company_settings").select("legal_name,trading_name").eq("organization_id", actor.organization_id).maybeSingle();
  return data?.trading_name || data?.legal_name || "PANALO";
}

async function abaSource(admin: Client, actor: Actor, id: string): Promise<AbaSource & { nickname: string }> {
  const { data: c } = await admin.from("company_bank_accounts").select("*").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!c || c.status !== "active") throw httpError(409, "Choose an approved company bank account to pay from.");
  if (!c.apca_user_id || !c.aba_bank_code || !c.aba_user_name) throw httpError(409, `Set up ${c.nickname} for bank files first (Bank accounts > settings).`);
  return { nickname: c.nickname, bankCode: c.aba_bank_code, userName: c.aba_user_name, apcaUserId: c.apca_user_id, bsb: c.bsb, accountNumber: c.account_number,
    accountTitle: c.account_name, remitter: (await companyName(admin, actor)).slice(0, 16), balancing: Boolean(c.aba_balancing_record) };
}

async function batchOptions(admin: Client, actor: Actor) {
  const [docs, open, sup, company] = await Promise.all([
    openDocuments(admin, actor),
    admin.from("payment_batch_items").select("bill_id,payment_batches!inner(status,organization_id)").eq("payment_batches.organization_id", actor.organization_id)
      .in("payment_batches.status", ["draft", "approved"]),
    admin.from("suppliers").select("id,bank_bsb,bank_account_number").eq("organization_id", actor.organization_id),
    admin.from("company_bank_accounts").select("id,nickname,bsb,account_number,status,ledger_account_id,apca_user_id,aba_bank_code,aba_user_name").eq("organization_id", actor.organization_id).eq("status", "active")
  ]);
  const inBatch = new Set((open.data || []).map((x: any) => x.bill_id));
  const bank = new Map((sup.data || []).map((s: any) => [s.id, s]));
  return {
    today: todaySydney(),
    bills: docs.bills.map((b: any) => {
      const s: any = bank.get(b.supplierId);
      const problem = inBatch.has(b.id) ? "In a batch already" : !s?.bank_bsb ? "No approved bank account" : String(s.bank_account_number).length > 9 ? "10-digit account: pay separately" : null;
      return { ...b, payTo: s?.bank_bsb ? `${fmtBsb(s.bank_bsb)} ${mask(s.bank_account_number)}` : null, problem };
    }).sort((a: any, b: any) => a.due.localeCompare(b.due)),
    sources: (company.data || []).map((c: any) => ({ id: c.id, nickname: c.nickname, bsb: fmtBsb(c.bsb), accountNumber: mask(c.account_number),
      ready: Boolean(c.ledger_account_id && c.apca_user_id && c.aba_bank_code && c.aba_user_name) }))
  };
}

async function batchesList(admin: Client, actor: Actor) {
  const { data } = await admin.from("payment_batches").select("*,company_bank_accounts(nickname)").eq("organization_id", actor.organization_id).order("created_at", { ascending: false }).limit(200);
  const who = await names(admin, (data || []).flatMap((b: any) => [b.created_by, b.approved_by]));
  return { batches: (data || []).map((b: any) => ({ id: b.id, number: b.number, status: b.status, date: b.payment_date, total: Number(b.total), count: b.item_count,
    source: b.company_bank_accounts?.nickname || "", by: who.get(b.created_by) || "", approvedBy: who.get(b.approved_by) || null,
    downloaded: Boolean(b.file_downloaded_at), mine: b.created_by === actor.id })) };
}

async function batchGet(admin: Client, actor: Actor, body: any) {
  const { data: b } = await admin.from("payment_batches").select("*,company_bank_accounts(nickname,bsb,account_number)").eq("id", uuid(body.id, "Payment batch"))
    .eq("organization_id", actor.organization_id).maybeSingle();
  if (!b) throw httpError(404, "Payment batch not found.");
  const { data: items } = await admin.from("payment_batch_items").select("*,bills(number,supplier_reference,due_date),suppliers(name)").eq("batch_id", b.id);
  const who = await names(admin, [b.created_by, b.approved_by, b.paid_by, b.cancelled_by, b.file_downloaded_by]);
  return {
    batch: { id: b.id, number: b.number, status: b.status, date: b.payment_date, description: b.description, total: Number(b.total), count: b.item_count,
      source: { nickname: b.company_bank_accounts?.nickname, bsb: fmtBsb(b.company_bank_accounts?.bsb), accountNumber: mask(b.company_bank_accounts?.account_number) },
      createdBy: who.get(b.created_by) || "", createdAt: b.created_at, approvedBy: who.get(b.approved_by) || null, approvedAt: b.approved_at,
      downloadedAt: b.file_downloaded_at, downloadedBy: who.get(b.file_downloaded_by) || null, paidAt: b.paid_at, paidBy: who.get(b.paid_by) || null,
      cancelledAt: b.cancelled_at, cancelReason: b.cancel_reason },
    items: (items || []).map((i: any) => ({ id: i.id, billId: i.bill_id, bill: i.bills?.number, supplierReference: i.bills?.supplier_reference, due: i.bills?.due_date,
      supplier: i.suppliers?.name, amount: Number(i.amount), accountName: i.account_name, bsb: fmtBsb(i.bsb), accountNumber: mask(i.account_number), reference: i.lodgement_ref,
      paymentId: i.supplier_payment_id })),
    can: {
      approve: b.status === "draft" && b.created_by !== actor.id,
      download: ["approved", "paid"].includes(b.status),
      markPaid: b.status === "approved" && Boolean(b.file_downloaded_at),
      cancel: ["draft", "approved"].includes(b.status)
    }
  };
}

async function batchCreate(admin: Client, actor: Actor, body: any) {
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 500).map((i: any) => ({ billId: uuid(i?.billId, "Bill"), amount: i?.amount == null || i.amount === "" ? null : Number(i.amount) }));
  const id = await rpc(admin, "payment_batch_create", { p_actor: actor.id, p_source: uuid(body.sourceId, "Bank account"), p_date: date(body.date, "Payment date"),
    p_description: text(body.description, 12), p_items: items });
  return { id };
}

async function batchAba(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Payment batch");
  const { data: b } = await admin.from("payment_batches").select("*").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!b) throw httpError(404, "Payment batch not found.");
  if (!["approved", "paid"].includes(b.status)) throw httpError(409, "The bank file is available once the batch is approved.");
  const src = await abaSource(admin, actor, b.source_bank_id);
  const { data: items } = await admin.from("payment_batch_items").select("bsb,account_number,account_name,amount,lodgement_ref").eq("batch_id", id).order("lodgement_ref");
  let file;
  try {
    file = buildAba(src, (items || []).map((i: any) => ({ bsb: i.bsb, accountNumber: i.account_number, accountName: i.account_name, amountCents: cents(i.amount), reference: i.lodgement_ref })),
      { date: b.payment_date, description: b.description, code: "50" });
  } catch (e) { throw httpError(409, (e as Error).message); }
  if (file.totalCents !== cents(b.total)) throw httpError(500, "The bank file total doesn't match the batch.");
  await rpc(admin, "payment_batch_file_downloaded", { p_actor: actor.id, p_id: id });
  return { fileName: `${b.number}.aba`, content: file.content, total: dollars(file.totalCents), count: file.count };
}

/** ABA file for an approved pay run's net pay. Needs payroll details access, like the bank list. */
async function payRunAba(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Pay run");
  const { data: r } = await admin.from("pay_runs").select("id,number,status,payment_date,net").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!r) throw httpError(404, "Pay run not found.");
  if (!["approved", "paid"].includes(r.status)) throw httpError(409, "The bank file is available once the pay run is approved.");
  const src = await abaSource(admin, actor, uuid(body.sourceId, "Bank account"));
  const { data: rows } = await admin.from("pay_run_employees").select("net,employee_id,payroll_employees(bank_account_name,bank_bsb,bank_account_number,employees(full_name))")
    .eq("pay_run_id", id).gt("net", 0);
  const missing = (rows || []).filter((x: any) => !x.payroll_employees?.bank_bsb).map((x: any) => x.payroll_employees?.employees?.full_name || "someone");
  if (missing.length) throw httpError(409, `No approved bank account for ${missing.join(", ")}. Pay them separately or approve their bank details first.`);
  let file;
  try {
    file = buildAba(src, (rows || []).map((x: any) => ({ bsb: x.payroll_employees.bank_bsb, accountNumber: x.payroll_employees.bank_account_number,
      accountName: x.payroll_employees.bank_account_name || x.payroll_employees.employees?.full_name || "", amountCents: cents(x.net), reference: `PAY ${r.number}` })),
      { date: r.payment_date, description: "WAGES", code: "53" });
  } catch (e) { throw httpError(409, (e as Error).message); }
  if (file.totalCents !== cents(r.net)) throw httpError(409, "Some net pays aren't in the file. Check the pay run.");
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "pay_run_aba_downloaded", p_entity_type: "pay_run", p_entity_id: id, p_old: null,
    p_new: { number: r.number, total: dollars(file.totalCents), count: file.count, from: src.nickname }, p_details: null, p_subject: null });
  return { fileName: `${r.number}.aba`, content: file.content, total: dollars(file.totalCents), count: file.count };
}

/* ---------------- Dashboard ---------------- */

export async function bankingHeadlines(admin: Client, actor: Actor) {
  if (!has(actor, "bank.manage")) return null;
  const [open, batches] = await Promise.all([
    admin.from("bank_transactions").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).eq("status", "new"),
    admin.from("payment_batches").select("id,created_by").eq("organization_id", actor.organization_id).eq("status", "draft")
  ]);
  return { linesToMatch: open.count || 0, batchesToApprove: (batches.data || []).filter((b: any) => b.created_by !== actor.id).length };
}

export const bankingActions: Record<string, { perm: string[] | null; run: Handler }> = {
  banking_overview: { perm: BANK_READ, run: overview },
  bank_settings_save: { perm: BANK, run: settingsSave },
  bank_lines: { perm: BANK_READ, run: lines },
  bank_line_candidates: { perm: BANK, run: candidates },
  bank_import: { perm: BANK, run: importStatement },
  bank_imports_list: { perm: BANK_READ, run: importsList },
  bank_import_undo: { perm: BANK, run: async (admin, actor, body) => { await rpc(admin, "bank_import_undo", { p_actor: actor.id, p_import: uuid(body.id, "Import") }); return { ok: true }; } },
  bank_match: { perm: BANK, run: lineAction("bank_match", b => ({ p_lines: lineIds(b.lineIds), p_kind: "existing" })) },
  bank_unmatch: { perm: BANK, run: lineAction("bank_unmatch", () => ({})) },
  bank_exclude: { perm: BANK, run: lineAction("bank_exclude", b => ({ p_reason: text(b.reason, 300) })) },
  bank_create_entry: { perm: BANK, run: createEntry },
  bank_receive_payment: { perm: BANK, run: lineAction("bank_receive_payment", b => ({ p_customer: uuid(b.customerId, "Customer"), p_allocations: allocs(b.allocations, "invoiceId") })) },
  bank_pay_bills: { perm: BANK, run: lineAction("bank_pay_bills", b => ({ p_supplier: uuid(b.supplierId, "Supplier"), p_allocations: allocs(b.allocations, "billId") })) },
  bank_pay_run: { perm: BANK, run: lineAction("bank_pay_run", b => ({ p_run: uuid(b.runId, "Pay run"), p_what: b.what === "super" ? "super" : "net" })) },
  bank_rule_save: { perm: BANK, run: ruleSave },
  bank_rule_delete: { perm: BANK, run: async (admin, actor, body) => { await rpc(admin, "bank_rule_delete", { p_actor: actor.id, p_id: uuid(body.id, "Rule") }); return { ok: true }; } },
  bank_reconcile_preview: { perm: BANK_READ, run: reconcilePreview },
  bank_reconcile: { perm: BANK, run: reconcile },
  bank_reconciliations: { perm: BANK_READ, run: reconciliationsList },
  bank_reconciliation_get: { perm: BANK_READ, run: reconciliationGet },
  bank_reconcile_undo: { perm: BANK, run: async (admin, actor, body) => { await rpc(admin, "bank_reconcile_undo", { p_actor: actor.id, p_id: uuid(body.id, "Reconciliation"), p_reason: text(body.reason, 300) }); return { ok: true }; } },
  payment_batch_options: { perm: BANK, run: batchOptions },
  payment_batches_list: { perm: BANK, run: batchesList },
  payment_batch_get: { perm: BANK, run: batchGet },
  payment_batch_create: { perm: BANK, run: batchCreate },
  payment_batch_approve: { perm: BANK, run: async (admin, actor, body) => { await rpc(admin, "payment_batch_approve", { p_actor: actor.id, p_id: uuid(body.id, "Payment batch") }); return { ok: true }; } },
  payment_batch_aba: { perm: BANK, run: batchAba },
  payment_batch_mark_paid: { perm: BANK, run: async (admin, actor, body) => { await rpc(admin, "payment_batch_mark_paid", { p_actor: actor.id, p_id: uuid(body.id, "Payment batch") }); return { ok: true }; } },
  payment_batch_cancel: { perm: BANK, run: async (admin, actor, body) => { await rpc(admin, "payment_batch_cancel", { p_actor: actor.id, p_id: uuid(body.id, "Payment batch"), p_reason: text(body.reason, 300) }); return { ok: true }; } },
  pay_run_aba: { perm: ["payroll.sensitive"], run: payRunAba }
};
