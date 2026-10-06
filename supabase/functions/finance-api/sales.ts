// Phase 3 sales: customers, quotes, invoices and credit notes (adjustment
// notes), receipts and their allocation, ageing and statements. Every write
// is a SQL function that re-checks the permission and audits; approving an
// invoice posts it through the ledger engine.
import { httpError, rpc } from "../_shared/http.ts";
import { createFinanceDocumentPdf, createStatementPdf, toBase64 } from "../_shared/finance-pdf.ts";
import {
  accountOption, amount, projectOptions, amountsAre, attachmentsFor, auditPdf, cents, cleanDocLines, date, dollars, has, lookups, mapLines, names, optDate, optUuid,
  sellerContext, taxOption, text, uuid, type Actor, type Client, type Handler
} from "./docs.ts";
import { todaySydney } from "./ledger.ts";

const SALES_READ = ["sales.manage", "bank.manage", "reports.view"];
const METHODS = ["bank_transfer", "card", "cheque", "cash", "other"];
const INVOICE_TYPES = ["standard", "progress", "deposit", "final", "variation", "materials", "labour"];

async function balances(admin: Client, actor: Actor) {
  const rows = await rpc<any[]>(admin, "invoice_balances", { p_org: actor.organization_id });
  return new Map<string, number>((rows || []).map((r: any) => [r.id, Number(r.owing)]));
}

function cleanAddress(v: any) {
  const a = v && typeof v === "object" ? v : {};
  return { street: text(a.street, 120), street2: text(a.street2, 120), suburb: text(a.suburb, 60), state: text(a.state, 3).toUpperCase(), postcode: text(a.postcode, 4) };
}

/* ---------------- Setup and customers ---------------- */

async function salesSetup(admin: Client, actor: Actor) {
  const [lk, customers, company] = await Promise.all([
    lookups(admin, actor),
    admin.from("customers").select("id,name,payment_terms_days,default_revenue_account_id,default_tax_code_id,po_required,email,status")
      .eq("organization_id", actor.organization_id).eq("status", "active").order("name"),
    admin.from("company_settings").select("payment_terms_days,gst_registered,abn").eq("organization_id", actor.organization_id).maybeSingle()
  ]);
  return {
    today: todaySydney(),
    defaultTermsDays: company.data?.payment_terms_days ?? 30,
    gstRegistered: company.data?.gst_registered !== false,
    companyAbnSet: Boolean(company.data?.abn),
    customers: (customers.data || []).map((c: any) => ({ id: c.id, name: c.name, termsDays: c.payment_terms_days, revenueAccountId: c.default_revenue_account_id,
      taxCodeId: c.default_tax_code_id, poRequired: c.po_required, email: c.email })),
    accounts: lk.accounts.filter(a => a.status === "active" && a.allow_manual && ["revenue", "other_income"].includes(a.type)).map(accountOption),
    bankAccounts: lk.accounts.filter(a => a.status === "active" && a.subtype === "bank").map(accountOption),
    taxCodes: lk.taxCodes.filter(t => t.active && t.applies_to !== "purchases").map(taxOption),
    projects: projectOptions(lk),
    can: { manage: has(actor, "sales.manage"), bank: has(actor, "bank.manage"), reports: has(actor, "reports.view") }
  };
}

async function customersList(admin: Client, actor: Actor, body: any) {
  let q = admin.from("customers").select("id,name,trading_name,abn,email,phone,contact_name,payment_terms_days,credit_limit,status")
    .eq("organization_id", actor.organization_id).order("name");
  q = q.eq("status", body.status === "archived" ? "archived" : "active");
  if (body.search) q = q.ilike("name", `%${String(body.search).replace(/[%*]/g, "").slice(0, 60)}%`);
  const [{ data, error }, aged] = await Promise.all([q, rpc<any>(admin, "report_aged_receivables", { p_actor: actor.id, p_as_at: todaySydney() })]);
  if (error) throw httpError(500, "Customers could not be loaded.");
  const owing = new Map<string, any>((aged.rows || []).map((r: any) => [r.customerId, r]));
  return {
    customers: data.map((c: any) => {
      const a = owing.get(c.id);
      const overdue = a ? dollars(cents(a.days30) + cents(a.days60) + cents(a.days90) + cents(a.over90)) : 0;
      return { id: c.id, name: c.name, tradingName: c.trading_name, abn: c.abn, email: c.email, phone: c.phone, contact: c.contact_name,
        termsDays: c.payment_terms_days, creditLimit: c.credit_limit == null ? null : Number(c.credit_limit), status: c.status,
        balance: a ? Number(a.total) : 0, overdue, overLimit: c.credit_limit != null && a && Number(a.total) > Number(c.credit_limit) };
    })
  };
}

async function customerGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Customer");
  const { data: c } = await admin.from("customers").select("*").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!c) throw httpError(404, "Customer not found.");
  const [invoices, quotes, payments, bal, files] = await Promise.all([
    admin.from("invoices").select("id,kind,number,invoice_date,due_date,total,status,reference,invoice_type").eq("customer_id", id).order("invoice_date", { ascending: false }).limit(200),
    admin.from("quotes").select("id,number,quote_date,expiry_date,title,total,status").eq("customer_id", id).order("quote_date", { ascending: false }).limit(100),
    admin.from("customer_payments").select("id,payment_date,amount,reference,method,status").eq("customer_id", id).order("payment_date", { ascending: false }).limit(200),
    balances(admin, actor),
    attachmentsFor(admin, actor, "customer", id)
  ]);
  const unalloc = await paymentUnallocated(admin, (payments.data || []).filter((p: any) => p.status === "posted").map((p: any) => p.id));
  return {
    customer: {
      id: c.id, name: c.name, tradingName: c.trading_name, abn: c.abn, contactName: c.contact_name, email: c.email, phone: c.phone,
      billingAddress: c.billing_address, siteAddress: c.site_address, termsDays: c.payment_terms_days, creditLimit: c.credit_limit == null ? null : Number(c.credit_limit),
      revenueAccountId: c.default_revenue_account_id, taxCodeId: c.default_tax_code_id, poRequired: c.po_required, notes: c.notes, status: c.status
    },
    invoices: (invoices.data || []).map((i: any) => ({ id: i.id, kind: i.kind, number: i.number, date: i.invoice_date, dueDate: i.due_date, total: Number(i.total),
      status: i.status, reference: i.reference, type: i.invoice_type, owing: bal.get(i.id) ?? (i.status === "draft" ? Number(i.total) : 0) })),
    quotes: (quotes.data || []).map((q: any) => ({ id: q.id, number: q.number, date: q.quote_date, expiryDate: q.expiry_date, title: q.title, total: Number(q.total), status: q.status })),
    payments: (payments.data || []).map((p: any) => ({ id: p.id, date: p.payment_date, amount: Number(p.amount), reference: p.reference, method: p.method, status: p.status,
      unallocated: p.status === "posted" ? unalloc.get(p.id) ?? Number(p.amount) : 0 })),
    attachments: files,
    can: { manage: has(actor, "sales.manage"), bank: has(actor, "bank.manage") }
  };
}

async function paymentUnallocated(admin: Client, ids: string[]) {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const [{ data: pays }, { data: allocs }] = await Promise.all([
    admin.from("customer_payments").select("id,amount").in("id", ids),
    admin.from("receivable_allocations").select("payment_id,amount").in("payment_id", ids).is("voided_at", null)
  ]);
  for (const p of pays || []) out.set(p.id, cents(p.amount));
  for (const a of allocs || []) out.set(a.payment_id, (out.get(a.payment_id) || 0) - cents(a.amount));
  for (const [k, v] of out) out.set(k, dollars(v));
  return out;
}

async function customerSave(admin: Client, actor: Actor, body: any) {
  const name = text(body.name, 160);
  if (name.length < 2) throw httpError(400, "Give the customer a name.");
  const terms = body.termsDays === "" || body.termsDays == null ? null : Number(body.termsDays);
  if (terms != null && (!Number.isInteger(terms) || terms < 0 || terms > 180)) throw httpError(400, "Payment terms are 0 to 180 days.");
  const limit = body.creditLimit === "" || body.creditLimit == null ? null : Number(String(body.creditLimit).replace(/[$,]/g, ""));
  if (limit != null && (!Number.isFinite(limit) || limit < 0)) throw httpError(400, "The credit limit must be a positive amount.");
  const email = text(body.email, 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "That email address doesn't look right.");
  const id = await rpc<string>(admin, "customer_save", {
    p_actor: actor.id, p_id: optUuid(body.id),
    p: {
      name, trading_name: text(body.tradingName, 160), abn: text(body.abn, 20).replace(/\s/g, ""), contact_name: text(body.contactName, 120), email,
      phone: text(body.phone, 30), billing_address: cleanAddress(body.billingAddress), site_address: cleanAddress(body.siteAddress),
      payment_terms_days: terms == null ? "" : String(terms), credit_limit: limit == null ? "" : String(limit),
      default_revenue_account_id: optUuid(body.revenueAccountId) || "", default_tax_code_id: optUuid(body.taxCodeId) || "",
      po_required: body.poRequired === true, notes: text(body.notes, 2000), status: body.status === "archived" ? "archived" : "active"
    }
  });
  return { id };
}

/* ---------------- Quotes ---------------- */

async function quotesList(admin: Client, actor: Actor, body: any) {
  let q = admin.from("quotes").select("id,number,quote_date,expiry_date,title,total,status,customer_id,customers(name)")
    .eq("organization_id", actor.organization_id).order("quote_date", { ascending: false }).order("number", { ascending: false }).limit(300);
  if (["draft", "approved", "sent", "accepted", "declined", "converted", "cancelled"].includes(body.status)) q = q.eq("status", body.status);
  if (optUuid(body.customerId)) q = q.eq("customer_id", body.customerId);
  if (body.search) q = q.ilike("title", `%${String(body.search).replace(/[%*]/g, "").slice(0, 60)}%`);
  const { data, error } = await q;
  if (error) throw httpError(500, "Quotes could not be loaded.");
  const today = todaySydney();
  return {
    quotes: data.map((x: any) => ({ id: x.id, number: x.number, date: x.quote_date, expiryDate: x.expiry_date, title: x.title, total: Number(x.total),
      status: x.status, customer: x.customers?.name || "", customerId: x.customer_id,
      expired: Boolean(x.expiry_date && x.expiry_date < today && ["draft", "approved", "sent"].includes(x.status)) }))
  };
}

async function quoteGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Quote");
  const { data: q } = await admin.from("quotes").select("*,quote_lines(*),customers(name)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!q) throw httpError(404, "Quote not found.");
  const [lk, who, inv, files] = await Promise.all([
    lookups(admin, actor), names(admin, [q.created_by, q.approved_by]),
    q.converted_invoice_id ? admin.from("invoices").select("id,number").eq("id", q.converted_invoice_id).maybeSingle() : Promise.resolve({ data: null }),
    attachmentsFor(admin, actor, "quote", id)
  ]);
  const today = todaySydney();
  return {
    quote: { id: q.id, number: q.number, customerId: q.customer_id, customer: q.customers?.name, date: q.quote_date, expiryDate: q.expiry_date, title: q.title,
      scope: q.scope, reference: q.reference, terms: q.terms, amountsAre: q.amounts_are, subtotal: Number(q.subtotal), gst: Number(q.gst), total: Number(q.total),
      status: q.status, expired: Boolean(q.expiry_date && q.expiry_date < today && ["draft", "approved", "sent"].includes(q.status)),
      createdBy: who.get(q.created_by) || null, approvedBy: who.get(q.approved_by) || null, approvedAt: q.approved_at, sentAt: q.sent_at,
      invoice: (inv as any).data ? { id: (inv as any).data.id, number: (inv as any).data.number } : null },
    lines: mapLines(q.quote_lines, lk.codeMap, lk.accountMap, lk),
    attachments: files,
    can: { edit: q.status === "draft" && has(actor, "sales.manage"), manage: has(actor, "sales.manage") }
  };
}

async function quoteSave(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "quote_save", {
    p_actor: actor.id, p_id: optUuid(body.id),
    p: { customer_id: uuid(body.customerId, "Customer"), quote_date: date(body.date, "The quote date"), expiry_date: optDate(body.expiryDate) || "",
      title: text(body.title, 200), scope: text(body.scope, 5000), reference: text(body.reference, 120), terms: text(body.terms, 3000), amounts_are: amountsAre(body.amountsAre) },
    p_lines: cleanDocLines(body.lines)
  });
  return { id };
}

async function quoteStatus(admin: Client, actor: Actor, body: any) {
  if (!["approved", "sent", "accepted", "declined", "cancelled", "draft"].includes(body.status)) throw httpError(400, "Choose a quote status.");
  await rpc(admin, "quote_set_status", { p_actor: actor.id, p_id: uuid(body.id, "Quote"), p_status: body.status });
  return { saved: true };
}

/** A new draft invoice carrying the quote's lines (the quote converts when it is approved). */
async function quoteToInvoice(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Quote");
  const { data: q } = await admin.from("quotes").select("*,quote_lines(*)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!q) throw httpError(404, "Quote not found.");
  if (!["approved", "sent", "accepted"].includes(q.status)) throw httpError(409, "Only an approved, sent or accepted quote can be invoiced.");
  const { data: existing } = await admin.from("invoices").select("id,number").eq("quote_id", id).eq("organization_id", actor.organization_id).neq("status", "void").limit(1);
  if (existing?.length) throw httpError(409, `An invoice${existing[0].number ? ` (${existing[0].number})` : " draft"} has already been created from this quote.`);
  const lines = (q.quote_lines || []).sort((a: any, b: any) => a.line_no - b.line_no).map((l: any) => ({
    description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unit_price, discountPercent: l.discount_percent,
    accountId: l.account_id, taxCodeId: l.tax_code_id, kind: l.line_kind, projectId: l.project_id
  }));
  const invoiceId = await rpc<string>(admin, "invoice_save", {
    p_actor: actor.id, p_id: null,
    p: { kind: "invoice", customer_id: q.customer_id, invoice_date: todaySydney(), quote_id: q.id, reference: q.reference || "", amounts_are: q.amounts_are,
      invoice_type: "standard", notes: q.title ? `Quote ${q.number}: ${q.title}` : `Quote ${q.number}`, terms: q.terms || "" },
    p_lines: lines
  });
  return { id: invoiceId };
}

/* ---------------- Invoices and credit notes ---------------- */

async function invoicesList(admin: Client, actor: Actor, body: any) {
  const kind = body.kind === "credit_note" ? "credit_note" : "invoice";
  let q = admin.from("invoices").select("id,kind,number,invoice_date,due_date,reference,invoice_type,total,status,sent_at,customer_id,customers(name)")
    .eq("organization_id", actor.organization_id).eq("kind", kind).order("invoice_date", { ascending: false }).order("created_at", { ascending: false }).limit(1000);
  const view = String(body.view || "all");
  if (view === "draft") q = q.eq("status", "draft");
  else if (view === "void") q = q.eq("status", "void");
  else if (["unpaid", "overdue", "paid"].includes(view)) q = q.eq("status", "approved");
  if (optUuid(body.customerId)) q = q.eq("customer_id", body.customerId);
  if (body.from && optDate(body.from)) q = q.gte("invoice_date", body.from);
  if (body.to && optDate(body.to)) q = q.lte("invoice_date", body.to);
  if (body.search) q = q.ilike("number", `%${String(body.search).replace(/[%*]/g, "").slice(0, 40)}%`);
  const [{ data, error }, bal] = await Promise.all([q, balances(admin, actor)]);
  if (error) throw httpError(500, "Invoices could not be loaded.");
  const today = todaySydney();
  let rows = data.map((i: any) => {
    const owing = i.status === "approved" ? bal.get(i.id) ?? Number(i.total) : i.status === "draft" ? Number(i.total) : 0;
    return { id: i.id, kind: i.kind, number: i.number, date: i.invoice_date, dueDate: i.due_date, reference: i.reference, type: i.invoice_type, total: Number(i.total),
      status: i.status, sent: Boolean(i.sent_at), customer: i.customers?.name || "", customerId: i.customer_id, owing,
      overdue: i.kind === "invoice" && i.status === "approved" && owing > 0 && i.due_date < today, daysOverdue: i.status === "approved" && owing > 0 && i.due_date < today
        ? Math.round((Date.parse(today) - Date.parse(i.due_date)) / 86400000) : 0 };
  });
  if (view === "unpaid") rows = rows.filter((r: any) => r.owing > 0);
  if (view === "overdue") rows = rows.filter((r: any) => r.overdue);
  if (view === "paid") rows = rows.filter((r: any) => r.owing === 0);
  const page = Math.max(1, Number(body.page) || 1);
  const totals = { count: rows.length, total: dollars(rows.reduce((s: number, r: any) => s + cents(r.total), 0)), owing: dollars(rows.reduce((s: number, r: any) => s + cents(r.owing), 0)) };
  return { page, pageSize: 50, total: rows.length, totals, invoices: rows.slice((page - 1) * 50, page * 50) };
}

async function loadInvoice(admin: Client, actor: Actor, id: string) {
  const { data } = await admin.from("invoices").select("*,invoice_lines(*),customers(*)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!data) throw httpError(404, "Invoice not found.");
  return data;
}

async function invoiceGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Invoice");
  const inv = await loadInvoice(admin, actor, id);
  const credit = inv.kind === "credit_note";
  const [lk, allocs, who, links, files, bal] = await Promise.all([
    lookups(admin, actor),
    admin.from("receivable_allocations").select("id,invoice_id,payment_id,credit_note_id,amount,allocation_date,voided_at")
      .eq(credit ? "credit_note_id" : "invoice_id", id).is("voided_at", null).order("allocation_date"),
    names(admin, [inv.created_by, inv.approved_by]),
    admin.from("journal_entries").select("id,number").in("id", [inv.journal_id, inv.void_journal_id].filter(Boolean).length ? [inv.journal_id, inv.void_journal_id].filter(Boolean) : ["00000000-0000-0000-0000-000000000000"]),
    attachmentsFor(admin, actor, "invoice", id),
    balances(admin, actor)
  ]);
  const jn = new Map((links.data || []).map((j: any) => [j.id, j.number]));
  const otherIds = (allocs.data || []).map((a: any) => credit ? a.invoice_id : a.credit_note_id).filter(Boolean);
  const payIds = (allocs.data || []).map((a: any) => a.payment_id).filter(Boolean);
  const [others, pays] = await Promise.all([
    otherIds.length ? admin.from("invoices").select("id,number").in("id", otherIds) : Promise.resolve({ data: [] }),
    payIds.length ? admin.from("customer_payments").select("id,reference,payment_date,method").in("id", payIds) : Promise.resolve({ data: [] })
  ]);
  const otherMap = new Map(((others as any).data || []).map((x: any) => [x.id, x.number]));
  const payMap = new Map(((pays as any).data || []).map((x: any) => [x.id, x]));
  const owing = inv.status === "approved" ? bal.get(id) ?? Number(inv.total) : inv.status === "draft" ? Number(inv.total) : 0;

  // Money that could be applied to this invoice: open credit notes and receipts with money left.
  let available: any[] = [];
  if (!credit && inv.status === "approved" && owing > 0) {
    const [credits, receipts] = await Promise.all([
      admin.from("invoices").select("id,number,invoice_date,total").eq("customer_id", inv.customer_id).eq("kind", "credit_note").eq("status", "approved"),
      admin.from("customer_payments").select("id,reference,payment_date,amount").eq("customer_id", inv.customer_id).eq("status", "posted")
    ]);
    const un = await paymentUnallocated(admin, (receipts.data || []).map((r: any) => r.id));
    available = [
      ...(credits.data || []).filter((c: any) => (bal.get(c.id) ?? 0) > 0).map((c: any) => ({ kind: "credit_note", id: c.id, label: `Credit note ${c.number}`, date: c.invoice_date, available: bal.get(c.id) })),
      ...(receipts.data || []).filter((r: any) => (un.get(r.id) ?? 0) > 0).map((r: any) => ({ kind: "payment", id: r.id, label: `Receipt ${r.reference || r.payment_date}`, date: r.payment_date, available: un.get(r.id) }))
    ];
  }
  const c = inv.customers || {};
  return {
    invoice: {
      id: inv.id, kind: inv.kind, number: inv.number, customerId: inv.customer_id, customer: c.name, customerAbn: c.abn, customerEmail: c.email,
      date: inv.invoice_date, dueDate: inv.due_date, reference: inv.reference, type: inv.invoice_type, quoteId: inv.quote_id, originalInvoiceId: inv.original_invoice_id,
      amountsAre: inv.amounts_are, subtotal: Number(inv.subtotal), gst: Number(inv.gst), total: Number(inv.total), notes: inv.notes, terms: inv.terms, status: inv.status,
      owing, paid: dollars(cents(inv.total) - cents(owing)), sentAt: inv.sent_at, voidReason: inv.void_reason,
      journal: inv.journal_id ? { id: inv.journal_id, number: jn.get(inv.journal_id) } : null,
      voidJournal: inv.void_journal_id ? { id: inv.void_journal_id, number: jn.get(inv.void_journal_id) } : null,
      createdBy: who.get(inv.created_by) || null, approvedBy: who.get(inv.approved_by) || null, approvedAt: inv.approved_at
    },
    lines: mapLines(inv.invoice_lines, lk.codeMap, lk.accountMap, lk),
    allocations: (allocs.data || []).map((a: any) => ({
      id: a.id, date: a.allocation_date, amount: Number(a.amount),
      source: a.payment_id ? `Receipt ${(payMap.get(a.payment_id) as any)?.reference || ""}`.trim() : credit ? `Invoice ${otherMap.get(a.invoice_id) || ""}` : `Credit note ${otherMap.get(a.credit_note_id) || ""}`,
      paymentId: a.payment_id, invoiceId: credit ? a.invoice_id : null, creditNoteId: credit ? null : a.credit_note_id
    })),
    available,
    attachments: files,
    can: {
      edit: inv.status === "draft" && has(actor, "sales.manage"),
      approve: inv.status === "draft" && has(actor, "sales.manage"),
      void: inv.status === "approved" && has(actor, "sales.manage"),
      receive: !credit && inv.status === "approved" && owing > 0 && has(actor, "bank.manage"),
      apply: inv.status === "approved" && owing > 0 && has(actor, "sales.manage"),
      allocate: has(actor, "bank.manage")
    }
  };
}

async function invoiceSave(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "invoice_save", {
    p_actor: actor.id, p_id: optUuid(body.id),
    p: {
      kind: body.kind === "credit_note" ? "credit_note" : "invoice", customer_id: uuid(body.customerId, "Customer"), invoice_date: date(body.date, "The invoice date"),
      due_date: optDate(body.dueDate) || "", reference: text(body.reference, 120), invoice_type: INVOICE_TYPES.includes(body.type) ? body.type : "standard",
      quote_id: optUuid(body.quoteId) || "", original_invoice_id: optUuid(body.originalInvoiceId) || "", amounts_are: amountsAre(body.amountsAre),
      notes: text(body.notes, 3000), terms: text(body.terms, 3000)
    },
    p_lines: cleanDocLines(body.lines)
  });
  if (body.approve === true) {
    try {
      const number = await rpc<string>(admin, "invoice_approve", { p_actor: actor.id, p_id: id });
      return { id, number, status: "approved" };
    } catch (error: any) {
      if (Number(error?.status) >= 500) throw error;
      return { id, status: "draft", approveError: error?.message || "The invoice could not be approved." };
    }
  }
  return { id, status: "draft" };
}

async function invoiceApprove(admin: Client, actor: Actor, body: any) {
  return { number: await rpc<string>(admin, "invoice_approve", { p_actor: actor.id, p_id: uuid(body.id, "Invoice") }) };
}
async function invoiceVoid(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "invoice_void", { p_actor: actor.id, p_id: uuid(body.id, "Invoice"), p_reason: text(body.reason, 300) });
  return { saved: true };
}
async function invoiceMarkSent(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "invoice_mark_sent", { p_actor: actor.id, p_id: uuid(body.id, "Invoice") });
  return { saved: true };
}

async function invoicePdf(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Invoice");
  const inv = await loadInvoice(admin, actor, id);
  const [ctx, lk, bal, orig] = await Promise.all([
    sellerContext(admin, actor), lookups(admin, actor), balances(admin, actor),
    inv.original_invoice_id ? admin.from("invoices").select("number").eq("id", inv.original_invoice_id).eq("organization_id", actor.organization_id).maybeSingle() : Promise.resolve({ data: null })
  ]);
  const c = inv.customers || {};
  const owing = inv.status === "approved" ? bal.get(id) ?? Number(inv.total) : Number(inv.total);
  const lines = mapLines(inv.invoice_lines, lk.codeMap, lk.accountMap, lk);
  const bytes = await createFinanceDocumentPdf({
    kind: inv.kind, gstRegistered: ctx.gstRegistered, seller: ctx.seller, logo: ctx.logo,
    to: { name: c.name, abn: c.abn, address: c.billing_address, email: c.email, contact: c.contact_name },
    number: inv.number || "DRAFT", date: inv.invoice_date, dueDate: inv.due_date, reference: inv.reference, originalNumber: (orig as any).data?.number || null,
    amountsAre: inv.amounts_are, lines, subtotal: Number(inv.subtotal), gst: Number(inv.gst), total: Number(inv.total),
    paid: inv.kind === "invoice" && inv.status === "approved" ? dollars(cents(inv.total) - cents(owing)) : 0,
    balance: inv.kind === "invoice" && inv.status === "approved" ? owing : null,
    bank: ctx.bank, notes: inv.notes, terms: inv.terms, status: inv.status
  });
  await auditPdf(admin, actor, "invoice", id, inv.number || "draft");
  const prefix = inv.kind === "credit_note" ? "Adjustment-note" : "Tax-invoice";
  return { fileName: `${prefix}-${inv.number || "draft"}.pdf`, base64: toBase64(bytes) };
}

async function quotePdf(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Quote");
  const { data: q } = await admin.from("quotes").select("*,quote_lines(*),customers(*)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!q) throw httpError(404, "Quote not found.");
  const [ctx, lk] = await Promise.all([sellerContext(admin, actor), lookups(admin, actor)]);
  const c = q.customers || {};
  const bytes = await createFinanceDocumentPdf({
    kind: "quote", gstRegistered: ctx.gstRegistered, seller: ctx.seller, logo: ctx.logo,
    to: { name: c.name, abn: c.abn, address: c.site_address?.street ? c.site_address : c.billing_address, email: c.email, contact: c.contact_name },
    number: q.number, date: q.quote_date, expiryDate: q.expiry_date, reference: q.reference, title: q.title, scope: q.scope, amountsAre: q.amounts_are,
    lines: mapLines(q.quote_lines, lk.codeMap, lk.accountMap, lk), subtotal: Number(q.subtotal), gst: Number(q.gst), total: Number(q.total), terms: q.terms,
    status: q.status === "draft" ? "draft" : "approved"
  });
  await auditPdf(admin, actor, "quote", id, q.number);
  return { fileName: `Quote-${q.number}.pdf`, base64: toBase64(bytes) };
}

async function creditApply(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "credit_note_apply", {
    p_actor: actor.id, p_credit: uuid(body.creditNoteId, "Credit note"), p_invoice: uuid(body.invoiceId, "Invoice"),
    p_amount: amount(body.amount, "The amount"), p_date: optDate(body.date)
  });
  return { saved: true };
}

/* ---------------- Receipts ---------------- */

async function receiptsList(admin: Client, actor: Actor, body: any) {
  let q = admin.from("customer_payments").select("id,payment_date,amount,reference,method,status,customer_id,bank_account_id,customers(name)")
    .eq("organization_id", actor.organization_id).order("payment_date", { ascending: false }).limit(300);
  if (optUuid(body.customerId)) q = q.eq("customer_id", body.customerId);
  const { data, error } = await q;
  if (error) throw httpError(500, "Receipts could not be loaded.");
  const un = await paymentUnallocated(admin, data.filter((p: any) => p.status === "posted").map((p: any) => p.id));
  return { receipts: data.map((p: any) => ({ id: p.id, date: p.payment_date, amount: Number(p.amount), reference: p.reference, method: p.method, status: p.status,
    customer: p.customers?.name || "", customerId: p.customer_id, unallocated: p.status === "posted" ? un.get(p.id) ?? Number(p.amount) : 0 })) };
}

async function receiptGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Receipt");
  const { data: p } = await admin.from("customer_payments").select("*,customers(name)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!p) throw httpError(404, "Receipt not found.");
  const [allocs, bank, journals, who] = await Promise.all([
    admin.from("receivable_allocations").select("id,invoice_id,amount,allocation_date,voided_at").eq("payment_id", id).order("allocation_date"),
    admin.from("accounts").select("code,name").eq("id", p.bank_account_id).maybeSingle(),
    admin.from("journal_entries").select("id,number").in("id", [p.journal_id, p.void_journal_id].filter(Boolean).length ? [p.journal_id, p.void_journal_id].filter(Boolean) : ["00000000-0000-0000-0000-000000000000"]),
    names(admin, [p.created_by])
  ]);
  const invIds = (allocs.data || []).map((a: any) => a.invoice_id);
  const invs = invIds.length ? await admin.from("invoices").select("id,number").in("id", invIds) : { data: [] };
  const num = new Map(((invs as any).data || []).map((x: any) => [x.id, x.number]));
  const jn = new Map((journals.data || []).map((j: any) => [j.id, j.number]));
  const unalloc = p.status === "posted" ? (await paymentUnallocated(admin, [id])).get(id) ?? 0 : 0;
  let open: any[] = [];
  if (unalloc > 0) {
    const [list, bal] = await Promise.all([
      admin.from("invoices").select("id,number,due_date,total").eq("customer_id", p.customer_id).eq("kind", "invoice").eq("status", "approved").order("due_date"),
      balances(admin, actor)
    ]);
    open = (list.data || []).map((i: any) => ({ id: i.id, number: i.number, dueDate: i.due_date, owing: bal.get(i.id) ?? 0 })).filter((i: any) => i.owing > 0);
  }
  return {
    receipt: { id: p.id, customerId: p.customer_id, customer: p.customers?.name, date: p.payment_date, amount: Number(p.amount), reference: p.reference, method: p.method,
      status: p.status, bank: bank.data ? `${bank.data.code} ${bank.data.name}` : null, unallocated: unalloc, voidReason: p.void_reason, createdBy: who.get(p.created_by) || null,
      journal: p.journal_id ? { id: p.journal_id, number: jn.get(p.journal_id) } : null, voidJournal: p.void_journal_id ? { id: p.void_journal_id, number: jn.get(p.void_journal_id) } : null },
    allocations: (allocs.data || []).map((a: any) => ({ id: a.id, invoiceId: a.invoice_id, number: num.get(a.invoice_id), amount: Number(a.amount), date: a.allocation_date, voided: Boolean(a.voided_at) })),
    openInvoices: open,
    can: { void: p.status === "posted" && has(actor, "bank.manage"), allocate: unalloc > 0 && has(actor, "bank.manage") }
  };
}

async function receiptRecord(admin: Client, actor: Actor, body: any) {
  const allocations = (Array.isArray(body.allocations) ? body.allocations : []).filter((a: any) => Number(a?.amount) > 0)
    .map((a: any) => ({ invoiceId: uuid(a.invoiceId, "Invoice"), amount: amount(a.amount, "Each amount applied") }));
  const id = await rpc<string>(admin, "customer_payment_record", {
    p_actor: actor.id, p_customer: uuid(body.customerId, "Customer"), p_date: date(body.date, "The date received"), p_amount: amount(body.amount, "The amount received"),
    p_bank: uuid(body.bankAccountId, "Bank account"), p_reference: text(body.reference, 120), p_method: METHODS.includes(body.method) ? body.method : "bank_transfer",
    p_allocations: allocations
  });
  return { id };
}

async function receiptAllocate(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "customer_payment_allocate", { p_actor: actor.id, p_payment: uuid(body.paymentId, "Receipt"), p_invoice: uuid(body.invoiceId, "Invoice"),
    p_amount: amount(body.amount, "The amount") });
  return { saved: true };
}

async function receiptVoid(admin: Client, actor: Actor, body: any) {
  const reason = text(body.reason, 300);
  if (reason.length < 3) throw httpError(400, "Say why the receipt is being voided.");
  await rpc(admin, "customer_payment_void", { p_actor: actor.id, p_id: uuid(body.id, "Receipt"), p_reason: reason });
  return { saved: true };
}

/* ---------------- Ageing and statements ---------------- */

async function agedReceivables(admin: Client, actor: Actor, body: any) {
  return await rpc(admin, "report_aged_receivables", { p_actor: actor.id, p_as_at: optDate(body.asAt) || todaySydney() });
}

async function customerStatement(admin: Client, actor: Actor, body: any) {
  const customerId = uuid(body.customerId, "Customer");
  const to = optDate(body.to) || todaySydney();
  const from = optDate(body.from) || `${to.slice(0, 8)}01`;
  if (from > to) throw httpError(400, "The start date must be before the end date.");
  const st = await rpc<any>(admin, "report_customer_statement", { p_actor: actor.id, p_customer: customerId, p_from: from, p_to: to });
  const aged = await rpc<any>(admin, "report_aged_receivables", { p_actor: actor.id, p_as_at: to });
  const row = (aged.rows || []).find((r: any) => r.customerId === customerId) || null;
  const ageing = row ? { current: Number(row.current), days30: Number(row.days30), days60: Number(row.days60), days90: Number(row.days90), over90: Number(row.over90), credits: Number(row.credits) } : null;
  if (body.pdf !== true) return { ...st, ageing };
  const ctx = await sellerContext(admin, actor);
  const bytes = await createStatementPdf({
    seller: ctx.seller, logo: ctx.logo, customer: { name: st.customer.name, abn: st.customer.abn, address: st.customer.address },
    from, to, openingBalance: Number(st.openingBalance), closingBalance: Number(st.closingBalance),
    rows: (st.rows || []).map((r: any) => ({ date: r.date, reference: r.reference, type: r.type, amount: Number(r.amount) })),
    openInvoices: st.openInvoices || [], ageing, bank: ctx.bank
  });
  await auditPdf(admin, actor, "customer", customerId, `statement ${from} to ${to}`);
  return { fileName: `Statement-${st.customer.name.replace(/[^A-Za-z0-9]+/g, "-")}-${to}.pdf`, base64: toBase64(bytes) };
}

/** Headline sales figures for the dashboard. */
export async function salesHeadlines(admin: Client, actor: Actor) {
  if (!SALES_READ.some(k => has(actor, k))) return null;
  const today = todaySydney();
  const [aged, drafts] = await Promise.all([
    rpc<any>(admin, "report_aged_receivables", { p_actor: actor.id, p_as_at: today }),
    admin.from("invoices").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).eq("status", "draft")
  ]);
  const t = aged.totals || {};
  return { owed: Number(t.total || 0), overdue: dollars(cents(t.days30) + cents(t.days60) + cents(t.days90) + cents(t.over90)), draftInvoices: drafts.count ?? 0 };
}

export const salesActions: Record<string, { perm: string[] | null; run: Handler }> = {
  sales_setup: { perm: SALES_READ, run: salesSetup },
  customers_list: { perm: SALES_READ, run: customersList },
  customer_get: { perm: SALES_READ, run: customerGet },
  customer_save: { perm: ["sales.manage"], run: customerSave },
  quotes_list: { perm: SALES_READ, run: quotesList },
  quote_get: { perm: SALES_READ, run: quoteGet },
  quote_save: { perm: ["sales.manage"], run: quoteSave },
  quote_status: { perm: ["sales.manage"], run: quoteStatus },
  quote_to_invoice: { perm: ["sales.manage"], run: quoteToInvoice },
  quote_pdf: { perm: SALES_READ, run: quotePdf },
  invoices_list: { perm: SALES_READ, run: invoicesList },
  invoice_get: { perm: SALES_READ, run: invoiceGet },
  invoice_save: { perm: ["sales.manage"], run: invoiceSave },
  invoice_approve: { perm: ["sales.manage"], run: invoiceApprove },
  invoice_void: { perm: ["sales.manage"], run: invoiceVoid },
  invoice_mark_sent: { perm: ["sales.manage"], run: invoiceMarkSent },
  invoice_pdf: { perm: SALES_READ, run: invoicePdf },
  credit_apply: { perm: ["sales.manage"], run: creditApply },
  receipts_list: { perm: SALES_READ, run: receiptsList },
  receipt_get: { perm: SALES_READ, run: receiptGet },
  receipt_record: { perm: ["bank.manage"], run: receiptRecord },
  receipt_allocate: { perm: ["bank.manage"], run: receiptAllocate },
  receipt_void: { perm: ["bank.manage"], run: receiptVoid },
  aged_receivables: { perm: ["reports.view", "sales.manage"], run: agedReceivables },
  customer_statement: { perm: SALES_READ, run: customerStatement }
};
