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
import { attachPad } from "./signature-pad.js";

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
  if (name !== "dashboard") {
    ui.adminLink.classList.add("hidden");
    drafts.clear();
    onboardingDirty = false;
  }
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
    card.href = `./modules/pp-trn-wld-001/?assignment=${encodeURIComponent(assignment.id)}`;
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
// Answers typed but not yet sent. Kept in memory only (never localStorage), because they can
// hold tax file numbers and bank details. It survives re-renders, so uploading a file or signing
// the contract does not wipe what the person has typed in the other forms.
const drafts = new Map();
let onboardingDirty = false;
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

function formHtml(item, open, answers) {
  const form = item.form;
  return `<form class="onb-form${open ? "" : " hidden"}" data-form-item="${safe(item.id)}" novalidate>
    ${form.intro ? `<p class="muted small">${safe(form.intro)}</p>` : ""}
    ${form.link ? `<p class="small doc-link-row"><strong>Click here to read it first:</strong> <a class="doc-link" href="${safe(form.link.href)}" target="_blank" rel="noopener">${safe(form.link.label)} ↗</a></p>` : ""}
    <div class="onb-fields">${form.fields.map(f => fieldHtml(item.id, f, answers)).join("")}</div>
    ${item.status === "uploaded" ? '<div class="form-actions"><button type="button" class="text-button" data-cancel-edit>Cancel changes</button></div>' : ""}
    <p class="form-message" data-form-msg role="status" aria-live="polite"></p>
  </form>`;
}

/* ---------------- Contract signing ---------------- */

function signStatus(item) {
  const hasDocs = (item.signDocs || []).length > 0;
  if (item.status === "accepted") return ["Signed · accepted", "good"];
  if (item.status === "uploaded") return ["Signed · waiting for HR", "info"];
  if (!hasDocs) return ["Waiting for HR to add it", "info"];
  return item.status === "rejected" ? ["Needs signing again", "bad"] : ["Ready to sign", "pending"];
}

function signFormHtml(item) {
  const id = safe(item.id);
  return `<form class="sign-form" data-sign-item="${id}" novalidate>
    <p class="muted small">Read the contract above, then sign below.</p>
    <div class="field onb-field"><label class="check-field"><input type="checkbox" name="agreed"><span>${safe(item.agreementText)}</span></label>
      <small class="field-error" data-error-for="agreed"></small></div>
    <fieldset class="sign-methods"><legend>How do you want to sign?</legend>
      <label><input type="radio" name="method" value="typed" checked> Type my name</label>
      <label><input type="radio" name="method" value="drawn"> Write my name</label></fieldset>
    <div class="field onb-field" data-sign-pane="typed"><label for="sign-name-${id}">Type your full name as your signature</label>
      <input id="sign-name-${id}" name="name" type="text" autocomplete="off" autocapitalize="words" spellcheck="false" maxlength="120" placeholder="${safe(item.signAs)}">
      <small>Your name on file is <strong>${safe(item.signAs)}</strong>. Type it exactly like that.</small>
      <small class="field-error" data-error-for="name"></small></div>
    <div class="field onb-field hidden" data-sign-pane="drawn"><label for="sign-pad-${id}">Write your name in the box, with your finger or mouse</label>
      <canvas id="sign-pad-${id}" class="sign-pad" width="600" height="200" role="img" aria-label="Signature box. Write your name here."></canvas>
      <button type="button" class="text-button" data-pad-clear>Clear and start again</button>
      <small class="field-error" data-error-for="signature"></small></div>
    <div class="form-actions"><button class="primary" type="submit">Sign contract</button></div>
    <p class="form-message" data-form-msg role="status" aria-live="polite"></p>
  </form>`;
}

function signItemHtml(item) {
  formItems.set(item.id, item);
  const [label, tone] = signStatus(item);
  const docs = item.signDocs || [];
  const chips = `${item.required ? "" : '<span class="chip">Optional</span>'}<span class="chip">Sign online</span>`;
  const reject = item.status === "rejected" && item.rejectReason ? `<p class="reject-note">HR says: ${safe(item.rejectReason)}</p>` : "";
  const list = docs.length ? `<ul class="file-list contract-docs">${docs.map(d => `<li>
      <div><strong>${safe(d.label)}</strong><small>PDF · Read opens it in a new tab</small></div>
      <span class="row-actions"><button type="button" class="secondary-action small" data-read-contract="${safe(d.id)}">Read</button>
        <button type="button" class="secondary-action small" data-download-contract="${safe(d.id)}">Download</button></span></li>`).join("")}</ul>` : "";
  // Before signing, the person can download the contract, fill it in and send the file back.
  const copies = item.copies || [];
  const copyBox = docs.length && !item.signed ? `<div class="copy-box" data-copy-for="${safe(item.id)}">
      <p class="eyebrow">FILL IT IN FIRST</p>
      <p class="muted small">Download the contract, fill it in, then upload your filled-in copy (PDF or Word, up to 20 MB each). HR will review it. You still sign online below, as usual.</p>
      ${copies.length ? `<ul class="file-list">${copies.map(c => `<li><div><strong>${safe(c.fileName)}</strong><small>${safe(fileSize(c.size))}${c.uploadedAt ? ` · ${safe(formatDate(c.uploadedAt))}` : ""}</small></div>
        <button type="button" class="text-button danger" data-remove-copy="${safe(c.name)}" data-copy-item="${safe(item.id)}" aria-label="Remove ${safe(c.fileName)}">Remove</button></li>`).join("")}</ul>` : ""}
      <label class="upload-button"><input type="file" multiple accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-copy-input="${safe(item.id)}">
        <span>${copies.length ? "Upload another file" : "Upload filled-in copy"}</span></label>
      <p class="form-message" data-copy-msg role="status" aria-live="polite"></p>
    </div>` : "";
  let body = "";
  if (item.signed) {
    body = `<p class="sign-done">Signed by <strong>${safe(item.signed.name)}</strong> on ${safe(formatDate(item.signed.at))} (${item.signed.method === "drawn" ? "written on screen" : "typed"}).${item.status === "uploaded" ? " HR will review it." : ""}</p>`;
  } else if (!docs.length) {
    body = '<p class="muted small">HR hasn\'t added your contract yet. It will appear here, so check back soon.</p>';
  } else {
    body = signFormHtml(item);
  }
  return `<article class="onboarding-item onb-form-item" data-item-card="${safe(item.id)}">
      <div class="onb-head"><div class="onboarding-text">
          <div class="onboarding-title"><strong>${safe(item.name)}</strong>${chips}</div>
          <p class="muted small">${safe(item.guidance)}</p>${reject}</div>
        <div class="onboarding-actions"><span class="chip ${tone}">${label}</span></div></div>
      ${list}${copyBox}${body}
    </article>`;
}

const fileSize = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((Number(n) || 0) / 1024))} KB`);

// Opens the contract in a new tab. The tab is opened first, in response to the
// tap, because phones block tabs opened after waiting for the network.
async function readContract(button) {
  const tab = window.open("", "_blank");
  button.disabled = true;
  try {
    const { url } = await api(config.trainingFunction, { action: "onboarding_contract_url", docId: button.dataset.readContract });
    if (!tab) {
      $("onboarding-message").textContent = "Your browser blocked the new tab. Allow pop-ups for this page, then press Read again.";
      return;
    }
    tab.opener = null;
    tab.location.href = url;
    $("onboarding-message").textContent = "";
  } catch (error) {
    tab?.close();
    $("onboarding-message").textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
}

// Saves the contract to the person's device so they can fill it in.
async function downloadContract(button) {
  button.disabled = true;
  try {
    const { url } = await api(config.trainingFunction, { action: "onboarding_contract_url", docId: button.dataset.downloadContract, download: true });
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    $("onboarding-message").textContent = "Your download has started. Fill it in, then upload your copy below the contract.";
  } catch (error) {
    $("onboarding-message").textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
}

// Uploads the filled-in copy (PDF or Word) next to the contract. Signing is separate.
async function uploadContractCopy(input) {
  const files = [...(input.files || [])];
  if (!files.length) return;
  const box = input.closest("[data-copy-for]");
  const message = box.querySelector("[data-copy-msg]");
  const itemId = input.dataset.copyInput;
  const big = files.find(f => f.size > 20 * 1024 * 1024);
  if (big) {
    message.textContent = `${big.name} is over 20 MB. Try a smaller file or save it as a PDF.`;
    input.value = "";
    return;
  }
  input.disabled = true;
  try {
    for (const [n, file] of files.entries()) {
      message.textContent = files.length > 1 ? `Uploading ${n + 1} of ${files.length}…` : `Uploading ${file.name}…`;
      const prepared = await api(config.trainingFunction, { action: "onboarding_copy_prepare", itemId, fileName: file.name, size: file.size });
      const res = await fetch(prepared.signedUrl, { method: "PUT", headers: { "Content-Type": prepared.contentType }, body: file });
      if (!res.ok) throw new Error(`The upload of ${file.name} failed (${res.status}). Please try again.`);
      await api(config.trainingFunction, { action: "onboarding_copy_attach", itemId, name: prepared.name });
    }
    await loadOnboarding();
    $("onboarding-message").textContent = "Your filled-in copy was uploaded. HR will review it. You can sign below when you're ready.";
  } catch (error) {
    message.textContent = friendlyError(error);
    input.disabled = false;
    input.value = "";
  }
}

async function removeContractCopy(button) {
  button.disabled = true;
  try {
    await api(config.trainingFunction, { action: "onboarding_copy_remove", itemId: button.dataset.copyItem, name: button.dataset.removeCopy });
    await loadOnboarding();
  } catch (error) {
    $("onboarding-message").textContent = friendlyError(error);
    button.disabled = false;
  }
}

// The signature box (see signature-pad.js).
const pads = new WeakMap();
function preparePad(canvas) {
  const pad = attachPad(canvas);
  if (pad) pads.set(canvas, pad);
}
function clearPad(canvas) {
  pads.get(canvas)?.clear();
}

function switchSignMethod(form) {
  const method = form.querySelector('input[name="method"]:checked')?.value || "typed";
  form.querySelectorAll("[data-sign-pane]").forEach(el => el.classList.toggle("hidden", el.dataset.signPane !== method));
  form.querySelectorAll("[data-error-for]").forEach(e => { e.textContent = ""; });
  if (method === "typed") form.elements.name?.focus();
}

async function submitSignature(form) {
  const item = formItems.get(form.dataset.signItem);
  if (!item) return;
  const msg = form.querySelector("[data-form-msg]");
  const button = form.querySelector('button[type="submit"]');
  form.querySelectorAll("[data-error-for]").forEach(e => { e.textContent = ""; });
  const fail = (key, text) => {
    const slot = form.querySelector(`[data-error-for="${CSS.escape(key)}"]`);
    if (slot) slot.textContent = text;
    msg.textContent = "Check the highlighted part.";
  };
  const method = form.querySelector('input[name="method"]:checked')?.value || "typed";
  const payload = { action: "onboarding_sign", itemId: item.id, agreed: form.elements.agreed.checked, method };
  if (!payload.agreed) return fail("agreed", "Tick the box to confirm you have read the contract and agree to it.");
  if (method === "typed") {
    payload.name = form.elements.name.value;
    if (!payload.name.trim()) return fail("name", "Type your full name to sign.");
  } else {
    const canvas = form.querySelector("canvas.sign-pad");
    const pad = canvas && pads.get(canvas);
    if (!pad?.isDirty()) return fail("signature", "Write your name in the box first.");
    payload.signatureImage = pad.toDataURL();
  }
  button.disabled = true;
  msg.textContent = "Signing…";
  try {
    await api(config.trainingFunction, payload);
    await loadOnboarding();
    $("onboarding-message").textContent = `${item.name} signed. HR will review it.`;
  } catch (error) {
    msg.textContent = friendlyError(error);
    const key = String(error.code || "").startsWith("field:") ? error.code.slice(6) : "";
    const slot = key && form.querySelector(`[data-error-for="${CSS.escape(key)}"]`);
    if (slot) {
      slot.textContent = error.message;
      msg.textContent = "Check the highlighted part.";
    }
    button.disabled = false;
  }
}

function itemHtml(item) {
  if (item.kind === "sign") return signItemHtml(item);
  const [label, tone] = ITEM_STATUS[item.status] || [item.status, ""];
  const chips = `${item.required ? "" : '<span class="chip">Optional</span>'}${item.sensitive ? '<span class="chip info">Restricted to HR</span>' : ""}`;
  const reject = item.status === "rejected" && item.rejectReason ? `<p class="reject-note">HR says: ${safe(item.rejectReason)}</p>` : "";
  if (item.kind === "form" && item.form) {
    formItems.set(item.id, item);
    const editable = item.status !== "accepted";
    const draft = drafts.get(item.id);
    const openForm = item.status === "pending" || item.status === "rejected" || (editable && Boolean(draft));
    // Open forms get a "ready to send" chip instead of the stale status, filled in by updateSubmitBar().
    const statusChip = openForm && item.status !== "rejected"
      ? `<span class="chip" data-ready-chip>${item.status === "uploaded" ? "Editing" : "Not sent yet"}</span>`
      : `<span class="chip ${tone}">${label}</span>`;
    return `<article class="onboarding-item onb-form-item" data-item-card="${safe(item.id)}">
      <div class="onb-head"><div class="onboarding-text">
          <div class="onboarding-title"><strong>${safe(item.name)}</strong>${chips}</div>
          <p class="muted small">${safe(item.guidance)}</p>${reject}</div>
        <div class="onboarding-actions">${statusChip}
          ${item.status === "uploaded" && !openForm ? `<button type="button" class="secondary-action small" data-edit="${safe(item.id)}">Edit answers</button>` : ""}</div></div>
      ${editable ? formHtml(item, openForm, draft ?? item.answers) : ""}
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

async function loadOnboarding({ snapshot = true } = {}) {
  if (snapshot) snapshotDrafts();
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
  ].filter(Boolean).join(" ") || "Fill in each item below. Only certificates need a photo or PDF, and you sign your contract right here.";
  formItems.clear();
  // Forms first, then the contract, then the few uploads.
  const ordered = [...items.filter(i => i.kind === "form"), ...items.filter(i => i.kind === "sign"), ...items.filter(i => i.kind !== "form" && i.kind !== "sign")];
  $("onboarding-items").innerHTML = ordered.map(itemHtml).join("") + CERT_NAMES;
  $("onboarding-items").querySelectorAll("canvas.sign-pad").forEach(preparePad);
  ui.onboarding.classList.remove("hidden");
  updateSubmitBar();
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

// Remember what is typed in every open form, so a re-render (after a file upload, a signature,
// or a partly failed send) does not lose it. `skip` is a form being cancelled.
function snapshotDrafts(skip) {
  document.querySelectorAll("#onboarding-items .onb-form:not(.hidden)").forEach(form => {
    const id = form.dataset.formItem;
    const item = formItems.get(id);
    if (item && id !== skip) drafts.set(id, collectAnswers(form, item));
  });
  if (skip) drafts.delete(skip);
}

function fieldContainer(form, key) {
  return form.querySelector(`[name="${CSS.escape(key)}"]`)?.closest(".onb-field") || null;
}

// Keys of visible, required questions that have no answer yet. The server still does the real
// checking; this is so the person sees what is missing before anything is sent.
function missingFields(form, item) {
  const missing = [];
  for (const field of item.form.fields) {
    const box = fieldContainer(form, field.key);
    if (!box || box.classList.contains("hidden")) continue;
    if (field.type === "confirm") {
      if (!form.elements[field.key].checked) missing.push(field.key);
    } else if (field.type === "yesno") {
      if (!form.querySelector(`input[name="${CSS.escape(field.key)}"]:checked`)) missing.push(field.key);
    } else if (!field.optional && !String(form.elements[field.key].value).trim()) {
      missing.push(field.key);
    }
  }
  return missing;
}

function sameAnswers(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].every(k => String(a?.[k] ?? "") === String(b?.[k] ?? ""));
}

function openForms() {
  return [...document.querySelectorAll("#onboarding-items .onb-form:not(.hidden)")]
    .map(form => ({ form, item: formItems.get(form.dataset.formItem) }))
    .filter(entry => entry.item)
    // A form being edited only counts once something has actually changed.
    .filter(({ form, item }) => item.status !== "uploaded" || !sameAnswers(collectAnswers(form, item), item.answers));
}

function showFormError(form, error) {
  const msg = form.querySelector("[data-form-msg]");
  msg.textContent = friendlyError(error);
  const key = String(error.code || "").startsWith("field:") ? error.code.slice(6) : "";
  const slot = key && form.querySelector(`[data-error-for="${CSS.escape(key)}"]`);
  if (slot) {
    slot.textContent = error.message;
    msg.textContent = "Check the highlighted answer.";
    fieldContainer(form, key)?.classList.add("invalid");
  }
}

function updateSubmitBar() {
  const bar = $("onboarding-submit");
  const entries = openForms();
  bar.classList.toggle("hidden", entries.length === 0);
  if (!entries.length) return;
  const ready = new Set(entries.filter(({ form, item }) => !missingFields(form, item).length).map(({ item }) => item.id));
  entries.forEach(({ form, item }) => {
    const chip = form.closest("[data-item-card]")?.querySelector("[data-ready-chip]");
    if (chip) {
      chip.textContent = ready.has(item.id) ? "Ready to send" : item.status === "uploaded" ? "Editing" : "Not sent yet";
      chip.classList.toggle("good", ready.has(item.id));
    }
  });
  const allEdits = entries.every(({ item }) => item.status === "uploaded");
  $("onboarding-submit-button").textContent = allEdits ? "Send changes to HR" : "Send all to HR";
  $("onboarding-submit-status").textContent = ready.size === entries.length
    ? `All ${entries.length} ${entries.length === 1 ? "item is" : "items are"} ready. Press the button to send ${entries.length === 1 ? "it" : "them"} to HR together.`
    : `${ready.size} of ${entries.length} ready. Answer the rest, then send everything to HR with one button.`;
}

// One button sends every open form to HR together. Nothing is sent until all of them are
// complete. If the server then rejects one, the others are already saved and the person is
// taken to the one that needs fixing, with everything they typed still in place.
async function submitAllOnboarding() {
  const button = $("onboarding-submit-button");
  const status = $("onboarding-submit-status");
  const entries = openForms();
  document.querySelectorAll("#onboarding-items .field-error").forEach(e => { e.textContent = ""; });
  document.querySelectorAll("#onboarding-items .invalid").forEach(e => e.classList.remove("invalid"));
  document.querySelectorAll("#onboarding-items [data-form-msg]").forEach(e => { e.textContent = ""; });
  if (!entries.length) {
    $("onboarding-message").textContent = "There is nothing new to send.";
    return;
  }
  let firstBad = null;
  let incomplete = 0;
  for (const { form, item } of entries) {
    const missing = missingFields(form, item);
    if (!missing.length) continue;
    incomplete += 1;
    for (const key of missing) {
      fieldContainer(form, key)?.classList.add("invalid");
      const slot = form.querySelector(`[data-error-for="${CSS.escape(key)}"]`);
      if (slot) slot.textContent = "Answer this to continue.";
    }
    firstBad ??= { form, key: missing[0] };
  }
  if (firstBad) {
    $("onboarding-message").textContent = `${incomplete} ${incomplete === 1 ? "item still needs" : "items still need"} answers. Nothing has been sent yet.`;
    const target = fieldContainer(firstBad.form, firstBad.key);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.querySelector("input,select")?.focus({ preventScroll: true });
    return;
  }
  button.disabled = true;
  const sent = [];
  const failed = [];
  for (const [n, { form, item }] of entries.entries()) {
    status.textContent = `Sending ${n + 1} of ${entries.length}…`;
    const answers = collectAnswers(form, item);
    try {
      await api(config.trainingFunction, { action: "onboarding_submit_form", itemId: item.id, answers });
      sent.push(item.id);
    } catch (error) {
      failed.push({ id: item.id, answers, error });
    }
  }
  sent.forEach(id => drafts.delete(id));
  failed.forEach(({ id, answers }) => drafts.set(id, answers));
  if (!failed.length) onboardingDirty = false;
  try {
    await loadOnboarding({ snapshot: false });
  } catch (error) {
    $("onboarding-message").textContent = friendlyError(error);
  }
  if (!failed.length) {
    $("onboarding-message").textContent = `${sent.length} ${sent.length === 1 ? "item" : "items"} sent to HR.`;
    button.disabled = false;
    return;
  }
  failed.forEach(({ id, error }) => {
    const form = document.querySelector(`[data-form-item="${CSS.escape(id)}"]`);
    if (form) showFormError(form, error);
  });
  $("onboarding-message").textContent = `${sent.length ? `${sent.length} sent to HR. ` : ""}${failed.length} could not be sent. Fix the highlighted answers and press the button again.`;
  document.querySelector("#onboarding-items .invalid")?.scrollIntoView({ block: "center", behavior: "smooth" });
  button.disabled = false;
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
    if (goNext()) return;
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
  if (event.target.matches("input[type=file][data-copy-input]")) uploadContractCopy(event.target);
  else if (event.target.matches("input[type=file][data-item]")) uploadOnboardingFile(event.target);
  else if (event.target.matches('.sign-form input[name="method"]')) switchSignMethod(event.target.closest(".sign-form"));
  else if (event.target.closest(".onb-form")) {
    refreshConditions(event.target.closest(".onb-form"));
    updateSubmitBar();
  }
});
$("onboarding-items").addEventListener("input", event => {
  if (!event.target.closest(".onb-form")) return;
  onboardingDirty = true;
  const box = event.target.closest(".onb-field");
  if (box?.classList.contains("invalid")) {
    box.classList.remove("invalid");
    box.querySelector(".field-error")?.replaceChildren();
  }
  updateSubmitBar();
});
$("onboarding-items").addEventListener("submit", event => {
  if (event.target.matches(".sign-form")) {
    event.preventDefault();
    submitSignature(event.target);
    return;
  }
  // Answers go to HR from the one button at the bottom, so pressing Enter in a field does nothing.
  if (event.target.matches(".onb-form")) event.preventDefault();
});
$("onboarding-submit-button").addEventListener("click", submitAllOnboarding);
window.addEventListener("beforeunload", event => {
  if (onboardingDirty && openForms().length) event.preventDefault();
});
$("onboarding-items").addEventListener("click", event => {
  const edit = event.target.closest("[data-edit]");
  if (edit) {
    const form = document.querySelector(`[data-form-item="${CSS.escape(edit.dataset.edit)}"]`);
    form?.classList.remove("hidden");
    edit.classList.add("hidden");
    form?.querySelector("input,select")?.focus();
    updateSubmitBar();
  }
  const cancel = event.target.closest("[data-cancel-edit]");
  if (cancel) {
    snapshotDrafts(cancel.closest(".onb-form").dataset.formItem);
    loadOnboarding({ snapshot: false });
  }
  const remove = event.target.closest("[data-remove-file]");
  if (remove) removeOnboardingFile(remove);
  const read = event.target.closest("[data-read-contract]");
  if (read) readContract(read);
  const download = event.target.closest("[data-download-contract]");
  if (download) downloadContract(download);
  const removeCopy = event.target.closest("[data-remove-copy]");
  if (removeCopy) removeContractCopy(removeCopy);
  const clear = event.target.closest("[data-pad-clear]");
  if (clear) clearPad(clear.closest(".sign-form").querySelector("canvas.sign-pad"));
});

ui.signOut.addEventListener("click", async () => {
  await signOut();
  show("signIn");
});

// ?next=/accounts/ returns to another Panalo page on this site after sign-in.
function goNext() {
  const next = new URLSearchParams(location.search).get("next") || "";
  if (!/^\/(accounts|training)\/[A-Za-z0-9/_#.?=&%-]*$/.test(next) || next.includes("//")) return false;
  location.assign(next);
  return true;
}

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
  if (await getSession()) {
    if (goNext()) return;
    await loadDashboard();
  } else show("signIn");
}

init();
