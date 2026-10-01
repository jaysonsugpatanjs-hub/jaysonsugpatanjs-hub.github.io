// Sign-in accounts, permissions and HR onboarding actions for admin-api.
// Passwords go only to Supabase Auth; temporary ones are returned once to the
// administrator who issued them and never stored or logged here.
import { generateTemporaryPassword } from "../_shared/accounts.ts";
import { httpError, rpc } from "../_shared/http.ts";

type Client = any;
export type Actor = { id: string; email: string; full_name: string; role: string; permissions: string[] };
type Handler = (admin: Client, actor: Actor, body: any) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HR_BUCKET = "hr-documents";

function uuid(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID.test(text)) throw httpError(400, `${label} is not valid.`);
  return text;
}
function has(actor: Actor, key: string) { return actor.permissions.includes(key); }
function appUrl() { return Deno.env.get("TRAINING_APP_URL") || "https://jaysonsugpatanjs-hub.github.io/training/"; }

async function employeeById(admin: Client, id: string) {
  const { data, error } = await admin.from("employees")
    .select("id,employee_number,full_name,email,employment_type,status,profile_id").eq("id", id).maybeSingle();
  if (error) throw httpError(500, "The register could not be read.");
  if (!data) throw httpError(404, "Person not found on the register.");
  return data;
}

async function profileByEmail(admin: Client, email: string) {
  const { data, error } = await admin.from("training_profiles").select("id,active").eq("email", email).maybeSingle();
  if (error) throw httpError(500, "Sign-in lookup failed.");
  return data;
}

/**
 * Makes sure a register entry has a sign-in. "invite" emails a link to set a
 * password; "password" creates or resets a temporary password shown once.
 */
export async function ensureLogin(admin: Client, actor: Actor, employee: any, mode: "invite" | "password") {
  const email = String(employee.email || "").toLowerCase();
  if (!email) throw httpError(409, "Add this person's email address on the register first.");
  if (mode === "password" && !has(actor, "access.manage")) throw httpError(403, "Issuing temporary passwords needs the Sign-in and access permission.");
  let profileId: string | null = employee.profile_id;
  let tempPassword: string | null = null;
  let invited = false;
  let created = false;

  if (!profileId) {
    const existing = await profileByEmail(admin, email);
    if (existing) {
      profileId = existing.id;
    } else if (mode === "password") {
      tempPassword = generateTemporaryPassword();
      const made = await admin.auth.admin.createUser({
        email, password: tempPassword, email_confirm: true,
        user_metadata: { full_name: employee.full_name, external_id: employee.employee_number, learner_type: employee.employment_type }
      });
      if (made.error || !made.data?.user?.id) throw httpError(409, "The sign-in could not be created. Check the email address and try again.");
      profileId = made.data.user.id;
      created = true;
    } else {
      const sent = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${appUrl()}?welcome=1`,
        data: { full_name: employee.full_name, external_id: employee.employee_number, learner_type: employee.employment_type }
      });
      if (sent.error || !sent.data?.user?.id) throw httpError(409, "The invitation could not be sent. Check the email address and try again.");
      profileId = sent.data.user.id;
      invited = true;
    }
    await rpc(admin, "account_link_employee", { p_actor: actor.id, p_employee: employee.id, p_profile: profileId });
  }

  if (mode === "password" && !created) {
    tempPassword = generateTemporaryPassword();
    const updated = await admin.auth.admin.updateUserById(profileId, { password: tempPassword });
    if (updated.error) throw httpError(500, "The temporary password could not be set.");
  }
  if (tempPassword) await rpc(admin, "account_temp_password_issued", { p_actor: actor.id, p_profile: profileId, p_new_account: created });
  if (invited) await rpc(admin, "ims_audit", { p_actor: actor.id, p_event: "sign_in_invitation_sent", p_details: {}, p_subject: profileId });
  return { profileId, tempPassword, invited, created };
}

async function accountCreate(admin: Client, actor: Actor, body: any) {
  const employee = await employeeById(admin, uuid(body.employeeId, "Person"));
  const mode = body.mode === "password" ? "password" : "invite";
  const result = await ensureLogin(admin, actor, employee, mode);
  return { ...result, email: employee.email };
}

async function accountResetPassword(admin: Client, actor: Actor, body: any) {
  const profileId = uuid(body.profileId, "Sign-in");
  const tempPassword = generateTemporaryPassword();
  const updated = await admin.auth.admin.updateUserById(profileId, { password: tempPassword });
  if (updated.error) throw httpError(500, "The temporary password could not be set.");
  await rpc(admin, "account_temp_password_issued", { p_actor: actor.id, p_profile: profileId, p_new_account: false });
  return { tempPassword };
}

async function accountSetActive(admin: Client, actor: Actor, body: any) {
  const profileId = uuid(body.profileId, "Sign-in");
  const active = body.active === true;
  await rpc(admin, "account_set_active", { p_actor: actor.id, p_profile: profileId, p_active: active });
  // Also block or unblock the login itself, not just this portal's records.
  const banned = await admin.auth.admin.updateUserById(profileId, { ban_duration: active ? "none" : "876000h" });
  if (banned.error) throw httpError(500, "Access was updated here, but the sign-in block could not be changed. Try again.");
  return { active };
}

async function accessDetail(admin: Client, _actor: Actor, body: any) {
  const profileId = uuid(body.profileId, "Sign-in");
  const [profile, effective, overrides, catalogue] = await Promise.all([
    admin.from("training_profiles").select("id,email,role,active,must_change_password,password_set_at").eq("id", profileId).maybeSingle(),
    rpc<string[]>(admin, "app_permissions_for", { p_profile: profileId }),
    admin.from("profile_permissions").select("permission_key,granted").eq("profile_id", profileId),
    admin.from("app_permissions").select("key,name,description,sort").order("sort")
  ]);
  if (profile.error || overrides.error || catalogue.error) throw httpError(500, "Access details could not be loaded.");
  if (!profile.data) throw httpError(404, "Sign-in not found.");
  const overrideMap = new Map((overrides.data || []).map((o: any) => [o.permission_key, o.granted ? "allow" : "deny"]));
  return {
    account: {
      id: profile.data.id, email: profile.data.email, systemAdmin: profile.data.role === "admin",
      active: profile.data.active, mustChangePassword: profile.data.must_change_password, passwordSetAt: profile.data.password_set_at
    },
    permissions: (catalogue.data || []).map((p: any) => ({
      key: p.key, name: p.name, description: p.description,
      effective: (effective || []).includes(p.key), override: overrideMap.get(p.key) || "default"
    }))
  };
}

async function permissionSet(admin: Client, actor: Actor, body: any) {
  const state = String(body.state || "");
  if (!["allow", "deny", "default"].includes(state)) throw httpError(400, "Choose allow, deny or position default.");
  await rpc(admin, "app_set_profile_permission", { p_actor: actor.id, p_profile: uuid(body.profileId, "Sign-in"), p_key: String(body.key || ""), p_state: state });
  return { saved: true };
}

async function positionPermissionSet(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "app_set_position_permission", { p_actor: actor.id, p_position: uuid(body.positionId, "Position"), p_key: String(body.key || ""), p_on: body.on === true });
  return { saved: true };
}

async function accessCatalogue(admin: Client) {
  const [perms, posPerms] = await Promise.all([
    admin.from("app_permissions").select("key,name,description,sort").order("sort"),
    admin.from("position_permissions").select("position_id,permission_key")
  ]);
  if (perms.error || posPerms.error) throw httpError(500, "Permissions could not be loaded.");
  return {
    permissions: perms.data.map((p: any) => ({ key: p.key, name: p.name, description: p.description })),
    positionPermissions: posPerms.data.map((p: any) => ({ positionId: p.position_id, key: p.permission_key }))
  };
}

/* ---------------- Onboarding ---------------- */

async function onboardingTypes(admin: Client) {
  const { data, error } = await admin.from("hr_document_types").select("key,name,guidance,required,applies_to,sensitive,sort,active").order("sort");
  if (error) throw httpError(500, "Document types could not be loaded.");
  return { types: data.map((t: any) => ({ key: t.key, name: t.name, guidance: t.guidance, required: t.required, appliesTo: t.applies_to, sensitive: t.sensitive, active: t.active })) };
}

async function onboardingTypeSave(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "hr_document_type_save", {
    p_actor: actor.id, p_key: String(body.key || ""), p_name: String(body.name || "").slice(0, 120),
    p_guidance: String(body.guidance || "").slice(0, 500), p_required: body.required === true, p_active: body.active !== false
  });
  return { saved: true };
}

async function onboardingList(admin: Client) {
  const { data, error } = await admin.from("onboarding_requests")
    .select("id,employee_id,status,due_on,created_at,completed_at,employees(full_name,employee_number,employment_type,email),onboarding_items(status,required)")
    .order("created_at", { ascending: false }).limit(300);
  if (error) throw httpError(500, "Onboarding requests could not be loaded.");
  return {
    requests: data.map((r: any) => {
      const items = r.onboarding_items || [];
      return {
        id: r.id, employeeId: r.employee_id, status: r.status, dueOn: r.due_on, createdAt: r.created_at, completedAt: r.completed_at,
        person: { name: r.employees?.full_name, number: r.employees?.employee_number, type: r.employees?.employment_type, email: r.employees?.email },
        counts: {
          total: items.length,
          required: items.filter((i: any) => i.required).length,
          accepted: items.filter((i: any) => i.status === "accepted").length,
          toReview: items.filter((i: any) => i.status === "uploaded").length,
          rejected: items.filter((i: any) => i.status === "rejected").length,
          pending: items.filter((i: any) => i.status === "pending").length
        }
      };
    })
  };
}

async function onboardingDetail(admin: Client, _actor: Actor, body: any) {
  const requestId = uuid(body.requestId, "Request");
  const { data, error } = await admin.from("onboarding_requests")
    .select("id,status,due_on,message,created_at,completed_at,cancelled_reason,employees(full_name,employee_number,employment_type,email),onboarding_items(id,doc_type,required,status,file_name,uploaded_at,reviewed_at,reject_reason,reviewed_by)")
    .eq("id", requestId).maybeSingle();
  if (error) throw httpError(500, "The onboarding request could not be loaded.");
  if (!data) throw httpError(404, "Onboarding request not found.");
  const types = await onboardingTypes(admin);
  const typeMap = new Map(types.types.map((t: any) => [t.key, t]));
  const reviewerIds = [...new Set((data.onboarding_items || []).map((i: any) => i.reviewed_by).filter(Boolean))];
  const reviewers = reviewerIds.length ? await admin.from("training_profiles").select("id,full_name,email").in("id", reviewerIds) : { data: [], error: null };
  const names = new Map((reviewers.data || []).map((p: any) => [p.id, p.full_name || p.email]));
  return {
    request: {
      id: data.id, status: data.status, dueOn: data.due_on, message: data.message, createdAt: data.created_at, completedAt: data.completed_at,
      cancelledReason: data.cancelled_reason,
      person: { name: data.employees?.full_name, number: data.employees?.employee_number, type: data.employees?.employment_type, email: data.employees?.email }
    },
    items: (data.onboarding_items || [])
      .map((i: any) => ({
        id: i.id, docType: i.doc_type, name: (typeMap.get(i.doc_type) as any)?.name || i.doc_type,
        sensitive: Boolean((typeMap.get(i.doc_type) as any)?.sensitive), required: i.required, status: i.status,
        fileName: i.file_name, uploadedAt: i.uploaded_at, reviewedAt: i.reviewed_at, reviewer: names.get(i.reviewed_by) || null,
        rejectReason: i.reject_reason, sort: (typeMap.get(i.doc_type) as any) ? types.types.findIndex((t: any) => t.key === i.doc_type) : 999
      }))
      .sort((a: any, b: any) => a.sort - b.sort)
  };
}

async function onboardingCreate(admin: Client, actor: Actor, body: any) {
  const employee = await employeeById(admin, uuid(body.employeeId, "Person"));
  const types = Array.isArray(body.types) ? body.types.map(String).slice(0, 40) : [];
  const dueOn = body.dueOn ? String(body.dueOn) : null;
  if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) throw httpError(400, "Due date is not valid.");
  const mode = body.signIn === "password" ? "password" : "invite";
  const login = await ensureLogin(admin, actor, employee, mode);
  const requestId = await rpc<string>(admin, "onboarding_create", {
    p_actor: actor.id, p_employee: employee.id, p_types: types, p_due: dueOn, p_message: String(body.message || "").slice(0, 1000)
  });
  return { requestId, invited: login.invited, tempPassword: login.tempPassword, hadLogin: !login.invited && !login.created && !login.tempPassword };
}

async function onboardingReview(admin: Client, actor: Actor, body: any) {
  return await rpc(admin, "onboarding_review", {
    p_actor: actor.id, p_item: uuid(body.itemId, "Document"), p_accept: body.accept === true, p_reason: String(body.reason || "").slice(0, 500)
  });
}

async function onboardingCancel(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "onboarding_cancel", { p_actor: actor.id, p_request: uuid(body.requestId, "Request"), p_reason: String(body.reason || "").slice(0, 300) });
  return { cancelled: true };
}

async function onboardingFile(admin: Client, actor: Actor, body: any) {
  const itemId = uuid(body.itemId, "Document");
  const { data, error } = await admin.from("onboarding_items").select("id,file_path,doc_type,request_id,onboarding_requests(profile_id)").eq("id", itemId).maybeSingle();
  if (error) throw httpError(500, "The document could not be found.");
  if (!data?.file_path) throw httpError(404, "Nothing has been uploaded for this document yet.");
  const signed = await admin.storage.from(HR_BUCKET).createSignedUrl(data.file_path, 120);
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "A viewing link could not be created.");
  await rpc(admin, "ims_audit", {
    p_actor: actor.id, p_event: "onboarding_document_viewed",
    p_details: { itemId, docType: data.doc_type, requestId: data.request_id }, p_subject: data.onboarding_requests?.profile_id ?? null
  });
  return { url: signed.data.signedUrl, expiresIn: 120 };
}

export const accountActions: Record<string, { perm: string | string[]; run: Handler }> = {
  account_create: { perm: ["access.manage", "hr.manage"], run: accountCreate },
  account_reset_password: { perm: "access.manage", run: accountResetPassword },
  account_set_active: { perm: "access.manage", run: accountSetActive },
  access_detail: { perm: "access.manage", run: accessDetail },
  access_catalogue: { perm: ["access.manage", "people.view", "people.manage"], run: admin => accessCatalogue(admin) },
  permission_set: { perm: "access.manage", run: permissionSet },
  position_permission_set: { perm: "access.manage", run: positionPermissionSet },
  onboarding_types: { perm: "hr.manage", run: admin => onboardingTypes(admin) },
  onboarding_type_save: { perm: "hr.manage", run: onboardingTypeSave },
  onboarding_list: { perm: "hr.manage", run: admin => onboardingList(admin) },
  onboarding_detail: { perm: "hr.manage", run: onboardingDetail },
  onboarding_create: { perm: "hr.manage", run: onboardingCreate },
  onboarding_review: { perm: "hr.manage", run: onboardingReview },
  onboarding_cancel: { perm: "hr.manage", run: onboardingCancel },
  onboarding_file: { perm: "hr.manage", run: onboardingFile }
};
