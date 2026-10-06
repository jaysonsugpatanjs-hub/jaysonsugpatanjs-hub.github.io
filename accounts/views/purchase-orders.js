// Purchase orders: Draft -> Submitted -> Approved -> Issued -> Partially
// received -> Completed (or Cancelled). Project managers raise and receive;
// someone with Purchases approves. POs don't touch the ledger; the bill does.
// Routes: #/purchase-orders, /new[?supplier=], /<id>, /<id>/edit
import { call, date, dateTime, flash, friendlyError, hashParams, money, options, safe, today } from "../lib/ui.js";
import { attachmentsPanel, documentEditor, downloadPdf, linesTable, statusChip, totalsList, wireAttachments } from "../lib/docs.js";
import { PO_STATUS } from "./suppliers.js";

export async function renderPurchaseOrders(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("/");
  if (id === "new") return editor(view, null);
  if (id && mode === "edit") return editor(view, id);
  if (id) return detail(view, id, ctx);
  return list(view);
}

async function list(view) {
  const f = { status: "", search: "" };
  const setup = await call("purchases_setup");
  const load = async () => {
    const d = await call("pos_list", f);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PURCHASES</p><h1>Purchase orders</h1>
        <p class="muted">Raise an order, have it approved, send it to the supplier, then record what arrives. Bills are matched against the order.</p></div>
        ${setup.can.raise ? '<a class="btn primary" href="#/purchase-orders/new">New purchase order</a>' : ""}</header>
      <section class="panel">
        <form class="toolbar" data-filter>
          <div class="fld"><label for="p-st">Status</label><select id="p-st">${options([["", "All"], ["open", "Open (approved to part received)"], ...Object.entries(PO_STATUS).map(([k, v]) => [k, v[0]])], f.status)}</select></div>
          <div class="fld"><label for="p-q">Number contains</label><input id="p-q" value="${safe(f.search)}"></div><button class="btn" type="submit">Filter</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Number</th><th scope="col">Supplier</th><th scope="col">Date</th><th scope="col">Required by</th><th scope="col">Raised by</th>
          <th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead><tbody>
          ${d.purchaseOrders.map(p => `<tr><td class="mono"><a href="#/purchase-orders/${safe(p.id)}">${safe(p.number)}</a>${p.reference ? `<small>${safe(p.reference)}</small>` : ""}</td>
            <td>${safe(p.supplier)}</td><td class="nowrap">${date(p.date)}</td><td class="nowrap">${date(p.expectedDate)}</td><td>${safe(p.requestedBy || "")}</td>
            <td>${statusChip(PO_STATUS, p.status)}</td><td class="num mono">${money(p.total)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No purchase orders yet.</td></tr>'}
        </tbody></table></div></section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    f.status = view.querySelector("#p-st").value;
    f.search = view.querySelector("#p-q").value.trim();
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function editor(view, id) {
  const setup = await call("purchases_setup");
  let doc = { partyId: hashParams().get("supplier") || "", date: today(), expectedDate: "", reference: "", deliveryAddress: "", notes: "", amountsAre: "exclusive", lines: [] };
  if (id) {
    const d = await call("po_get", { id });
    if (d.purchaseOrder.status !== "draft") { location.hash = `#/purchase-orders/${id}`; return; }
    const p = d.purchaseOrder;
    doc = { id, partyId: p.supplierId, date: p.date, expectedDate: p.expectedDate || "", reference: p.reference || "", deliveryAddress: p.deliveryAddress, notes: p.notes, amountsAre: p.amountsAre, lines: d.lines };
  }
  const defaults = s => {
    const acc = s?.expenseAccountId || setup.accounts.find(a => a.code === "5100")?.id || "";
    return { acc, tax: s?.taxCodeId || setup.accounts.find(a => a.id === acc)?.defaultTaxCodeId || "" };
  };
  if (!doc.lines.length) { const dft = defaults(setup.suppliers.find(s => s.id === doc.partyId)); doc.lines = [{ accountId: dft.acc, taxCodeId: dft.tax, kind: "materials" }]; }
  const fromProject = hashParams().get("project");
  if (fromProject && !id) doc.lines.forEach(l => { if (!l.projectId) l.projectId = fromProject; });
  documentEditor(view, {
    eyebrow: "PURCHASES · PURCHASE ORDERS", title: id ? "Edit draft purchase order" : "New purchase order",
    intro: setup.can.manage ? "Save as a draft, or submit it for approval." : "Submit it when ready; someone with Purchases approves it before it goes to the supplier.",
    partyLabel: "Supplier", parties: setup.suppliers, accounts: setup.accounts, taxCodes: setup.taxCodes, doc,
    projects: setup.projects, costCodes: setup.costCodes,
    partyNote: s => [s.hasAbn ? "" : "No ABN on file", s.subcontractor ? "Subcontractor" : ""].filter(Boolean).join(" · "),
    defaultAccount: s => defaults(s).acc, defaultTax: s => defaults(s).tax,
    onParty: (d, s) => { const dft = defaults(s); d.lines.forEach(l => { if (!l.accountId) l.accountId = dft.acc; if (!l.taxCodeId) l.taxCodeId = dft.tax; }); },
    fields: d => `
      <div class="fld"><label for="d-date">Order date</label><input id="d-date" type="date" value="${safe(d.date)}" required></div>
      <div class="fld"><label for="d-exp">Required by</label><input id="d-exp" type="date" value="${safe(d.expectedDate)}"></div>
      <div class="fld"><label for="d-ref">Job / reference</label><input id="d-ref" value="${safe(d.reference)}" maxlength="120" placeholder="For example: job number"></div>`,
    readFields: (root, d) => {
      d.date = root.querySelector("#d-date").value;
      d.expectedDate = root.querySelector("#d-exp").value;
      d.reference = root.querySelector("#d-ref").value.trim();
      d.deliveryAddress = root.querySelector("#d-deliver")?.value ?? d.deliveryAddress;
      d.notes = root.querySelector("#d-notes")?.value ?? d.notes;
    },
    after: d => `<div class="grid2">
      <div class="fld"><label for="d-deliver">Deliver to</label><textarea id="d-deliver" rows="2" maxlength="500">${safe(d.deliveryAddress)}</textarea></div>
      <div class="fld"><label for="d-notes">Notes for the supplier</label><textarea id="d-notes" rows="2" maxlength="3000">${safe(d.notes)}</textarea></div></div>`,
    buttons: [{ value: "draft", label: "Save draft" }, { value: "submit", label: "Save and submit for approval", primary: true }],
    cancelHref: id ? `#/purchase-orders/${id}` : "#/purchase-orders",
    onSubmit: async (d, act) => {
      const r = await call("po_save", { id: d.id || null, supplierId: d.partyId, date: d.date, expectedDate: d.expectedDate, reference: d.reference, deliveryAddress: d.deliveryAddress,
        notes: d.notes, amountsAre: d.amountsAre, lines: d.lines, submit: act === "submit" });
      location.hash = `#/purchase-orders/${r.id}`;
    }
  });
}

async function detail(view, id, ctx) {
  const load = async () => {
    const d = await call("po_get", { id });
    const p = d.purchaseOrder, c = d.can;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PURCHASES · PURCHASE ORDER</p><h1>${safe(p.number)} ${statusChip(PO_STATUS, p.status)}</h1>
        <p class="muted"><a href="#/suppliers/${safe(p.supplierId)}">${safe(p.supplier)}</a> · ${date(p.date)}${p.expectedDate ? ` · required by ${date(p.expectedDate)}` : ""}</p></div>
        <div class="actions tight"><button type="button" class="btn" data-pdf>Download PDF</button></div></header>
      <section class="panel">
        <dl class="facts">${p.reference ? `<dt>Job / reference</dt><dd>${safe(p.reference)}</dd>` : ""}
          <dt>Raised by</dt><dd>${safe(p.requestedBy || "—")}</dd>
          ${p.approvedAt ? `<dt>Approved</dt><dd>${safe(p.approvedBy || "—")} · ${dateTime(p.approvedAt)}</dd>` : ""}
          ${p.issuedAt ? `<dt>Issued</dt><dd>${dateTime(p.issuedAt)}</dd>` : ""}
          ${p.deliveryAddress ? `<dt>Deliver to</dt><dd>${safe(p.deliveryAddress)}</dd>` : ""}
          <dt>Billed so far</dt><dd class="mono">${money(p.billed)} of ${money(p.total)}</dd></dl>
        ${linesTable(d.lines, p.amountsAre)}
        ${totalsList([[p.amountsAre === "no_tax" ? "Subtotal" : "Subtotal (ex GST)", money(p.subtotal)], p.amountsAre === "no_tax" ? null : ["GST", money(p.gst)], ["Total", money(p.total), "grand"]])}
        ${p.notes ? `<p class="small prewrap"><strong>Notes:</strong> ${safe(p.notes)}</p>` : ""}
        <div class="actions">
          ${c.edit ? `<a class="btn" href="#/purchase-orders/${safe(id)}/edit">Edit</a>` : ""}
          ${c.submit ? '<button type="button" class="btn primary" data-status="submitted">Submit for approval</button>' : ""}
          ${c.approve ? '<button type="button" class="btn primary" data-status="approved">Approve</button><button type="button" class="btn" data-status="draft">Send back</button>' : ""}
          ${c.issue ? '<button type="button" class="btn primary" data-status="issued">Mark as issued to supplier</button>' : ""}
          ${c.bill ? `<a class="btn" href="#/bills/new?po=${safe(id)}">Enter the bill</a>` : ""}
          ${c.close ? '<button type="button" class="btn" data-status="completed">Close order</button>' : ""}
          ${c.cancel ? '<button type="button" class="btn danger" data-status="cancelled">Cancel order</button>' : ""}
        </div>
      </section>
      ${c.receive ? `<form class="panel" data-receive><h2>Record goods received</h2>
        <p class="muted small">Enter what arrived today. The order moves to part received or completed automatically.</p>
        <table class="tbl"><thead><tr><th scope="col">Item</th><th scope="col" class="num">Ordered</th><th scope="col" class="num">Received so far</th><th scope="col" class="num">Received now</th></tr></thead><tbody>
          ${d.lines.map(l => `<tr><td>${safe(l.description)}</td><td class="num mono">${safe(String(l.quantity))}</td><td class="num mono">${safe(String(l.receivedQuantity))}</td>
            <td class="num"><input class="num apply" data-recv="${safe(l.id)}" inputmode="decimal" aria-label="Received now: ${safe(l.description)}" ${l.receivedQuantity >= l.quantity ? "disabled" : ""}></td></tr>`).join("")}
        </tbody></table><div class="actions"><button class="btn primary" type="submit">Record receipt</button>
        <button class="link" type="button" data-all>Everything outstanding arrived</button></div></form>` : ""}
      ${d.bills.length ? `<section class="panel"><h2>Bills against this order</h2><table class="tbl"><thead><tr><th scope="col">Bill</th><th scope="col">Their reference</th><th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead><tbody>
        ${d.bills.map(b => `<tr><td class="mono"><a href="#/bills/${safe(b.id)}">${safe(b.number)}</a></td><td>${safe(b.supplierReference || "—")}</td><td>${safe(b.status)}</td><td class="num mono">${money(b.total)}</td></tr>`).join("")}</tbody></table></section>` : ""}
      ${attachmentsPanel(d.attachments, c.edit || c.receive || ctx.can("purchases.manage"), "purchase_order", id)}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
    return d;
  };
  let d = await load();
  wireAttachments(view, async () => { d = await load(); });
  view.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b || b.closest("[data-attachments]")) return;
    try {
      if ("pdf" in b.dataset) { b.disabled = true; await downloadPdf("po_pdf", { id }); b.disabled = false; return; }
      if ("all" in b.dataset) {
        d.lines.forEach(l => { const el = view.querySelector(`[data-recv="${l.id}"]`); if (el && !el.disabled) el.value = String(Math.max(0, l.quantity - l.receivedQuantity)); });
        return;
      }
      if (b.dataset.status) {
        let reason = "";
        if (b.dataset.status === "cancelled" || b.dataset.status === "draft") {
          reason = window.prompt(b.dataset.status === "cancelled" ? "Cancel this purchase order? Reason:" : "Send it back to draft? Tell the requester why:", "");
          if (reason === null) return;
        }
        b.disabled = true;
        await call("po_status", { id, status: b.dataset.status, reason });
        d = await load();
        flash(view, "Updated.", "good");
        ctx.refreshCounts?.();
      }
    } catch (error) {
      b.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-receive]")) return;
    e.preventDefault();
    const lines = [...view.querySelectorAll("[data-recv]")].filter(el => el.value.trim()).map(el => ({ lineId: el.dataset.recv, quantity: Number(el.value) }));
    if (lines.some(l => !Number.isFinite(l.quantity) || l.quantity < 0)) return flash(view, "Quantities must be numbers.", "bad");
    try {
      const r = await call("po_receive", { id, lines });
      d = await load();
      flash(view, r.status === "completed" ? "Everything has arrived. The order is completed." : "Receipt recorded.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
