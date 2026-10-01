// IMS document browser: folders, documents, revisions, approvals and folder
// access. Mounted on the standalone staff page and inside administration.
import { api, config, friendlyError } from "../auth.js";

const LEVEL_LABEL = { none: "No access", viewer: "Viewer", editor: "Editor", approver: "Approver", owner: "Owner" };
const GATE_LABEL = { technical: "Technical approval", whs: "WHS approval", ims: "IMS approval" };
const fn = () => config.imsFunction || "ims-api";

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fmt(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}
function sydneyToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function reviewChip(due) {
  if (!due) return '<span class="chip">Set on approval</span>';
  const days = Math.round((Date.parse(due) - Date.parse(sydneyToday())) / 86400000);
  if (days < 0) return `<span class="chip bad">Overdue · ${fmt(due)}</span>`;
  if (days <= 60) return `<span class="chip warn">Due ${fmt(due)}</span>`;
  return `<span class="chip">${fmt(due)}</span>`;
}
const FOLDER_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#f5b40026" stroke="#f5b400" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const LOCK_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff7d86" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export function mountIms(root) {
  const s = { folderId: null, view: null, access: null, documentId: null, doc: null };
  root.innerHTML = `
    <section class="portal-card ims-browser">
      <nav class="crumbs" aria-label="Folder path" data-crumbs></nav>
      <div class="ims-head">
        <div><h2 data-folder-name>Loading…</h2><p class="muted" data-folder-note></p></div>
        <div class="ims-level"><span class="muted">Your access</span> <span data-folder-level class="chip"></span></div>
      </div>
      <div data-folder-body></div>
      <p class="form-message" data-ims-msg role="status" aria-live="polite"></p>
    </section>
    <div class="ims-split">
      <section class="portal-card" data-doc-panel><h2>Document</h2><p class="muted">Pick a document to see its revisions and approvals.</p></section>
      <section class="portal-card" data-access-panel></section>
    </div>`;

  const $ = sel => root.querySelector(sel);
  const msg = text => { $("[data-ims-msg]").textContent = text || ""; };
  const call = (action, body = {}) => api(fn(), { action, ...body });

  async function openFolder(folderId) {
    msg("");
    s.folderId = folderId;
    s.view = await call("folder", folderId ? { folderId } : {});
    if (!s.view.root && s.view.canCreateRoot) {
      $("[data-folder-name]").textContent = "Document control is not set up yet";
      $("[data-folder-note]").textContent = "Create the main Panalo Asset File folder to begin. You will own it and can then build the folder structure.";
      $("[data-folder-body]").innerHTML = '<button class="primary" type="button" data-create-root>Create Panalo Asset File</button>';
      return;
    }
    if (!s.view.root && !s.view.folder) {
      $("[data-folder-name]").textContent = "No document folders yet";
      $("[data-folder-note]").textContent = "Ask a system administrator to set up document control.";
      return;
    }
    s.folderId = s.view.folder.id;
    renderFolder();
    await loadAccess();
  }

  function renderFolder() {
    const v = s.view;
    $("[data-crumbs]").innerHTML = v.path.map((p, i) => i === v.path.length - 1
      ? `<span class="crumb-current">${safe(p.name)}</span>`
      : `<button type="button" class="link-btn crumb" data-folder="${safe(p.id)}">${safe(p.name)}</button><span aria-hidden="true">›</span>`).join("");
    $("[data-folder-name]").textContent = v.folder.name;
    $("[data-folder-note]").textContent = v.folder.isRoot
      ? "Main Panalo asset file. Access set on a folder flows down to everything inside it."
      : v.folder.inherits ? "Inherits access from the folder above." : "Has its own access list.";
    const lvl = $("[data-folder-level]");
    lvl.className = `chip ${v.folder.level}`;
    lvl.textContent = LEVEL_LABEL[v.folder.level];

    if (v.folder.level === "none") {
      $("[data-folder-body]").innerHTML = `<div class="locked-panel">${LOCK_ICON}<div><strong>You don’t have access to this folder</strong>
        <p class="muted">Its contents stay hidden. Access is granted by the folder owner: ${safe((v.owners || []).join(", ") || "the folder owner")}.</p></div>
        <button class="secondary-action" type="button" data-request>Request access</button></div>`;
      return;
    }
    const canEdit = ["editor", "approver", "owner"].includes(v.folder.level);
    const tiles = v.children.map(c => `<button type="button" class="folder-tile" data-folder="${safe(c.id)}">
        ${c.level === "none" ? LOCK_ICON : FOLDER_ICON}
        <span class="tile-text"><strong>${safe(c.name)}</strong><small>${c.level === "none" ? "Restricted" : [c.folderCount ? `${c.folderCount} folder${c.folderCount === 1 ? "" : "s"}` : "", `${c.documentCount} document${c.documentCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}${c.inherits ? "" : " · own access list"}</small></span>
        <span class="chip ${c.level}">${LEVEL_LABEL[c.level]}</span></button>`).join("");
    const docs = v.documents.map(d => `<tr class="${d.id === s.documentId ? "selected-row" : ""}">
        <td><button type="button" class="link-btn mono" data-doc="${safe(d.id)}">${safe(d.docNumber)}</button><small>${safe(d.title)}</small></td>
        <td>${safe(d.type)}</td>
        <td>${safe(d.currentRevision || "—")}${d.pending ? `<small>${safe(d.pending.revision)} in approval (${d.pending.approved}/${d.pending.required})</small>` : ""}</td>
        <td>${d.status === "approved" ? '<span class="chip good">Approved</span>' : '<span class="chip pending">Draft</span>'}</td>
        <td>${reviewChip(d.reviewDue)}</td></tr>`).join("");
    $("[data-folder-body]").innerHTML = `
      ${tiles ? `<div class="folder-grid">${tiles}</div>` : ""}
      ${docs ? `<div class="table-wrap"><table><thead><tr><th>Document</th><th>Type</th><th>Revision</th><th>Status</th><th>Review due</th></tr></thead><tbody>${docs}</tbody></table></div>` : ""}
      ${!tiles && !docs ? '<p class="empty-note">This folder is empty.</p>' : ""}
      ${v.hiddenDrafts ? `<p class="muted small">${v.hiddenDrafts} draft${v.hiddenDrafts === 1 ? " is" : "s are"} hidden: viewers see approved revisions only.</p>` : ""}
      ${canEdit || v.folder.level === "owner" ? `<details class="add-ref"><summary>Add to this folder</summary>
        ${v.folder.level === "owner" ? `<form data-new-folder class="inline-form"><div class="field"><label for="nf-name">New folder name</label><input id="nf-name" name="name" required maxlength="120"></div><button class="secondary-action" type="submit">Create folder</button></form>` : ""}
        ${canEdit ? `<form data-new-doc class="inline-form">
          <div class="field-row"><div class="field"><label for="nd-num">Document number</label><input id="nd-num" name="docNumber" required maxlength="50" placeholder="PP-PRO-001"></div>
          <div class="field"><label for="nd-type">Type</label><select id="nd-type" name="docType">${["Procedure", "Form", "Register", "Policy", "Manual", "Plan", "Training module", "Record"].map(t => `<option>${t}</option>`).join("")}</select></div></div>
          <div class="field"><label for="nd-title">Title</label><input id="nd-title" name="title" required maxlength="200"></div>
          <fieldset class="gates"><legend>Approvals required before release</legend>
            ${Object.entries(GATE_LABEL).map(([g, l]) => `<label class="check-field"><input type="checkbox" name="gate" value="${g}" ${g === "ims" ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
          <div class="field"><label for="nd-review">Review every (months)</label><input id="nd-review" name="reviewMonths" type="number" min="1" max="60" value="12"></div>
          <button class="secondary-action" type="submit">Create document</button></form>` : ""}
      </details>` : ""}`;
  }

  async function loadAccess() {
    const panel = $("[data-access-panel]");
    if (s.view.folder.level === "none") {
      panel.innerHTML = '<h2>Folder access</h2><p class="muted">The access list is visible only to people who can open this folder.</p>';
      return;
    }
    s.access = await call("access", { folderId: s.folderId });
    const a = s.access;
    const sorted = [...a.grants].sort((x, y) => ["owner", "approver", "editor", "viewer"].indexOf(x.level) - ["owner", "approver", "editor", "viewer"].indexOf(y.level) || (x.inheritedFrom ? 1 : 0) - (y.inheritedFrom ? 1 : 0));
    const owners = a.grants.filter(g => g.level === "owner").length;
    const isOwner = a.level === "owner";
    panel.innerHTML = `
      <h2>Folder access</h2><p class="muted">Who can open ${safe(s.view.folder.name)}</p>
      <div class="level-key">
        <div><span class="chip viewer">Viewer</span><small>Approved revisions only</small></div>
        <div><span class="chip editor">Editor</span><small>Drafts and new revisions</small></div>
        <div><span class="chip approver">Approver</span><small>Signs off revisions</small></div>
        <div><span class="chip owner">Owner</span><small>Everything, plus access</small></div>
      </div>
      ${a.isRoot ? "" : `<div class="inherit-row"><span class="chip ${a.inherits ? "info" : "warn"}">${a.inherits ? "Inheriting" : "Own access list"}</span>
        <span class="muted">${a.inherits ? `Inherits from ${safe(a.parentName)}. Grants added here are on top of that.` : "Inheritance stopped: only the access listed here applies."}</span>
        ${isOwner ? `<button type="button" class="secondary-action small" data-inherit="${a.inherits ? "false" : "true"}">${a.inherits ? "Stop inheriting" : `Inherit from ${safe(a.parentName)}`}</button>` : ""}</div>`}
      <div class="list">${sorted.map(g => `<div class="list-row"><div><strong>${safe(g.principal.name)}</strong><small>${g.principal.type === "group" ? "Group" : "Person"} · ${g.inheritedFrom ? `inherited from ${safe(g.inheritedFrom)}` : "set here"}</small></div>
        <div class="row-actions"><span class="chip ${g.level}">${LEVEL_LABEL[g.level]}</span>
        ${isOwner && !g.inheritedFrom && !(g.level === "owner" && owners === 1) ? `<button type="button" class="revoke" data-remove-grant="${safe(g.id)}" aria-label="Remove ${safe(g.principal.name)}">Remove</button>` : ""}</div></div>`).join("")}</div>
      ${isOwner ? `<form data-grant class="inline-form grant-form"><h3>Grant access</h3>
        <div class="field-row"><div class="field"><label for="gr-who">Person or group</label><select id="gr-who" name="who">
          <optgroup label="Groups">${a.principals.groups.map(g => `<option value="group:${safe(g.key)}">${safe(g.name)}</option>`).join("")}</optgroup>
          <optgroup label="People">${a.principals.people.map(p => `<option value="person:${safe(p.id)}">${safe(p.name)}</option>`).join("")}</optgroup></select></div>
        <div class="field"><label for="gr-level">Access level</label><select id="gr-level" name="level"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="approver">Approver</option><option value="owner">Owner</option></select></div></div>
        <button class="primary" type="submit">Grant access</button>
        <p class="muted small">Applies straight away and is written to the audit log. Granting again replaces that person’s or group’s level.</p></form>`
        : `<p class="muted small">Only the folder owner can change access.</p>`}`;
  }

  async function openDocument(documentId) {
    s.documentId = documentId;
    const panel = $("[data-doc-panel]");
    panel.innerHTML = '<p class="muted">Loading document…</p>';
    try {
      s.doc = await call("document", { documentId });
    } catch (error) {
      panel.innerHTML = `<p class="form-message">${safe(friendlyError(error))}</p>`;
      return;
    }
    renderFolder();
    const { document: d, revisions, links, canRevise } = s.doc;
    panel.innerHTML = `
      <p class="mono muted">${safe(d.docNumber)} · ${safe(d.type)}</p><h2>${safe(d.title)}</h2>
      <div class="chips">${d.status === "approved" ? '<span class="chip good">Approved</span>' : '<span class="chip pending">Draft</span>'}
        ${d.owner ? `<span class="chip">Owner ${safe(d.owner)}</span>` : ""}${reviewChip(d.reviewDue)}
        ${d.controlsTrainingModule ? '<span class="chip info">Controls a training module</span>' : ""}</div>
      <p class="muted small">Release needs: ${d.requiredGates.map(g => GATE_LABEL[g]).join(", ")}. The author cannot approve their own revision.</p>
      ${revisions.map(r => `<article class="revision">
        <div class="revision-head"><div><strong>${safe(r.revision)}</strong> <span class="chip ${r.status === "approved" ? "good" : r.status === "in_approval" ? "pending" : ""}">${safe(r.status.replace("_", " "))}</span>
          <small>${safe(r.summary || "No change summary")}${r.f01 ? ` · ${safe(r.f01)}` : ""} · by ${safe(r.author || "unknown")} ${fmt(r.createdAt)}${r.effectiveFrom ? ` · effective ${fmt(r.effectiveFrom)}` : ""}</small></div>
          ${r.hasFile ? `<button type="button" class="secondary-action small" data-download="${safe(r.id)}">Download ${safe(r.fileName)}</button>` : ""}</div>
        ${r.status === "in_approval" ? `<div class="gate-list">${r.gates.map(g => {
          const done = r.approvals.find(a => a.gate === g.gate);
          return `<div class="list-row"><div><strong>${GATE_LABEL[g.gate]}</strong><small>${done ? `Approved by ${safe(done.approver)} ${fmt(done.approvedAt)}` : "Waiting"}</small></div>
            ${g.canApprove ? `<button type="button" class="primary small" data-approve="${safe(r.id)}" data-gate="${g.gate}">Record approval</button>` : `<span class="chip ${done ? "good" : ""}">${done ? "Approved" : "Waiting"}</span>`}</div>`;
        }).join("")}</div>
        ${r.canUpload ? `<form data-upload="${safe(r.id)}" class="inline-form"><div class="field"><label for="up-${safe(r.id)}">${r.hasFile ? "Replace file" : "Attach the controlled file"}</label>
          <input id="up-${safe(r.id)}" name="file" type="file" required accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp"></div><button class="secondary-action" type="submit">Upload</button></form>` : ""}
        ${!r.hasFile ? '<p class="muted small">Approvals open once the file is attached.</p>' : ""}
        ${r.youAreAuthor ? '<p class="muted small">You wrote this revision, so you cannot approve it.</p>' : ""}` : ""}
      </article>`).join("") || '<p class="muted">No revisions yet.</p>'}
      ${canRevise ? `<details class="add-ref"><summary>Start a new revision</summary><form data-new-rev class="inline-form">
        <div class="field-row"><div class="field"><label for="nr-rev">Revision</label><input id="nr-rev" name="revision" required maxlength="40" placeholder="Rev 2"></div>
        <div class="field"><label for="nr-f01">F01 change request</label><input id="nr-f01" name="f01" maxlength="40" placeholder="F01-0008"></div></div>
        <div class="field"><label for="nr-sum">What changed</label><textarea id="nr-sum" name="summary" rows="2" maxlength="1000"></textarea></div>
        <button class="secondary-action" type="submit">Create revision</button></form></details>` : ""}
      ${links.length ? `<h3>Linked documents</h3><div class="list">${links.map(l => `<div class="list-row"><div><span class="mono">${safe(l.docNumber)}</span><small>${safe(l.title)}</small></div><span class="muted">${safe(l.relation)}</span></div>`).join("")}</div>` : ""}
      <p class="form-message" data-doc-msg role="status" aria-live="polite"></p>`;
  }

  async function act(fnc, button) {
    if (button) button.disabled = true;
    try { await fnc(); } catch (error) { msg(friendlyError(error)); const dm = root.querySelector("[data-doc-msg]"); if (dm) dm.textContent = friendlyError(error); }
    finally { if (button) button.disabled = false; }
  }

  root.addEventListener("click", event => {
    const b = event.target.closest("button");
    if (!b) return;
    if (b.dataset.folder) act(() => { s.documentId = null; root.querySelector("[data-doc-panel]").innerHTML = '<h2>Document</h2><p class="muted">Pick a document to see its revisions and approvals.</p>'; return openFolder(b.dataset.folder); }, b);
    else if (b.dataset.doc) act(() => openDocument(b.dataset.doc), b);
    else if ("createRoot" in b.dataset) act(async () => { await call("create_root"); await openFolder(null); }, b);
    else if ("request" in b.dataset) act(async () => { await call("request_access", { folderId: s.folderId }); msg("Access request sent to the folder owner and recorded in the audit log."); b.remove(); }, b);
    else if (b.dataset.inherit) act(async () => {
      if (b.dataset.inherit === "false" && !window.confirm("Stop inheriting access? The current inherited access is copied here first so nobody loses access; remove what you don’t want afterwards.")) return;
      await call("set_inherit", { folderId: s.folderId, inherit: b.dataset.inherit === "true" }); await openFolder(s.folderId);
    }, b);
    else if (b.dataset.removeGrant) act(async () => {
      if (!window.confirm("Remove this access entry?")) return;
      await call("remove_grant", { grantId: b.dataset.removeGrant }); await openFolder(s.folderId);
    }, b);
    else if (b.dataset.approve) act(async () => {
      const gate = b.dataset.gate;
      const comment = window.prompt(`Record ${GATE_LABEL[gate].toLowerCase()} for this revision? Add an optional comment:`, "");
      if (comment === null) return;
      const result = await call("approve", { revisionId: b.dataset.approve, gate, comment });
      await openFolder(s.folderId); await openDocument(s.documentId);
      root.querySelector("[data-doc-msg]").textContent = result.approved ? "All approvals recorded. This revision is now the approved current revision." : "Approval recorded.";
    }, b);
    else if (b.dataset.download) act(async () => { const r = await call("download", { revisionId: b.dataset.download }); window.location.assign(r.url); }, b);
  });

  root.addEventListener("submit", event => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form));
    if (form.matches("[data-new-folder]")) act(async () => { await call("create_folder", { parentId: s.folderId, name: data.name }); await openFolder(s.folderId); }, button);
    else if (form.matches("[data-new-doc]")) act(async () => {
      const gates = [...form.querySelectorAll('input[name="gate"]:checked')].map(i => i.value);
      const r = await call("create_document", { folderId: s.folderId, docNumber: data.docNumber, title: data.title, docType: data.docType, requiredGates: gates, reviewMonths: Number(data.reviewMonths) });
      await openFolder(s.folderId); await openDocument(r.id);
    }, button);
    else if (form.matches("[data-new-rev]")) act(async () => {
      await call("create_revision", { documentId: s.documentId, revision: data.revision, summary: data.summary, f01: data.f01 });
      await openDocument(s.documentId);
    }, button);
    else if (form.matches("[data-upload]")) act(async () => {
      const file = form.file.files[0];
      if (!file) return;
      const prepared = await call("prepare_upload", { revisionId: form.dataset.upload, fileName: file.name, size: file.size });
      const res = await fetch(prepared.signedUrl, { method: "PUT", headers: { "Content-Type": prepared.contentType }, body: file });
      if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
      await call("attach_file", { revisionId: form.dataset.upload, path: prepared.path });
      await openDocument(s.documentId);
    }, button);
    else if (form.matches("[data-grant]")) act(async () => {
      const [type, value] = String(data.who).split(":");
      await call("set_grant", { folderId: s.folderId, level: data.level, ...(type === "group" ? { group: value } : { profileId: value }) });
      await openFolder(s.folderId);
    }, button);
  });

  return { open: () => openFolder(null).catch(error => msg(friendlyError(error))) };
}
