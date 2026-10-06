// Shared pieces for sales and purchasing screens: the line-item editor used
// by quotes, invoices, credit notes, purchase orders and bills; PDF
// downloads; attachments; address fields.
import { call, chip, date, flash, friendlyError, money, options, safe, TYPE_LABEL, TYPE_ORDER } from "./ui.js";
import { docLine, docTotals } from "./validate.js";

export const AMOUNTS_LABEL = { exclusive: "Tax exclusive (GST added)", inclusive: "Tax inclusive (GST included)", no_tax: "No GST" };
export const LINE_KINDS = [["labour", "Labour"], ["materials", "Materials"], ["equipment", "Equipment"], ["subcontract", "Subcontract"], ["travel", "Travel"],
  ["consumables", "Consumables"], ["freight", "Freight"], ["other", "Other"]];
export const METHODS = [["bank_transfer", "Bank transfer"], ["card", "Card"], ["cheque", "Cheque"], ["cash", "Cash"], ["other", "Other"]];

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

/** Saves a base64 PDF from the API as a file. */
export function downloadBase64(fileName, base64, type = "application/pdf") {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type }));
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
export async function downloadPdf(action, body) {
  const r = await call(action, body);
  downloadBase64(r.fileName, r.base64);
  return r;
}

export function accountOptions(accounts, selected) {
  return `<option value="">Account…</option>${TYPE_ORDER.map(t => {
    const rows = accounts.filter(a => a.type === t);
    return rows.length ? `<optgroup label="${safe(TYPE_LABEL[t])}">${rows.map(a => `<option value="${safe(a.id)}" ${a.id === selected ? "selected" : ""}>${safe(a.code)} ${safe(a.name)}</option>`).join("")}</optgroup>` : "";
  }).join("")}`;
}

export function addressFields(prefix, a = {}, legend = "Address") {
  return `<fieldset class="addr"><legend>${safe(legend)}</legend><div class="grid4 addr-grid">
    <div class="fld"><label for="${prefix}-street">Street</label><input id="${prefix}-street" value="${safe(a.street || "")}" maxlength="120" autocomplete="off"></div>
    <div class="fld"><label for="${prefix}-suburb">Suburb</label><input id="${prefix}-suburb" value="${safe(a.suburb || "")}" maxlength="60"></div>
    <div class="fld"><label for="${prefix}-state">State</label><select id="${prefix}-state">${options([["", "—"], "ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"], a.state || "")}</select></div>
    <div class="fld"><label for="${prefix}-postcode">Postcode</label><input id="${prefix}-postcode" value="${safe(a.postcode || "")}" maxlength="4" inputmode="numeric"></div>
  </div></fieldset>`;
}
export function readAddress(root, prefix) {
  const v = id => root.querySelector(`#${prefix}-${id}`)?.value.trim() || "";
  return { street: v("street"), suburb: v("suburb"), state: v("state"), postcode: v("postcode") };
}
export const addressText = a => [a?.street, [a?.suburb, a?.state, a?.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/* ---------------- Line-item editor ---------------- */

const blankLine = (acc = "", tax = "", project = "", costCode = "") => ({ description: "", kind: "other", quantity: "1", unit: "", unitPrice: "", discountPercent: "", accountId: acc, taxCodeId: tax, poLineId: null,
  projectId: project, costCodeId: costCode });

/**
 * Renders the editor and wires it up.
 * cfg: { eyebrow, title, intro, partyLabel, parties, accounts, taxCodes, doc, fields(doc) -> html, readFields(root, doc),
 *        buttons: [{ value, label, primary }], cancelHref, onSubmit(doc, button) -> Promise, onParty(doc, party) }
 */
export function documentEditor(view, cfg) {
  const rates = Object.fromEntries(cfg.taxCodes.map(t => [t.id, t.rate]));
  const doc = cfg.doc;
  if (!doc.lines?.length) doc.lines = [blankLine()];
  doc.lines = doc.lines.map(l => ({ ...blankLine(), ...l, quantity: String(l.quantity ?? "1"), unitPrice: String(l.unitPrice ?? ""), discountPercent: l.discountPercent ? String(l.discountPercent) : "" }));
  const party = () => cfg.parties.find(p => p.id === doc.partyId);

  const draw = () => {
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">${safe(cfg.eyebrow)}</p><h1>${safe(cfg.title)}</h1>${cfg.intro ? `<p class="muted">${cfg.intro}</p>` : ""}</div></header>
      <form class="panel" data-doc novalidate>
        <div class="grid3">
          <div class="fld"><label for="d-party">${safe(cfg.partyLabel)} <span class="req" aria-hidden="true">*</span></label>
            <select id="d-party" required>${options([["", `Choose a ${cfg.partyLabel.toLowerCase()}…`], ...cfg.parties.map(p => [p.id, p.name])], doc.partyId)}</select>
            <small data-party-note></small></div>
          ${cfg.fields(doc)}
          <div class="fld"><label for="d-amounts">Amounts are</label><select id="d-amounts">${options(Object.entries(AMOUNTS_LABEL), doc.amountsAre)}</select></div>
        </div>
        <div class="tbl-wrap"><table class="tbl lines doc-lines"><thead><tr>
          <th scope="col">Description</th><th scope="col">Account</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Unit price</th>
          <th scope="col" class="num">Disc %</th><th scope="col">Tax</th><th scope="col" class="num">GST</th><th scope="col" class="num">Amount</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead><tbody>
          ${doc.lines.map((l, i) => `<tr data-line="${i}">
            <td class="desc"><textarea rows="1" aria-label="Description, line ${i + 1}" data-f="description" maxlength="500">${safe(l.description)}</textarea>
              <div class="line-tags"><select aria-label="Type, line ${i + 1}" data-f="kind" class="kind">${options(LINE_KINDS, l.kind)}</select>
              ${cfg.projects ? `<select aria-label="Project, line ${i + 1}" data-f="projectId" class="kind">${options([["", "No project"], ...cfg.projects.map(p => [p.id, `${p.number} ${p.name}`]),
                ...(l.projectId && !cfg.projects.some(p => p.id === l.projectId) ? [[l.projectId, l.projectNumber || "Closed project"]] : [])], l.projectId || "")}</select>` : ""}
              ${cfg.costCodes ? `<select aria-label="Cost code, line ${i + 1}" data-f="costCodeId" class="kind" ${l.projectId ? "" : "disabled"}>${options([["", "Cost code…"], ...cfg.costCodes.map(c => [c.id, `${c.code} ${c.name}`])], l.costCodeId || "")}</select>` : ""}</div>
              ${l.poLineId ? '<small class="muted">From the purchase order</small>' : ""}</td>
            <td><select aria-label="Account, line ${i + 1}" data-f="accountId">${accountOptions(cfg.accounts, l.accountId)}</select></td>
            <td><input aria-label="Quantity, line ${i + 1}" data-f="quantity" class="num qty" inputmode="decimal" value="${safe(l.quantity)}"></td>
            <td><input aria-label="Unit price, line ${i + 1}" data-f="unitPrice" class="num" inputmode="decimal" value="${safe(l.unitPrice)}"></td>
            <td><input aria-label="Discount percent, line ${i + 1}" data-f="discountPercent" class="num disc" inputmode="decimal" value="${safe(l.discountPercent)}"></td>
            <td><select aria-label="Tax code, line ${i + 1}" data-f="taxCodeId" ${doc.amountsAre === "no_tax" ? "disabled" : ""}>${options([["", "—"], ...cfg.taxCodes.map(t => [t.id, t.code])], l.taxCodeId)}</select></td>
            <td class="num mono muted" data-gst></td><td class="num mono" data-amt></td>
            <td><button type="button" class="link" data-remove="${i}" aria-label="Remove line ${i + 1}" ${doc.lines.length <= 1 ? "disabled" : ""}>✕</button></td></tr>`).join("")}
        </tbody></table></div>
        <div class="doc-foot">
          <button type="button" class="link" data-add-line>+ Add a line</button>
          <dl class="totals" data-totals></dl>
        </div>
        ${cfg.after ? cfg.after(doc) : ""}
        <div class="actions">${cfg.buttons.map(b => `<button class="btn ${b.primary ? "primary" : ""}" type="submit" data-act="${safe(b.value)}">${safe(b.label)}</button>`).join("")}
          <a class="btn" href="${safe(cfg.cancelHref)}">Cancel</a></div>
      </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
    partyNote();
    totals();
  };

  const read = () => {
    doc.partyId = view.querySelector("#d-party").value;
    doc.amountsAre = view.querySelector("#d-amounts").value;
    cfg.readFields(view, doc);
    view.querySelectorAll("[data-line]").forEach(row => {
      const l = doc.lines[Number(row.dataset.line)];
      row.querySelectorAll("[data-f]").forEach(el => { l[el.dataset.f] = el.value; });
    });
  };

  const partyNote = () => {
    const p = party();
    const el = view.querySelector("[data-party-note]");
    if (el) el.textContent = p && cfg.partyNote ? cfg.partyNote(p) : "";
  };

  const totals = () => {
    read();
    let bad = false;
    doc.lines.forEach((l, i) => {
      const row = view.querySelector(`[data-line="${i}"]`);
      const qBad = !/^\d+(\.\d{1,3})?$/.test(String(l.quantity).trim()) || Number(l.quantity) <= 0;
      const pBad = !/^\d*(\.\d{1,4})?$/.test(String(l.unitPrice).replace(/[$,\s]/g, ""));
      const dBad = l.discountPercent !== "" && !(Number(l.discountPercent) >= 0 && Number(l.discountPercent) <= 100);
      row.querySelector('[data-f="quantity"]').classList.toggle("invalid", qBad);
      row.querySelector('[data-f="unitPrice"]').classList.toggle("invalid", pBad);
      row.querySelector('[data-f="discountPercent"]').classList.toggle("invalid", dBad);
      if (qBad || pBad || dBad) { bad = true; row.querySelector("[data-amt]").textContent = ""; row.querySelector("[data-gst]").textContent = ""; return; }
      const r = docLine({ ...l, unitPrice: String(l.unitPrice).replace(/[$,\s]/g, "") || 0 }, rates[l.taxCodeId] || 0, doc.amountsAre);
      row.querySelector("[data-amt]").textContent = money(r.amount);
      row.querySelector("[data-gst]").textContent = money(r.gst, { blankZero: true });
    });
    const t = bad ? null : docTotals(doc.lines.map(l => ({ ...l, unitPrice: String(l.unitPrice).replace(/[$,\s]/g, "") || 0 })), rates, doc.amountsAre);
    const extra = cfg.extraTotals && t ? cfg.extraTotals(doc, t) : [];
    view.querySelector("[data-totals]").innerHTML = t
      ? `<dt>Subtotal${doc.amountsAre === "no_tax" ? "" : " (ex GST)"}</dt><dd class="mono">${money(t.subtotal)}</dd>
         ${doc.amountsAre === "no_tax" ? "" : `<dt>GST</dt><dd class="mono">${money(t.gst)}</dd>`}
         <dt class="grand">Total</dt><dd class="mono grand">${money(t.total)}</dd>
         ${extra.map(([k, v, cls]) => `<dt class="${cls || ""}">${safe(k)}</dt><dd class="mono ${cls || ""}">${v}</dd>`).join("")}`
      : '<dt class="bad">Check the highlighted amounts</dt><dd></dd>';
  };

  draw();
  view.addEventListener("input", e => { if (e.target.closest("[data-line]") || e.target.id === "d-amounts") totals(); });
  view.addEventListener("change", e => {
    if (e.target.id === "d-amounts") { read(); draw(); return; }
    if (e.target.id === "d-party") {
      read();
      const p = party();
      if (p && cfg.onParty) cfg.onParty(doc, p);
      draw();
      return;
    }
    if (e.target.dataset.f === "accountId") {
      const row = e.target.closest("[data-line]");
      const acc = cfg.accounts.find(a => a.id === e.target.value);
      const tax = row.querySelector('[data-f="taxCodeId"]');
      if (acc && !tax.value && acc.defaultTaxCodeId && cfg.taxCodes.some(t => t.id === acc.defaultTaxCodeId)) tax.value = acc.defaultTaxCodeId;
    }
    if (e.target.dataset.f === "projectId") {
      const cc = e.target.closest("[data-line]").querySelector('[data-f="costCodeId"]');
      if (cc) { cc.disabled = !e.target.value; if (!e.target.value) cc.value = ""; }
    }
    if (cfg.onFieldChange) cfg.onFieldChange(view, doc, e.target);
    totals();
  });
  view.addEventListener("click", e => {
    if (e.target.closest("[data-add-line]")) {
      read();
      const p = party();
      const prev = doc.lines[doc.lines.length - 1] || {};
      doc.lines.push(blankLine(prev.accountId || cfg.defaultAccount?.(p) || "", prev.taxCodeId || cfg.defaultTax?.(p) || "", prev.projectId || "", prev.costCodeId || ""));
      draw();
      view.querySelector(`[data-line="${doc.lines.length - 1}"] textarea`).focus();
    }
    const r = e.target.closest("[data-remove]");
    if (r) { read(); doc.lines.splice(Number(r.dataset.remove), 1); draw(); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-doc]")) return;
    e.preventDefault();
    read();
    if (!doc.partyId) return flash(view, `Choose a ${cfg.partyLabel.toLowerCase()}.`, "bad");
    if (view.querySelector("[data-line] .invalid")) return flash(view, "Fix the highlighted amounts first.", "bad");
    const lines = doc.lines.filter(l => l.description.trim() || l.unitPrice || l.accountId).map(l => ({ ...l, unitPrice: String(l.unitPrice).replace(/[$,\s]/g, "") || "0", discountPercent: l.discountPercent || "0" }));
    const missing = lines.findIndex(l => !l.description.trim() || !l.accountId);
    if (!lines.length) return flash(view, "Add at least one line.", "bad");
    if (missing >= 0) return flash(view, `Line ${missing + 1}: add a description and choose an account.`, "bad");
    view.querySelectorAll("button[type=submit]").forEach(b => { b.disabled = true; });
    try {
      await cfg.onSubmit({ ...doc, lines }, e.submitter?.dataset.act);
    } catch (error) {
      flash(view, friendlyError(error), "bad");
      view.querySelectorAll("button[type=submit]").forEach(b => { b.disabled = false; });
    }
  });
  return { doc, redraw: draw };
}

/* ---------------- Read-only document view ---------------- */

export function linesTable(lines, amountsAre) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Description</th><th scope="col">Account</th><th scope="col" class="num">Qty</th>
    <th scope="col" class="num">Unit price</th><th scope="col" class="num">Disc</th><th scope="col">Tax</th><th scope="col" class="num">GST</th>
    <th scope="col" class="num">Amount${amountsAre === "inclusive" ? " (inc)" : amountsAre === "exclusive" ? " (ex)" : ""}</th></tr></thead><tbody>
    ${lines.map(l => `<tr><td>${safe(l.description)}<small>${safe(LINE_KINDS.find(k => k[0] === l.kind)?.[1] || "")}${l.projectNumber ? ` · <a href="#/projects/${safe(l.projectId)}">${safe(l.projectNumber)}</a>${l.costCode ? ` / ${safe(l.costCode)}` : ""}` : ""}</small></td>
      <td><span class="mono">${safe(l.accountCode || "")}</span> ${safe(l.accountName || "")}</td>
      <td class="num mono">${safe(String(l.quantity))}${l.unit ? ` ${safe(l.unit)}` : ""}${l.receivedQuantity != null ? `<small>${safe(String(l.receivedQuantity))} received</small>` : ""}</td>
      <td class="num mono">${money(l.unitPrice)}</td><td class="num mono">${l.discountPercent ? `${safe(String(l.discountPercent))}%` : ""}</td>
      <td>${safe(l.taxCode || "")}</td><td class="num mono">${money(l.gst, { blankZero: true })}</td><td class="num mono">${money(l.amount)}</td></tr>`).join("")}
  </tbody></table></div>`;
}

export function totalsList(rows) {
  return `<dl class="totals">${rows.filter(Boolean).map(([k, v, cls]) => `<dt class="${cls || ""}">${safe(k)}</dt><dd class="mono ${cls || ""}">${v}</dd>`).join("")}</dl>`;
}

/* ---------------- Attachments ---------------- */

export function attachmentsPanel(list, canAdd, entityType, entityId) {
  return `<section class="panel" data-attachments data-entity="${safe(entityType)}" data-entity-id="${safe(entityId)}">
    <h2>Attachments</h2>
    ${list.length ? `<ul class="files">${list.map(f => `<li><button type="button" class="link" data-open-file="${safe(f.id)}">${safe(f.fileName)}</button>
      <small class="muted">${Math.max(1, Math.round(f.size / 1024))} KB · ${date(f.uploadedAt)}</small>
      ${canAdd ? `<button type="button" class="link muted-link" data-archive-file="${safe(f.id)}" aria-label="Remove ${safe(f.fileName)}">Remove</button>` : ""}</li>`).join("")}</ul>`
      : '<p class="muted small">Nothing attached.</p>'}
    ${canAdd ? `<label class="btn file">Attach a PDF or photo<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" data-attach></label>` : ""}
  </section>`;
}

/** Wires the attachments panel. reload() redraws the screen afterwards. */
export function wireAttachments(view, reload) {
  view.addEventListener("change", async e => {
    const input = e.target.closest("[data-attach]");
    if (!input || !input.files?.length) return;
    const panel = input.closest("[data-attachments]");
    const file = input.files[0];
    try {
      flash(view, "Uploading…");
      const prep = await call("attachment_prepare_upload", { entityType: panel.dataset.entity, entityId: panel.dataset.entityId, fileName: file.name, size: file.size });
      const res = await fetch(prep.signedUrl, { method: "PUT", headers: { "Content-Type": prep.contentType }, body: file });
      if (!res.ok) throw new Error("The upload didn't go through. Please try again.");
      await call("attachment_attach", { entityType: panel.dataset.entity, entityId: panel.dataset.entityId, path: prep.path, fileName: file.name, size: file.size });
      await reload();
      flash(view, `Attached ${file.name}.`, "good");
    } catch (error) {
      flash(view, friendlyError(error), "bad");
    }
  });
  view.addEventListener("click", async e => {
    const open = e.target.closest("[data-open-file]");
    const archive = e.target.closest("[data-archive-file]");
    try {
      if (open) {
        const r = await call("attachment_open", { id: open.dataset.openFile });
        window.open(r.url, "_blank", "noopener");
      } else if (archive) {
        if (!window.confirm("Remove this attachment? It is kept in the archive for the audit trail.")) return;
        await call("attachment_archive", { id: archive.dataset.archiveFile });
        await reload();
      }
    } catch (error) {
      flash(view, friendlyError(error), "bad");
    }
  });
}

export const statusChip = (map, s) => { const [l, t] = map[s] || [s, ""]; return chip(l, t); };
