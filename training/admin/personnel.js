// HR files tab: each person's personnel folder, sorted into categories.
// Accepted onboarding items arrive here automatically; HR can add documents,
// view them (two-minute links, audited) and archive them with a reason.
import { api, config, friendlyError } from "../auth.js";

const call = (action, body = {}) => api(config.adminFunction, { action, ...body });
const state = { people: [], selected: null, file: null, showArchived: false, query: "" };
const FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const SOURCE = { onboarding_upload: "From onboarding", onboarding_form: "Onboarding answers (PDF)", hr_upload: "Added by HR" };

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fmt(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(iso));
}
const today = () => new Date().toISOString().slice(0, 10);

export async function loadPersonnel(root, employeeId) {
  root.querySelector("[data-hr-msg]").textContent = "Loading HR files…";
  state.people = (await call("personnel_people")).people;
  root.querySelector("[data-hr-msg]").textContent = "";
  renderPeople(root);
  const pick = employeeId || state.selected;
  if (pick) await openPerson(root, pick);
}

function renderPeople(root) {
  const q = state.query.toLowerCase();
  const rows = state.people.filter(p => !q || `${p.name} ${p.number} ${p.type}`.toLowerCase().includes(q));
  root.querySelector("[data-hr-people]").innerHTML = rows.map(p => `<tr class="${p.id === state.selected ? "selected-row" : ""}">
      <td><button type="button" class="link-btn" data-hr-open="${safe(p.id)}">${safe(p.name)}</button><small>${safe(p.type)} · ${safe(p.number)}${p.status === "terminated" ? " · former" : ""}</small></td>
      <td>${p.documents}${p.expired ? `<small class="reject-note">${p.expired} expired</small>` : ""}</td></tr>`).join("")
    || '<tr><td colspan="2" class="muted">No one matches.</td></tr>';
}

async function openPerson(root, id) {
  state.selected = id;
  renderPeople(root);
  const panel = root.querySelector("[data-hr-file]");
  panel.innerHTML = '<p class="muted">Opening HR file…</p>';
  try {
    state.file = await call("personnel_view", { employeeId: id });
    renderFile(root);
    if (state.file.filedNow) root.querySelector("[data-hr-file-msg]").textContent = `${state.file.filedNow} accepted onboarding item${state.file.filedNow === 1 ? " was" : "s were"} filed just now.`;
  } catch (error) {
    panel.innerHTML = `<p class="form-message">${safe(friendlyError(error))}</p>`;
  }
}

function docRow(d) {
  const expired = d.expiresOn && d.expiresOn < today();
  return `<li class="${d.archivedAt ? "archived" : ""}">
      <div><strong>${safe(d.title)}</strong>
        <small>${safe(SOURCE[d.source] || d.source)} · filed ${fmt(d.filedAt)}${d.filedBy ? ` by ${safe(d.filedBy)}` : ""}${d.expiresOn ? ` · <span class="${expired ? "reject-note" : ""}">${expired ? "expired" : "expires"} ${fmt(d.expiresOn)}</span>` : ""}</small>
        ${d.archivedAt ? `<small>Archived ${fmt(d.archivedAt)}: ${safe(d.archiveReason)}</small>` : ""}</div>
      <div class="row-actions"><button type="button" class="secondary-action small" data-hr-view="${safe(d.id)}">View</button>
        ${d.archivedAt ? "" : `<button type="button" class="text-button" data-hr-archive="${safe(d.id)}">Archive</button>`}</div></li>`;
}

function renderFile(root) {
  const f = state.file;
  const panel = root.querySelector("[data-hr-file]");
  const visible = docs => docs.filter(d => state.showArchived || !d.archivedAt);
  const archivedCount = f.categories.reduce((n, c) => n + c.documents.filter(d => d.archivedAt).length, 0);
  panel.innerHTML = `
    <div class="register-head"><div><p class="eyebrow">HR FILE · ${safe(String(f.person.type).toUpperCase())}</p><h2>${safe(f.person.name)}</h2>
      <p class="muted small">${safe(f.person.number)} · HR › Personnel files › ${safe(f.person.name)}</p></div>
      ${archivedCount ? `<label class="check-field inline-check"><input type="checkbox" data-hr-archived ${state.showArchived ? "checked" : ""}> Show ${archivedCount} archived</label>` : ""}</div>
    <div class="hr-folders">
      ${f.categories.map(c => {
        const docs = visible(c.documents);
        const extra = c.key === "training" ? f.training : [];
        const count = docs.length + extra.length;
        return `<details class="hr-folder" ${count ? "open" : ""}>
          <summary>${FOLDER}<span><strong>${safe(c.name)}</strong><small>${safe(c.description)}</small></span>
            ${c.sensitive ? '<span class="chip info">Restricted</span>' : ""}<span class="chip">${count}</span></summary>
          ${count ? `<ul class="file-list">${docs.map(docRow).join("")}
            ${extra.map(t => `<li><div><strong>${safe(t.module)}${t.revision ? ` · ${safe(t.revision)}` : ""}</strong>
              <small>Portal certificate ${safe(t.number)} · issued ${fmt(t.issuedAt)}${t.status === "void" ? ' · <span class="reject-note">void</span>' : ""}</small></div>
              <div class="row-actions"><button type="button" class="secondary-action small" data-hr-cert="${safe(t.id)}">View</button></div></li>`).join("")}</ul>`
            : '<p class="muted small empty-folder">Empty</p>'}
        </details>`;
      }).join("")}
    </div>
    <form class="admin-form hr-add" data-hr-add>
      <p class="eyebrow">ADD TO THIS HR FILE</p>
      <div class="field-row">
        <div class="field"><label for="hr-cat">Folder</label><select id="hr-cat" name="category" required>
          ${f.categories.filter(c => c.key !== "training").map(c => `<option value="${safe(c.key)}">${safe(c.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="hr-title">Title</label><input id="hr-title" name="title" required minlength="2" maxlength="160" placeholder="e.g. Probation review"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="hr-exp">Expiry date (if any)</label><input id="hr-exp" name="expiresOn" type="date"></div>
        <div class="field"><label for="hr-upload">File (PDF or photo, up to 20 MB)</label><input id="hr-upload" name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*"></div>
      </div>
      <button class="primary" type="submit">Add document</button>
    </form>
    <p class="muted small">Records are never deleted: archiving keeps them for the 7-year retention period. Opening this file and each document is recorded in the audit log.</p>
    <p class="form-message" data-hr-file-msg role="status" aria-live="polite"></p>`;
}

export function bindPersonnel(root) {
  root.addEventListener("input", event => {
    if (event.target.matches("[data-hr-search]")) { state.query = event.target.value; renderPeople(root); }
  });
  root.addEventListener("change", event => {
    if (event.target.matches("[data-hr-archived]")) { state.showArchived = event.target.checked; renderFile(root); }
  });
  root.addEventListener("submit", async event => {
    if (!event.target.matches("[data-hr-add]")) return;
    event.preventDefault();
    const form = event.target;
    const msg = root.querySelector("[data-hr-file-msg]");
    const file = form.file.files[0];
    if (!file) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    msg.textContent = `Uploading ${file.name}…`;
    try {
      const prepared = await call("personnel_prepare_upload", { employeeId: state.selected, category: form.category.value, fileName: file.name, size: file.size });
      const res = await fetch(prepared.signedUrl, { method: "PUT", headers: { "Content-Type": prepared.contentType }, body: file });
      if (!res.ok) throw new Error(`The upload failed (${res.status}). Please try again.`);
      await call("personnel_add", { employeeId: state.selected, category: form.category.value, path: prepared.path, fileName: file.name, title: form.title.value, expiresOn: form.expiresOn.value || null });
      await loadPersonnel(root);
      root.querySelector("[data-hr-file-msg]").textContent = "Added to the HR file.";
    } catch (error) {
      msg.textContent = friendlyError(error);
      button.disabled = false;
    }
  });
  root.addEventListener("click", async event => {
    const b = event.target.closest("button");
    if (!b) return;
    const msg = () => root.querySelector("[data-hr-file-msg]") || root.querySelector("[data-hr-msg]");
    try {
      if (b.dataset.hrOpen) await openPerson(root, b.dataset.hrOpen);
      else if (b.dataset.hrView || b.dataset.hrCert) {
        b.disabled = true;
        const r = b.dataset.hrView ? await call("personnel_open", { documentId: b.dataset.hrView }) : await call("personnel_open_certificate", { certificateId: b.dataset.hrCert });
        window.open(r.url, "_blank", "noopener");
        b.disabled = false;
      } else if (b.dataset.hrArchive) {
        const reason = window.prompt("Archive this document? It stays on record. Give a reason:", "");
        if (reason === null) return;
        b.disabled = true;
        await call("personnel_archive", { documentId: b.dataset.hrArchive, reason });
        await loadPersonnel(root);
      }
    } catch (error) {
      b.disabled = false;
      if (msg()) msg().textContent = friendlyError(error);
    }
  });
}
