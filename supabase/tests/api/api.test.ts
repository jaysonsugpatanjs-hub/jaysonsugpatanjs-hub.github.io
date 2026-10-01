// End-to-end API tests: the real Edge Function handlers, running against
// PostgREST over a database with every migration applied (see run.sh).
// Only Supabase Auth and Storage are stubbed.
import { storageCalls } from "./client.ts";

const BASE = Deno.env.get("POSTGREST_URL") || "http://127.0.0.1:3999";
const fns = new URL("../../functions/", import.meta.url);
const adminApi = (await import(new URL("admin-api/index.ts", fns).href)).default;
const imsApi = (await import(new URL("ims-api/index.ts", fns).href)).default;
const trainingApi = (await import(new URL("training-api/index.ts", fns).href)).default;

async function rest(path: string) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return await res.json();
}
async function one(path: string) {
  const rows = await rest(path);
  if (rows.length !== 1) throw new Error(`${path}: expected 1 row, got ${rows.length}`);
  return rows[0];
}
const profile = async (email: string) => (await one(`training_profiles?select=id&email=eq.${encodeURIComponent(email)}`)).id;

async function call(api: any, user: string, body: Record<string, unknown>) {
  const res = await api.fetch(new Request("https://x.test/fn", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jaysonsugpatanjs-hub.github.io", "x-test-user": user },
    body: JSON.stringify(body)
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function expectStatus(result: { status: number; body: any }, expected: number, label: string) {
  if (result.status !== expected) throw new Error(`${label}: expected ${expected}, got ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  return result.body;
}
const ok = async (api: any, user: string, body: Record<string, unknown>) => expectStatus(await call(api, user, body), 200, String(body.action));

const A = await profile("admin@panalo.test");
const D = await profile("doc@panalo.test");
const S = await profile("sup@panalo.test");
const L = await profile("learner@panalo.test");
const HR = await profile("hr@access.test");
const LEAD = await profile("lead@access.test");

Deno.test("admin page loads for an administrator", async () => {
  for (const action of ["whoami", "dashboard", "module_catalog", "module_ims_revisions", "people_reference", "people_list", "competency_matrix", "access_catalogue"]) {
    await ok(adminApi, A, { action });
  }
  const page = await ok(adminApi, A, { action: "dashboard", page: 1 });
  if (!page.paging) throw new Error("paging missing");
});

Deno.test("areas follow permissions", async () => {
  expectStatus(await call(adminApi, S, { action: "whoami" }), 403, "no permissions");
  const hr = await ok(adminApi, HR, { action: "whoami" });
  if (!hr.permissions.includes("hr.manage") || hr.permissions.includes("training.manage")) throw new Error(`hr permissions ${hr.permissions}`);
  expectStatus(await call(adminApi, HR, { action: "dashboard" }), 403, "hr cannot open training admin");
  await ok(adminApi, HR, { action: "onboarding_list" });
  const team = await ok(adminApi, LEAD, { action: "competency_matrix" });
  if (!team.teamOnly) throw new Error("lead should see team only");
  if (team.rows.some((r: any) => r.employeeNumber !== "X-WORK")) throw new Error(`lead sees others: ${team.rows.map((r: any) => r.employeeNumber)}`);
});

Deno.test("people and training actions", async () => {
  const ref = await ok(adminApi, A, { action: "people_reference" });
  const emp = await ok(adminApi, A, { action: "employee_save", employeeNumber: "E-7777", fullName: "Test Person", email: "test.person@panalo.test", positionId: ref.positions[0].id });
  await ok(adminApi, A, { action: "employee_save", id: emp.id, employeeNumber: "E-7777", fullName: "Test Person Edited", email: "test.person@panalo.test", status: "active" });
  const lic = await ok(adminApi, A, { action: "licence_save", employeeId: emp.id, licenceType: "White card", expiresOn: "2027-01-01", verified: true });
  await ok(adminApi, A, { action: "licence_delete", id: lic.id });
  await ok(adminApi, A, { action: "position_save", code: "APIPOS", title: "API Position" });
  await ok(adminApi, A, { action: "site_save", code: "APISITE", name: "API Site" });
  const module = await one("training_modules?select=id&code=eq.PP-TRN-WLD-001");
  await ok(adminApi, A, { action: "requirement_set", positionId: ref.positions[0].id, moduleId: module.id, required: true, refresherMonths: 24 });
  expectStatus(await call(adminApi, A, { action: "group_member_set", group: "all_employees", profileId: L, member: true }), 409, "implicit group");
});

Deno.test("document control", async () => {
  const root = await one("ims_folders?select=id&parent_id=is.null");
  const trn = await one("ims_folders?select=id&name=eq.Training%20modules");
  const per = await one("ims_folders?select=id&name=eq.Personnel%20records");
  await ok(imsApi, D, { action: "folder" });
  await ok(imsApi, D, { action: "folder", folderId: trn.id });
  const locked = await ok(imsApi, D, { action: "folder", folderId: per.id });
  if (locked.children.length || locked.documents.length) throw new Error("locked folder leaked contents");
  await ok(imsApi, D, { action: "access", folderId: trn.id });
  expectStatus(await call(imsApi, D, { action: "access", folderId: per.id }), 403, "locked access list");
  const wld = await one("ims_documents?select=id&doc_number=eq.PP-TRN-WLD-001");
  await ok(imsApi, D, { action: "document", documentId: wld.id });
  expectStatus(await call(imsApi, S, { action: "document", documentId: wld.id }), 403, "no folder access");
  const nf = await ok(imsApi, D, { action: "create_folder", parentId: root.id, name: "07. HSEQ (api)" });
  const nd = await ok(imsApi, D, { action: "create_document", folderId: nf.id, docNumber: "PP-PRO-777", title: "Test procedure", docType: "Procedure", requiredGates: ["ims"], reviewMonths: 12 });
  const nr = await ok(imsApi, D, { action: "create_revision", documentId: nd.id, revision: "Rev 1", summary: "First" });
  const up = await ok(imsApi, D, { action: "prepare_upload", revisionId: nr.id, fileName: "Test Proc.pdf", size: 1000 });
  await ok(imsApi, D, { action: "attach_file", revisionId: nr.id, path: up.path });
  const rev2 = await one("ims_document_revisions?select=id&revision=eq.Rev%202");
  await ok(imsApi, D, { action: "download", revisionId: rev2.id });
  await ok(imsApi, D, { action: "set_grant", folderId: nf.id, group: "supervisors", level: "editor" });
  await ok(imsApi, D, { action: "set_inherit", folderId: nf.id, inherit: false });
  await ok(imsApi, D, { action: "set_inherit", folderId: nf.id, inherit: true });
  await ok(imsApi, S, { action: "request_access", folderId: per.id });
});

Deno.test("temporary password: shown once, then forced change", async () => {
  const ref = await ok(adminApi, A, { action: "people_reference" });
  const emp = await ok(adminApi, A, { action: "employee_save", employeeNumber: "E-8001", fullName: "Temp Starter", email: "temp.starter@panalo.test", positionId: ref.positions[0].id });
  const made = await ok(adminApi, A, { action: "account_create", employeeId: emp.id, mode: "password" });
  if (!/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/.test(made.tempPassword || "")) throw new Error("temporary password not returned");
  const id = made.profileId;
  const audit = await rest(`training_audit_events?select=details&subject_user_id=eq.${id}`);
  if (JSON.stringify(audit).includes(made.tempPassword)) throw new Error("temporary password leaked into the audit log");

  const boot = await ok(trainingApi, id, { action: "bootstrap" });
  if (!boot.learner.mustChangePassword) throw new Error("must change flag missing");
  expectStatus(await call(trainingApi, id, { action: "onboarding_view" }), 403, "blocked until changed");
  expectStatus(await call(imsApi, id, { action: "folder" }), 403, "ims blocked until changed");
  expectStatus(await call(trainingApi, id, { action: "change_password", password: "short" }), 400, "weak password");
  expectStatus(await call(trainingApi, id, { action: "change_password", password: "Temp.Starter-2026x" }), 400, "contains email name");
  await ok(trainingApi, id, { action: "change_password", password: "Grinder-Torch-47-Kettle" });
  await ok(trainingApi, id, { action: "onboarding_view" });

  const reset = await ok(adminApi, A, { action: "account_reset_password", profileId: id });
  if (!reset.tempPassword || reset.tempPassword === made.tempPassword) throw new Error("reset did not issue a new password");
  expectStatus(await call(trainingApi, id, { action: "onboarding_view" }), 403, "blocked again after reset");
  expectStatus(await call(adminApi, HR, { action: "account_reset_password", profileId: id }), 403, "HR cannot reset passwords");

  await ok(adminApi, A, { action: "account_set_active", profileId: id, active: false });
  expectStatus(await call(trainingApi, id, { action: "bootstrap" }), 403, "disabled account");
  await ok(adminApi, A, { action: "account_set_active", profileId: id, active: true });
  const calls = await (await fetch(`${BASE}/rpc/test_auth_calls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ p_id: id }) })).json();
  if (!calls.some((c: any) => c.fields.includes("ban_duration"))) throw new Error("sign-in was not blocked in Auth");
});

Deno.test("permissions: position defaults and personal overrides", async () => {
  const worker = await profile("worker@access.test");
  const detail = await ok(adminApi, A, { action: "access_detail", profileId: worker });
  if (!detail.permissions.find((p: any) => p.key === "people.view")) throw new Error("catalogue missing");
  await ok(adminApi, A, { action: "permission_set", profileId: worker, key: "hr.manage", state: "allow" });
  const after = await ok(adminApi, A, { action: "access_detail", profileId: worker });
  if (!after.permissions.find((p: any) => p.key === "hr.manage").effective) throw new Error("allow not effective");
  await ok(adminApi, A, { action: "permission_set", profileId: worker, key: "hr.manage", state: "default" });
  const pos = await one("positions?select=id&code=eq.WELDX");
  await ok(adminApi, A, { action: "position_permission_set", positionId: pos.id, key: "people.view", on: true });
  const viaPosition = await ok(adminApi, A, { action: "access_detail", profileId: worker });
  if (!viaPosition.permissions.find((p: any) => p.key === "people.view").effective) throw new Error("position default not effective");
  expectStatus(await call(adminApi, HR, { action: "permission_set", profileId: worker, key: "hr.manage", state: "allow" }), 403, "HR cannot grant");
});

Deno.test("onboarding: invite, upload, reject, re-upload, accept", async () => {
  const emp = await ok(adminApi, A, { action: "employee_save", employeeNumber: "A-9001", fullName: "Applicant Nine", email: "applicant.nine@panalo.test", employmentType: "applicant", status: "applicant" });
  const types = await ok(adminApi, HR, { action: "onboarding_types" });
  const forApplicants = types.types.filter((t: any) => t.appliesTo.includes("applicant") && t.active).map((t: any) => t.key);
  if (!forApplicants.includes("tfn_declaration") || !forApplicants.includes("right_to_work")) throw new Error("AU checklist missing");
  expectStatus(await call(adminApi, HR, { action: "onboarding_create", employeeId: emp.id, types: forApplicants, signIn: "password" }), 403, "HR cannot issue passwords");
  const sent = await ok(adminApi, HR, { action: "onboarding_create", employeeId: emp.id, types: forApplicants, signIn: "invite", dueOn: "2030-01-01", message: "Welcome" });
  if (!sent.invited) throw new Error("invitation not sent");
  const applicant = await profile("applicant.nine@panalo.test");

  const mine = await ok(trainingApi, applicant, { action: "onboarding_view" });
  if (mine.items.length !== forApplicants.length) throw new Error("applicant sees wrong checklist");
  const tfn = mine.items.find((i: any) => i.name.includes("Tax file"));
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: tfn.id, fileName: "tfn.exe", size: 100 }), 400, "bad file type");
  expectStatus(await call(trainingApi, L, { action: "onboarding_prepare_upload", itemId: tfn.id, fileName: "tfn.pdf", size: 100 }), 404, "someone else's item");
  let up = await ok(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: tfn.id, fileName: "My TFN.pdf", size: 100 });
  await ok(trainingApi, applicant, { action: "onboarding_attach", itemId: tfn.id, path: up.path, fileName: "My TFN.pdf" });

  const list = await ok(adminApi, HR, { action: "onboarding_list" });
  const req = list.requests.find((r: any) => r.id === sent.requestId);
  if (req.counts.toReview !== 1) throw new Error("upload not waiting for review");
  const detail = await ok(adminApi, HR, { action: "onboarding_detail", requestId: sent.requestId });
  const item = detail.items.find((i: any) => i.id === tfn.id);
  if (!item.sensitive) throw new Error("TFN not flagged sensitive");
  const view = await ok(adminApi, HR, { action: "onboarding_file", itemId: tfn.id });
  if (!view.url) throw new Error("no viewing link");
  expectStatus(await call(adminApi, HR, { action: "onboarding_review", itemId: tfn.id, accept: false, reason: "" }), 409, "reject needs reason");
  await ok(adminApi, HR, { action: "onboarding_review", itemId: tfn.id, accept: false, reason: "Please sign page 2" });
  const again = await ok(trainingApi, applicant, { action: "onboarding_view" });
  if (again.items.find((i: any) => i.id === tfn.id).rejectReason !== "Please sign page 2") throw new Error("reason not shown to applicant");
  up = await ok(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: tfn.id, fileName: "tfn-signed.jpg", size: 100 });
  await ok(trainingApi, applicant, { action: "onboarding_attach", itemId: tfn.id, path: up.path, fileName: "tfn-signed.jpg" });
  await ok(adminApi, HR, { action: "onboarding_review", itemId: tfn.id, accept: true });
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: tfn.id, fileName: "x.pdf", size: 100 }), 409, "accepted is final");
  const boot = await ok(trainingApi, applicant, { action: "bootstrap" });
  const requiredCount = types.types.filter((t: any) => forApplicants.includes(t.key) && t.required).length;
  if (boot.onboarding?.outstanding !== requiredCount - 1) throw new Error(`outstanding count wrong: ${JSON.stringify(boot.onboarding)}`);
  await ok(adminApi, HR, { action: "onboarding_type_save", key: "tickets", name: "Licences and tickets", guidance: "One PDF please.", required: false, active: true });
  await ok(adminApi, HR, { action: "onboarding_cancel", requestId: sent.requestId, reason: "Test complete" });
  if (!storageCalls.some(c => c.startsWith("upload hr-documents/"))) throw new Error("uploads did not go to the HR bucket");
});

Deno.test("learner invite with a temporary password", async () => {
  const mod = await one("training_modules?select=code&code=eq.PP-TRN-WLD-001");
  const res = await ok(adminApi, A, { action: "invite", fullName: "New Learner", email: "new.learner@panalo.test", learnerType: "employee", moduleCode: mod.code, expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(), signIn: "password" });
  if (!res.tempPassword || res.invitationSent) throw new Error("temporary password expected");
});
