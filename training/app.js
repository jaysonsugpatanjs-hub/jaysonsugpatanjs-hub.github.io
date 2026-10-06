import {
  api,
  completeAuthRedirect,
  config,
  friendlyError,
  getSession,
  isConfigured,
  requestPasswordReset,
  signInWithPassword,
  signOut
} from "./auth.js";

const $ = id => document.getElementById(id);
const ui = {
  setup: $("setup-panel"),
  signIn: $("sign-in-panel"),
  password: $("password-panel"),
  dashboard: $("dashboard"),
  form: $("sign-in-form"),
  resetForm: $("reset-form"),
  passwordForm: $("password-form"),
  authMessage: $("auth-message"),
  resetMessage: $("reset-message"),
  passwordMessage: $("password-message"),
  dashboardMessage: $("dashboard-message"),
  moduleGrid: $("module-grid"),
  signOut: $("sign-out"),
  adminLink: $("admin-link"),
  imsLink: $("ims-link"),
  onboarding: $("onboarding")
};

function show(name) {
  ui.setup.classList.toggle("hidden", name !== "setup");
  ui.signIn.classList.toggle("hidden", name !== "signIn");
  ui.password.classList.toggle("hidden", name !== "password");
  ui.dashboard.classList.toggle("hidden", name !== "dashboard");
  ui.signOut.classList.toggle("hidden", !["dashboard", "password"].includes(name));
  ui.imsLink.classList.toggle("hidden", name !== "dashboard");
  if (name !== "dashboard") ui.adminLink.classList.add("hidden");
}

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  if (!value) return "No expiry set";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(value));
}

function askForPassword(reason) {
  const intro = {
    invite: ["Welcome to Panalo", "Choose the password you'll use to sign in from now on."],
    recovery: ["Reset your password", "Choose a new password. It replaces your old one straight away."],
    temporary: ["Choose your own password", "You signed in with a temporary password. Choose your own to continue."]
  }[reason] || ["Choose your password", "Set a password you'll use to sign in from now on."];
  $("password-title").textContent = intro[0];
  $("password-intro").textContent = intro[1];
  ui.passwordForm.reset();
  ui.passwordMessage.textContent = "";
  show("password");
  $("new-password").focus();
}

function renderAssignments(assignments) {
  ui.moduleGrid.replaceChildren();
  $("assignment-count").textContent = `${assignments.length} active assignment${assignments.length === 1 ? "" : "s"}`;
  if (!assignments.length) {
    const empty = document.createElement("article");
    empty.className = "module-card empty-assignment";
    empty.innerHTML = "<div class=\"module-body\"><div class=\"code\">NO ACTIVE MODULES</div><h3>No training is assigned to you yet</h3><p>Contact the Panalo Pipes training administrator if you expected an assignment.</p></div>";
    ui.moduleGrid.appendChild(empty);
    return;
  }
  assignments.forEach(assignment => {
    const card = document.createElement("a");
    card.className = "module-card available secure-module";
    card.href = `./modules/?assignment=${encodeURIComponent(assignment.id)}`;
    const progress = Number(assignment.progressPercent || 0);
    const status = assignment.theoryPassedAt ? "THEORY PASSED" : progress ? "IN PROGRESS" : "ASSIGNED";
    card.innerHTML = `<div class="module-visual secure-cover"><div><span>${safe(assignment.module.code)}</span><strong>${safe(assignment.module.title)}</strong></div><span class="status">${status}</span></div>
      <div class="module-body"><div class="code">${safe(assignment.module.code)} · ${safe(assignment.module.revision)}</div><h3>${safe(assignment.module.title)}</h3>
      <p>${safe(assignment.module.description)}</p><div class="progress-line" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i></i></div>
      <div class="meta"><span>${progress}% complete</span><span>Expires ${safe(formatDate(assignment.expiresAt))}</span><span>${assignment.module.practicalRequired ? "Practical verification required" : "Online theory"}</span></div>
      <div class="open">${assignment.theoryPassedAt ? "View result and certificate" : "Open assigned module"}<span>→</span></div></div>`;
    // Set through the DOM: the page's security policy blocks inline style attributes.
    card.querySelector(".progress-line i").style.width = `${Math.max(0, Math.min(100, progress))}%`;
    ui.moduleGrid.appendChild(card);
  });
}

/* ---------------- Onboarding documents ---------------- */

const ITEM_STATUS = {
  pending: ["To do", "pending"],
  uploaded: ["Sent · waiting for HR", "info"],
  accepted: ["Accepted", "good"],
  rejected: ["Needs fixing", "bad"]
};
const formItems = new Map();
// Items where each file gets its own name and optional expiry.
const CERT_NAMES = `<datalist id="cert-names">${["White Card", "Forklift licence (LF)", "Elevating work platform (WP)", "Dogging (DG)", "Basic rigging (RB)", "Basic scaffolding (SB)", "Working at heights", "Confined space entry", "First aid (HLTAID011)", "Welding certificate", "Trade certificate", "Driver licence (heavy vehicle)"].map(n => `<option value="${n}">`).join("")}</datalist>`;
const NAMED_UPLOADS = new Set(["certificates", "tickets", "public_liability", "workers_comp"]);

function fieldHtml(itemId, field, answers) {
  const id = `f-${itemId}-${field.key}`;
  const value = answers?.[field.key];
  const hidden = field.when && !field.when.in.includes(String(answers?.[field.when.field] ?? "")) ? " hidden" : "";
  const when = field.when ? ` data-when="${safe(field.when.field)}" data-when-in="${safe(JSON.stringify(field.when.in))}"` : "";
  const help = field.help ? `<small>${safe(field.help)}</small>` : "";
  const error = `<small class="field-error" data-error-for="${safe(field.key)}"></small>`;
  const label = `${safe(field.label)}${field.optional ? ' <span class="muted">(optional)</span>' : ""}`;
  const common = `name="${safe(field.key)}" id="${id}"${field.autocomplete ? ` autocomplete="${safe(field.autocomplete)}"` : ""}`;
  if (field.type === "confirm") {
    return `<div class="field onb-field${hidden}"${when}><label class="check-field"><input type="checkbox" ${common} ${value === true ? "checked" : ""}><span>${safe(field.label)}</span></label>${error}</div>`;
  }
  if (field.type === "yesno") {
    return `<fieldset class="field onb-field yesno${hidden}"${when}><legend>${label}</legend>
      ${["Yes", "No"].map(v => `<label><input type="radio" name="${safe(field.key)}" value="${v}" ${value === v ? "checked" : ""}> ${v}</label>`).join("")}${help}${error}</fieldset>`;
  }
  let control;
  if (field.type === "select") {
    control = `<select ${common}><option value="">Choose…</option>${field.options.map(o => `<option ${value === o ? "selected" : ""}>${safe(o)}</option>`).join("")}</select>`;
  } else {
    const type = field.type === "date" ? "date" : field.type === "tel" ? "tel" : "text";
    const mode = ["tfn", "abn", "bsb", "account", "postcode"].includes(field.format) ? ' inputmode="numeric"' : "";
    control = `<input type="${type}" ${common}${mode} value="${safe(value ?? "")}"${field.placeholder ? ` placeholder="${safe(field.placeholder)}"` : ""}${field.maxLength ? ` maxlength="${field.maxLength}"` : ""}>`;
  }
  return `<div class="field onb-field${hidden}"${when}><label for="${id}">${label}</label>${control}${help}${error}</div>`;
}

function formHtml(item, open) {
  const form = item.form;
  return `<form class="onb-form${open ? "" : " hidden"}" data-form-item="${safe(item.id)}" novalidate>
    ${form.intro ? `<p class="muted small">${safe(form.intro)}</p>` : ""}
    ${form.link ? `<p class="small"><a href="${safe(form.link.href)}" target="_blank" rel="noopener">${safe(form.link.label)} ↗</a></p>` : ""}
    <div class="onb-fields">${form.fields.map(f => fieldHtml(item.id, f, item.answers)).join("")}</div>
    <div class="form-actions"><button class="primary" type="submit">${item.status === "pending" ? "Send to HR" : "Send changes"}</button>
      ${item.status === "uploaded" ? '<button type="button" class="text-button" data-cancel-edit>Cancel</button>' : ""}</div>
    <p class="form-message" data-form-msg role="status" aria-live="polite"></p>
  </form>`;
}

function itemHtml(item) {
  const [label, tone] = ITEM_STATUS[item.status] || [item.status, ""];
  const chips = `${item.required ? "" : '<span class="chip">Optional</span>'}${item.sensitive ? '<span class="chip info">Restricted to HR</span>' : ""}`;
  const reject = item.status === "rejected" && item.rejectReason ? `<p class="reject-note">HR says: ${safe(item.rejectReason)}</p>` : "";
  if (item.kind === "form" && item.form) {
    formItems.set(item.id, item);
    const editable = item.status !== "accepted";
    const openForm = item.status === "pending" || item.status === "rejected";
    return `<article class="onboarding-item onb-form-item" data-item-card="${safe(item.id)}">
      <div class="onb-head"><div class="onboarding-text">
          <div class="onboarding-title"><strong>${safe(item.name)}</strong>${chips}</div>
          <p class="muted small">${safe(item.guidance)}</p>${reject}</div>
        <div class="onboarding-actions"><span class="chip ${tone}">${label}</span>
          ${item.status === "uploaded" ? `<button type="button" class="secondary-action small" data-edit="${safe(item.id)}">Edit answers</button>` : ""}</div></div>
      ${editable ? formHtml(item, openForm) : ""}
    </article>`;
  }
  formItems.set(item.id, item);
  const named = NAMED_UPLOADS.has(item.docType);
  const files = item.files || [];
  const editable = item.status !== "accepted";
  return `<article class="onboarding-item onb-form-item" data-item-card="${safe(item.id)}">
      <div class="onb-head"><div class="onboarding-text">
          <div class="onboarding-title"><strong>${safe(item.name)}</strong>${chips}<span class="chip">Photos or PDF</span></div>
          <p class="muted small">${safe(item.guidance)}</p>${reject}</div>
        <div class="onboarding-actions"><span class="chip ${tone}">${label}</span></div></div>
      ${files.length ? `<ul class="file-list">${files.map(f => `<li>
          <div><strong>${safe(f.label)}</strong><small>${safe(f.fileName)}${f.expiresOn ? ` · expires ${safe(formatDate(f.expiresOn))}` : ""}</small></div>
          ${editable ? `<button type="button" class="text-button danger" data-remove-file="${safe(f.id)}" aria-label="Remove ${safe(f.label)}">Remove</button>` : ""}</li>`).join("")}</ul>` : ""}
      ${editable ? `<div class="add-file" data-add-for="${safe(item.id)}">
        ${named ? `<div class="field onb-field"><label for="lbl-${safe(item.id)}">What is it?</label>
            <input id="lbl-${safe(item.id)}" data-file-label list="cert-names" maxlength="80" placeholder="e.g. White Card, Forklift licence"></div>
          <div class="field onb-field"><label for="exp-${safe(item.id)}">Expiry date <span class="muted">(if it has one)</span></label>
            <input id="exp-${safe(item.id)}" type="date" data-file-expiry></div>` : ""}
        <label class="upload-button">
          <input type="file" multiple data-item="${safe(item.id)}" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*">
          <span>${files.length ? "Add more" : "Take photo or upload"}</span></label>
        <p class="form-message" data-file-msg role="status" aria-live="polite"></p>
      </div>` : ""}
    </article>`;
}

async function loadOnboarding() {
  const data = await api(config.trainingFunction, { action: "onboarding_view" });
  if (!data.request || data.request.status !== "open") {
    ui.onboarding.classList.add("hidden");
    return;
  }
  const items = data.items || [];
  const required = items.filter(i => i.required);
  const done = required.filter(i => i.status === "accepted" || i.status === "uploaded").length;
  $("onboarding-progress").textContent = `${done} of ${required.length} required items sent`;
  $("onboarding-intro").textContent = [
    data.request.message,
    data.request.dueOn ? `Due by ${formatDate(data.request.dueOn)}.` : ""
  ].filter(Boolean).join(" ") || "Fill in each item below. Only certificates and your signed contract need a photo or PDF.";
  formItems.clear();
  // Forms first, then the few uploads.
  const ordered = [...items.filter(i => i.kind === "form"), ...items.filter(i => i.kind !== "form")];
  $("onboarding-items").innerHTML = ordered.map(itemHtml).join("") + CERT_NAMES;
  ui.onboarding.classList.remove("hidden");
}

function collectAnswers(form, item) {
  const answers = {};
  for (const field of item.form.fields) {
    if (field.type === "confirm") answers[field.key] = form.elements[field.key].checked;
    else if (field.type === "yesno") answers[field.key] = form.querySelector(`input[name="${field.key}"]:checked`)?.value || "";
    else answers[field.key] = form.elements[field.key].value;
  }
  return answers;
}

function refreshConditions(form) {
  form.querySelectorAll("[data-when]").forEach(el => {
    const control = form.elements[el.dataset.when];
    const current = control?.value ?? "";
    el.classList.toggle("hidden", !JSON.parse(el.dataset.whenIn).includes(current));
  });
}

async function submitOnboardingForm(form) {
  const item = formItems.get(form.dataset.formItem);
  if (!item) return;
  const msg = form.querySelector("[data-form-msg]");
  const button = form.querySelector('button[type="submit"]');
  form.querySelectorAll("[data-error-for]").forEach(e => { e.textContent = ""; });
  form.querySelectorAll(".invalid").forEach(e => e.classList.remove("invalid"));
  button.disabled = true;
  msg.textContent = "Sending…";
  try {
    await api(config.trainingFunction, { action: "onboarding_submit_form", itemId: item.id, answers: collectAnswers(form, item) });
    await loadOnboarding();
    $("onboarding-message").textContent = `${item.name} sent to HR.`;
  } catch (error) {
    msg.textContent = friendlyError(error);
    const key = String(error.code || "").startsWith("field:") ? error.code.slice(6) : "";
    const slot = key && form.querySelector(`[data-error-for="${CSS.escape(key)}"]`);
    if (slot) {
      slot.textContent = error.message;
      msg.textContent = "Check the highlighted answer.";
      const control = form.elements[key];
      const el = control instanceof RadioNodeList ? control[0] : control;
      el?.closest(".onb-field")?.classList.add("invalid");
      el?.focus();
    }
    button.disabled = false;
  }
}

async function uploadOnboardingFile(input) {
  const files = [...(input.files || [])];
  if (!files.length) return;
  const box = input.closest("[data-add-for]");
  const item = formItems.get(input.dataset.item);
  const message = box.querySelector("[data-file-msg]");
  const labelInput = box.querySelector("[data-file-label]");
  const expiry = box.querySelector("[data-file-expiry]")?.value || null;
  const label = labelInput ? labelInput.value.trim() : item?.name;
  if (labelInput && label.length < 2) {
    message.textContent = "Type what it is first, for example \"White Card\", then choose the photo.";
    input.value = "";
    labelInput.focus();
    return;
  }
  const big = files.find(f => f.size > 20 * 1024 * 1024);
  if (big) {
    message.textContent = `${big.name} is over 20 MB. Try a PDF or a smaller photo.`;
    input.value = "";
    return;
  }
  input.disabled = true;
  try {
    for (const [n, file] of files.entries()) {
      message.textContent = files.length > 1 ? `Uploading ${n + 1} of ${files.length}…` : `Uploading ${file.name}…`;
      const prepared = await api(config.trainingFunction, { action: "onboarding_prepare_upload", itemId: input.dataset.item, fileName: file.name, size: file.size });
      const res = await fetch(prepared.signedUrl, { method: "PUT", headers: { "Content-Type": prepared.contentType }, body: file });
      if (!res.ok) throw new Error(`The upload of ${file.name} failed (${res.status}). Please try again.`);
      await api(config.trainingFunction, { action: "onboarding_attach", itemId: input.dataset.item, path: prepared.path, fileName: file.name, label, expiresOn: expiry });
    }
    await loadOnboarding();
    $("onboarding-message").textContent = `${label} uploaded. HR will review it.`;
  } catch (error) {
    message.textContent = friendlyError(error);
    input.disabled = false;
    input.value = "";
  }
}

async function removeOnboardingFile(button) {
  button.disabled = true;
  try {
    await api(config.trainingFunction, { action: "onboarding_remove_file", fileId: button.dataset.removeFile });
    await loadOnboarding();
  } catch (error) {
    $("onboarding-message").textContent = friendlyError(error);
    button.disabled = false;
  }
}

/* ---------------- Dashboard ---------------- */

async function loadDashboard() {
  ui.dashboardMessage.textContent = "Loading…";
  try {
    const data = await api(config.trainingFunction, { action: "bootstrap" });
    if (data.learner.mustChangePassword) {
      askForPassword("temporary");
      return;
    }
    show("dashboard");
    $("learner-name").textContent = data.learner.fullName || "Panalo learner";
    $("learner-email").textContent = data.learner.email;
    $("learner-id").textContent = data.learner.externalId || "Not assigned";
    ui.adminLink.classList.toggle("hidden", !data.learner.hasAdminAccess);
    renderAssignments(data.assignments || []);
    if (data.onboarding) await loadOnboarding();
    else ui.onboarding.classList.add("hidden");
    ui.dashboardMessage.textContent = "";
  } catch (error) {
    if (error.status === 401) {
      await signOut();
      show("signIn");
      ui.authMessage.textContent = friendlyError(error);
      return;
    }
    show("dashboard");
    ui.dashboardMessage.textContent = friendlyError(error);
  }
}

ui.form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = ui.form.querySelector('button[type="submit"]');
  button.disabled = true;
  ui.authMessage.textContent = "Signing in…";
  try {
    await signInWithPassword($("email").value, $("password").value);
    ui.form.reset();
    ui.authMessage.textContent = "";
    await loadDashboard();
  } catch (error) {
    ui.authMessage.textContent = friendlyError(error);
    $("password").value = "";
  } finally {
    button.disabled = false;
  }
});

$("forgot-link").addEventListener("click", () => {
  ui.form.classList.add("hidden");
  ui.resetForm.classList.remove("hidden");
  $("reset-email").value = $("email").value;
  $("reset-email").focus();
});
$("back-to-sign-in").addEventListener("click", () => {
  ui.resetForm.classList.add("hidden");
  ui.form.classList.remove("hidden");
});

ui.resetForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = ui.resetForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await requestPasswordReset($("reset-email").value);
    ui.resetMessage.textContent = "If that email has a Panalo account, a reset link is on its way. It works once and expires soon.";
  } catch (error) {
    ui.resetMessage.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});

ui.passwordForm.addEventListener("submit", async event => {
  event.preventDefault();
  const password = $("new-password").value;
  if (password !== $("confirm-password").value) {
    ui.passwordMessage.textContent = "The two passwords don't match.";
    return;
  }
  const button = ui.passwordForm.querySelector('button[type="submit"]');
  button.disabled = true;
  ui.passwordMessage.textContent = "Saving…";
  try {
    await api(config.trainingFunction, { action: "change_password", password });
    ui.passwordForm.reset();
    ui.passwordMessage.textContent = "";
    await loadDashboard();
  } catch (error) {
    ui.passwordMessage.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});

$("onboarding-items").addEventListener("change", event => {
  if (event.target.matches("input[type=file][data-item]")) uploadOnboardingFile(event.target);
  else if (event.target.closest(".onb-form")) refreshConditions(event.target.closest(".onb-form"));
});
$("onboarding-items").addEventListener("submit", event => {
  if (!event.target.matches(".onb-form")) return;
  event.preventDefault();
  submitOnboardingForm(event.target);
});
$("onboarding-items").addEventListener("click", event => {
  const edit = event.target.closest("[data-edit]");
  if (edit) {
    const form = document.querySelector(`[data-form-item="${CSS.escape(edit.dataset.edit)}"]`);
    form?.classList.remove("hidden");
    edit.classList.add("hidden");
    form?.querySelector("input,select")?.focus();
  }
  if (event.target.closest("[data-cancel-edit]")) loadOnboarding();
  const remove = event.target.closest("[data-remove-file]");
  if (remove) removeOnboardingFile(remove);
});

ui.signOut.addEventListener("click", async () => {
  await signOut();
  show("signIn");
});

async function init() {
  const callback = completeAuthRedirect();
  if (!isConfigured()) {
    show("setup");
    return;
  }
  if (callback.error) ui.authMessage.textContent = callback.error;
  if (callback.authenticated && (callback.type === "invite" || callback.type === "recovery")) {
    askForPassword(callback.type);
    return;
  }
  if (await getSession()) await loadDashboard();
  else show("signIn");
}

init();
