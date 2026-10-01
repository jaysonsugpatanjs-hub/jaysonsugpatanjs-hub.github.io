import { api, completeAuthRedirect, config, friendlyError, getSession, isConfigured, signOut } from "../auth.js";
import { defaultContentVersion, endOfSydneyDayIso, moduleAuthoringTemplate, sortSlideFiles } from "./module-manager-core.js";
import { bindMatrix, bindPeople, loadMatrix, loadPeople } from "./people.js";
import { mountIms } from "../ims/ims.js";

const ui = {
  gate: document.getElementById("admin-gate"),
  app: document.getElementById("admin-app"),
  inviteForm: document.getElementById("invite-form"),
  inviteMessage: document.getElementById("invite-message"),
  registerBody: document.getElementById("register-body"),
  registerMessage: document.getElementById("register-message"),
  search: document.getElementById("search"),
  moduleForm: document.getElementById("module-form"),
  moduleMessage: document.getElementById("module-message"),
  moduleProgress: document.getElementById("module-upload-progress"),
  moduleRegisterBody: document.getElementById("module-register-body"),
  moduleRegisterMessage: document.getElementById("module-register-message")
};
let data = null;
let moduleData = null;
let imsRevisions = null;
let page = 0;
const loaded = new Set();
let ims = null;

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(value)) : "—";
}

function dateInputValue(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function defaultExpiry() {
  return dateInputValue(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000));
}

function renderSummary(summary) {
  document.getElementById("summary").innerHTML = [
    ["Active learners", summary.activeLearners],
    ["Open assignments", summary.openAssignments],
    ["Theory passed", summary.theoryPassed]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function statusLabel(assignment) {
  if (assignment.status === "revoked") return "Revoked";
  if (new Date(assignment.expiresAt).getTime() <= Date.now()) return "Expired";
  if (assignment.status === "theory_passed") return "Theory passed";
  return "Assigned";
}

function renderRegister() {
  const term = ui.search.value.trim().toLowerCase();
  const assignments = (data?.assignments || []).filter(assignment => {
    const haystack = [assignment.learner?.full_name, assignment.learner?.email, assignment.learner?.external_id, assignment.module?.code, assignment.module?.title].join(" ").toLowerCase();
    return !term || haystack.includes(term);
  });
  ui.registerBody.innerHTML = assignments.map(assignment => {
    const active = !["revoked"].includes(assignment.status) && new Date(assignment.expiresAt).getTime() > Date.now();
    const result = assignment.latestAttempt
      ? `${assignment.latestAttempt.score}% · ${assignment.latestAttempt.pass ? "Pass" : "Not passed"}`
      : "Not attempted";
    return `<tr><td><strong>${safe(assignment.learner?.full_name || "Unknown learner")}</strong><small>${safe(assignment.learner?.email || "")}</small><small>${safe(assignment.learner?.external_id || "No record ID")}</small></td>
      <td><strong>${safe(assignment.module?.code || "Unknown")}</strong><small>${safe(assignment.module?.revision || "")}</small></td><td><span class="status-chip ${safe(statusLabel(assignment).toLowerCase().replace(/\s/g, "-"))}">${safe(statusLabel(assignment))}</span></td>
      <td>${safe(result)}<small>${assignment.latestAttempt ? `Attempt ${assignment.latestAttempt.attemptNumber} · ${safe(formatDate(assignment.latestAttempt.submittedAt))}` : ""}</small></td><td>${safe(formatDate(assignment.expiresAt))}</td>
      <td>${active ? `<button class="revoke" type="button" data-assignment="${safe(assignment.id)}" data-learner="${safe(assignment.learner?.full_name || assignment.learner?.email)}">Revoke</button>` : "—"}</td></tr>`;
  }).join("");
  ui.registerMessage.textContent = assignments.length ? "" : "No assignments match this search.";
  ui.registerBody.querySelectorAll(".revoke").forEach(button => button.addEventListener("click", revokeAssignment));
}

function renderModuleCatalog() {
  const modules = new Map((moduleData?.modules || []).map(module => [module.id, module]));
  const versions = moduleData?.versions || [];
  ui.moduleRegisterBody.innerHTML = versions.map(version => {
    const module = modules.get(version.moduleId) || {};
    const release = version.published ? (version.current ? "Current published" : "Published archive") : "Secure draft";
    const missing = version.assets?.missing || [];
    const assetDetail = version.assets?.ready
      ? "Complete and validated"
      : missing.length <= 3 ? `Missing: ${missing.join(", ")}` : `${missing.length} files missing`;
    const imsApproved = version.ims?.status === "approved";
    const imsCell = version.ims
      ? `<strong>${safe(version.ims.docNumber)} ${safe(version.ims.revision)}</strong><small><span class="chip ${imsApproved ? "good" : "pending"}">${imsApproved ? "Approved" : "Awaiting approval"}</span></small>`
      : version.published ? '<small>Published before IMS control</small>' : linkSelect(version);
    const action = version.published
      ? '<span class="status-chip theory-passed">Published</span>'
      : `<button class="secondary-action publish-module" type="button" data-version="${safe(version.id)}" data-label="${safe(`${version.code} ${version.revision}`)}" ${version.assets?.ready && imsApproved ? "" : "disabled"}>Publish</button>
         <small>${!version.assets?.ready ? "Upload every slide first." : !version.ims ? "Link its IMS revision first." : !imsApproved ? "Waiting for IMS approval." : "Ready to publish."}</small>`;
    return `<tr><td><strong>${safe(version.code)}</strong><small>${safe(module.title || "")}</small><small>${safe(module.status || "draft")}</small></td>
      <td><strong>${safe(version.revision)}</strong><small>${safe(version.contentVersion)}</small><small>${version.slideCount} slides · ${version.passMark}% pass</small></td>
      <td><strong>${version.assets?.present || 0}/${version.assets?.expected || version.slideCount + 1}</strong><small>${safe(assetDetail)}</small></td>
      <td>${imsCell}</td>
      <td><span class="status-chip ${version.published ? "theory-passed" : ""}">${safe(release)}</span></td><td>${action}</td></tr>`;
  }).join("");
  ui.moduleRegisterMessage.textContent = versions.length ? "" : "No module versions have been created.";
  ui.moduleRegisterBody.querySelectorAll(".publish-module").forEach(button => button.addEventListener("click", publishModule));
  ui.moduleRegisterBody.querySelectorAll(".link-ims").forEach(button => button.addEventListener("click", linkIms));
}

function linkSelect(version) {
  const docs = (imsRevisions?.documents || []).filter(doc => !doc.trainingModuleId || doc.trainingModuleId === version.moduleId);
  const options = docs.flatMap(doc => doc.revisions.map(revision => `<option value="${safe(revision.id)}">${safe(doc.docNumber)} ${safe(revision.revision)} (${revision.status === "approved" ? "approved" : "in approval"})</option>`)).join("");
  if (!options) return '<small>Create this module\'s document and revision under IMS documents, then link it here.</small>';
  return `<label class="sr-only" for="ims-${safe(version.id)}">IMS revision for ${safe(version.code)}</label>
    <select id="ims-${safe(version.id)}" class="ims-select">${options}</select>
    <button type="button" class="secondary-action small link-ims" data-version="${safe(version.id)}">Link</button>`;
}

async function linkIms(event) {
  const button = event.currentTarget;
  const select = document.getElementById(`ims-${button.dataset.version}`);
  button.disabled = true;
  ui.moduleRegisterMessage.textContent = "Linking the IMS revision…";
  try {
    await api(config.adminFunction, { action: "module_link_ims", versionId: button.dataset.version, revisionId: select.value });
    await loadModules();
    ui.moduleRegisterMessage.textContent = "Linked. Publishing unlocks once that revision is approved.";
  } catch (error) {
    ui.moduleRegisterMessage.textContent = friendlyError(error);
    button.disabled = false;
  }
}

async function loadDashboard(append = false) {
  ui.registerMessage.textContent = "Loading the controlled register…";
  page = append ? page + 1 : 0;
  const result = await api(config.adminFunction, { action: "dashboard", page });
  data = append && data ? { ...result, assignments: [...data.assignments, ...result.assignments] } : result;
  document.getElementById("load-more").classList.toggle("hidden", !result.paging?.hasMore);
  document.getElementById("admin-identity").textContent = `Signed in as ${data.administrator.fullName || data.administrator.email}`;
  renderSummary(data.summary);
  const moduleSelect = document.getElementById("module-code");
  moduleSelect.innerHTML = data.modules.filter(module => module.published).map(module => `<option value="${safe(module.code)}">${safe(module.code)} — ${safe(module.title)} (${safe(module.revision)})</option>`).join("");
  renderRegister();
}

async function loadModules() {
  ui.moduleRegisterMessage.textContent = "Checking private module assets…";
  [moduleData, imsRevisions] = await Promise.all([
    api(config.adminFunction, { action: "module_catalog" }),
    api(config.adminFunction, { action: "module_ims_revisions" })
  ]);
  renderModuleCatalog();
}

async function revokeAssignment(event) {
  const button = event.currentTarget;
  const learner = button.dataset.learner;
  if (!window.confirm(`Revoke ${learner}'s access to this assignment? Their existing audit records will be retained.`)) return;
  button.disabled = true;
  ui.registerMessage.textContent = "Revoking access…";
  try {
    await api(config.adminFunction, { action: "revoke", assignmentId: button.dataset.assignment, reason: "Access ended by training administrator" });
    await loadDashboard();
    ui.registerMessage.textContent = "Access revoked and recorded.";
  } catch (error) {
    ui.registerMessage.textContent = friendlyError(error);
    button.disabled = false;
  }
}

async function publishModule(event) {
  const button = event.currentTarget;
  if (!window.confirm(`Publish ${button.dataset.label}? Published versions are immutable and become available for assignment.`)) return;
  button.disabled = true;
  ui.moduleRegisterMessage.textContent = "Publishing the validated module version…";
  try {
    const result = await api(config.adminFunction, { action: "module_publish", versionId: button.dataset.version });
    await Promise.all([loadModules(), loadDashboard()]);
    ui.moduleRegisterMessage.textContent = `${result.module.code} ${result.version.revision} is published and available for assignment.`;
  } catch (error) {
    ui.moduleRegisterMessage.textContent = friendlyError(error);
    button.disabled = false;
  }
}

const MAX_SLIDE_WIDTH = 1600;
const MAX_SLIDE_HEIGHT = 900;
const SLIDE_WEBP_QUALITY = 0.8;

async function convertImageToWebp(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SLIDE_WIDTH / bitmap.width, MAX_SLIDE_HEIGHT / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    value => value ? resolve(value) : reject(new Error(`Could not convert ${file.name} to WebP.`)),
    "image/webp",
    SLIDE_WEBP_QUALITY
  ));
  return blob;
}

async function uploadSignedAsset(upload, body) {
  const response = await fetch(upload.signedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": upload.contentType,
      "Cache-Control": "max-age=31536000, immutable",
      "x-upsert": "true"
    },
    body
  });
  if (!response.ok) throw new Error(`Private upload failed for ${upload.filename} (${response.status}).`);
}

async function runUploadQueue(tasks, onProgress, concurrency = 3) {
  let next = 0;
  let complete = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      await uploadSignedAsset(task.upload, task.body);
      complete += 1;
      onProgress(complete, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
}

async function createModuleDraft(event) {
  event.preventDefault();
  const button = ui.moduleForm.querySelector('button[type="submit"]');
  const form = new FormData(ui.moduleForm);
  const authoringFile = form.get("authoring");
  const powerpoint = form.get("powerpoint");
  const slideFiles = sortSlideFiles(document.getElementById("module-slides").files || []);
  button.disabled = true;
  ui.moduleProgress.classList.remove("hidden");
  ui.moduleProgress.value = 2;
  ui.moduleMessage.textContent = "Validating the authoring package…";
  try {
    if (!(authoringFile instanceof File) || !authoringFile.size) throw new Error("Choose the authoring JSON file.");
    if (!(powerpoint instanceof File) || !/\.pptx$/i.test(powerpoint.name) || !powerpoint.size) throw new Error("Choose a valid PPTX source file.");
    if (powerpoint.size > 25 * 1024 * 1024) throw new Error("The source PowerPoint must be no larger than 25 MB.");
    let authoringManifest;
    try { authoringManifest = JSON.parse(await authoringFile.text()); } catch (_) { throw new Error("The authoring JSON is not valid JSON."); }
    const expectedSlides = Array.isArray(authoringManifest?.slides) ? authoringManifest.slides.length : 0;
    if (expectedSlides < 2) throw new Error("The authoring JSON must contain at least two slides.");
    if (slideFiles.length !== expectedSlides) throw new Error(`Select exactly ${expectedSlides} rendered slide images; ${slideFiles.length} were selected.`);

    ui.moduleProgress.value = 8;
    const draft = await api(config.adminFunction, {
      action: "module_save_draft",
      code: form.get("code"),
      title: form.get("title"),
      description: form.get("description"),
      revision: form.get("revision"),
      contentVersion: form.get("contentVersion"),
      passMark: Number(form.get("passMark")),
      practicalRequired: document.getElementById("module-practical").checked,
      authoringManifest
    });

    const convertedSlides = [];
    for (let index = 0; index < slideFiles.length; index += 1) {
      ui.moduleMessage.textContent = `Preparing slide ${index + 1} of ${slideFiles.length}…`;
      convertedSlides.push(await convertImageToWebp(slideFiles[index]));
      ui.moduleProgress.value = 10 + Math.round((index + 1) / slideFiles.length * 20);
    }

    const prepared = await api(config.adminFunction, {
      action: "module_prepare_uploads",
      versionId: draft.version.id,
      assets: [
        { kind: "source", size: powerpoint.size },
        ...convertedSlides.map((slide, index) => ({ kind: "slide", slideNumber: index + 1, size: slide.size }))
      ]
    });
    const bodies = new Map([["source.pptx", powerpoint], ...convertedSlides.map((slide, index) => [`slide-${String(index + 1).padStart(2, "0")}.webp`, slide])]);
    const tasks = prepared.uploads.map(upload => ({ upload, body: bodies.get(upload.filename) }));
    ui.moduleMessage.textContent = "Uploading directly to private training storage…";
    await runUploadQueue(tasks, (complete, total) => { ui.moduleProgress.value = 30 + Math.round(complete / total * 60); });
    const validation = await api(config.adminFunction, { action: "module_validate", versionId: draft.version.id });
    if (!validation.assets.ready) throw new Error(`Upload incomplete. Missing: ${validation.assets.missing.join(", ")}.`);
    ui.moduleProgress.value = 100;
    ui.moduleMessage.textContent = `${draft.module.code} ${draft.version.revision} is stored privately and ready for publication.`;
    ui.moduleForm.reset();
    document.getElementById("module-new-revision").value = "Draft Rev 1";
    document.getElementById("module-pass-mark").value = "80";
    document.getElementById("module-practical").checked = true;
    document.getElementById("module-content-version").value = defaultContentVersion();
    await loadModules();
  } catch (error) {
    ui.moduleMessage.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
}

function downloadAuthoringTemplate() {
  const blob = new Blob([`${JSON.stringify(moduleAuthoringTemplate(), null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "panalo-module-authoring-template.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function loadView(selected) {
  if (loaded.has(selected)) return;
  loaded.add(selected);
  try {
    if (selected === "people-management") await loadPeople(document.getElementById(selected));
    if (selected === "competency-matrix") await loadMatrix(document.getElementById(selected));
    if (selected === "ims-documents") { ims = ims || mountIms(document.getElementById(selected)); await ims.open(); }
  } catch (error) {
    loaded.delete(selected);
    const target = document.querySelector(`#${selected} .form-message`);
    if (target) target.textContent = friendlyError(error);
  }
}

function switchAdminView(event) {
  const selected = event.currentTarget.dataset.adminView;
  loadView(selected);
  document.querySelectorAll(".admin-view").forEach(view => view.classList.toggle("hidden", view.id !== selected));
  document.querySelectorAll(".admin-tab").forEach(tab => {
    const active = tab.dataset.adminView === selected;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
}

ui.inviteForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = ui.inviteForm.querySelector('button[type="submit"]');
  const form = new FormData(ui.inviteForm);
  button.disabled = true;
  ui.inviteMessage.textContent = "Creating controlled access and sending the invitation…";
  try {
    const result = await api(config.adminFunction, {
      action: "invite",
      fullName: form.get("fullName"),
      email: form.get("email"),
      learnerType: form.get("learnerType"),
      externalId: form.get("externalId"),
      moduleCode: form.get("moduleCode"),
      expiresAt: endOfSydneyDayIso(String(form.get("expiresOn")))
    });
    ui.inviteMessage.textContent = result.invitationSent
      ? "Invitation sent and module assigned."
      : "Existing verified account updated and module assigned.";
    ui.inviteForm.reset();
    document.getElementById("expires-on").value = defaultExpiry();
    await loadDashboard();
  } catch (error) {
    ui.inviteMessage.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});

ui.moduleForm.addEventListener("submit", createModuleDraft);
ui.search.addEventListener("input", renderRegister);
document.getElementById("refresh").addEventListener("click", () => {
  const visible = document.querySelector(".admin-view:not(.hidden)")?.id;
  loaded.clear();
  loaded.add("access-management");
  loaded.add("module-management");
  return Promise.all([loadDashboard(), loadModules(), visible ? loadView(visible) : null]).catch(error => { ui.registerMessage.textContent = friendlyError(error); });
});
document.getElementById("load-more").addEventListener("click", () => loadDashboard(true).catch(error => { ui.registerMessage.textContent = friendlyError(error); }));
bindPeople(document.getElementById("people-management"));
bindMatrix(document.getElementById("competency-matrix"));
document.getElementById("refresh-modules").addEventListener("click", () => loadModules().catch(error => { ui.moduleRegisterMessage.textContent = friendlyError(error); }));
document.getElementById("download-module-template").addEventListener("click", downloadAuthoringTemplate);
document.querySelectorAll(".admin-tab").forEach(tab => tab.addEventListener("click", switchAdminView));
document.getElementById("sign-out").addEventListener("click", async () => { await signOut(); window.location.href = "../"; });

async function init() {
  const redirect = completeAuthRedirect();
  if (!isConfigured()) {
    document.getElementById("gate-title").textContent = "Secure service connection pending";
    document.getElementById("gate-message").textContent = "Configure the Supabase project URL and publishable key before using training administration.";
    return;
  }
  if (redirect.error) {
    document.getElementById("gate-title").textContent = "Sign-in link could not be verified";
    document.getElementById("gate-message").textContent = redirect.error;
    return;
  }
  if (!await getSession()) {
    document.getElementById("gate-title").textContent = "Administrator sign-in required";
    document.getElementById("gate-message").textContent = "Sign in through the learner portal using an administrator email.";
    return;
  }
  try {
    document.getElementById("expires-on").value = defaultExpiry();
    document.getElementById("module-content-version").value = defaultContentVersion();
    await Promise.all([loadDashboard(), loadModules()]);
    ui.gate.classList.add("hidden");
    ui.app.classList.remove("hidden");
  } catch (error) {
    document.getElementById("gate-title").textContent = error?.status === 403 ? "Administrator access required" : "Administration unavailable";
    document.getElementById("gate-message").textContent = friendlyError(error);
  }
}

init();
