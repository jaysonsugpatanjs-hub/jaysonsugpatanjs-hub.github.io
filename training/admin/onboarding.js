// Onboarding tab: send applicants the document checklist, track progress and
// review each upload. Also hosts the one-time temporary password dialog.
import { api, config, friendlyError } from "../auth.js";
import { createPlacer } from "./contract-placer.js";
import { attachPad } from "../signature-pad.js";

const call = (action, body = {}) => api(config.adminFunction, { action, ...body });
const state = { types: [], people: [], requests: [], items: [], openId: null, canIssuePasswords: false, asContractor: false };
// Page viewers HR has opened to place a signature, by item id. Cleared whenever the request is redrawn.
const placers = new Map();

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fmt(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(iso));
}
const ITEM = { pending: ["Not sent yet", ""], uploaded: ["To review", "pending"], accepted: ["Accepted", "good"], rejected: ["Sent back", "bad"] };
// A contract HR has not attached, or the applicant has not signed yet, reads differently from other items.
function itemStatus(i) {
  if (i.kind === "sign" && i.status === "pending") return i.signDocs?.length ? ["Waiting for signature", "info"] : ["Add the contract", "pending"];
  if (i.kind === "sign" && i.status === "uploaded") return ["Signed · to review", "pending"];
  return ITEM[i.status] || [i.status, ""];
}
const mask = v => (v.length > 3 ? "•".repeat(Math.min(v.length - 3, 8)) + v.slice(-3) : "•••");

function filesHtml(item) {
  if (!item.files?.length) return "";
  return `<ul class="file-list admin-files">${item.files.map(f => `<li><div><strong>${safe(f.label)}</strong>
      <small>${safe(f.fileName)} · ${fmt(f.uploadedAt)}${f.expiresOn ? ` · <span class="${f.expiresOn < new Date().toISOString().slice(0, 10) ? "reject-note" : ""}">expires ${fmt(f.expiresOn)}</span>` : ""}</small></div>
      <button type="button" class="secondary-action small" data-view-file="${safe(f.id)}">View</button></li>`).join("")}</ul>`;
}

const kb = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Online contract signing: HR attaches the PDF(s); the applicant signs on the portal. */
function signHtml(i) {
  if (i.kind !== "sign") return "";
  const id = safe(i.id);
  const docs = i.signDocs?.length ? `<ul class="file-list admin-files">${i.signDocs.map(d => `<li><div><strong>${safe(d.label)}</strong>
      <small>${safe(d.fileName)} · ${kb(d.size)} · added ${fmt(d.addedAt)} · SHA-256 ${safe(d.sha256.slice(0, 12))}…</small></div>
      <span class="row-actions"><button type="button" class="secondary-action small" data-sign-view="${safe(d.id)}">View</button>${i.canChangeContract
        ? `<button type="button" class="revoke" data-sign-remove="${safe(d.id)}">Remove</button>` : ""}</span></li>`).join("")}</ul>` : "";
  const upload = i.canChangeContract ? `<div class="add-file">
      <div class="field onb-field"><label for="sign-label-${id}">Document name</label><input id="sign-label-${id}" data-sign-label maxlength="80" value="Employment contract"></div>
      <label class="upload-button"><input type="file" accept=".pdf,application/pdf" data-sign-upload="${id}"><span>${i.signDocs?.length ? "Add another PDF" : "Upload contract (PDF)"}</span></label>
      <small class="muted">${i.signDocs?.length
        ? "The applicant signs once and covers every file listed."
        : "PDF only, up to 20 MB. Save Word files as PDF first. The applicant can sign as soon as a file is attached."}</small>
      <p class="form-message" data-sign-msg role="status" aria-live="polite"></p></div>` : "";
  const finalize = i.canFinalize ? `<div class="finalize-panel" data-finalize="${id}">
      <p class="eyebrow">FINALIZE</p>
      <p class="muted small">The signature is stamped onto the contract and the finished copy is filed in the HR folder only when you finalize. Show where the signature and date go, check the preview, then finalize.</p>
      <div class="placer" data-placer="${id}" hidden></div>
      <div class="counter-sign">
        <label class="check-field"><input type="checkbox" data-company-on><span><strong>Also sign for Panalo</strong>
          <small>The HR representative or the Managing Director signs the contract on Panalo's behalf. It goes on the same page.</small></span></label>
        <div class="counter-fields" data-company-fields hidden>
          <div class="field-row">
            <div class="field"><label for="co-name-${id}">Name</label><input id="co-name-${id}" data-company-name maxlength="80" autocomplete="off" placeholder="For example, Rene Fiestada"></div>
            <div class="field"><label for="co-pos-${id}">Position</label><input id="co-pos-${id}" data-company-position maxlength="60" autocomplete="off" list="co-positions" placeholder="For example, Managing Director"></div>
          </div>
          <datalist id="co-positions"><option value="Managing Director"><option value="HR representative"></datalist>
          <fieldset class="sign-methods"><legend>How they sign</legend>
            <label><input type="radio" name="co-method-${id}" value="typed" data-company-method checked> Type their name</label>
            <label><input type="radio" name="co-method-${id}" value="drawn" data-company-method> Write it on screen</label></fieldset>
          <div class="field onb-field" data-company-pane="drawn" hidden><label for="co-pad-${id}">Write the name in the box</label>
            <canvas id="co-pad-${id}" class="sign-pad" data-company-pad width="600" height="200" role="img" aria-label="Signature box for Panalo. Write the name here."></canvas>
            <button type="button" class="text-button" data-company-clear="${id}">Clear</button></div>
          <small class="muted">Entered under your sign-in (you are recorded as who entered it); the signatory's name and position are recorded as typed.</small>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="secondary-action" data-place-open="${id}">Place the signature on the contract</button>
        <button type="button" class="secondary-action" data-sign-preview="${id}" disabled>Preview signed contract</button>
        <button type="button" class="primary" data-finalize-go="${id}" disabled>Finalize &amp; file</button>
      </div>
      <p class="form-message" data-finalize-msg role="status" aria-live="polite"></p></div>` : "";
  const hand = i.hasHandwriting ? `<button type="button" class="text-button" data-sign-signature="${id}">View handwritten signature</button>` : "";
  return docs + upload + hand + finalize;
}

function answersHtml(item) {
  if (!item.answers?.length) return "";
  return `<dl class="answer-list">${item.answers.map(a => `<dt>${safe(a.label)}</dt><dd>${a.sensitive
    ? `<span class="masked" data-secret="${safe(a.value)}">${safe(mask(a.value))}</span> <button type="button" class="text-button" data-reveal>Show</button>`
    : safe(a.value)}</dd>`).join("")}</dl>`;
}

/** Shows a temporary password exactly once, with copy and a reminder. */
export function showTemporaryPassword({ name, email, password }) {
  const dialog = document.createElement("dialog");
  dialog.className = "secret-dialog";
  dialog.innerHTML = `<form method="dialog">
      <p class="eyebrow">TEMPORARY PASSWORD</p>
      <h2>Give this to ${safe(name || email)}</h2>
      <p class="muted">Pass it on by phone, SMS or in person, not by email. It is shown only now; if it's lost, issue a new one. They'll choose their own password when they first sign in.</p>
      <dl class="secret-facts"><dt>Sign in at</dt><dd>${safe(new URL(config.appUrl, location.href).href)}</dd><dt>Email</dt><dd>${safe(email)}</dd><dt>Temporary password</dt><dd><code class="secret">${safe(password)}</code></dd></dl>
      <div class="form-actions"><button type="button" class="secondary-action" data-copy>Copy password</button><button class="primary" value="done">I've recorded it</button></div>
      <p class="form-message" data-copy-msg role="status"></p>
    </form>`;
  document.body.appendChild(dialog);
  dialog.querySelector("[data-copy]").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(password); dialog.querySelector("[data-copy-msg]").textContent = "Copied."; }
    catch (_) { dialog.querySelector("[data-copy-msg]").textContent = "Copy it by hand from above."; }
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

export async function loadOnboarding(root, { canIssuePasswords }) {
  state.canIssuePasswords = canIssuePasswords;
  root.querySelector("[data-onb-msg]").textContent = "Loading onboarding…";
  const [types, list, people] = await Promise.all([call("onboarding_types"), call("onboarding_list"), call("people_list")]);
  state.types = types.types;
  state.requests = list.requests;
  state.people = people.employees.filter(e => e.status !== "terminated");
  renderForm(root);
  renderList(root);
  root.querySelector("[data-onb-msg]").textContent = "";
  if (state.openId) await openRequest(root, state.openId);
}

// The kind of person the checklist is for. An applicant who will work as a contractor can be
// treated as one here, so they get the contractor documents (ABN and business details,
// insurance, contractor agreement) instead of the employee ones.
function checklistKind(person) {
  return state.asContractor ? "contractor" : person?.employmentType || "applicant";
}

function typesFor(person) {
  const kind = checklistKind(person);
  return state.types.filter(t => t.active && t.appliesTo.includes(kind));
}

function renderForm(root, { keep = false } = {}) {
  const form = root.querySelector("[data-onb-form]");
  const selected = form.employeeId?.value || "";
  // Ticking "contractor" redraws the list; what was already typed stays.
  const typed = keep ? { due: form.dueOn?.value || "", message: form.message?.value || "", signIn: form.signIn?.value || "" } : { due: "", message: "", signIn: "" };
  const person = state.people.find(p => p.id === selected);
  const open = new Set(state.requests.filter(r => r.status === "open").map(r => r.employeeId));
  form.innerHTML = `
    <p class="eyebrow">SEND ONBOARDING LINK</p><h2>Request details</h2>
    <div class="field"><label for="onb-person">Person</label>
      <select id="onb-person" name="employeeId" required><option value="">Choose from the register</option>
      ${state.people.map(p => `<option value="${safe(p.id)}" ${p.id === selected ? "selected" : ""} ${open.has(p.id) ? "disabled" : ""}>${safe(p.fullName)} · ${safe(p.employmentType)}${p.email ? "" : " · no email"}${open.has(p.id) ? " · request open" : ""}</option>`).join("")}
      </select><small>Add new applicants under People first, with their email address.</small></div>
    ${person && person.employmentType !== "contractor" ? `<div class="field"><label class="check-field"><input type="checkbox" name="asContractor" ${state.asContractor ? "checked" : ""}>
      <span><strong>This person is a contractor</strong> Ask for their contractor details instead: ID, ABN and business details, insurance and the contractor agreement.</span></label></div>` : ""}
    ${person ? `<fieldset class="doc-picks"><legend>Documents for ${safe(checklistKind(person))}s</legend>
      ${typesFor(person).map(t => `<label class="check-field"><input type="checkbox" name="types" value="${safe(t.key)}" ${t.required ? "checked" : ""}>
        <span><strong>${safe(t.name)}</strong> <span class='chip'>${t.kind === "form" ? "Fill in" : t.kind === "sign" ? "Sign online" : "Photo/PDF"}</span>${t.required ? "" : " <span class='chip'>Optional</span>"}${t.sensitive ? " <span class='chip info'>Sensitive</span>" : ""}<small>${safe(t.guidance)}${t.link ? ` <span class="doc-link-row"><strong>Click here to read it:</strong> <a class="doc-link" href="${safe(t.link.href)}" target="_blank" rel="noopener">${safe(t.link.label)} ↗</a></span>` : ""}</small></span></label>`).join("")}
      </fieldset>
      <div class="field-row">
        <div class="field"><label for="onb-due">Due by</label><input id="onb-due" name="dueOn" type="date" value="${safe(typed.due)}"></div>
        <div class="field"><label for="onb-signin">How they'll sign in</label><select id="onb-signin" name="signIn">
          <option value="invite">Email them a link to set a password</option>
          ${state.canIssuePasswords ? '<option value="password" ${typed.signIn === "password" ? "selected" : ""}>Create a temporary password (shown once)</option>' : ""}
        </select></div>
      </div>
      <small class="muted">${person.profileId ? "They already have a sign-in; they'll see the checklist next time they sign in." : "They don't have a sign-in yet; one is created now."}</small>
      <div class="field"><label for="onb-msg">Message to them (optional)</label><textarea id="onb-msg" name="message" rows="2" maxlength="1000" placeholder="Welcome to Panalo. Please complete these before your first day.">${safe(typed.message)}</textarea></div>
      <button class="primary" type="submit">Send request</button>` : ""}
    <p class="form-message" data-onb-form-msg role="status" aria-live="polite"></p>`;
}

function renderList(root) {
  root.querySelector("[data-onb-body]").innerHTML = state.requests.map(r => {
    const tone = r.status === "complete" ? "good" : r.status === "cancelled" ? "" : r.counts.toReview ? "pending" : "info";
    const label = r.status === "complete" ? "Complete" : r.status === "cancelled" ? "Cancelled" : r.counts.toReview ? `${r.counts.toReview} to review` : "Waiting on applicant";
    return `<tr class="${r.id === state.openId ? "selected-row" : ""}">
      <td><button type="button" class="link-btn" data-open="${safe(r.id)}">${safe(r.person.name)}</button><small>${safe(r.person.type)} · ${safe(r.person.number)}</small></td>
      <td><strong>${r.counts.accepted} / ${r.counts.required}</strong><small>required accepted</small></td>
      <td><span class="chip ${tone}">${label}</span>${r.counts.rejected ? `<small>${r.counts.rejected} sent back</small>` : ""}</td>
      <td>${fmt(r.dueOn)}<small>sent ${fmt(r.createdAt)}</small></td></tr>`;
  }).join("") || '<tr><td colspan="4" class="muted">No onboarding requests yet.</td></tr>';
}

async function openRequest(root, id) {
  state.openId = id;
  renderList(root);
  const panel = root.querySelector("[data-onb-detail]");
  panel.innerHTML = '<p class="muted">Loading…</p>';
  panel.classList.remove("hidden");
  placers.clear();
  try {
    const { request, items } = await call("onboarding_detail", { requestId: id });
    state.items = items;
    panel.innerHTML = `
      <div class="register-head"><div><p class="eyebrow">ONBOARDING · ${safe(request.status.toUpperCase())}</p><h2>${safe(request.person.name)}</h2>
        <p class="muted small">${safe(request.person.email || "")} · sent ${fmt(request.createdAt)}${request.dueOn ? ` · due ${fmt(request.dueOn)}` : ""}</p></div>
        ${request.status === "open" ? '<button type="button" class="revoke" data-cancel>Cancel request</button>' : ""}</div>
      ${request.cancelledReason ? `<p class="muted">Cancelled: ${safe(request.cancelledReason)}</p>` : ""}
      <div class="list">${items.map(i => {
        const [label, tone] = itemStatus(i);
        return `<div class="list-row review-row"><div>
            <strong>${safe(i.name)}</strong>${i.required ? "" : " <span class='chip'>Optional</span>"}${i.sensitive ? " <span class='chip info'>Sensitive</span>" : ""}
            <small>${i.kind === "sign"
              ? (["uploaded", "accepted"].includes(i.status) && i.submittedAt ? `Signed ${fmt(i.submittedAt)}` : i.signDocs?.length ? "Contract attached · the applicant hasn't signed yet" : "Attach the contract so the applicant can sign it")
              : i.kind === "form"
              ? (i.submittedAt ? `Filled in ${fmt(i.submittedAt)}` : "Not filled in yet")
              : (i.files?.length ? `${i.files.length} file${i.files.length === 1 ? "" : "s"} · last added ${fmt(i.uploadedAt)}` : "Nothing uploaded yet")}${i.kind === "form" && i.fileName ? ` · earlier file: ${safe(i.fileName)}` : ""}${i.reviewer ? ` · reviewed by ${safe(i.reviewer)}` : ""}</small>
            ${i.status === "rejected" ? `<small class="reject-note">Sent back: ${safe(i.rejectReason)}</small>` : ""}
            ${answersHtml(i)}${filesHtml(i)}${signHtml(i)}</div>
          <div class="row-actions"><span class="chip ${tone}">${label}</span>
            ${i.kind === "form" && i.fileName && !i.files?.length ? `<button type="button" class="secondary-action small" data-view="${safe(i.id)}">View earlier file</button>` : ""}
            ${i.status === "uploaded" && request.status === "open" ? `${i.kind === "sign" ? "" : `<button type="button" class="primary small" data-accept="${safe(i.id)}">Accept</button>`}<button type="button" class="revoke" data-reject="${safe(i.id)}">Send back</button>` : ""}
          </div></div>`;
      }).join("")}</div>
      ${request.status === "open" && items.filter(i => i.status === "uploaded" && i.kind !== "sign").length > 1 ? '<div class="form-actions"><button type="button" class="primary" data-accept-all>Accept everything waiting for review</button></div>' : ""}
      <p class="muted small">Opening a request with answers, and viewing each file, is recorded in the audit log. File links last two minutes.</p>
      <p class="form-message" data-detail-msg role="status" aria-live="polite"></p>`;
  } catch (error) {
    panel.innerHTML = `<p class="form-message">${safe(friendlyError(error))}</p>`;
  }
}

const bytesFromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const todayText = iso => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" }).format(new Date(iso));

/** The finalize panel an element belongs to, and its message line. */
function finalizeParts(button) {
  const panel = button.closest("[data-finalize]");
  return { panel, id: panel.dataset.finalize, msg: panel.querySelector("[data-finalize-msg]") };
}

/** Shows or hides the counter-signature fields and tells the page viewer about Panalo's signatory. */
function syncCompany(panel) {
  if (!panel) return;
  const on = panel.querySelector("[data-company-on]").checked;
  panel.querySelector("[data-company-fields]").hidden = !on;
  const drawn = on && panel.querySelector("[data-company-method]:checked")?.value === "drawn";
  const pane = panel.querySelector("[data-company-pane]");
  pane.hidden = !drawn;
  if (drawn) attachPad(panel.querySelector("[data-company-pad]"));
  const name = panel.querySelector("[data-company-name]").value.trim();
  placers.get(panel.dataset.finalize)?.setCompany(on ? { name: name || "Panalo" } : null);
}

/**
 * What HR has set up in a finalize panel: where the signature (and Panalo's, if
 * counter-signing) goes, and who signs for Panalo. Returns { error } when
 * something is missing.
 */
function readFinalize(panel) {
  const placed = placers.get(panel.dataset.finalize)?.getPlacement();
  if (!placed) return { error: "Click on the page where the signature goes first." };
  const { company: marks, ...placement } = placed;
  if (!panel.querySelector("[data-company-on]").checked) return { placement, company: null };
  const name = panel.querySelector("[data-company-name]").value.trim();
  if (name.length < 2) return { error: "Enter the name of the person signing for Panalo." };
  if (!marks) return { error: "Click on the page where Panalo's signature goes." };
  const method = panel.querySelector("[data-company-method]:checked")?.value || "typed";
  const company = { name, position: panel.querySelector("[data-company-position]").value.trim(), method, signature: marks.signature, date: marks.date };
  if (method === "drawn") {
    const pad = attachPad(panel.querySelector("[data-company-pad]"));
    if (!pad?.isDirty()) return { error: "Write the signature for Panalo in the box first." };
    company.signatureImage = pad.toDataURL();
  }
  return { placement, company };
}

/** Opens the page viewer so HR can click where the signature and date go. */
async function openPlacer(root, button) {
  const { panel, id, msg } = finalizeParts(button);
  const host = panel.querySelector("[data-placer]");
  if (!host.hidden) { host.hidden = true; button.textContent = "Place the signature on the contract"; return; }
  button.disabled = true;
  msg.textContent = "Loading the contract pages…";
  try {
    if (!placers.has(id)) {
      const item = state.items.find(i => i.id === id);
      const signedName = item?.answers?.find(a => a.key === "signedName")?.value || "Signature";
      host.hidden = false;
      const refresh = () => {
        const ready = Boolean(placers.get(id)?.getPlacement());
        panel.querySelector("[data-sign-preview]").disabled = !ready;
        panel.querySelector("[data-finalize-go]").disabled = !ready;
      };
      placers.set(id, await createPlacer(host, {
        signedName, dateText: todayText(item.submittedAt), companyDateText: todayText(new Date().toISOString()),
        docs: item.signDocs.map(d => ({ label: d.label, load: async () => bytesFromBase64((await call("onboarding_sign_bytes", { docId: d.id })).pdf) })),
        onChange: refresh
      }));
    }
    host.hidden = false;
    syncCompany(panel);
    button.textContent = "Hide the pages";
    msg.textContent = "";
  } catch (error) {
    host.hidden = true;
    placers.delete(id);
    msg.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
}

/** Builds the signed contract with the chosen placement and opens it for HR to check. Nothing is stored. */
async function previewContract(root, button) {
  const { panel, id, msg } = finalizeParts(button);
  const choice = readFinalize(panel);
  if (choice.error) { msg.textContent = choice.error; return; }
  // Open the tab first, while the click is still fresh, or the browser blocks it.
  const tab = window.open("", "_blank");
  button.disabled = true;
  msg.textContent = "Building the preview…";
  try {
    const { pdf } = await call("onboarding_sign_preview", { itemId: id, placement: choice.placement, company: choice.company });
    const url = URL.createObjectURL(new Blob([bytesFromBase64(pdf)], { type: "application/pdf" }));
    if (tab) tab.location.href = url; else window.open(url, "_blank");
    msg.textContent = "Preview opened in a new tab. It is not filed yet.";
  } catch (error) {
    if (tab) tab.close();
    msg.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
}

/** Accepts the signature and files the stamped contract in the HR folder. */
async function finalizeContract(root, button) {
  const { panel, id, msg } = finalizeParts(button);
  const choice = readFinalize(panel);
  if (choice.error) { msg.textContent = choice.error; return; }
  const counter = choice.company ? ` It is also signed for Panalo by ${choice.company.name}${choice.company.position ? ` (${choice.company.position})` : ""}.` : "";
  if (!window.confirm(`Finalize this contract? The signature is stamped on page ${choice.placement.page} and the signed copy is filed in the person's HR folder.${counter}`)) return;
  button.disabled = true;
  try {
    const r = await call("onboarding_review", { itemId: id, accept: true, placement: choice.placement, company: choice.company });
    await loadOnboarding(root, { canIssuePasswords: state.canIssuePasswords });
    const note = root.querySelector("[data-detail-msg]");
    if (note) note.textContent = r.filingDeferred
      ? "Finalized, but filing in the HR folder failed. Open the person's HR file to retry."
      : r.requestComplete ? "Contract finalized and filed. All required documents accepted. Onboarding is complete." : "Contract finalized and filed in the HR folder.";
  } catch (error) {
    button.disabled = false;
    msg.textContent = friendlyError(error);
  }
}

/** Uploads a contract PDF: signed upload link, PUT, then the server checks and fingerprints it. */
async function uploadContract(root, input) {
  const file = input.files?.[0];
  if (!file) return;
  const box = input.closest(".add-file");
  const msg = box.querySelector("[data-sign-msg]");
  if (!/\.pdf$/i.test(file.name)) { msg.textContent = "Choose a PDF. Save Word files as PDF first."; input.value = ""; return; }
  if (file.size > 20 * 1024 * 1024) { msg.textContent = `${file.name} is over 20 MB.`; input.value = ""; return; }
  const label = (box.querySelector("[data-sign-label]")?.value || "").trim() || "Employment contract";
  input.disabled = true;
  msg.textContent = `Uploading ${file.name}…`;
  try {
    const itemId = input.dataset.signUpload;
    const prepared = await call("onboarding_sign_prepare", { itemId, fileName: file.name, size: file.size });
    const res = await fetch(prepared.signedUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
    if (!res.ok) throw new Error(`The upload failed (${res.status}). Please try again.`);
    await call("onboarding_sign_attach", { itemId, path: prepared.path, fileName: file.name, label });
    await loadOnboarding(root, { canIssuePasswords: state.canIssuePasswords });
  } catch (error) {
    msg.textContent = friendlyError(error);
    input.disabled = false;
    input.value = "";
  }
}

export function bindOnboarding(root) {
  root.addEventListener("change", event => {
    if (event.target.name === "employeeId") { state.asContractor = false; renderForm(root); }
    else if (event.target.name === "asContractor") { state.asContractor = event.target.checked; renderForm(root, { keep: true }); }
    else if (event.target.matches("input[type=file][data-sign-upload]")) uploadContract(root, event.target);
    else if (event.target.matches("[data-company-on], [data-company-method]")) syncCompany(event.target.closest("[data-finalize]"));
  });
  root.addEventListener("input", event => {
    if (event.target.matches("[data-company-name]")) syncCompany(event.target.closest("[data-finalize]"));
  });
  root.addEventListener("submit", async event => {
    if (!event.target.matches("[data-onb-form]")) return;
    event.preventDefault();
    const form = event.target;
    const msg = form.querySelector("[data-onb-form-msg]");
    const button = form.querySelector('button[type="submit"]');
    const types = [...form.querySelectorAll('input[name="types"]:checked')].map(i => i.value);
    if (!types.length) { msg.textContent = "Tick at least one document."; return; }
    button.disabled = true;
    msg.textContent = "Sending…";
    try {
      const person = state.people.find(p => p.id === form.employeeId.value);
      const result = await call("onboarding_create", { employeeId: form.employeeId.value, types, dueOn: form.dueOn.value || null, message: form.message.value, signIn: form.signIn.value });
      state.openId = result.requestId;
      state.asContractor = false;
      await loadOnboarding(root, { canIssuePasswords: state.canIssuePasswords });
      root.querySelector("[data-onb-form-msg]").textContent = result.invited
        ? `Invitation emailed to ${person.email}. They'll set a password, then see the checklist.`
        : result.tempPassword ? "Request created. Pass on the temporary password shown." : "Request created. They'll see it next time they sign in.";
      if (result.tempPassword) showTemporaryPassword({ name: person.fullName, email: person.email, password: result.tempPassword });
    } catch (error) {
      msg.textContent = friendlyError(error);
    } finally {
      button.disabled = false;
    }
  });
  root.addEventListener("click", async event => {
    const b = event.target.closest("button");
    if (!b) return;
    const detailMsg = () => root.querySelector("[data-detail-msg]");
    try {
      if (b.dataset.open) await openRequest(root, b.dataset.open);
      else if (b.dataset.viewFile) {
        b.disabled = true;
        const r = await call("onboarding_file", { fileId: b.dataset.viewFile });
        window.open(r.url, "_blank", "noopener");
        b.disabled = false;
      } else if (b.dataset.signView || b.dataset.signSignature) {
        b.disabled = true;
        const r = await call("onboarding_sign_view", b.dataset.signView ? { docId: b.dataset.signView } : { itemId: b.dataset.signSignature });
        window.open(r.url, "_blank", "noopener");
        b.disabled = false;
      } else if (b.dataset.companyClear) {
        attachPad(b.closest("[data-finalize]").querySelector("[data-company-pad]"))?.clear();
      } else if (b.dataset.placeOpen) {
        await openPlacer(root, b);
      } else if (b.dataset.signPreview) {
        await previewContract(root, b);
      } else if (b.dataset.finalizeGo) {
        await finalizeContract(root, b);
      } else if (b.dataset.signRemove) {
        if (!window.confirm("Remove this file from the contract? The applicant hasn't signed yet.")) return;
        b.disabled = true;
        await call("onboarding_sign_remove", { docId: b.dataset.signRemove });
        await loadOnboarding(root, { canIssuePasswords: state.canIssuePasswords });
      } else if (b.dataset.view) {
        b.disabled = true;
        const r = await call("onboarding_file", { itemId: b.dataset.view });
        window.open(r.url, "_blank", "noopener");
        b.disabled = false;
      } else if (b.dataset.accept) {
        b.disabled = true;
        const r = await call("onboarding_review", { itemId: b.dataset.accept, accept: true });
        await loadOnboarding(root, { canIssuePasswords: state.canIssuePasswords });
        if (r.requestComplete && detailMsg()) detailMsg().textContent = "All required documents accepted. Onboarding is complete.";
      } else if ("reveal" in b.dataset) {
        const span = b.previousElementSibling;
        const shown = b.textContent === "Hide";
        span.textContent = shown ? mask(span.dataset.secret) : span.dataset.secret;
        b.textContent = shown ? "Show" : "Hide";
      } else if ("acceptAll" in b.dataset) {
        const ids = [...root.querySelectorAll("[data-accept]")].map(x => x.dataset.accept);
        if (!window.confirm(`Accept ${ids.length} items? Check the answers first.`)) return;
        b.disabled = true;
        let complete = false;
        for (const id of ids) complete = (await call("onboarding_review", { itemId: id, accept: true })).requestComplete || complete;
        await loadOnboarding(root, { canIssuePasswords: state.canIssuePasswords });
        if (complete && detailMsg()) detailMsg().textContent = "All required items accepted. Onboarding is complete.";
      } else if (b.dataset.reject) {
        const reason = window.prompt("What should they fix? They'll see this message.", "");
        if (reason === null) return;
        b.disabled = true;
        await call("onboarding_review", { itemId: b.dataset.reject, accept: false, reason });
        await loadOnboarding(root, { canIssuePasswords: state.canIssuePasswords });
      } else if ("cancel" in b.dataset) {
        const reason = window.prompt("Cancel this request? Give a short reason for the record.", "");
        if (reason === null) return;
        await call("onboarding_cancel", { requestId: state.openId, reason });
        await loadOnboarding(root, { canIssuePasswords: state.canIssuePasswords });
      }
    } catch (error) {
      b.disabled = false;
      if (detailMsg()) detailMsg().textContent = friendlyError(error);
      else root.querySelector("[data-onb-msg]").textContent = friendlyError(error);
    }
  });
}
