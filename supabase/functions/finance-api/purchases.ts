// Phase 3 purchasing: suppliers (bank changes need a second approver),
// purchase orders with goods receipts, bills and supplier credits, supplier
// payments, and aged payables. Approving a bill posts it through the ledger
// engine, including PAYG withholding where a supplier quoted no ABN.
import { httpError, rpc } from "../_shared/http.ts";
import { createFinanceDocumentPdf, toBase64 } from "../_shared/finance-pdf.ts";
import {
  accountOption, amount, amountsAre, attachmentsFor, auditPdf, cents, cleanDocLines, date, dollars, has, lookups, mapLines, names, optDate, optUuid,
  sellerContext, taxOption, text, uuid, type Actor, type Client, type Handler
} from "./docs.ts";
import { todaySydney } from "./ledger.ts";

const PURCH_READ = ["purchases.manage", "purchases.raise", "bank.manage", "reports.view"];
const METHODS = ["bank_transfer", "card", "cheque", "cash", "other"];
const PO_STATUSES = ["draft", "submitted", "approved", "issued", "partially_received", "completed", "cancelled"];
const mask = (n?: string | null) => (n ? `•••${n.slice(-3)}` : null);
const fmtBsb = (b?: string | null) => (b ? `${b.slice(0, 3)}-${b.slice(3)}` : null);

async function balances(admin: Client, actor: Actor) {
  const rows = await rpc<any[]>(admin, "bill_balances", { p_org: actor.organization_id });
  return new Map<string, number>((rows || []).map((r: any) => [r.id, Number(r.owing)]));
}
function cleanAddress(v: any) {
  const a = v && typeof v === "object" ? v : {};
  return { street: text(a.street, 120), street2: text(a.street2, 120), suburb: text(a.suburb, 60), state: text(a.state, 3).toUpperCase(), postcode: text(a.postcode, 4) };
}
const daysUntil = (iso: string | null, today: string) => (iso ? Math.round((Date.parse(iso) - Date.parse(today)) / 86400000) : null);

/* ---------------- Setup and suppliers ---------------- */

async function purchasesSetup(admin: Client, actor: Actor) {
  const [lk, suppliers, rule] = await Promise.all([
    lookups(admin, actor),
    admin.from("suppliers").select("id,name,abn,withholding_exempt,payment_terms_days,default_expense_account_id,default_tax_code_id,is_subcontractor,gst_registered")
      .eq("organization_id", actor.organization_id).eq("status", "active").order("name"),
    rpc<any>(admin, "compliance_value", { p_rule: "no_abn_withholding_rate", p_date: todaySydney() })
  ]);
  return {
    today: todaySydney(),
    noAbnWithholdingRate: rule == null ? null : Number(rule),
    suppliers: (suppliers.data || []).map((s: any) => ({ id: s.id, name: s.name, hasAbn: Boolean(s.abn), withholdingExempt: s.withholding_exempt,
      termsDays: s.payment_terms_days, expenseAccountId: s.default_expense_account_id, taxCodeId: s.default_tax_code_id, subcontractor: s.is_subcontractor,
      gstRegistered: s.gst_registered })),
    accounts: lk.accounts.filter(a => a.status === "active" && a.allow_manual && !["revenue", "other_income", "equity"].includes(a.type)).map(accountOption),
    bankAccounts: lk.accounts.filter(a => a.status === "active" && a.subtype === "bank").map(accountOption),
    taxCodes: lk.taxCodes.filter(t => t.active && t.applies_to !== "sales").map(taxOption),
    can: { manage: has(actor, "purchases.manage"), raise: has(actor, "purchases.raise") || has(actor, "purchases.manage"), bank: has(actor, "bank.manage"),
      approveBank: has(actor, "purchases.bank"), reports: has(actor, "reports.view") }
  };
}

async function suppliersList(admin: Client, actor: Actor, body: any) {
  let q = admin.from("suppliers").select("id,name,trading_name,abn,email,phone,trade_type,is_subcontractor,tpar_reportable,insurance_expiry,licence_expiry,bank_bsb,status")
    .eq("organization_id", actor.organization_id).eq("status", body.status === "archived" ? "archived" : "active").order("name");
  if (body.search) q = q.ilike("name", `%${String(body.search).replace(/[%*]/g, "").slice(0, 60)}%`);
  const [{ data, error }, aged] = await Promise.all([q, rpc<any>(admin, "report_aged_payables", { p_actor: actor.id, p_as_at: todaySydney() })]);
  if (error) throw httpError(500, "Suppliers could not be loaded.");
  const owing = new Map<string, any>((aged.rows || []).map((r: any) => [r.supplierId, r]));
  const today = todaySydney();
  return {
    suppliers: data.map((s: any) => {
      const ins = daysUntil(s.insurance_expiry, today), lic = daysUntil(s.licence_expiry, today);
      return { id: s.id, name: s.name, tradingName: s.trading_name, abn: s.abn, email: s.email, phone: s.phone, tradeType: s.trade_type,
        subcontractor: s.is_subcontractor, tpar: s.tpar_reportable, insuranceExpiry: s.insurance_expiry, licenceExpiry: s.licence_expiry,
        insuranceDays: ins, licenceDays: lic, hasBank: Boolean(s.bank_bsb), status: s.status, balance: owing.has(s.id) ? Number(owing.get(s.id).total) : 0,
        warnings: [
          !s.abn ? "No ABN: 47% must be withheld from payments over $75" : "",
          ins != null && ins < 0 ? "Insurance expired" : ins != null && ins <= 30 ? "Insurance expires within 30 days" : "",
          lic != null && lic < 0 ? "Licence expired" : lic != null && lic <= 30 ? "Licence expires within 30 days" : "",
          s.is_subcontractor && s.insurance_expiry == null ? "No insurance on file" : ""
        ].filter(Boolean) };
    })
  };
}

async function supplierGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Supplier");
  const { data: s } = await admin.from("suppliers").select("*").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!s) throw httpError(404, "Supplier not found.");
  const [bills, pos, pays, bal, pending, files] = await Promise.all([
    admin.from("bills").select("id,kind,number,supplier_reference,bill_date,due_date,total,withholding,status").eq("supplier_id", id).order("bill_date", { ascending: false }).limit(200),
    admin.from("purchase_orders").select("id,number,order_date,total,status").eq("supplier_id", id).order("order_date", { ascending: false }).limit(100),
    admin.from("supplier_payments").select("id,payment_date,amount,reference,status").eq("supplier_id", id).order("payment_date", { ascending: false }).limit(200),
    balances(admin, actor),
    admin.from("approvals").select("id,created_at,requested_by").eq("kind", "supplier_bank").eq("entity_id", id).eq("status", "pending").maybeSingle(),
    attachmentsFor(admin, actor, "supplier", id)
  ]);
  const full = has(actor, "bank.manage") || has(actor, "purchases.bank");
  return {
    supplier: {
      id: s.id, name: s.name, tradingName: s.trading_name, abn: s.abn, withholdingExempt: s.withholding_exempt, gstRegistered: s.gst_registered,
      contactName: s.contact_name, email: s.email, phone: s.phone, address: s.address, termsDays: s.payment_terms_days,
      expenseAccountId: s.default_expense_account_id, taxCodeId: s.default_tax_code_id, tradeType: s.trade_type, subcontractor: s.is_subcontractor,
      tpar: s.tpar_reportable, insuranceExpiry: s.insurance_expiry, licenceExpiry: s.licence_expiry, notes: s.notes, status: s.status,
      bank: s.bank_bsb ? { accountName: s.bank_account_name, bsb: fmtBsb(s.bank_bsb), accountNumber: full ? s.bank_account_number : mask(s.bank_account_number), changedAt: s.bank_changed_at } : null,
      bankChangePending: Boolean(pending.data)
    },
    bills: (bills.data || []).map((b: any) => ({ id: b.id, kind: b.kind, number: b.number, supplierReference: b.supplier_reference, date: b.bill_date, dueDate: b.due_date,
      total: Number(b.total), withholding: Number(b.withholding), status: b.status, owing: b.status === "approved" ? bal.get(b.id) ?? 0 : b.status === "void" ? 0 : Number(b.total) })),
    purchaseOrders: (pos.data || []).map((p: any) => ({ id: p.id, number: p.number, date: p.order_date, total: Number(p.total), status: p.status })),
    payments: (pays.data || []).map((p: any) => ({ id: p.id, date: p.payment_date, amount: Number(p.amount), reference: p.reference, status: p.status })),
    attachments: files,
    can: { manage: has(actor, "purchases.manage"), bank: has(actor, "bank.manage") }
  };
}

async function supplierSave(admin: Client, actor: Actor, body: any) {
  const name = text(body.name, 160);
  if (name.length < 2) throw httpError(400, "Give the supplier a name.");
  const terms = body.termsDays === "" || body.termsDays == null ? null : Number(body.termsDays);
  if (terms != null && (!Number.isInteger(terms) || terms < 0 || terms > 180)) throw httpError(400, "Payment terms are 0 to 180 days.");
  const email = text(body.email, 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "That email address doesn't look right.");
  const id = await rpc<string>(admin, "supplier_save", {
    p_actor: actor.id, p_id: optUuid(body.id),
    p: {
      name, trading_name: text(body.tradingName, 160), abn: text(body.abn, 20).replace(/\s/g, ""), withholding_exempt: body.withholdingExempt === true,
      gst_registered: body.gstRegistered !== false, contact_name: text(body.contactName, 120), email, phone: text(body.phone, 30), address: cleanAddress(body.address),
      payment_terms_days: terms == null ? "" : String(terms), default_expense_account_id: optUuid(body.expenseAccountId) || "", default_tax_code_id: optUuid(body.taxCodeId) || "",
      trade_type: text(body.tradeType, 80), is_subcontractor: body.subcontractor === true, tpar_reportable: body.tpar === true,
      insurance_expiry: optDate(body.insuranceExpiry) || "", licence_expiry: optDate(body.licenceExpiry) || "", notes: text(body.notes, 2000),
      status: body.status === "archived" ? "archived" : "active"
    }
  });
  return { id };
}

async function supplierBankRequest(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "supplier_bank_request", {
    p_actor: actor.id, p_supplier: uuid(body.supplierId, "Supplier"), p_name: text(body.accountName, 120), p_bsb: text(body.bsb, 10), p_account: text(body.accountNumber, 14)
  });
  return { approvalId: id, status: "pending" };
}

/* ---------------- Purchase orders ---------------- */

async function posList(admin: Client, actor: Actor, body: any) {
  let q = admin.from("purchase_orders").select("id,number,order_date,expected_date,reference,total,status,supplier_id,requested_by,suppliers(name)")
    .eq("organization_id", actor.organization_id).order("order_date", { ascending: false }).order("number", { ascending: false }).limit(300);
  if (PO_STATUSES.includes(body.status)) q = q.eq("status", body.status);
  if (body.status === "open") q = q.in("status", ["approved", "issued", "partially_received"]);
  if (optUuid(body.supplierId)) q = q.eq("supplier_id", body.supplierId);
  if (body.search) q = q.ilike("number", `%${String(body.search).replace(/[%*]/g, "").slice(0, 40)}%`);
  const { data, error } = await q;
  if (error) throw httpError(500, "Purchase orders could not be loaded.");
  const who = await names(admin, data.map((p: any) => p.requested_by));
  return { purchaseOrders: data.map((p: any) => ({ id: p.id, number: p.number, date: p.order_date, expectedDate: p.expected_date, reference: p.reference,
    total: Number(p.total), status: p.status, supplier: p.suppliers?.name || "", supplierId: p.supplier_id, requestedBy: who.get(p.requested_by) || null })) };
}

async function poGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Purchase order");
  const { data: p } = await admin.from("purchase_orders").select("*,purchase_order_lines(*),suppliers(name,abn)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!p) throw httpError(404, "Purchase order not found.");
  const [lk, who, bills, files] = await Promise.all([
    lookups(admin, actor), names(admin, [p.requested_by, p.approved_by]),
    admin.from("bills").select("id,number,supplier_reference,total,status").eq("purchase_order_id", id),
    attachmentsFor(admin, actor, "purchase_order", id)
  ]);
  const manage = has(actor, "purchases.manage"), raise = has(actor, "purchases.raise") || manage;
  const billed = (bills.data || []).filter((b: any) => b.status !== "void").reduce((s: number, b: any) => s + cents(b.total), 0);
  return {
    purchaseOrder: { id: p.id, number: p.number, supplierId: p.supplier_id, supplier: p.suppliers?.name, supplierHasAbn: Boolean(p.suppliers?.abn),
      date: p.order_date, expectedDate: p.expected_date, reference: p.reference, deliveryAddress: p.delivery_address, notes: p.notes, amountsAre: p.amounts_are,
      subtotal: Number(p.subtotal), gst: Number(p.gst), total: Number(p.total), status: p.status, billed: dollars(billed),
      requestedBy: who.get(p.requested_by) || null, approvedBy: who.get(p.approved_by) || null, approvedAt: p.approved_at, issuedAt: p.issued_at },
    lines: mapLines(p.purchase_order_lines, lk.codeMap, lk.accountMap),
    bills: (bills.data || []).map((b: any) => ({ id: b.id, number: b.number, supplierReference: b.supplier_reference, total: Number(b.total), status: b.status })),
    attachments: files,
    can: {
      edit: p.status === "draft" && raise, submit: p.status === "draft" && raise,
      approve: p.status === "submitted" && manage, issue: p.status === "approved" && manage,
      receive: ["issued", "partially_received"].includes(p.status) && raise,
      bill: ["approved", "issued", "partially_received", "completed"].includes(p.status) && manage,
      close: ["issued", "partially_received"].includes(p.status) && manage,
      cancel: !["completed", "cancelled"].includes(p.status) && manage
    }
  };
}

async function poSave(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "po_save", {
    p_actor: actor.id, p_id: optUuid(body.id),
    p: { supplier_id: uuid(body.supplierId, "Supplier"), order_date: date(body.date, "The order date"), expected_date: optDate(body.expectedDate) || "",
      reference: text(body.reference, 120), delivery_address: text(body.deliveryAddress, 500), notes: text(body.notes, 3000), amounts_are: amountsAre(body.amountsAre) },
    p_lines: cleanDocLines(body.lines)
  });
  if (body.submit === true) await rpc(admin, "po_set_status", { p_actor: actor.id, p_id: id, p_status: "submitted", p_reason: null });
  return { id };
}

async function poStatus(admin: Client, actor: Actor, body: any) {
  if (!["submitted", "approved", "draft", "issued", "cancelled", "completed"].includes(body.status)) throw httpError(400, "Choose a purchase order status.");
  await rpc(admin, "po_set_status", { p_actor: actor.id, p_id: uuid(body.id, "Purchase order"), p_status: body.status, p_reason: text(body.reason, 300) });
  return { saved: true };
}

async function poReceive(admin: Client, actor: Actor, body: any) {
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((l: any) => ({ lineId: uuid(l?.lineId, "Line"), quantity: Number(l?.quantity) || 0 }))
    .filter((l: any) => l.quantity !== 0);
  if (!lines.length) throw httpError(400, "Enter the quantity received on at least one line.");
  return { status: await rpc<string>(admin, "po_receive", { p_actor: actor.id, p_id: uuid(body.id, "Purchase order"), p_lines: lines }) };
}

async function poPdf(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Purchase order");
  const { data: p } = await admin.from("purchase_orders").select("*,purchase_order_lines(*),suppliers(*)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!p) throw httpError(404, "Purchase order not found.");
  const [ctx, lk] = await Promise.all([sellerContext(admin, actor), lookups(admin, actor)]);
  const s = p.suppliers || {};
  const bytes = await createFinanceDocumentPdf({
    kind: "purchase_order", gstRegistered: ctx.gstRegistered, seller: ctx.seller, logo: ctx.logo,
    to: { name: s.name, abn: s.abn, address: s.address, email: s.email, contact: s.contact_name },
    number: p.number, date: p.order_date, dueDate: p.expected_date, reference: p.reference, deliverTo: p.delivery_address, amountsAre: p.amounts_are,
    lines: mapLines(p.purchase_order_lines, lk.codeMap, lk.accountMap), subtotal: Number(p.subtotal), gst: Number(p.gst), total: Number(p.total), notes: p.notes,
    status: ["draft", "submitted"].includes(p.status) ? "draft" : p.status === "cancelled" ? "void" : "approved"
  });
  await auditPdf(admin, actor, "purchase_order", id, p.number);
  return { fileName: `Purchase-order-${p.number}.pdf`, base64: toBase64(bytes) };
}

/* ---------------- Bills and supplier credits ---------------- */

async function billsList(admin: Client, actor: Actor, body: any) {
  const kind = body.kind === "credit_note" ? "credit_note" : "bill";
  let q = admin.from("bills").select("id,kind,number,supplier_reference,bill_date,due_date,total,withholding,status,supplier_id,purchase_order_id,suppliers(name)")
    .eq("organization_id", actor.organization_id).eq("kind", kind).order("due_date", { ascending: true }).limit(1000);
  const view = String(body.view || "all");
  if (view === "draft") q = q.in("status", ["draft", "submitted"]);
  else if (view === "void") q = q.eq("status", "void");
  else if (["unpaid", "overdue", "paid"].includes(view)) q = q.eq("status", "approved");
  if (optUuid(body.supplierId)) q = q.eq("supplier_id", body.supplierId);
  if (body.search) q = q.ilike("supplier_reference", `%${String(body.search).replace(/[%*]/g, "").slice(0, 40)}%`);
  const [{ data, error }, bal] = await Promise.all([q, balances(admin, actor)]);
  if (error) throw httpError(500, "Bills could not be loaded.");
  const today = todaySydney();
  let rows = data.map((b: any) => {
    const owing = b.status === "approved" ? bal.get(b.id) ?? 0 : b.status === "void" ? 0 : dollars(cents(b.total) - cents(b.withholding));
    return { id: b.id, kind: b.kind, number: b.number, supplierReference: b.supplier_reference, date: b.bill_date, dueDate: b.due_date, total: Number(b.total),
      withholding: Number(b.withholding), status: b.status, supplier: b.suppliers?.name || "", supplierId: b.supplier_id, purchaseOrderId: b.purchase_order_id,
      owing, overdue: b.kind === "bill" && b.status === "approved" && owing > 0 && b.due_date < today };
  });
  if (view === "unpaid") rows = rows.filter((r: any) => r.owing > 0);
  if (view === "overdue") rows = rows.filter((r: any) => r.overdue);
  if (view === "paid") rows = rows.filter((r: any) => r.owing === 0);
  const page = Math.max(1, Number(body.page) || 1);
  const totals = { count: rows.length, total: dollars(rows.reduce((s: number, r: any) => s + cents(r.total), 0)), owing: dollars(rows.reduce((s: number, r: any) => s + cents(r.owing), 0)) };
  return { page, pageSize: 50, total: rows.length, totals, bills: rows.slice((page - 1) * 50, page * 50) };
}

async function billGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Bill");
  const { data: b } = await admin.from("bills").select("*,bill_lines(*),suppliers(name,abn,withholding_exempt)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!b) throw httpError(404, "Bill not found.");
  const credit = b.kind === "credit_note";
  const [lk, who, allocs, po, journals, files, bal] = await Promise.all([
    lookups(admin, actor), names(admin, [b.created_by, b.approved_by]),
    admin.from("payable_allocations").select("id,bill_id,payment_id,credit_note_id,amount,allocation_date").eq(credit ? "credit_note_id" : "bill_id", id).is("voided_at", null).order("allocation_date"),
    b.purchase_order_id ? admin.from("purchase_orders").select("id,number,total,status,purchase_order_lines(id,line_no,description,quantity,received_quantity,unit_price)").eq("id", b.purchase_order_id).maybeSingle() : Promise.resolve({ data: null }),
    admin.from("journal_entries").select("id,number").in("id", [b.journal_id, b.void_journal_id].filter(Boolean).length ? [b.journal_id, b.void_journal_id].filter(Boolean) : ["00000000-0000-0000-0000-000000000000"]),
    attachmentsFor(admin, actor, "bill", id),
    balances(admin, actor)
  ]);
  const jn = new Map((journals.data || []).map((j: any) => [j.id, j.number]));
  const otherIds = (allocs.data || []).map((a: any) => credit ? a.bill_id : a.credit_note_id).filter(Boolean);
  const others = otherIds.length ? await admin.from("bills").select("id,number").in("id", otherIds) : { data: [] };
  const om = new Map(((others as any).data || []).map((x: any) => [x.id, x.number]));
  const owing = b.status === "approved" ? bal.get(id) ?? 0 : b.status === "void" ? 0 : Number(b.total);
  const lines = mapLines(b.bill_lines, lk.codeMap, lk.accountMap);
  // Three-way match: what was ordered and received against what is billed.
  const poData = (po as any).data;
  const match = poData ? {
    id: poData.id, number: poData.number, total: Number(poData.total), status: poData.status,
    differences: (poData.purchase_order_lines || []).sort((x: any, y: any) => x.line_no - y.line_no).map((pl: any) => {
      const billedQty = lines.filter((l: any) => l.poLineId === pl.id).reduce((s: number, l: any) => s + l.quantity, 0);
      const billedPrice = lines.find((l: any) => l.poLineId === pl.id)?.unitPrice ?? null;
      return { description: pl.description, ordered: Number(pl.quantity), received: Number(pl.received_quantity), billed: billedQty,
        orderedPrice: Number(pl.unit_price), billedPrice, ok: billedQty <= Number(pl.received_quantity) && (billedPrice == null || billedPrice <= Number(pl.unit_price)) };
    })
  } : null;
  let available: any[] = [];
  if (!credit && b.status === "approved" && owing > 0) {
    const { data: credits } = await admin.from("bills").select("id,number,supplier_reference,bill_date").eq("supplier_id", b.supplier_id).eq("kind", "credit_note").eq("status", "approved");
    available = (credits || []).filter((c: any) => (bal.get(c.id) ?? 0) > 0).map((c: any) => ({ id: c.id, label: `Credit ${c.supplier_reference || c.number}`, available: bal.get(c.id) }));
  }
  return {
    bill: {
      id: b.id, kind: b.kind, number: b.number, supplierId: b.supplier_id, supplier: b.suppliers?.name, supplierHasAbn: Boolean(b.suppliers?.abn),
      withholdingExempt: b.suppliers?.withholding_exempt, supplierReference: b.supplier_reference, date: b.bill_date, dueDate: b.due_date, purchaseOrderId: b.purchase_order_id,
      amountsAre: b.amounts_are, subtotal: Number(b.subtotal), gst: Number(b.gst), total: Number(b.total), withholding: Number(b.withholding), notes: b.notes,
      status: b.status, owing, voidReason: b.void_reason,
      journal: b.journal_id ? { id: b.journal_id, number: jn.get(b.journal_id) } : null, voidJournal: b.void_journal_id ? { id: b.void_journal_id, number: jn.get(b.void_journal_id) } : null,
      createdBy: who.get(b.created_by) || null, approvedBy: who.get(b.approved_by) || null, approvedAt: b.approved_at
    },
    lines, match,
    allocations: (allocs.data || []).map((a: any) => ({ id: a.id, date: a.allocation_date, amount: Number(a.amount),
      source: a.payment_id ? "Payment" : credit ? `Bill ${om.get(a.bill_id) || ""}` : `Credit ${om.get(a.credit_note_id) || ""}` })),
    available, attachments: files,
    can: {
      edit: ["draft", "submitted"].includes(b.status) && has(actor, "purchases.manage"),
      submit: b.status === "draft" && has(actor, "purchases.manage"),
      approve: ["draft", "submitted"].includes(b.status) && has(actor, "purchases.manage"),
      void: b.status === "approved" && has(actor, "purchases.manage"),
      pay: !credit && b.status === "approved" && owing > 0 && has(actor, "bank.manage"),
      apply: b.status === "approved" && owing > 0 && has(actor, "purchases.manage")
    }
  };
}

async function billSave(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "bill_save", {
    p_actor: actor.id, p_id: optUuid(body.id),
    p: { kind: body.kind === "credit_note" ? "credit_note" : "bill", supplier_id: uuid(body.supplierId, "Supplier"), bill_date: date(body.date, "The bill date"),
      due_date: optDate(body.dueDate) || "", supplier_reference: text(body.supplierReference, 120), purchase_order_id: optUuid(body.purchaseOrderId) || "",
      amounts_are: amountsAre(body.amountsAre), notes: text(body.notes, 3000) },
    p_lines: cleanDocLines(body.lines)
  });
  if (body.then === "submit") await rpc(admin, "bill_submit", { p_actor: actor.id, p_id: id });
  if (body.then === "approve") {
    try {
      await rpc(admin, "bill_approve", { p_actor: actor.id, p_id: id });
      return { id, status: "approved" };
    } catch (error: any) {
      if (Number(error?.status) >= 500) throw error;
      return { id, status: "draft", approveError: error?.message || "The bill could not be approved." };
    }
  }
  return { id, status: body.then === "submit" ? "submitted" : "draft" };
}

/** A draft bill pre-filled from a purchase order's received (not yet billed) quantities. */
async function billFromPo(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.purchaseOrderId, "Purchase order");
  const { data: p } = await admin.from("purchase_orders").select("*,purchase_order_lines(*)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!p) throw httpError(404, "Purchase order not found.");
  const { data: billed } = await admin.from("bill_lines").select("po_line_id,quantity,bills!inner(status,purchase_order_id)").eq("bills.purchase_order_id", id).neq("bills.status", "void");
  const done = new Map<string, number>();
  for (const l of billed || []) if (l.po_line_id) done.set(l.po_line_id, (done.get(l.po_line_id) || 0) + Number(l.quantity));
  // Bill what has been received; if nothing has been receipted yet, what was ordered.
  const anyReceived = (p.purchase_order_lines || []).some((l: any) => Number(l.received_quantity) > 0);
  const lines = (p.purchase_order_lines || []).sort((a: any, b: any) => a.line_no - b.line_no).map((l: any) => {
    const left = Math.max(0, Number(anyReceived ? l.received_quantity : l.quantity) - (done.get(l.id) || 0));
    return { description: l.description, quantity: left, unit: l.unit, unitPrice: l.unit_price, discountPercent: l.discount_percent, accountId: l.account_id,
      taxCodeId: l.tax_code_id, kind: l.line_kind, poLineId: l.id };
  }).filter((l: any) => l.quantity > 0);
  if (!lines.length) throw httpError(409, "Everything on this purchase order has already been billed.");
  return { draft: { supplierId: p.supplier_id, purchaseOrderId: p.id, amountsAre: p.amounts_are, notes: `Purchase order ${p.number}`, lines } };
}

async function billSubmit(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "bill_submit", { p_actor: actor.id, p_id: uuid(body.id, "Bill") });
  return { saved: true };
}
async function billApprove(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "bill_approve", { p_actor: actor.id, p_id: uuid(body.id, "Bill") });
  return { saved: true };
}
async function billVoid(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "bill_void", { p_actor: actor.id, p_id: uuid(body.id, "Bill"), p_reason: text(body.reason, 300) });
  return { saved: true };
}
async function supplierCreditApply(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "supplier_credit_apply", { p_actor: actor.id, p_credit: uuid(body.creditId, "Supplier credit"), p_bill: uuid(body.billId, "Bill"),
    p_amount: amount(body.amount, "The amount"), p_date: optDate(body.date) });
  return { saved: true };
}

/* ---------------- Supplier payments ---------------- */

async function supplierPaymentsList(admin: Client, actor: Actor, body: any) {
  let q = admin.from("supplier_payments").select("id,payment_date,amount,reference,method,status,supplier_id,suppliers(name)")
    .eq("organization_id", actor.organization_id).order("payment_date", { ascending: false }).limit(300);
  if (optUuid(body.supplierId)) q = q.eq("supplier_id", body.supplierId);
  const { data, error } = await q;
  if (error) throw httpError(500, "Payments could not be loaded.");
  return { payments: data.map((p: any) => ({ id: p.id, date: p.payment_date, amount: Number(p.amount), reference: p.reference, method: p.method, status: p.status,
    supplier: p.suppliers?.name || "", supplierId: p.supplier_id })) };
}

async function supplierPaymentGet(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Payment");
  const { data: p } = await admin.from("supplier_payments").select("*,suppliers(name,bank_account_name,bank_bsb,bank_account_number)").eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!p) throw httpError(404, "Payment not found.");
  const [allocs, bank, journals, who] = await Promise.all([
    admin.from("payable_allocations").select("id,bill_id,amount,allocation_date,voided_at").eq("payment_id", id).order("allocation_date"),
    admin.from("accounts").select("code,name").eq("id", p.bank_account_id).maybeSingle(),
    admin.from("journal_entries").select("id,number").in("id", [p.journal_id, p.void_journal_id].filter(Boolean).length ? [p.journal_id, p.void_journal_id].filter(Boolean) : ["00000000-0000-0000-0000-000000000000"]),
    names(admin, [p.created_by])
  ]);
  const ids = (allocs.data || []).map((a: any) => a.bill_id);
  const bills = ids.length ? await admin.from("bills").select("id,number,supplier_reference").in("id", ids) : { data: [] };
  const bm = new Map(((bills as any).data || []).map((b: any) => [b.id, b]));
  const jn = new Map((journals.data || []).map((j: any) => [j.id, j.number]));
  const s = p.suppliers || {};
  const full = has(actor, "bank.manage") || has(actor, "purchases.bank");
  return {
    payment: { id: p.id, supplierId: p.supplier_id, supplier: s.name, date: p.payment_date, amount: Number(p.amount), reference: p.reference, method: p.method, status: p.status,
      bank: bank.data ? `${bank.data.code} ${bank.data.name}` : null, voidReason: p.void_reason, createdBy: who.get(p.created_by) || null,
      payTo: s.bank_bsb ? { accountName: s.bank_account_name, bsb: fmtBsb(s.bank_bsb), accountNumber: full ? s.bank_account_number : mask(s.bank_account_number) } : null,
      journal: p.journal_id ? { id: p.journal_id, number: jn.get(p.journal_id) } : null, voidJournal: p.void_journal_id ? { id: p.void_journal_id, number: jn.get(p.void_journal_id) } : null },
    allocations: (allocs.data || []).map((a: any) => ({ id: a.id, billId: a.bill_id, number: (bm.get(a.bill_id) as any)?.number, supplierReference: (bm.get(a.bill_id) as any)?.supplier_reference,
      amount: Number(a.amount), date: a.allocation_date, voided: Boolean(a.voided_at) })),
    can: { void: p.status === "posted" && has(actor, "bank.manage") }
  };
}

async function supplierPaymentRecord(admin: Client, actor: Actor, body: any) {
  const allocations = (Array.isArray(body.allocations) ? body.allocations : []).filter((a: any) => Number(a?.amount) > 0)
    .map((a: any) => ({ billId: uuid(a.billId, "Bill"), amount: amount(a.amount, "Each amount paid") }));
  if (!allocations.length) throw httpError(400, "Choose the bills to pay and the amounts.");
  const id = await rpc<string>(admin, "supplier_payment_record", {
    p_actor: actor.id, p_supplier: uuid(body.supplierId, "Supplier"), p_date: date(body.date, "The payment date"), p_bank: uuid(body.bankAccountId, "Bank account"),
    p_reference: text(body.reference, 120), p_method: METHODS.includes(body.method) ? body.method : "bank_transfer", p_allocations: allocations
  });
  return { id };
}

async function supplierPaymentVoid(admin: Client, actor: Actor, body: any) {
  const reason = text(body.reason, 300);
  if (reason.length < 3) throw httpError(400, "Say why the payment is being voided.");
  await rpc(admin, "supplier_payment_void", { p_actor: actor.id, p_id: uuid(body.id, "Payment"), p_reason: reason });
  return { saved: true };
}

async function agedPayables(admin: Client, actor: Actor, body: any) {
  return await rpc(admin, "report_aged_payables", { p_actor: actor.id, p_as_at: optDate(body.asAt) || todaySydney() });
}

/** Headline purchasing figures for the dashboard. */
export async function purchasesHeadlines(admin: Client, actor: Actor) {
  if (!PURCH_READ.some(k => has(actor, k))) return null;
  const today = todaySydney();
  const [aged, review, pos] = await Promise.all([
    rpc<any>(admin, "report_aged_payables", { p_actor: actor.id, p_as_at: today }),
    admin.from("bills").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).in("status", ["draft", "submitted"]),
    admin.from("purchase_orders").select("id", { count: "exact", head: true }).eq("organization_id", actor.organization_id).eq("status", "submitted")
  ]);
  const t = aged.totals || {};
  return { owing: Number(t.total || 0), overdue: dollars(cents(t.days30) + cents(t.days60) + cents(t.days90) + cents(t.over90)),
    billsToReview: review.count ?? 0, ordersToApprove: pos.count ?? 0 };
}

export const purchasesActions: Record<string, { perm: string[] | null; run: Handler }> = {
  purchases_setup: { perm: PURCH_READ, run: purchasesSetup },
  suppliers_list: { perm: PURCH_READ, run: suppliersList },
  supplier_get: { perm: PURCH_READ, run: supplierGet },
  supplier_save: { perm: ["purchases.manage"], run: supplierSave },
  supplier_bank_request: { perm: ["purchases.manage"], run: supplierBankRequest },
  pos_list: { perm: PURCH_READ, run: posList },
  po_get: { perm: PURCH_READ, run: poGet },
  po_save: { perm: ["purchases.raise", "purchases.manage"], run: poSave },
  po_status: { perm: ["purchases.raise", "purchases.manage"], run: poStatus },
  po_receive: { perm: ["purchases.raise", "purchases.manage"], run: poReceive },
  po_pdf: { perm: PURCH_READ, run: poPdf },
  bills_list: { perm: PURCH_READ, run: billsList },
  bill_get: { perm: PURCH_READ, run: billGet },
  bill_save: { perm: ["purchases.manage"], run: billSave },
  bill_from_po: { perm: ["purchases.manage"], run: billFromPo },
  bill_submit: { perm: ["purchases.manage"], run: billSubmit },
  bill_approve: { perm: ["purchases.manage"], run: billApprove },
  bill_void: { perm: ["purchases.manage"], run: billVoid },
  supplier_credit_apply: { perm: ["purchases.manage"], run: supplierCreditApply },
  supplier_payments_list: { perm: PURCH_READ, run: supplierPaymentsList },
  supplier_payment_get: { perm: PURCH_READ, run: supplierPaymentGet },
  supplier_payment_record: { perm: ["bank.manage"], run: supplierPaymentRecord },
  supplier_payment_void: { perm: ["bank.manage"], run: supplierPaymentVoid },
  aged_payables: { perm: ["reports.view", "purchases.manage"], run: agedPayables }
};
