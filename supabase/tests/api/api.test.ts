// End-to-end API tests: the real Edge Function handlers, running against
// PostgREST over a database with every migration applied (see run.sh).
// Only Supabase Auth and Storage are stubbed.
import { pdfDraws, pdfText } from "./pdf-lib-stub.ts";
import { failNextStore, hasStorage, putStorage, storageCalls } from "./client.ts";

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

Deno.test("onboarding: invite, forms and uploads, send back, accept", async () => {
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
  const tfn = mine.items.find((i: any) => i.docType === "tfn_declaration");
  const card = mine.items.find((i: any) => i.docType === "certificates");
  if (mine.items.some((i: any) => i.docType === "white_card")) throw new Error("retired White Card item still offered");
  if (tfn.kind !== "form" || !tfn.form?.fields?.length) throw new Error("TFN should be a form with fields");
  if (card.kind !== "upload" || card.form) throw new Error("certificates should be an upload");
  if (!mine.items.some((i: any) => i.docType === "personal_details")) throw new Error("personal details missing");

  // Forms: typed answers, validated on the server.
  const answers = { tfn_option: "I'll provide my TFN", tfn: "123 456 782", pay_basis: "Casual", residency: "An Australian resident", tax_free_threshold: "Yes", study_loan: "No", declaration: true, signature: "Applicant Nine" };
  const bad = await call(trainingApi, applicant, { action: "onboarding_submit_form", itemId: tfn.id, answers: { ...answers, tfn: "123456789" } });
  expectStatus(bad, 400, "invalid TFN");
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: tfn.id, fileName: "tfn.pdf", size: 100 }), 400, "forms take no files");
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_submit_form", itemId: card.id, answers: {} }), 400, "uploads take no answers");
  expectStatus(await call(trainingApi, L, { action: "onboarding_submit_form", itemId: tfn.id, answers }), 404, "someone else's item");
  await ok(trainingApi, applicant, { action: "onboarding_submit_form", itemId: tfn.id, answers });
  const audit = await rest(`training_audit_events?select=details&event_type=in.(onboarding_form_submitted,onboarding_answers_viewed)`);
  if (!audit.length || JSON.stringify(audit).includes("123456782")) throw new Error("form submission not audited, or TFN leaked into the audit log");

  // Uploads: certificates and contracts only.
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: card.id, fileName: "card.exe", size: 100 }), 400, "bad file type");
  let up = await ok(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: card.id, fileName: "White card.jpg", size: 100 });
  await ok(trainingApi, applicant, { action: "onboarding_attach", itemId: card.id, path: up.path, fileName: "White card.jpg", label: "White Card" });
  up = await ok(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: card.id, fileName: "IMG_2041.jpg", size: 100 });
  const extra = await ok(trainingApi, applicant, { action: "onboarding_attach", itemId: card.id, path: up.path, fileName: "IMG_2041.jpg", label: "Forklift licence", expiresOn: "2030-05-01" });
  up = await ok(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: card.id, fileName: "oops.jpg", size: 100 });
  const oops = await ok(trainingApi, applicant, { action: "onboarding_attach", itemId: card.id, path: up.path, fileName: "oops.jpg", label: "Wrong photo" });
  expectStatus(await call(trainingApi, L, { action: "onboarding_remove_file", fileId: oops.fileId }), 404, "someone else's file");
  await ok(trainingApi, applicant, { action: "onboarding_remove_file", fileId: oops.fileId });
  if (!storageCalls.some(c => c.startsWith("remove hr-documents/"))) throw new Error("removed file not deleted from storage");
  const cardNow = (await ok(trainingApi, applicant, { action: "onboarding_view" })).items.find((i: any) => i.id === card.id);
  if (cardNow.files.map((f: any) => f.label).join("|") !== "White Card|Forklift licence" || cardNow.files[1].expiresOn !== "2030-05-01") throw new Error(`files wrong: ${JSON.stringify(cardNow.files)}`);

  const list = await ok(adminApi, HR, { action: "onboarding_list" });
  const req = list.requests.find((r: any) => r.id === sent.requestId);
  if (req.counts.toReview !== 2) throw new Error("form and upload not waiting for review");
  const detail = await ok(adminApi, HR, { action: "onboarding_detail", requestId: sent.requestId });
  const item = detail.items.find((i: any) => i.id === tfn.id);
  if (!item.sensitive) throw new Error("TFN not flagged sensitive");
  const tfnRow = item.answers.find((r: any) => r.key === "tfn");
  if (tfnRow?.value !== "123456782" || !tfnRow.sensitive) throw new Error(`HR should see the TFN, flagged sensitive: ${JSON.stringify(item.answers)}`);
  const cardRow = detail.items.find((i: any) => i.id === card.id);
  if (cardRow.files.length !== 2) throw new Error("HR should see both files");
  const view = await ok(adminApi, HR, { action: "onboarding_file", fileId: extra.fileId });
  if (!view.url) throw new Error("no viewing link");
  expectStatus(await call(adminApi, HR, { action: "onboarding_review", itemId: tfn.id, accept: false, reason: "" }), 409, "reject needs reason");
  await ok(adminApi, HR, { action: "onboarding_review", itemId: tfn.id, accept: false, reason: "Check your residency answer" });
  const again = await ok(trainingApi, applicant, { action: "onboarding_view" });
  const back = again.items.find((i: any) => i.id === tfn.id);
  if (back.rejectReason !== "Check your residency answer" || back.answers?.tfn !== "123456782") throw new Error("sent-back form should keep reason and answers");
  await ok(trainingApi, applicant, { action: "onboarding_submit_form", itemId: tfn.id, answers: { ...answers, residency: "A working holiday maker" } });
  const accTfn = await ok(adminApi, HR, { action: "onboarding_review", itemId: tfn.id, accept: true });
  if (accTfn.filed !== 1) throw new Error(`accepted TFN should be filed as one record: ${JSON.stringify(accTfn)}`);
  const accCard = await ok(adminApi, HR, { action: "onboarding_review", itemId: card.id, accept: true });
  if (accCard.filed !== 2) throw new Error("each certificate should be filed");

  // HR file: filed by category, generated record holds the answers, nothing duplicated.
  if (!storageCalls.some(c => c.startsWith(`store hr-documents/personnel/${emp.id}/tax/`))) throw new Error("TFN record not stored in the tax folder");
  if (!pdfText.includes("123456782") || !pdfText.some(t => t.includes("Tax file number declaration"))) throw new Error("record PDF missing the answers");
  expectStatus(await call(adminApi, L, { action: "personnel_view", employeeId: emp.id }), 403, "learner cannot open HR files");
  const file = await ok(adminApi, HR, { action: "personnel_view", employeeId: emp.id });
  if (file.filedNow !== 0) throw new Error("nothing should be filed twice");
  const cat = (k: string) => file.categories.find((c: any) => c.key === k).documents;
  if (cat("tax").length !== 1 || cat("tax")[0].source !== "onboarding_form") throw new Error("tax folder wrong");
  if (cat("licences").map((d: any) => d.title).sort().join("|") !== "Forklift licence|White Card") throw new Error(`licences folder wrong: ${JSON.stringify(cat("licences"))}`);
  if (cat("licences").find((d: any) => d.title === "Forklift licence").expiresOn !== "2030-05-01") throw new Error("expiry not carried into the HR file");
  const opened = await ok(adminApi, HR, { action: "personnel_open", documentId: cat("tax")[0].id });
  if (!opened.url) throw new Error("no link to the filed record");
  // HR adds a document directly, then archives it with a reason (never deleted).
  const prep = await ok(adminApi, HR, { action: "personnel_prepare_upload", employeeId: emp.id, category: "performance", fileName: "Probation review.pdf", size: 100 });
  const added = await ok(adminApi, HR, { action: "personnel_add", employeeId: emp.id, category: "performance", path: prep.path, fileName: "Probation review.pdf", title: "3-month probation review" });
  expectStatus(await call(adminApi, HR, { action: "personnel_add", employeeId: emp.id, category: "performance", path: `personnel/${emp.id}/tax/x.pdf`, title: "Wrong folder" }), 400, "path must match the folder");
  expectStatus(await call(adminApi, HR, { action: "personnel_archive", documentId: added.documentId, reason: "" }), 409, "archive needs a reason");
  await ok(adminApi, HR, { action: "personnel_archive", documentId: added.documentId, reason: "Uploaded to the wrong person" });
  const people = await ok(adminApi, HR, { action: "personnel_people" });
  if (people.people.find((p: any) => p.id === emp.id).documents !== 3) throw new Error("archived documents should not count");
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_submit_form", itemId: tfn.id, answers }), 409, "accepted is final");
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: card.id, fileName: "x.pdf", size: 100 }), 409, "accepted upload is final");
  const after = await ok(trainingApi, applicant, { action: "onboarding_view" });
  if (after.items.find((i: any) => i.id === tfn.id).answers !== null) throw new Error("accepted answers should not be sent back to the browser");
  const boot = await ok(trainingApi, applicant, { action: "bootstrap" });
  const requiredCount = types.types.filter((t: any) => forApplicants.includes(t.key) && t.required).length;
  if (boot.onboarding?.outstanding !== requiredCount - 2) throw new Error(`outstanding count wrong: ${JSON.stringify(boot.onboarding)}`);
  await ok(adminApi, HR, { action: "onboarding_type_save", key: "tickets", name: "Licences and tickets", guidance: "One PDF please.", required: false, active: true });
  await ok(adminApi, HR, { action: "onboarding_cancel", requestId: sent.requestId, reason: "Test complete" });
  if (!storageCalls.some(c => c.startsWith("upload hr-documents/"))) throw new Error("uploads did not go to the HR bucket");
});

Deno.test("contract signing: HR attaches the contract, the applicant signs, HR accepts, a signed copy is filed", async () => {
  const sha256 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)))].map(x => x.toString(16).padStart(2, "0")).join("");
  const bytesOf = (text: string) => new TextEncoder().encode(text);
  const pdfV1 = bytesOf("%PDF-1.7\n" + "Employment contract v1 ".repeat(40));
  const pdfV2 = bytesOf("%PDF-1.7\n" + "Employment contract v2, corrected start date ".repeat(40));
  const png = Uint8Array.from({ length: 400 }, (_, i) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? (i * 7) % 251);
  const pngUrl = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
  const BUCKET = "hr-documents";
  // What the browser does: ask for a signed upload link, then PUT the bytes to it.
  const upload = async (user: string, itemId: string, name: string, bytes: Uint8Array) => {
    const prepared = await ok(adminApi, user, { action: "onboarding_sign_prepare", itemId, fileName: name, size: bytes.length });
    putStorage(BUCKET, prepared.path, bytes);
    return prepared.path as string;
  };

  const emp = await ok(adminApi, A, { action: "employee_save", employeeNumber: "A-9010", fullName: "Contract  Signer", email: "contract.signer@panalo.test", employmentType: "applicant", status: "applicant" });
  const types = await ok(adminApi, HR, { action: "onboarding_types" });
  const esign = types.types.find((t: any) => t.key === "contract_esign");
  if (!esign || esign.kind !== "sign" || !esign.active) throw new Error("the sign-online contract item should be offered");
  if (types.types.find((t: any) => t.key === "contract")?.active) throw new Error("the old upload-a-signed-copy item should be retired");

  const sent = await ok(adminApi, HR, { action: "onboarding_create", employeeId: emp.id, types: ["contract_esign"], signIn: "invite" });
  const applicant = await profile("contract.signer@panalo.test");
  const itemOf = async () => (await ok(trainingApi, applicant, { action: "onboarding_view" })).items.find((i: any) => i.docType === "contract_esign");
  let item = await itemOf();
  if (item.kind !== "sign" || item.form || item.answers !== null || item.signDocs.length || item.signed) throw new Error(`fresh sign item wrong: ${JSON.stringify(item)}`);
  if (item.signAs !== "Contract Signer") throw new Error(`the name to type should be the register name, tidied: ${item.signAs}`);
  if (!/read and understood this contract/.test(item.agreementText)) throw new Error("agreement wording not sent to the portal");
  const sign = (extra: Record<string, unknown>) => call(trainingApi, applicant, { action: "onboarding_sign", itemId: item.id, agreed: true, ...extra });

  // Nothing to sign until HR attaches the contract.
  expectStatus(await sign({ method: "typed", name: "Contract Signer" }), 409, "no contract attached yet");

  // HR attaches it: PDFs only, checked and fingerprinted on the server.
  expectStatus(await call(adminApi, L, { action: "onboarding_sign_prepare", itemId: item.id, fileName: "contract.pdf", size: 100 }), 403, "a learner cannot attach contracts");
  expectStatus(await call(adminApi, HR, { action: "onboarding_sign_prepare", itemId: item.id, fileName: "contract.docx", size: 100 }), 400, "Word files are not accepted");
  expectStatus(await call(adminApi, HR, { action: "onboarding_sign_prepare", itemId: item.id, fileName: "contract.pdf", size: 30 * 1024 * 1024 }), 400, "too large");
  const notThere = await ok(adminApi, HR, { action: "onboarding_sign_prepare", itemId: item.id, fileName: "contract.pdf", size: 100 });
  expectStatus(await call(adminApi, HR, { action: "onboarding_sign_attach", itemId: item.id, path: notThere.path, label: "Employment contract" }), 409, "upload never arrived");
  const fake = await upload(HR, item.id, "fake.pdf", bytesOf("PK\u0003\u0004 this is a Word file renamed .pdf"));
  expectStatus(await call(adminApi, HR, { action: "onboarding_sign_attach", itemId: item.id, path: fake, label: "Contract" }), 400, "not really a PDF");
  expectStatus(await call(adminApi, HR, { action: "onboarding_sign_attach", itemId: item.id, path: `${sent.requestId}/elsewhere/x.pdf`, label: "Contract" }), 400, "path must belong to the item");
  const path1 = await upload(HR, item.id, "Employment contract.pdf", pdfV1);
  const attached = await ok(adminApi, HR, { action: "onboarding_sign_attach", itemId: item.id, path: path1, label: "Employment contract" });
  if (attached.sha256 !== await sha256(pdfV1)) throw new Error("fingerprint should be the SHA-256 of the stored bytes");

  let detail = (await ok(adminApi, HR, { action: "onboarding_detail", requestId: sent.requestId })).items.find((i: any) => i.id === item.id);
  if (detail.kind !== "sign" || detail.signDocs.length !== 1 || !detail.canChangeContract || detail.status !== "pending") throw new Error(`HR view wrong: ${JSON.stringify(detail)}`);

  // The applicant reads the contract: a short-lived link, only for their own, and audited.
  item = await itemOf();
  if (item.signDocs.length !== 1 || item.signDocs[0].label !== "Employment contract" || "sha256" in item.signDocs[0]) throw new Error("applicant should see the contract file (no internals)");
  const link = await ok(trainingApi, applicant, { action: "onboarding_contract_url", docId: item.signDocs[0].id });
  if (!link.url) throw new Error("no link to read the contract");
  expectStatus(await call(trainingApi, L, { action: "onboarding_contract_url", docId: item.signDocs[0].id }), 404, "someone else's contract");
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_contract_url", docId: "nope" }), 400, "bad id");
  if (!(await rest("training_audit_events?select=id&event_type=eq.onboarding_contract_viewed")).length) throw new Error("opening the contract should be audited");

  // Signing rules, in the order a person might trip over them.
  // A refused signature is a 400 that names the field to fix.
  const refused = async (result: Promise<{ status: number; body: any }>, label: string, field: string) => {
    const r = await result;
    expectStatus(r, 400, label);
    if (r.body.code !== `field:${field}`) throw new Error(`${label}: expected field:${field}, got ${JSON.stringify(r.body)}`);
    return r;
  };
  await refused(call(trainingApi, applicant, { action: "onboarding_sign", itemId: item.id, method: "typed", name: "Contract Signer" }), "agreement not ticked", "agreed");
  const wrongName = await refused(sign({ method: "typed", name: "Contract" }), "a first name is not a full name", "name");
  if (!/exactly as shown: Contract Signer/.test(wrongName.body.message)) throw new Error(`should say what to type: ${wrongName.body.message}`);
  await refused(sign({ method: "stamp" }), "unknown method", "method");
  await refused(sign({ method: "drawn", signatureImage: "data:image/png;base64,AAAA" }), "not a real signature image", "signature");
  await refused(sign({ method: "drawn", signatureImage: "data:image/svg+xml;base64," + btoa("<svg/>") }), "svg refused", "signature");
  expectStatus(await call(trainingApi, L, { action: "onboarding_sign", itemId: item.id, agreed: true, method: "typed", name: "Contract Signer" }), 404, "someone else's item");
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_submit_form", itemId: item.id, answers: {} }), 400, "a sign item is not a form");
  expectStatus(await call(trainingApi, applicant, { action: "onboarding_prepare_upload", itemId: item.id, fileName: "signed.pdf", size: 100 }), 400, "nor a scan-and-upload item");
  if ((await itemOf()).status !== "pending") throw new Error("failed attempts must leave the contract unsigned");

  // Typed signature: case and spacing are forgiven; the register spelling is what is recorded.
  await ok(trainingApi, applicant, { action: "onboarding_sign", itemId: item.id, agreed: true, method: "typed", name: "  contract   SIGNER " });
  item = await itemOf();
  if (item.status !== "uploaded" || item.signed?.name !== "Contract Signer" || item.signed?.method !== "typed" || !item.signed?.at || item.answers !== null) throw new Error(`signed state wrong: ${JSON.stringify(item)}`);
  expectStatus(await sign({ method: "typed", name: "Contract Signer" }), 409, "already signed");

  // Once signed, HR cannot swap the contract underneath the signature.
  expectStatus(await call(adminApi, HR, { action: "onboarding_sign_prepare", itemId: item.id, fileName: "other.pdf", size: 100 }), 409, "no new files once signed");
  expectStatus(await call(adminApi, HR, { action: "onboarding_sign_remove", docId: item.signDocs[0].id }), 409, "cannot remove once signed");
  detail = (await ok(adminApi, HR, { action: "onboarding_detail", requestId: sent.requestId })).items.find((i: any) => i.id === item.id);
  if (detail.canChangeContract || detail.status !== "uploaded") throw new Error("contract should be locked after signing");
  const rows = Object.fromEntries(detail.answers.map((r: any) => [r.label, r.value]));
  if (rows["Signed by"] !== "Contract Signer" || !/Typed their full name \("contract SIGNER"\)/.test(rows["How they signed"]) || rows["Contract file: Employment contract"] !== `SHA-256 ${await sha256(pdfV1)}`) throw new Error(`HR cannot see what was signed: ${JSON.stringify(rows)}`);
  expectStatus(await call(adminApi, HR, { action: "onboarding_sign_view", itemId: item.id }), 404, "a typed signature has no image");
  const signedEvent = await rest("training_audit_events?select=details&event_type=eq.onboarding_contract_signed");
  if (!signedEvent.length || !JSON.stringify(signedEvent).includes(await sha256(pdfV1))) throw new Error("signature not audited with the contract fingerprint");

  // Finalizing: HR shows where the signature and date go, previews, then finalizes. Nothing is accepted or filed before that.
  const spot = { page: "last", signature: { x: 0.55, y: 0.9 }, date: { x: 0.55, y: 0.93 } };
  const stillWaiting = async (why: string) => {
    const now = (await ok(adminApi, HR, { action: "onboarding_detail", requestId: sent.requestId })).items.find((i: any) => i.id === item.id);
    if (now.status !== "uploaded" || !now.canFinalize) throw new Error(`${why}: the signature should still be waiting to be finalized`);
  };
  detail = (await ok(adminApi, HR, { action: "onboarding_detail", requestId: sent.requestId })).items.find((i: any) => i.id === item.id);
  if (!detail.canFinalize) throw new Error("a signed contract should be ready to finalize");
  const noPlace = await call(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: true });
  expectStatus(noPlace, 400, "accepting a signed contract needs a placement");
  if (!/where the signature goes/.test(noPlace.body.message)) throw new Error(`should say what to do: ${noPlace.body.message}`);
  expectStatus(await call(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: true, placement: { page: "last", signature: { x: 2, y: 0.5 } } }), 400, "off the page");
  expectStatus(await call(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: true, placement: { page: 0, signature: { x: 0.5, y: 0.5 } } }), 400, "page 0");
  const farPage = await call(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: true, placement: { ...spot, page: 9 } });
  expectStatus(farPage, 400, "a page the contract does not have");
  if (!/has 2 pages/.test(farPage.body.message)) throw new Error(`should name the page count: ${farPage.body.message}`);
  expectStatus(await call(adminApi, L, { action: "onboarding_sign_preview", itemId: item.id, placement: spot }), 403, "a learner cannot preview");
  await stillWaiting("refused placements");

  // HR can see the contract's pages, and preview the stamped result without anything being stored.
  const shown = await ok(adminApi, HR, { action: "onboarding_sign_bytes", docId: detail.signDocs[0].id });
  if (atob(shown.pdf) !== new TextDecoder().decode(pdfV1)) throw new Error("HR should be shown the exact contract file");
  expectStatus(await call(adminApi, L, { action: "onboarding_sign_bytes", docId: detail.signDocs[0].id }), 403, "a learner cannot read contract files here");
  const storedBefore = storageCalls.filter(c => c.startsWith(`store ${BUCKET}/personnel/`)).length;
  const drawsBefore = pdfDraws.length;
  const preview = await ok(adminApi, HR, { action: "onboarding_sign_preview", itemId: item.id, placement: spot });
  if (!preview.pdf || !preview.size) throw new Error("no preview returned");
  if (!pdfText.some(t => t.includes("PREVIEW - not finalized yet"))) throw new Error("a preview must say it is not finalized");
  const previewDraws = pdfDraws.slice(drawsBefore);
  if (!previewDraws.some(d => d.text === "Contract Signer" && Math.abs(d.x - (0.55 * 595 + 2)) < 0.01 && Math.abs(d.y - (0.1 * 842 + 5)) < 0.01)) throw new Error(`typed name not stamped on the signature line: ${JSON.stringify(previewDraws)}`);
  if (!previewDraws.some(d => /^\d{1,2} \w{3,4} \d{4}$/.test(d.text ?? "") && Math.abs(d.x - (0.55 * 595 + 2)) < 0.01 && Math.abs(d.y - (0.07 * 842 + 3)) < 0.01)) throw new Error("date not stamped on the date line");
  if (storageCalls.filter(c => c.startsWith(`store ${BUCKET}/personnel/`)).length !== storedBefore) throw new Error("a preview must not store anything");
  await stillWaiting("after a preview");
  if (!(await rest("training_audit_events?select=id&event_type=eq.onboarding_contract_previewed")).length) throw new Error("previews should be audited");

  // HR spots a mistake in the contract: send it back, swap the file, the applicant signs again, this time by hand.
  expectStatus(await call(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: false, reason: "" }), 409, "send-back needs a reason");
  await ok(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: false, reason: "Wrong start date in the contract" });
  item = await itemOf();
  if (item.status !== "pending" && item.status !== "rejected") throw new Error("sent back");
  if (item.rejectReason !== "Wrong start date in the contract" || item.signed) throw new Error(`sent-back state wrong: ${JSON.stringify(item)}`);
  await ok(adminApi, HR, { action: "onboarding_sign_remove", docId: item.signDocs[0].id });
  const path2 = await upload(HR, item.id, "Employment contract v2.pdf", pdfV2);
  await ok(adminApi, HR, { action: "onboarding_sign_attach", itemId: item.id, path: path2, label: "Employment contract" });
  if (!hasStorage(BUCKET, path1)) throw new Error("a removed contract file must stay in storage (nothing in the HR bucket is deleted)");
  await ok(trainingApi, applicant, { action: "onboarding_sign", itemId: item.id, agreed: true, method: "drawn", signatureImage: pngUrl });
  item = await itemOf();
  if (item.status !== "uploaded" || item.signed?.method !== "drawn" || item.signed?.name !== "Contract Signer") throw new Error(`handwritten state wrong: ${JSON.stringify(item)}`);
  const sigPath = storageCalls.filter(c => c.startsWith(`store ${BUCKET}/${sent.requestId}/${item.id}/signature-`)).pop();
  if (!sigPath) throw new Error("handwriting image not stored in the HR bucket");
  detail = (await ok(adminApi, HR, { action: "onboarding_detail", requestId: sent.requestId })).items.find((i: any) => i.id === item.id);
  if (!detail.hasHandwriting || !(await ok(adminApi, HR, { action: "onboarding_sign_view", itemId: item.id })).url) throw new Error("HR should be able to open the handwriting");
  const v2Row = detail.answers.find((r: any) => r.key === "document0");
  if (v2Row.value !== `SHA-256 ${await sha256(pdfV2)}`) throw new Error("re-signing must record the new contract's fingerprint");

  // Integrity: if the stored contract no longer matches what was signed, the signature is not accepted at all.
  const drawn = { page: 2, signature: { x: 0.12, y: 0.8 }, date: null };
  putStorage(BUCKET, path2, bytesOf("%PDF-1.7 tampered"));
  const blocked = await call(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: true, placement: drawn });
  expectStatus(blocked, 409, "a changed contract");
  if (!/no longer matches/.test(blocked.body.message)) throw new Error(`should explain: ${blocked.body.message}`);
  await stillWaiting("a changed contract");
  if ((await ok(adminApi, HR, { action: "personnel_view", employeeId: emp.id })).categories.find((c: any) => c.key === "employment").documents.length) throw new Error("a changed contract must not be filed");

  // The file is put back. HR also counter-signs for Panalo (the Managing Director), by hand, on the same page.
  putStorage(BUCKET, path2, pdfV2);
  const company = { name: "  Rene   Fiestada ", position: "Managing Director", method: "drawn", signature: { x: 0.62, y: 0.8 }, date: { x: 0.62, y: 0.83 }, signatureImage: pngUrl };
  const refusedCompany = async (extra: Record<string, unknown>, pattern: RegExp, label: string) => {
    const r = await call(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: true, placement: drawn, company: { ...company, ...extra } });
    expectStatus(r, 400, label);
    if (!pattern.test(r.body.message)) throw new Error(`${label}: ${r.body.message}`);
  };
  await refusedCompany({ name: "" }, /name of the person signing for Panalo/, "counter-signature without a name");
  await refusedCompany({ method: "stamp" }, /how to sign for Panalo/, "counter-signature with an unknown method");
  await refusedCompany({ signature: undefined }, /place the Panalo signature/, "counter-signature not placed");
  await refusedCompany({ signatureImage: undefined }, /Write your name in the box/, "handwriting missing");
  await stillWaiting("a half-filled counter-signature");
  if (storageCalls.some(c => c.includes("/company-signature-"))) throw new Error("a refused counter-signature must not store an image");

  // Finalizing accepts and records what HR chose. This time filing hits a storage hiccup right after the acceptance.
  failNextStore(`${BUCKET}/personnel/${emp.id}/`);
  const finalized = await ok(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: true, placement: drawn, company });
  if (finalized.filed !== 0 || finalized.filingDeferred !== true || !finalized.requestComplete) throw new Error(`the acceptance should stand even if filing is deferred: ${JSON.stringify(finalized)}`);
  const companyImage = storageCalls.filter(c => c.startsWith(`store ${BUCKET}/${sent.requestId}/${item.id}/company-signature-`));
  if (companyImage.length !== 1) throw new Error(`the counter-signature image should be stored once: ${JSON.stringify(companyImage)}`);
  const kept = (await rest(`onboarding_items?select=finalize&id=eq.${item.id}`))[0].finalize;
  if (kept.placement.page !== 2 || kept.company.name !== "Rene Fiestada" || kept.company.position !== "Managing Director" || !kept.company.imagePath || kept.company.image) throw new Error(`what HR chose should be kept for the retry: ${JSON.stringify(kept)}`);
  const finalizedEvent = await rest("training_audit_events?select=details&event_type=eq.onboarding_contract_finalized");
  if (!JSON.stringify(finalizedEvent).includes("Rene Fiestada")) throw new Error("finalizing should be audited with who signed for Panalo");

  // Opening the HR folder retries the filing. It rebuilds the document exactly as HR finalized it.
  const drawsAtRetry = pdfDraws.length;
  const file = await ok(adminApi, HR, { action: "personnel_view", employeeId: emp.id });
  if (file.filedNow !== 1) throw new Error(`the retry should file the signed copy: ${file.filedNow}`);
  const rebuilt = pdfDraws.slice(drawsAtRetry);
  const near = (d: { x: number; y: number }, x: number, y: number) => Math.abs(d.x - x) < 0.01 && Math.abs(d.y - y) < 0.01;
  const ink = rebuilt.filter(d => d.image);
  if (!ink.some(d => near(d, 0.12 * 595 + 2, 0.2 * 842 + 3) && Math.abs((d.width ?? 0) - 120) < 0.01)) throw new Error(`applicant handwriting not stamped on the chosen line: ${JSON.stringify(ink)}`);
  if (!ink.some(d => near(d, 0.62 * 595 + 2, 0.2 * 842 + 3) && Math.abs((d.width ?? 0) - 120) < 0.01)) throw new Error(`Panalo's handwriting not stamped on its line: ${JSON.stringify(ink)}`);
  if (!rebuilt.some(d => /^\d{1,2} \w{3,4} \d{4}$/.test(d.text ?? "") && near(d, 0.62 * 595 + 2, 0.17 * 842 + 3))) throw new Error("Panalo's date not stamped on its date line");
  if (!pdfText.some(t => t === "Rene Fiestada (Managing Director)") || !pdfText.some(t => t === "Signed for Panalo by") || !pdfText.some(t => t === "Entered by (HR sign-in)")) throw new Error("the record should say who signed for Panalo and who entered it");
  if ((await ok(adminApi, HR, { action: "personnel_view", employeeId: emp.id })).filedNow !== 0) throw new Error("nothing should be filed twice");
  const employment = file.categories.find((c: any) => c.key === "employment").documents;
  if (employment.length !== 1 || employment[0].title !== "Employment contract (signed)") throw new Error(`HR folder wrong: ${JSON.stringify(employment)}`);
  if (!storageCalls.some(c => c.startsWith(`store ${BUCKET}/personnel/${emp.id}/employment/`) && c.includes("-signed-"))) throw new Error("signed PDF not stored in the employment folder");
  if (!pdfText.some(t => t.includes("Wrote their name on screen")) || !pdfText.some(t => t.includes("Contract Signer"))) throw new Error("signature record missing from the filed PDF");
  expectStatus(await call(adminApi, HR, { action: "onboarding_review", itemId: item.id, accept: true, placement: drawn }), 409, "already finalized");
  if (!(await ok(adminApi, HR, { action: "personnel_open", documentId: employment[0].id })).url) throw new Error("no link to the signed copy");
  const done = await ok(trainingApi, applicant, { action: "onboarding_view" });
  if (done.request?.status !== "complete") throw new Error("request should be complete");
});

Deno.test("learner invite with a temporary password", async () => {
  const mod = await one("training_modules?select=code&code=eq.PP-TRN-WLD-001");
  const res = await ok(adminApi, A, { action: "invite", fullName: "New Learner", email: "new.learner@panalo.test", learnerType: "employee", moduleCode: mod.code, expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(), signIn: "password" });
  if (!res.tempPassword || res.invitationSent) throw new Error("temporary password expected");
});
