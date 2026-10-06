// Helpers shared by the sales and purchasing modules: input cleaning,
// cents arithmetic, the seller block and logo for PDFs, attachments.
import { httpError, rpc } from "../_shared/http.ts";
import type { DocInput } from "../_shared/finance-pdf.ts";

export type Client = any;
export type Actor = { id: string; organization_id: string; permissions: string[] };
export type Handler = (admin: Client, actor: Actor, body: any) => Promise<unknown>;

export const BUCKET = "finance-documents";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const has = (a: Actor, k: string) => a.permissions.includes(k);

export function uuid(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID.test(text)) throw httpError(400, `${label} is not valid.`);
  return text;
}
export const optUuid = (v: unknown) => (v && UUID.test(String(v)) ? String(v) : null);
export function date(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!DATE.test(text) || Number.isNaN(Date.parse(text))) throw httpError(400, `${label} must be a date.`);
  return text;
}
export const optDate = (v: unknown) => (v && DATE.test(String(v)) && !Number.isNaN(Date.parse(String(v))) ? String(v) : null);
export const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
export function amount(value: unknown, label: string): number {
  const n = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) {
    throw httpError(400, `${label} must be an amount in dollars and cents.`);
  }
  return Math.round(n * 100) / 100;
}
export const cents = (n: unknown) => Math.round(Number(n || 0) * 100);
export const dollars = (c: number) => Math.round(c) / 100;
export const AMOUNTS = ["exclusive", "inclusive", "no_tax"];
export const amountsAre = (v: unknown) => (AMOUNTS.includes(String(v)) ? String(v) : "exclusive");
export const LINE_KINDS = ["labour", "materials", "equipment", "subcontract", "travel", "consumables", "freight", "other"];

export function cleanDocLines(lines: unknown) {
  if (!Array.isArray(lines) || !lines.length) throw httpError(400, "Add at least one line.");
  if (lines.length > 150) throw httpError(400, "A document can have at most 150 lines.");
  return lines.map((l: any) => ({
    description: text(l?.description, 500),
    quantity: String(l?.quantity ?? "1").replace(/,/g, "") || "1",
    unit: text(l?.unit, 20),
    unitPrice: String(l?.unitPrice ?? "0").replace(/[$,]/g, "") || "0",
    discountPercent: String(l?.discountPercent ?? "0").replace(/%/g, "") || "0",
    accountId: optUuid(l?.accountId),
    taxCodeId: optUuid(l?.taxCodeId),
    kind: LINE_KINDS.includes(l?.kind) ? l.kind : "other",
    poLineId: optUuid(l?.poLineId)
  }));
}

export function mapLines(rows: any[], codes: Map<string, any>, accounts: Map<string, any>) {
  return (rows || []).sort((a, b) => a.line_no - b.line_no).map((l: any) => ({
    id: l.id, lineNo: l.line_no, description: l.description, quantity: Number(l.quantity), unit: l.unit, unitPrice: Number(l.unit_price),
    discountPercent: Number(l.discount_percent), accountId: l.account_id, accountCode: accounts.get(l.account_id)?.code || null,
    accountName: accounts.get(l.account_id)?.name || null, taxCodeId: l.tax_code_id, taxCode: codes.get(l.tax_code_id)?.code || null,
    taxRate: codes.has(l.tax_code_id) ? Number(codes.get(l.tax_code_id).rate) : 0,
    kind: l.line_kind, amount: Number(l.amount), gst: Number(l.gst),
    ...(l.received_quantity != null ? { receivedQuantity: Number(l.received_quantity) } : {}),
    ...(l.po_line_id !== undefined ? { poLineId: l.po_line_id } : {})
  }));
}

export async function lookups(admin: Client, actor: Actor) {
  const [accounts, codes] = await Promise.all([
    admin.from("accounts").select("id,code,name,type,subtype,status,allow_manual,default_tax_code_id").eq("organization_id", actor.organization_id).order("code"),
    admin.from("tax_codes").select("id,code,name,kind,rate,applies_to,active,sort").eq("organization_id", actor.organization_id).order("sort")
  ]);
  if (accounts.error || codes.error) throw httpError(500, "Accounts could not be loaded.");
  return {
    accounts: accounts.data as any[],
    taxCodes: codes.data as any[],
    accountMap: new Map<string, any>(accounts.data.map((a: any) => [a.id, a])),
    codeMap: new Map<string, any>(codes.data.map((t: any) => [t.id, t]))
  };
}

export const accountOption = (a: any) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, defaultTaxCodeId: a.default_tax_code_id });
export const taxOption = (t: any) => ({ id: t.id, code: t.code, name: t.name, kind: t.kind, rate: Number(t.rate), appliesTo: t.applies_to });

export async function names(admin: Client, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, string>();
  const { data } = await admin.from("training_profiles").select("id,full_name,email").in("id", unique);
  return new Map<string, string>((data || []).map((p: any) => [p.id, p.full_name || p.email]));
}

/** Company letterhead, logo and the bank account printed on invoices. */
export async function sellerContext(admin: Client, actor: Actor) {
  const [settings, bank] = await Promise.all([
    admin.from("company_settings").select("legal_name,trading_name,abn,acn,business_address,phone,email,website,gst_registered,logo_document_id,payment_terms_days")
      .eq("organization_id", actor.organization_id).maybeSingle(),
    admin.from("company_bank_accounts").select("account_name,bsb,account_number").eq("organization_id", actor.organization_id)
      .eq("status", "active").eq("show_on_invoices", true).maybeSingle()
  ]);
  const c = settings.data || {};
  let logo: DocInput["logo"] = null;
  if (c.logo_document_id) {
    const doc = await admin.from("documents").select("path,content_type").eq("id", c.logo_document_id).maybeSingle();
    const type = doc.data?.content_type === "image/png" ? "png" : doc.data?.content_type === "image/jpeg" ? "jpg" : null;
    if (type && doc.data?.path) {
      const file = await admin.storage.from(BUCKET).download(doc.data.path);
      if (!file.error && file.data) logo = { bytes: new Uint8Array(await file.data.arrayBuffer()), type };
    }
  }
  return {
    gstRegistered: c.gst_registered !== false,
    seller: { name: c.trading_name || c.legal_name || "", legalName: c.legal_name || "", tradingName: c.trading_name, abn: c.abn, acn: c.acn,
      address: c.business_address, phone: c.phone, email: c.email, website: c.website },
    logo,
    bank: bank.data ? { accountName: bank.data.account_name, bsb: bank.data.bsb, accountNumber: bank.data.account_number } : null
  };
}

const ATTACH_TYPES: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/** Signed upload for an attachment (supplier invoice, remittance, signed PO). */
export async function attachmentPrepare(admin: Client, actor: Actor, body: any) {
  const entityType = String(body.entityType || "");
  if (!["bill", "purchase_order", "supplier", "invoice", "quote", "customer"].includes(entityType)) throw httpError(400, "Attachments are not available here.");
  if (["bill", "purchase_order", "supplier"].includes(entityType) ? !(has(actor, "purchases.manage") || (entityType === "purchase_order" && has(actor, "purchases.raise"))) : !has(actor, "sales.manage")) {
    throw httpError(403, "Your access doesn't include this area. Ask an administrator if you need it.");
  }
  const id = uuid(body.entityId, "Record");
  const name = String(body.fileName || "");
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!ATTACH_TYPES[ext]) throw httpError(400, "Attach a PDF or a photo (JPG, PNG or WebP).");
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 1 || size > 15 * 1024 * 1024) throw httpError(400, "Attachments must be under 15 MB.");
  const safe = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60) || "file";
  const path = `org/${actor.organization_id}/${entityType}/${id}/${Date.now().toString(36)}-${safe}.${ext}`;
  const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false });
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "A secure upload link could not be created.");
  return { path, signedUrl: signed.data.signedUrl, contentType: ATTACH_TYPES[ext] };
}

export async function attachmentAttach(admin: Client, actor: Actor, body: any) {
  const entityType = String(body.entityType || "");
  const id = uuid(body.entityId, "Record");
  const path = String(body.path || "");
  const folder = `org/${actor.organization_id}/${entityType}/${id}`;
  if (!path.startsWith(`${folder}/`)) throw httpError(400, "Invalid upload path.");
  const listed = await admin.storage.from(BUCKET).list(folder, { limit: 1000 });
  const file = (listed.data || []).find((f: any) => f.name === path.split("/").pop());
  if (listed.error || !file) throw httpError(409, "The upload didn't arrive. Please try again.");
  const ext = path.split(".").pop()!.toLowerCase();
  const docId = await rpc<string>(admin, "finance_attach_document", {
    p_actor: actor.id, p_entity_type: entityType, p_entity_id: id, p_path: path, p_file_name: text(body.fileName, 200),
    p_content_type: ATTACH_TYPES[ext], p_size: Number(file?.metadata?.size || body.size || 1)
  });
  return { id: docId };
}

export async function attachmentsFor(admin: Client, actor: Actor, entityType: string, id: string) {
  const { data } = await admin.from("documents").select("id,title,file_name,content_type,size_bytes,uploaded_at,uploaded_by")
    .eq("organization_id", actor.organization_id).eq("entity_type", entityType).eq("entity_id", id).eq("category", "attachment").is("archived_at", null)
    .order("uploaded_at", { ascending: false });
  return (data || []).map((d: any) => ({ id: d.id, fileName: d.file_name || d.title, contentType: d.content_type, size: Number(d.size_bytes), uploadedAt: d.uploaded_at }));
}

export async function attachmentOpen(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Attachment");
  const { data } = await admin.from("documents").select("path,entity_type,file_name").eq("id", id).eq("organization_id", actor.organization_id)
    .eq("category", "attachment").is("archived_at", null).maybeSingle();
  if (!data) throw httpError(404, "Attachment not found.");
  const sales = ["invoice", "quote", "customer"].includes(data.entity_type);
  if (sales ? !(has(actor, "sales.manage") || has(actor, "reports.view")) : !(has(actor, "purchases.manage") || has(actor, "purchases.raise") || has(actor, "reports.view"))) {
    throw httpError(403, "Your access doesn't include this area. Ask an administrator if you need it.");
  }
  const signed = await admin.storage.from(BUCKET).createSignedUrl(data.path, 120);
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "The file could not be opened.");
  return { url: signed.data.signedUrl, fileName: data.file_name };
}

export async function attachmentArchive(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "finance_archive_document", { p_actor: actor.id, p_document: uuid(body.id, "Attachment") });
  return { archived: true };
}

/** Records that a PDF was produced (who downloaded which document). */
export async function auditPdf(admin: Client, actor: Actor, entityType: string, id: string, number: string) {
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "document_pdf_generated", p_entity_type: entityType, p_entity_id: id,
    p_old: null, p_new: null, p_details: { number }, p_subject: null });
}
