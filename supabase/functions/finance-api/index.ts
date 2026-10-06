// Panalo Accounts API (foundation, ledger, sales and purchasing, projects and timesheets).
// Every request: verified session -> active profile -> effective permissions
// -> MFA (aal2) for anyone holding a privileged key -> the action's permission.
// Every write then goes through a security-definer SQL function that checks
// the permission again and writes the audit row in the same transaction.
import { withSupabase } from "npm:@supabase/server@^1";
import { corsHeaders, errorJson, httpError, json, rpc } from "../_shared/http.ts";
import { ledgerActions, ledgerHeadlines } from "./ledger.ts";
import { salesActions, salesHeadlines } from "./sales.ts";
import { purchasesActions, purchasesHeadlines } from "./purchases.ts";
import { projectsActions, projectsHeadlines } from "./projects.ts";
import { attachmentArchive, attachmentAttach, attachmentOpen, attachmentPrepare } from "./docs.ts";

type Client = any;
type Actor = { id: string; email: string; full_name: string; role: string; organization_id: string; permissions: string[] };
type Handler = (admin: Client, actor: Actor, body: any) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = "finance-documents";
const LOGO_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

function uuid(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID.test(text)) throw httpError(400, `${label} is not valid.`);
  return text;
}
const has = (actor: Actor, key: string) => actor.permissions.includes(key);
function need(actor: Actor, ...keys: string[]) {
  if (!keys.some(k => has(actor, k))) throw httpError(403, "Your access doesn't include this area. Ask an administrator if you need it.");
}

/** The assurance level of the verified session token (aal1 = password, aal2 = password + MFA). */
export function sessionAal(request: Request, claims: any): string {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (part) {
    try {
      const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
      if (payload?.aal) return String(payload.aal);
    } catch (_) { /* fall through */ }
  }
  return String(claims?.aal || "aal1");
}

async function loadActor(admin: Client, userId: string): Promise<Actor & { mustChangePassword: boolean }> {
  const { data, error } = await admin.from("training_profiles")
    .select("id,email,full_name,role,active,must_change_password,organization_id").eq("id", userId).maybeSingle();
  if (error) throw httpError(500, "Profile lookup failed.");
  if (!data?.active) throw httpError(403, "This account is not active.");
  const permissions = await rpc<string[]>(admin, "app_permissions_for", { p_profile: userId });
  return { ...data, permissions: permissions || [], mustChangePassword: Boolean(data.must_change_password) };
}

async function permissionCatalogue(admin: Client) {
  const { data, error } = await admin.from("app_permissions").select("key,name,description,area,requires_mfa,admin_default,sort").order("sort");
  if (error) throw httpError(500, "Permissions could not be loaded.");
  return data as any[];
}

/* ---------------- Company ---------------- */

const maskAccount = (n: string) => `•••• ${n.slice(-3)}`;
const fmtBsb = (b: string) => `${b.slice(0, 3)}-${b.slice(3)}`;

function missingSetup(c: any) {
  const missing: string[] = [];
  if (!c.abn) missing.push("ABN");
  if (!c.business_address?.street || !c.business_address?.postcode) missing.push("business address");
  if (!c.email) missing.push("email");
  if (!c.phone) missing.push("phone");
  if (!(c.states || []).length) missing.push("states you operate in");
  if (!c.payroll_contact?.name) missing.push("payroll contact");
  return missing;
}

async function companyGet(admin: Client, actor: Actor) {
  const [settings, numbering, banks] = await Promise.all([
    admin.from("company_settings").select("*").eq("organization_id", actor.organization_id).maybeSingle(),
    admin.from("number_sequences").select("kind,prefix,next_number,padding").eq("organization_id", actor.organization_id),
    admin.from("company_bank_accounts").select("id,nickname,account_name,bsb,account_number,apca_user_id,purpose,show_on_invoices,status,created_at,activated_at,retired_at")
      .eq("organization_id", actor.organization_id).order("created_at", { ascending: false })
  ]);
  if (settings.error || numbering.error || banks.error) throw httpError(500, "Company settings could not be loaded.");
  const c = settings.data;
  let logoUrl: string | null = null;
  if (c?.logo_document_id) {
    const doc = await admin.from("documents").select("path").eq("id", c.logo_document_id).maybeSingle();
    if (doc.data?.path) {
      const signed = await admin.storage.from(BUCKET).createSignedUrl(doc.data.path, 600);
      logoUrl = signed.data?.signedUrl || null;
    }
  }
  const full = has(actor, "org.manage") || has(actor, "bank.manage");
  return {
    settings: c,
    missing: missingSetup(c || {}),
    logoUrl,
    numbering: numbering.data,
    bankAccounts: banks.data.map((b: any) => ({
      id: b.id, nickname: b.nickname, accountName: b.account_name, bsb: fmtBsb(b.bsb),
      accountNumber: full ? b.account_number : maskAccount(b.account_number), apcaUserId: full ? b.apca_user_id : null,
      purpose: b.purpose, showOnInvoices: b.show_on_invoices, status: b.status, createdAt: b.created_at, activatedAt: b.activated_at, retiredAt: b.retired_at
    })),
    canEdit: has(actor, "org.manage")
  };
}

const SETTING_KEYS = new Set(["legal_name", "trading_name", "abn", "acn", "business_address", "postal_address", "phone", "email", "website",
  "gst_registered", "gst_basis", "bas_frequency", "accounting_basis", "financial_year_start_month", "timezone", "payment_terms_days",
  "pay_frequency", "pay_day", "states", "super_clearing_house", "workers_comp", "payroll_contact"]);

function cleanAddress(v: any) {
  const a = v && typeof v === "object" ? v : {};
  const out: Record<string, string> = {};
  for (const k of ["street", "suburb", "state", "postcode"]) out[k] = String(a[k] ?? "").trim().slice(0, 120);
  if (out.postcode && !/^\d{4}$/.test(out.postcode)) throw httpError(400, "A postcode is 4 digits.");
  if (out.state && !["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"].includes(out.state)) throw httpError(400, "Choose a state.");
  return out;
}

async function companySave(admin: Client, actor: Actor, body: any) {
  const raw = body.patch && typeof body.patch === "object" ? body.patch : {};
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!SETTING_KEYS.has(k)) throw httpError(400, `Unknown setting: ${k}`);
    patch[k] = v;
  }
  if ("legal_name" in patch && String(patch.legal_name || "").trim().length < 2) throw httpError(400, "Enter the company's legal name.");
  for (const k of ["business_address", "postal_address"]) if (k in patch) patch[k] = cleanAddress(patch[k]);
  if ("payroll_contact" in patch) {
    const p: any = patch.payroll_contact || {};
    patch.payroll_contact = { name: String(p.name || "").trim().slice(0, 120), email: String(p.email || "").trim().toLowerCase().slice(0, 160), phone: String(p.phone || "").trim().slice(0, 30) };
  }
  if ("workers_comp" in patch) {
    const list = Array.isArray(patch.workers_comp) ? patch.workers_comp : [];
    patch.workers_comp = list.slice(0, 8).map((w: any) => ({
      state: String(w.state || ""), insurer: String(w.insurer || "").trim().slice(0, 120), policyNumber: String(w.policyNumber || "").trim().slice(0, 60),
      expiresOn: /^\d{4}-\d{2}-\d{2}$/.test(String(w.expiresOn || "")) ? String(w.expiresOn) : null
    })).filter((w: any) => w.state || w.insurer || w.policyNumber);
  }
  if (!Object.keys(patch).length) throw httpError(400, "Nothing to save.");
  await rpc(admin, "company_settings_save", { p_actor: actor.id, p_patch: patch });
  return await companyGet(admin, actor);
}

async function numberingSave(admin: Client, actor: Actor, body: any) {
  const next = Number(body.nextNumber), padding = Number(body.padding);
  if (!Number.isInteger(next) || next < 1) throw httpError(400, "The next number must be a whole number.");
  if (!Number.isInteger(padding) || padding < 1 || padding > 10) throw httpError(400, "Digits must be between 1 and 10.");
  await rpc(admin, "number_sequence_save", { p_actor: actor.id, p_kind: String(body.kind || ""), p_prefix: String(body.prefix || ""), p_next: next, p_padding: padding });
  return { saved: true };
}

async function companyComplete(admin: Client, actor: Actor) {
  await rpc(admin, "company_setup_complete", { p_actor: actor.id });
  return { completed: true };
}

async function bankAccountRequest(admin: Client, actor: Actor, body: any) {
  const id = await rpc<string>(admin, "company_bank_account_request", {
    p_actor: actor.id, p_nickname: String(body.nickname || "").slice(0, 60), p_account_name: String(body.accountName || "").slice(0, 120),
    p_bsb: String(body.bsb || ""), p_account_number: String(body.accountNumber || ""), p_apca: body.apcaUserId ? String(body.apcaUserId) : null,
    p_purpose: String(body.purpose || "operating"), p_show_on_invoices: body.showOnInvoices === true
  });
  return { id, status: "pending" };
}

async function bankAccountRetire(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "company_bank_account_retire", { p_actor: actor.id, p_account: uuid(body.accountId, "Account"), p_reason: String(body.reason || "").slice(0, 300) });
  return { retired: true };
}

async function logoPrepare(admin: Client, actor: Actor, body: any) {
  const name = String(body.fileName || "");
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!LOGO_TYPES[ext]) throw httpError(400, "The logo must be a PNG, JPG, WebP or SVG image.");
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 1 || size > 2 * 1024 * 1024) throw httpError(400, "The logo must be under 2 MB.");
  const path = `org/${actor.organization_id}/company/logo-${Date.now().toString(36)}.${ext}`;
  const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false });
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "A secure upload link could not be created.");
  return { path, signedUrl: signed.data.signedUrl, contentType: LOGO_TYPES[ext] };
}

async function logoAttach(admin: Client, actor: Actor, body: any) {
  const path = String(body.path || "");
  const folder = `org/${actor.organization_id}/company`;
  if (!path.startsWith(`${folder}/`)) throw httpError(400, "Invalid upload path.");
  const listed = await admin.storage.from(BUCKET).list(folder, { limit: 1000 });
  const file = (listed.data || []).find((f: any) => f.name === path.split("/").pop());
  if (listed.error || !file) throw httpError(409, "The upload didn't arrive. Please try again.");
  const ext = path.split(".").pop()!.toLowerCase();
  await rpc(admin, "company_logo_set", {
    p_actor: actor.id, p_path: path, p_file_name: String(body.fileName || "").slice(0, 200), p_content_type: LOGO_TYPES[ext], p_size: Number(file?.metadata?.size || body.size || 1)
  });
  return { saved: true };
}

/* ---------------- Approvals and notifications ---------------- */

async function names(admin: Client, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, string>();
  const { data } = await admin.from("training_profiles").select("id,full_name,email").in("id", unique);
  return new Map((data || []).map((p: any) => [p.id, p.full_name || p.email]));
}

async function approvalsList(admin: Client, actor: Actor) {
  const { data, error } = await admin.from("approvals")
    .select("id,kind,title,required_permission,requested_by,requested_at,status,decided_by,decided_at,comment,previous_value,new_value")
    .eq("organization_id", actor.organization_id).order("requested_at", { ascending: false }).limit(200);
  if (error) throw httpError(500, "Approvals could not be loaded.");
  const who = await names(admin, data.flatMap((a: any) => [a.requested_by, a.decided_by]));
  const canDecide = (a: any) => a.status === "pending" && a.requested_by !== actor.id && has(actor, a.required_permission);
  // Full account numbers only for the approver (to check them) and the requester.
  const shape = (a: any) => {
    const full = canDecide(a) || a.requested_by === actor.id;
    const v = a.new_value && !full && a.new_value.accountNumber ? { ...a.new_value, accountNumber: maskAccount(String(a.new_value.accountNumber)) } : a.new_value;
    return {
      id: a.id, kind: a.kind, title: a.title, status: a.status, requestedAt: a.requested_at, requestedBy: who.get(a.requested_by) || "Unknown",
      decidedAt: a.decided_at, decidedBy: a.decided_by ? who.get(a.decided_by) || "Unknown" : null, comment: a.comment,
      newValue: v, previousValue: full ? a.previous_value : null, mine: a.requested_by === actor.id
    };
  };
  return {
    toDecide: data.filter(canDecide).map(shape),
    mine: data.filter((a: any) => a.requested_by === actor.id).slice(0, 50).map(shape),
    recent: has(actor, "audit.view") ? data.filter((a: any) => a.status !== "pending").slice(0, 50).map(shape) : []
  };
}

async function approvalDecide(admin: Client, actor: Actor, body: any) {
  return await rpc(admin, "approval_decide", { p_actor: actor.id, p_approval: uuid(body.approvalId, "Approval"), p_approve: body.approve === true, p_comment: String(body.comment || "").slice(0, 500) });
}

async function approvalCancel(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "approval_cancel", { p_actor: actor.id, p_approval: uuid(body.approvalId, "Approval") });
  return { cancelled: true };
}

async function notificationsList(admin: Client, actor: Actor) {
  const { data, error } = await admin.from("notifications").select("id,kind,title,body,link,created_at,read_at")
    .eq("profile_id", actor.id).order("created_at", { ascending: false }).limit(50);
  if (error) throw httpError(500, "Notifications could not be loaded.");
  return {
    unread: data.filter((n: any) => !n.read_at).length,
    items: data.map((n: any) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, read: Boolean(n.read_at) }))
  };
}

async function notificationsRead(admin: Client, actor: Actor, body: any) {
  let q = admin.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", actor.id).is("read_at", null);
  if (Array.isArray(body.ids) && body.ids.length) q = q.in("id", body.ids.slice(0, 100).map((v: unknown) => uuid(v, "Notification")));
  const { error } = await q;
  if (error) throw httpError(500, "Notifications could not be updated.");
  return { read: true };
}

/* ---------------- Users and roles ---------------- */

async function rolesCatalogue(admin: Client) {
  const [roles, links, perms] = await Promise.all([
    admin.from("app_roles").select("key,name,description,sort").order("sort"),
    admin.from("app_role_permissions").select("role_key,permission_key"),
    permissionCatalogue(admin)
  ]);
  if (roles.error || links.error) throw httpError(500, "Roles could not be loaded.");
  return {
    roles: roles.data.map((r: any) => ({ ...r, permissions: links.data.filter((l: any) => l.role_key === r.key).map((l: any) => l.permission_key) })),
    permissions: perms.map(p => ({ key: p.key, name: p.name, description: p.description, area: p.area, requiresMfa: p.requires_mfa }))
  };
}

async function usersList(admin: Client, actor: Actor) {
  const [profiles, roles, emps] = await Promise.all([
    admin.from("training_profiles").select("id,email,full_name,role,active").eq("organization_id", actor.organization_id).order("full_name").limit(2000),
    admin.from("profile_roles").select("profile_id,role_key"),
    admin.from("employees").select("profile_id,employee_number,employment_type,positions(title)").not("profile_id", "is", null)
  ]);
  if (profiles.error || roles.error || emps.error) throw httpError(500, "Users could not be loaded.");
  const emp = new Map(emps.data.map((e: any) => [e.profile_id, e]));
  return {
    users: profiles.data.map((p: any) => ({
      id: p.id, email: p.email, name: p.full_name || p.email, active: p.active, systemAdmin: p.role === "admin",
      number: (emp.get(p.id) as any)?.employee_number || null, position: (emp.get(p.id) as any)?.positions?.title || null,
      roles: roles.data.filter((r: any) => r.profile_id === p.id).map((r: any) => r.role_key), self: p.id === actor.id
    }))
  };
}

async function roleSet(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "app_set_profile_role", { p_actor: actor.id, p_profile: uuid(body.profileId, "Person"), p_role: String(body.role || ""), p_on: body.on === true });
  const perms = await rpc<string[]>(admin, "app_permissions_for", { p_profile: body.profileId });
  return { permissions: perms };
}

/* ---------------- Audit log ---------------- */

async function auditList(admin: Client, actor: Actor, body: any) {
  const page = Math.max(1, Math.min(500, Number(body.page) || 1));
  const size = 50;
  let q = admin.from("training_audit_events")
    .select("id,created_at,event_type,actor_user_id,subject_user_id,entity_type,entity_id,old_value,new_value,details", { count: "exact" })
    .eq("organization_id", actor.organization_id)
    .order("created_at", { ascending: false }).range((page - 1) * size, page * size - 1);
  if (body.entityType) q = q.eq("entity_type", String(body.entityType).slice(0, 40));
  if (body.event) q = q.ilike("event_type", `%${String(body.event).replace(/[%*]/g, "").slice(0, 40)}%`);
  if (body.from && /^\d{4}-\d{2}-\d{2}$/.test(body.from)) q = q.gte("created_at", `${body.from}T00:00:00+10:00`);
  if (body.to && /^\d{4}-\d{2}-\d{2}$/.test(body.to)) q = q.lte("created_at", `${body.to}T23:59:59+11:00`);
  const { data, error, count } = await q;
  if (error) throw httpError(500, "The audit log could not be loaded.");
  const who = await names(admin, data.flatMap((e: any) => [e.actor_user_id, e.subject_user_id]));
  await rpc(admin, "app_audit", { p_actor: actor.id, p_event: "audit_log_viewed", p_entity_type: "audit_log", p_entity_id: null, p_old: null, p_new: null, p_details: { page, filters: { entityType: body.entityType || null, event: body.event || null } }, p_subject: null });
  return {
    page, pageSize: size, total: count ?? null,
    events: data.map((e: any) => ({
      id: e.id, at: e.created_at, event: e.event_type, actor: e.actor_user_id ? who.get(e.actor_user_id) || "Unknown" : "System",
      subject: e.subject_user_id ? who.get(e.subject_user_id) || null : null, entityType: e.entity_type, entityId: e.entity_id,
      oldValue: e.old_value, newValue: e.new_value, details: e.details
    }))
  };
}

/* ---------------- Dashboard ---------------- */

async function dashboard(admin: Client, actor: Actor) {
  const [company, approvals, notes, ledger, sales, purchases, projects] = await Promise.all([companyGet(admin, actor), approvalsList(admin, actor), notificationsList(admin, actor),
    ledgerHeadlines(admin, actor), salesHeadlines(admin, actor), purchasesHeadlines(admin, actor), projectsHeadlines(admin, actor)]);
  return {
    setup: { complete: Boolean(company.settings?.setup_completed_at), missing: company.missing, canEdit: company.canEdit },
    approvalsWaiting: approvals.toDecide.length,
    myPending: approvals.mine.filter((a: any) => a.status === "pending").length,
    unread: notes.unread,
    ledger,
    sales,
    purchases,
    projects,
    company: { legalName: company.settings?.legal_name, tradingName: company.settings?.trading_name, abn: company.settings?.abn, logoUrl: company.logoUrl }
  };
}

/* ---------------- Dispatcher ---------------- */

const ACTIONS: Record<string, { perm: string[] | null; run: Handler }> = {
  dashboard: { perm: null, run: dashboard },
  company_get: { perm: null, run: companyGet },
  company_save: { perm: ["org.manage"], run: companySave },
  company_complete: { perm: ["org.manage"], run: companyComplete },
  numbering_save: { perm: ["org.manage"], run: numberingSave },
  bank_account_request: { perm: ["org.manage"], run: bankAccountRequest },
  bank_account_retire: { perm: ["org.manage"], run: bankAccountRetire },
  logo_prepare_upload: { perm: ["org.manage"], run: logoPrepare },
  logo_attach: { perm: ["org.manage"], run: logoAttach },
  approvals_list: { perm: null, run: approvalsList },
  approval_decide: { perm: null, run: approvalDecide },
  approval_cancel: { perm: null, run: approvalCancel },
  notifications_list: { perm: null, run: notificationsList },
  notifications_read: { perm: null, run: notificationsRead },
  roles_catalogue: { perm: ["access.manage"], run: admin => rolesCatalogue(admin) },
  users_list: { perm: ["access.manage"], run: usersList },
  role_set: { perm: ["access.manage"], run: roleSet },
  audit_list: { perm: ["audit.view"], run: auditList },
  ...ledgerActions,
  ...salesActions,
  ...purchasesActions,
  ...projectsActions,
  attachment_prepare_upload: { perm: ["sales.manage", "purchases.manage", "purchases.raise"], run: attachmentPrepare },
  attachment_attach: { perm: ["sales.manage", "purchases.manage", "purchases.raise"], run: attachmentAttach },
  attachment_open: { perm: ["sales.manage", "purchases.manage", "purchases.raise", "reports.view"], run: attachmentOpen },
  attachment_archive: { perm: ["sales.manage", "purchases.manage"], run: attachmentArchive }
};

export default {
  fetch: withSupabase({ auth: "user" }, async (request: Request, context: any) => {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response("ok", { headers: cors.headers });
    if (!cors.allowed) return json(request, { message: "This website is not permitted to call Panalo Accounts." }, 403);
    if (request.method !== "POST") return json(request, { message: "Method not allowed." }, 405);
    try {
      const userId = String(context.userClaims?.id || context.userClaims?.sub || "");
      if (!userId) throw httpError(401, "A verified session is required.");
      const admin = context.supabaseAdmin;
      const actor = await loadActor(admin, userId);
      if (actor.mustChangePassword) throw httpError(403, "Change your temporary password on the portal first.", "password_change_required");
      const catalogue = await permissionCatalogue(admin);
      const financeKeys = new Set(catalogue.filter(p => p.area !== "Portal" || p.key === "access.manage").map(p => p.key));
      if (!actor.permissions.some(k => financeKeys.has(k))) throw httpError(403, "Your account doesn't include Panalo Accounts. Ask an administrator if you need it.", "no_access");
      const mfaRequired = catalogue.some(p => p.requires_mfa && actor.permissions.includes(p.key));
      const aal = sessionAal(request, context.userClaims);
      const body = await request.json().catch(() => ({}));
      const action = String(body.action || "");

      let result: unknown;
      if (action === "whoami") {
        const roles = await admin.from("profile_roles").select("role_key").eq("profile_id", actor.id);
        const org = await admin.from("organizations").select("id,name").eq("id", actor.organization_id).maybeSingle();
        result = {
          id: actor.id, name: actor.full_name || actor.email, email: actor.email, systemAdmin: actor.role === "admin",
          organization: org.data, permissions: actor.permissions, roles: (roles.data || []).map((r: any) => r.role_key),
          mfa: { required: mfaRequired, aal, satisfied: !mfaRequired || aal === "aal2" }
        };
      } else {
        if (mfaRequired && aal !== "aal2") throw httpError(403, "Confirm your sign-in with your authenticator app to continue.", "mfa_required");
        const handler = ACTIONS[action];
        if (!handler) throw httpError(400, "Unknown Panalo Accounts action.");
        if (handler.perm) need(actor, ...handler.perm);
        result = await handler.run(admin, actor, body);
      }
      return json(request, result);
    } catch (error) {
      return errorJson(request, error);
    }
  })
};
