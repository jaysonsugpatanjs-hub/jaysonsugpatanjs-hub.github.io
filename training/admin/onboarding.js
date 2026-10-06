// Onboarding tab: send applicants the document checklist, track progress and
// review each upload. Also hosts the one-time temporary password dialog.
import { api, config, friendlyError } from "../auth.js";

const call = (action, body = {}) => api(config.adminFunction, { action, ...body });
const state = { types: [], people: [], requests: [], openId: null, canIssuePasswords: false };

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fmt(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(iso));
}
const ITEM = { pending: ["Not sent yet", ""], uploaded: ["To review", "pending"], accepted: ["Accepted", "good"], rejected: ["Sent back", "bad"] };
const mask = v => (v.length > 3 ? "•".repeat(Math.min(v.length - 3, 8)) + v.slice(-3) : "•••");

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

function typesFor(person) {
  return state.types.filter(t => t.active && t.appliesTo.includes(person?.employmentType || "applicant"));
}

function renderForm(root) {
  const form = root.querySelector("[data-onb-form]");
  const selected = form.employeeId?.value || "";
  const person = state.people.find(p => p.id === selected);
  const open = new Set(state.requests.filter(r => r.status === "open").map(r => r.employeeId));
  form.innerHTML = `
    <p class="eyebrow">SEND ONBOARDING LINK</p><h2>Request details</h2>
    <div class="field"><label for="onb-person">Person</label>
      <select id="onb-person" name="employeeId" required><option value="">Choose from the register</option>
      ${state.people.map(p => `<option value="${safe(p.id)}" ${p.id === selected ? "selected" : ""} ${open.has(p.id) ? "disabled" : ""}>${safe(p.fullName)} · ${safe(p.employmentType)}${p.email ? "" : " · no email"}${open.has(p.id) ? " · request open" : ""}</option>`).join("")}
      </select><small>Add new applicants under People first, with their email address.</small></div>
    ${person ? `<fieldset class="doc-picks"><legend>Documents for ${safe(person.employmentType)}s</legend>
      ${typesFor(person).map(t => `<label class="check-field"><input type="checkbox" name="types" value="${safe(t.key)}" ${t.required ? "checked" : ""}>
        <span><strong>${safe(t.name)}</strong> <span class='chip'>${t.kind === "form" ? "Fill in" : "Photo/PDF"}</span>${t.required ? "" : " <span class='chip'>Optional</span>"}${t.sensitive ? " <span class='chip info'>Sensitive</span>" : ""}<small>${safe(t.guidance)}</small></span></label>`).join("")}
      </fieldset>
      <div class="field-row">
        <div class="field"><label for="onb-due">Due by</label><input id="onb-due" name="dueOn" type="date"></div>
        <div class="field"><label for="onb-signin">How they'll sign in</label><select id="onb-signin" name="signIn">
          <option value="invite">Email them a link to set a password</option>
          ${state.canIssuePasswords ? '<option value="password">Create a temporary password (shown once)</option>' : ""}
        </select></div>
      </div>
      <small class="muted">${person.profileId ? "They already have a sign-in; they'll see the checklist next time they sign in." : "They don't have a sign-in yet; one is created now."}</small>
      <div class="field"><label for="onb-msg">Message to them (optional)</label><textarea id="onb-msg" name="message" rows="2" maxlength="1000" placeholder="Welcome to Panalo. Please complete these before your first day."></textarea></div>
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
  try {
    const { request, items } = await call("onboarding_detail", { requestId: id });
    panel.innerHTML = `
      <div class="register-head"><div><p class="eyebrow">ONBOARDING · ${safe(request.status.toUpperCase())}</p><h2>${safe(request.person.name)}</h2>
        <p class="muted small">${safe(request.person.email || "")} · sent ${fmt(request.createdAt)}${request.dueOn ? ` · due ${fmt(request.dueOn)}` : ""}</p></div>
        ${request.status === "open" ? '<button type="button" class="revoke" data-cancel>Cancel request</button>' : ""}</div>
      ${request.cancelledReason ? `<p class="muted">Cancelled: ${safe(request.cancelledReason)}</p>` : ""}
      <div class="list">${items.map(i => {
        const [label, tone] = ITEM[i.status] || [i.status, ""];
        return `<div class="list-row review-row"><div>
            <strong>${safe(i.name)}</strong>${i.required ? "" : " <span class='chip'>Optional</span>"}${i.sensitive ? " <span class='chip info'>Sensitive</span>" : ""}
            <small>${i.kind === "form"
              ? (i.submittedAt ? `Filled in ${fmt(i.submittedAt)}` : "Not filled in yet")
              : (i.fileName ? `${safe(i.fileName)} · uploaded ${fmt(i.uploadedAt)}` : "Nothing uploaded yet")}${i.kind === "form" && i.fileName ? ` · earlier file: ${safe(i.fileName)}` : ""}${i.reviewer ? ` · reviewed by ${safe(i.reviewer)}` : ""}</small>
            ${i.status === "rejected" ? `<small class="reject-note">Sent back: ${safe(i.rejectReason)}</small>` : ""}
            ${answersHtml(i)}</div>
          <div class="row-actions"><span class="chip ${tone}">${label}</span>
            ${i.fileName ? `<button type="button" class="secondary-action small" data-view="${safe(i.id)}">View</button>` : ""}
            ${i.status === "uploaded" && request.status === "open" ? `<button type="button" class="primary small" data-accept="${safe(i.id)}">Accept</button><button type="button" class="revoke" data-reject="${safe(i.id)}">Send back</button>` : ""}
          </div></div>`;
      }).join("")}</div>
      ${request.status === "open" && items.filter(i => i.status === "uploaded").length > 1 ? '<div class="form-actions"><button type="button" class="primary" data-accept-all>Accept everything waiting for review</button></div>' : ""}
      <p class="muted small">Opening a request with answers, and viewing each file, is recorded in the audit log. File links last two minutes.</p>
      <p class="form-message" data-detail-msg role="status" aria-live="polite"></p>`;
  } catch (error) {
    panel.innerHTML = `<p class="form-message">${safe(friendlyError(error))}</p>`;
  }
}

export function bindOnboarding(root) {
  root.addEventListener("change", event => { if (event.target.name === "employeeId") renderForm(root); });
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
      else if (b.dataset.view) {
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
