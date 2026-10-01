// People register, positions and requirements, and the competency matrix.
// Rendered with escaped template strings, like the rest of the admin page.
import { api, config, friendlyError } from "../auth.js";

const STATUS_LABEL = {
  competent: "Competent",
  expiring: "Expiring",
  expired: "Expired",
  practical_pending: "Practical pending",
  assigned: "Assigned",
  gap: "Gap",
  awaiting_release: "Awaiting release",
  not_required: "—"
};
const STATUS_CLASS = {
  competent: "good", expiring: "warn", expired: "bad", practical_pending: "pending",
  assigned: "info", gap: "gap", awaiting_release: "", not_required: ""
};
const LICENCE_CLASS = { current: "good", expiring: "warn", expired: "bad", no_expiry: "" };
const LICENCE_LABEL = { current: "Current", expiring: "Expiring", expired: "Expired", no_expiry: "No expiry" };

const state = { ref: null, people: null, selected: null, positionId: null, matrix: null, filters: { q: "", site: "", position: "" }, practical: null };

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fmt(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}
function call(action, body = {}) { return api(config.adminFunction, { action, ...body }); }
function options(list, selected, label, value = "id", blank = "— none —") {
  return `<option value="">${safe(blank)}</option>` + list.map(item => `<option value="${safe(item[value])}" ${item[value] === selected ? "selected" : ""}>${safe(label(item))}</option>`).join("");
}
function message(el, text) { if (el) el.textContent = text || ""; }

/* ---------------- People ---------------- */

export async function loadPeople(root) {
  root.querySelector("[data-people-msg]").textContent = "Loading the employee register…";
  const [ref, people] = await Promise.all([call("people_reference"), call("people_list")]);
  state.ref = ref;
  state.people = people;
  if (!state.positionId && ref.positions[0]) state.positionId = ref.positions[0].id;
  renderPeople(root);
}

function personName(id) {
  return state.people?.employees.find(e => e.id === id)?.fullName || "—";
}

function renderPeople(root) {
  const { ref, people } = state;
  const q = state.filters.q.toLowerCase();
  const positions = new Map(ref.positions.map(p => [p.id, p]));
  const sites = new Map(ref.sites.map(s => [s.id, s]));
  const rows = people.employees.filter(e => !q || [e.fullName, e.employeeNumber, e.email, positions.get(e.positionId)?.title, sites.get(e.siteId)?.name].join(" ").toLowerCase().includes(q));
  root.querySelector("[data-people-body]").innerHTML = rows.map(e => {
    const lic = e.licences.filter(l => l.status === "expired" || l.status === "expiring");
    return `<tr class="${e.id === state.selected ? "selected-row" : ""}">
      <td><button type="button" class="link-btn" data-pick="${safe(e.id)}">${safe(e.fullName)}</button><small class="mono">${safe(e.employeeNumber)}</small></td>
      <td>${safe(positions.get(e.positionId)?.title || "—")}<small>${safe(sites.get(e.siteId)?.name || "")}</small></td>
      <td>${safe(e.employmentType)}<small>${safe(e.status.replace("_", " "))}</small></td>
      <td>${e.profileId ? '<span class="chip good">Linked</span>' : '<span class="chip">No login</span>'}</td>
      <td>${lic.length ? `<span class="chip ${lic.some(l => l.status === "expired") ? "bad" : "warn"}">${lic.length} licence${lic.length > 1 ? "s" : ""} due</span>` : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join("");
  message(root.querySelector("[data-people-msg]"), rows.length ? (people.truncated ? "Showing the first 2,000 people." : "") : "No one matches this search.");
  renderEditor(root);
  renderPositions(root);
}

function renderEditor(root) {
  const { ref, people } = state;
  const e = people.employees.find(x => x.id === state.selected) || { id: "", employeeNumber: "", fullName: "", email: "", employmentType: "employee", status: "active", positionId: "", siteId: "", supervisorId: "", startDate: "", endDate: "", licences: [], groups: [], profileId: null };
  const form = root.querySelector("[data-employee-form]");
  form.innerHTML = `
    <p class="eyebrow">${e.id ? "EDIT PERSON" : "NEW PERSON"}</p><h2>${safe(e.fullName || "Add to the register")}</h2>
    <input type="hidden" name="id" value="${safe(e.id)}">
    <div class="field-row">
      <div class="field"><label for="emp-number">Employee number</label><input id="emp-number" name="employeeNumber" required maxlength="30" value="${safe(e.employeeNumber)}"></div>
      <div class="field"><label for="emp-type">Type</label><select id="emp-type" name="employmentType">${["employee", "applicant", "contractor"].map(t => `<option ${t === e.employmentType ? "selected" : ""}>${t}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label for="emp-name">Full legal name</label><input id="emp-name" name="fullName" required maxlength="100" value="${safe(e.fullName)}"></div>
    <div class="field"><label for="emp-email">Email (links their training login)</label><input id="emp-email" name="email" type="email" maxlength="254" value="${safe(e.email || "")}"></div>
    <div class="field-row">
      <div class="field"><label for="emp-position">Position</label><select id="emp-position" name="positionId">${options(ref.positions, e.positionId, p => p.title)}</select></div>
      <div class="field"><label for="emp-site">Site</label><select id="emp-site" name="siteId">${options(ref.sites, e.siteId, s => s.name)}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="emp-sup">Supervisor</label><select id="emp-sup" name="supervisorId">${options(people.employees.filter(x => x.id !== e.id && x.status !== "terminated"), e.supervisorId, x => x.fullName)}</select></div>
      <div class="field"><label for="emp-status">Status</label><select id="emp-status" name="status">${["applicant", "active", "on_leave", "terminated"].map(t => `<option value="${t}" ${t === e.status ? "selected" : ""}>${t.replace("_", " ")}</option>`).join("")}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="emp-start">Start date</label><input id="emp-start" name="startDate" type="date" value="${safe(e.startDate || "")}"></div>
      <div class="field"><label for="emp-end">End date</label><input id="emp-end" name="endDate" type="date" value="${safe(e.endDate || "")}"></div>
    </div>
    <div class="form-actions"><button class="primary" type="submit">${e.id ? "Save changes" : "Add person"}</button>${e.id ? '<button class="secondary-action" type="button" data-new-person>New person</button>' : ""}</div>
    <p class="form-message" data-employee-msg role="status" aria-live="polite"></p>`;

  const extra = root.querySelector("[data-employee-extra]");
  if (!e.id) { extra.innerHTML = ""; return; }
  extra.innerHTML = `
    <h3>Licences and tickets</h3>
    <div class="list">${e.licences.map(l => `<div class="list-row"><div><strong>${safe(l.type)}</strong><small>${safe([l.number, l.issuer, l.expiresOn ? `expires ${fmt(l.expiresOn)}` : "", l.verified ? "sighted" : "not sighted"].filter(Boolean).join(" · "))}</small></div>
      <div class="row-actions"><span class="chip ${LICENCE_CLASS[l.status]}">${LICENCE_LABEL[l.status]}</span><button type="button" class="revoke" data-delete-licence="${safe(l.id)}" aria-label="Delete ${safe(l.type)}">Delete</button></div></div>`).join("") || '<p class="muted">None recorded.</p>'}</div>
    <form data-licence-form class="inline-form">
      <div class="field-row">
        <div class="field"><label for="lic-type">Licence or ticket</label><input id="lic-type" name="licenceType" required maxlength="120" placeholder="White card, forklift (LF), first aid…"></div>
        <div class="field"><label for="lic-number">Number</label><input id="lic-number" name="licenceNumber" maxlength="60"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="lic-issued">Issued</label><input id="lic-issued" name="issuedOn" type="date"></div>
        <div class="field"><label for="lic-expires">Expires</label><input id="lic-expires" name="expiresOn" type="date"></div>
      </div>
      <label class="check-field"><input type="checkbox" name="verified"> I have sighted the original or a certified copy</label>
      <button class="secondary-action" type="submit">Add licence</button>
      <p class="form-message" data-licence-msg role="status" aria-live="polite"></p>
    </form>
    <h3>Document access groups</h3>
    ${e.profileId ? `<div class="group-grid">${state.ref.groups.filter(g => !g.implicit).map(g => `<label class="check-field"><input type="checkbox" data-group="${safe(g.key)}" ${e.groups.includes(g.key) ? "checked" : ""}> ${safe(g.name)}</label>`).join("")}</div>
      <p class="muted small">"All employees" applies automatically to current staff on the register.</p>`
      : '<p class="muted">Groups can be set once this person has a training login with the same email.</p>'}`;
}

function renderPositions(root) {
  const { ref } = state;
  const pos = ref.positions.find(p => p.id === state.positionId);
  const req = new Map(ref.requirements.filter(r => r.positionId === state.positionId).map(r => [r.moduleId, r]));
  root.querySelector("[data-positions]").innerHTML = `
    <div class="register-head"><div><p class="eyebrow">TRAINING MATRIX SETUP</p><h2>Positions and required training</h2></div></div>
    <p class="muted">Each position lists the modules it needs. The competency matrix and refresher dates come from here.</p>
    <div class="field"><label for="req-position">Position</label><select id="req-position" data-position-select>${options(ref.positions, state.positionId, p => `${p.title} (${p.code})`, "id", "Choose a position")}</select></div>
    ${pos ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Module</th><th>Required</th><th>Refresher (months)</th><th>Before start</th></tr></thead><tbody>
      ${ref.modules.map(m => { const r = req.get(m.id); return `<tr data-req-row="${safe(m.id)}">
        <td><span class="mono">${safe(m.code)}</span><small>${safe(m.title)}${m.released ? "" : " · not yet released"}</small></td>
        <td><input type="checkbox" data-req-required aria-label="Required for ${safe(pos.title)}" ${r ? "checked" : ""}></td>
        <td><input type="number" min="1" max="120" data-req-months aria-label="Refresher months" value="${safe(r?.refresherMonths ?? "")}" ${r ? "" : "disabled"}></td>
        <td><input type="checkbox" data-req-before aria-label="Required before start" ${r?.requiredBeforeStart ? "checked" : ""} ${r ? "" : "disabled"}></td></tr>`; }).join("")}
      </tbody></table></div>` : ""}
    <p class="form-message" data-req-msg role="status" aria-live="polite"></p>
    <details class="add-ref"><summary>Add a position or site</summary>
      <form data-position-form class="inline-form"><div class="field-row">
        <div class="field"><label for="pos-code">Position code</label><input id="pos-code" name="code" required maxlength="30" placeholder="WELDER"></div>
        <div class="field"><label for="pos-title">Title</label><input id="pos-title" name="title" required maxlength="100" placeholder="Welder / Fabricator"></div></div>
        <label class="check-field"><input type="checkbox" name="safetyCritical"> Safety-critical role</label>
        <button class="secondary-action" type="submit">Add position</button></form>
      <form data-site-form class="inline-form"><div class="field-row">
        <div class="field"><label for="site-code">Site code</label><input id="site-code" name="code" required maxlength="30" placeholder="MAIN"></div>
        <div class="field"><label for="site-name">Site name</label><input id="site-name" name="name" required maxlength="100" placeholder="Main workshop"></div></div>
        <button class="secondary-action" type="submit">Add site</button></form>
      <p class="form-message" data-ref-msg role="status" aria-live="polite"></p>
    </details>`;
}

export function bindPeople(root) {
  root.addEventListener("click", async event => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.pick) { state.selected = target.dataset.pick; renderPeople(root); root.querySelector("[data-employee-form]").scrollIntoView({ block: "start", behavior: "smooth" }); }
    if ("newPerson" in target.dataset) { state.selected = null; renderEditor(root); }
    if (target.dataset.deleteLicence) {
      if (!window.confirm("Delete this licence record? The deletion is kept in the audit log.")) return;
      target.disabled = true;
      try { await call("licence_delete", { id: target.dataset.deleteLicence }); await loadPeople(root); }
      catch (error) { target.disabled = false; window.alert(friendlyError(error)); }
    }
  });
  root.addEventListener("input", event => {
    if (event.target.matches("[data-people-search]")) { state.filters.q = event.target.value; renderPeople(root); root.querySelector("[data-people-search]").focus(); }
  });
  root.addEventListener("change", async event => {
    const el = event.target;
    if (el.matches("[data-position-select]")) { state.positionId = el.value; renderPositions(root); return; }
    if (el.dataset.group) {
      const e = state.people.employees.find(x => x.id === state.selected);
      el.disabled = true;
      try { await call("group_member_set", { group: el.dataset.group, profileId: e.profileId, member: el.checked }); await loadPeople(root); }
      catch (error) { el.checked = !el.checked; el.disabled = false; window.alert(friendlyError(error)); }
      return;
    }
    const row = el.closest("[data-req-row]");
    if (row) {
      const required = row.querySelector("[data-req-required]").checked;
      const msg = root.querySelector("[data-req-msg]");
      message(msg, "Saving requirement…");
      try {
        await call("requirement_set", {
          positionId: state.positionId, moduleId: row.dataset.reqRow, required,
          refresherMonths: required ? row.querySelector("[data-req-months]").value || null : null,
          requiredBeforeStart: required && row.querySelector("[data-req-before]").checked
        });
        state.ref = await call("people_reference");
        renderPositions(root);
        message(root.querySelector("[data-req-msg]"), "Requirement saved.");
      } catch (error) { message(msg, friendlyError(error)); }
    }
  });
  root.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    try {
      if (form.matches("[data-employee-form]")) {
        message(form.querySelector("[data-employee-msg]"), "Saving…");
        const result = await call("employee_save", data);
        state.selected = result.id;
        await loadPeople(root);
        message(root.querySelector("[data-employee-msg]"), "Saved and recorded in the audit log.");
      } else if (form.matches("[data-licence-form]")) {
        await call("licence_save", { ...data, employeeId: state.selected, verified: form.verified.checked });
        await loadPeople(root);
      } else if (form.matches("[data-position-form]")) {
        const result = await call("position_save", { ...data, safetyCritical: form.safetyCritical.checked });
        state.positionId = result.id;
        await loadPeople(root);
      } else if (form.matches("[data-site-form]")) {
        await call("site_save", data);
        await loadPeople(root);
      }
    } catch (error) {
      const msg = form.querySelector(".form-message") || root.querySelector("[data-ref-msg]");
      message(msg, friendlyError(error));
    } finally {
      button.disabled = false;
    }
  });
}

/* ---------------- Competency matrix ---------------- */

export async function loadMatrix(root) {
  message(root.querySelector("[data-matrix-msg]"), "Calculating competency…");
  state.matrix = await call("competency_matrix");
  renderMatrix(root);
}

function renderMatrix(root) {
  const m = state.matrix;
  const site = root.querySelector("[data-matrix-site]")?.value || "";
  const position = root.querySelector("[data-matrix-position]")?.value || "";
  root.querySelector("[data-matrix-filters]").innerHTML = `
    <div class="field"><label for="mx-site">Site</label><select id="mx-site" data-matrix-site>${options(m.sites, site, s => s.name, "id", "All sites")}</select></div>
    <div class="field"><label for="mx-pos">Position</label><select id="mx-pos" data-matrix-position>${options(m.positions, position, p => p.title, "id", "All positions")}</select></div>
    <div class="matrix-score"><strong>${m.summary.required ? Math.round(m.summary.competent / m.summary.required * 100) : 0}%</strong><span>${m.summary.competent} of ${m.summary.required} required modules competent</span></div>`;
  root.querySelector("[data-matrix-legend]").innerHTML = ["competent", "expiring", "expired", "practical_pending", "assigned", "gap", "awaiting_release"]
    .map(s => `<span class="chip ${STATUS_CLASS[s]}">${STATUS_LABEL[s]}</span>`).join("");
  const rows = m.rows.filter(r => (!site || r.siteId === site) && (!position || r.positionId === position));
  const pos = new Map(m.positions.map(p => [p.id, p.title]));
  root.querySelector("[data-matrix-head]").innerHTML = `<tr><th>Person</th>${m.columns.map(c => `<th><span class="mono">${safe(c.code)}</span><small>${safe(c.title)}</small></th>`).join("")}</tr>`;
  root.querySelector("[data-matrix-body]").innerHTML = rows.map(r => `<tr><td><strong>${safe(r.fullName)}</strong><small>${safe(pos.get(r.positionId) || "No position")}${r.linked ? "" : " · no login"}</small></td>
    ${r.cells.map(c => {
      const sub = c.status === "competent" || c.status === "expiring" || c.status === "expired" ? (c.competentUntil ? `to ${fmt(c.competentUntil)}` : "no expiry")
        : c.status === "assigned" ? `due ${fmt(c.dueBy)}` : c.status === "gap" ? "not assigned" : "";
      const action = c.practicalAssignmentId ? `<button type="button" class="link-btn small" data-practical="${safe(c.practicalAssignmentId)}" data-who="${safe(r.fullName)}">Record practical</button>` : "";
      return `<td>${c.status === "not_required" ? '<span class="muted">—</span>' : `<span class="chip ${STATUS_CLASS[c.status]}">${STATUS_LABEL[c.status]}</span><small>${sub}</small>${action}`}</td>`;
    }).join("")}</tr>`).join("");
  message(root.querySelector("[data-matrix-msg]"), m.columns.length ? (rows.length ? "" : "No one matches these filters.") : "Set required modules for each position under People to build the matrix.");
}

export function bindMatrix(root) {
  root.addEventListener("change", event => { if (event.target.matches("[data-matrix-site],[data-matrix-position]")) renderMatrix(root); });
  root.addEventListener("click", event => {
    const button = event.target.closest("[data-practical]");
    if (!button) return;
    const form = root.querySelector("[data-practical-form]");
    form.classList.remove("hidden");
    form.assignmentId.value = button.dataset.practical;
    form.querySelector("[data-practical-who]").textContent = button.dataset.who;
    form.assessedOn.value = new Date().toISOString().slice(0, 10);
    form.siteId.innerHTML = options(state.matrix.sites, "", s => s.name, "id", "Not recorded");
    form.scrollIntoView({ block: "center", behavior: "smooth" });
    form.assessorName.focus();
  });
  root.addEventListener("submit", async event => {
    if (!event.target.matches("[data-practical-form]")) return;
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    message(form.querySelector(".form-message"), "Recording…");
    try {
      await call("practical_record", Object.fromEntries(new FormData(form)));
      form.reset();
      form.classList.add("hidden");
      await loadMatrix(root);
      message(root.querySelector("[data-matrix-msg]"), "Practical verification recorded.");
    } catch (error) {
      message(form.querySelector(".form-message"), friendlyError(error));
    } finally {
      button.disabled = false;
    }
  });
  root.querySelector("[data-practical-cancel]").addEventListener("click", () => root.querySelector("[data-practical-form]").classList.add("hidden"));
}
