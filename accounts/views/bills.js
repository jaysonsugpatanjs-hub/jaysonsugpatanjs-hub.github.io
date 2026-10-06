// Bills and supplier credits: Draft -> For review -> Approved (posted) -> Paid.
// Unapproved bills can't be paid. Routes: #/bills, #/bills/new[?supplier=&po=&kind=credit_note],
// #/bills/<id>, #/bills/<id>/edit
import { call, chip, date, dateTime, flash, friendlyError, hashParams, money, options, safe, today } from "../lib/ui.js";
import { addDays, attachmentsPanel, documentEditor, linesTable, statusChip, totalsList, wireAttachments } from "../lib/docs.js";
import { noAbnWithholding } from "../lib/validate.js";
import { BILL_STATUS } from "./suppliers.js";

const VIEWS = [["all", "All"], ["draft", "To review"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"], ["void", "Void"]];

export async function renderBills(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("/");
  if (id === "new") return editor(view, null);
  if (id && mode === "edit") return editor(view, id);
  if (id) return detail(view, id, ctx);
  return list(view);
}

async function list(view) {
  const p = hashParams();
  const f = { kind: p.get("kind") === "credit_note" ? "credit_note" : "bill", view: VIEWS.some(v => v[0] === p.get("view")) ? p.get("view") : "all", search: "", page: 1 };
  const setup = await call("purchases_setup");
  const load = async () => {
    const d = await call("bills_list", f);
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const credit = f.kind === "credit_note";
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PURCHASES</p><h1>${credit ? "Supplier credits" : "Bills"}</h1>
        <p class="muted">${credit ? "Credit notes from suppliers reduce what Panalo owes them." : "Supplier invoices. A bill is posted to Accounts Payable when it is approved, and only approved bills can be paid."}</p></div>
        ${setup.can.manage ? `<div class="actions tight"><a class="btn" href="#/bills?kind=${credit ? "bill" : "credit_note"}">${credit ? "Bills" : "Supplier credits"}</a>
          <a class="btn primary" href="#/bills/new${credit ? "?kind=credit_note" : ""}">${credit ? "New supplier credit" : "Enter a bill"}</a></div>` : ""}</header>
      <section class="panel">
        <div class="tabs" role="tablist">${VIEWS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === f.view}" class="${k === f.view ? "on" : ""}" data-view-tab="${k}">${l}</button>`).join("")}</div>
        <form class="toolbar" data-filter><div class="fld"><label for="b-q">Supplier reference contains</label><input id="b-q" value="${safe(f.search)}"></div><button class="btn" type="submit">Search</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Bill</th><th scope="col">Supplier</th><th scope="col">Their reference</th><th scope="col">Date</th><th scope="col">Due</th>
          <th scope="col">Status</th><th scope="col" class="num">Total</th><th scope="col" class="num">Owing</th></tr></thead><tbody>
          ${d.bills.map(b => `<tr><td class="mono"><a href="#/bills/${safe(b.id)}">${safe(b.number)}</a></td><td>${safe(b.supplier)}${b.withholding ? `<small>${money(b.withholding)} withheld (no ABN)</small>` : ""}</td>
            <td>${safe(b.supplierReference || "—")}</td><td class="nowrap">${date(b.date)}</td><td class="nowrap">${date(b.dueDate)}${b.overdue ? ` ${chip("Overdue", "bad")}` : ""}</td>
            <td>${statusChip(BILL_STATUS, b.status)}${b.status === "approved" && b.owing === 0 ? ` ${chip(credit ? "Applied" : "Paid", "good")}` : ""}</td>
            <td class="num mono">${money(b.total)}</td><td class="num mono">${money(b.status === "approved" ? b.owing : 0, { blankZero: true })}</td></tr>`).join("")
            || '<tr><td colspan="8" class="muted">Nothing here.</td></tr>'}
        </tbody><tfoot><tr><th colspan="6" scope="row">${d.totals.count} shown</th><td class="num mono">${money(d.totals.total)}</td><td class="num mono"><strong>${money(d.totals.owing)}</strong></td></tr></tfoot></table></div>
        <div class="pager"><button type="button" class="btn" data-page="-1" ${f.page <= 1 ? "disabled" : ""}>Previous</button>
          <span class="muted small">Page ${f.page} of ${pages}</span><button type="button" class="btn" data-page="1" ${f.page >= pages ? "disabled" : ""}>Next</button></div>
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("click", async e => {
    const tab = e.target.closest("[data-view-tab]");
    const pg = e.target.closest("[data-page]");
    if (!tab && !pg) return;
    if (tab) { f.view = tab.dataset.viewTab; f.page = 1; }
    if (pg) f.page = Math.max(1, f.page + Number(pg.dataset.page));
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    f.search = view.querySelector("#b-q").value.trim();
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function editor(view, id) {
  const setup = await call("purchases_setup");
  const p = hashParams();
  let doc = { partyId: p.get("supplier") || "", kind: p.get("kind") === "credit_note" ? "credit_note" : "bill", date: today(), dueDate: "", dueTouched: false,
    supplierReference: "", purchaseOrderId: "", amountsAre: "exclusive", notes: "", lines: [] };
  if (id) {
    const d = await call("bill_get", { id });
    if (!["draft", "submitted"].includes(d.bill.status)) { location.hash = `#/bills/${id}`; return; }
    const b = d.bill;
    doc = { id, partyId: b.supplierId, kind: b.kind, date: b.date, dueDate: b.dueDate, dueTouched: true, supplierReference: b.supplierReference || "", purchaseOrderId: b.purchaseOrderId || "",
      amountsAre: b.amountsAre, notes: b.notes, lines: d.lines };
  } else if (p.get("po")) {
    const { draft } = await call("bill_from_po", { purchaseOrderId: p.get("po") });
    Object.assign(doc, { partyId: draft.supplierId, purchaseOrderId: draft.purchaseOrderId, amountsAre: draft.amountsAre, notes: draft.notes, lines: draft.lines });
  }
  const credit = doc.kind === "credit_note";
  const supOf = sid => setup.suppliers.find(s => s.id === sid);
  const defaults = s => {
    const acc = s?.expenseAccountId || setup.accounts.find(a => a.code === "5100")?.id || "";
    return { acc, tax: s?.taxCodeId || setup.accounts.find(a => a.id === acc)?.defaultTaxCodeId || "" };
  };
  if (!doc.lines.length) { const dft = defaults(supOf(doc.partyId)); doc.lines = [{ accountId: dft.acc, taxCodeId: dft.tax, kind: "materials" }]; }
  const terms = s => s?.termsDays ?? 30;
  if (!doc.dueDate) doc.dueDate = addDays(doc.date, terms(supOf(doc.partyId)));

  documentEditor(view, {
    eyebrow: `PURCHASES · ${credit ? "SUPPLIER CREDITS" : "BILLS"}`,
    title: id ? `Edit ${credit ? "supplier credit" : "bill"}` : credit ? "New supplier credit" : doc.purchaseOrderId ? "Bill from purchase order" : "Enter a bill",
    intro: credit ? "Enter the supplier's credit note as they issued it." : "Copy the supplier's invoice: their reference, the lines and the GST. Attach a copy of it after saving.",
    partyLabel: "Supplier", parties: setup.suppliers, accounts: setup.accounts, taxCodes: setup.taxCodes, doc,
    partyNote: s => [!s.hasAbn && !s.withholdingExempt ? `No ABN: ${Math.round((setup.noAbnWithholdingRate || 0) * 100)}% will be withheld` : "", s.gstRegistered ? "" : "Not registered for GST: use a GST-free code"].filter(Boolean).join(" · "),
    defaultAccount: s => defaults(s).acc, defaultTax: s => defaults(s).tax,
    onParty: (d, s) => {
      const dft = defaults(s);
      d.lines.forEach(l => { if (!l.accountId) l.accountId = dft.acc; if (!l.taxCodeId) l.taxCodeId = dft.tax; });
      if (!d.dueTouched) d.dueDate = addDays(d.date, terms(s));
    },
    fields: d => `
      <div class="fld"><label for="d-sref">Supplier's invoice number</label><input id="d-sref" value="${safe(d.supplierReference)}" maxlength="120"></div>
      <div class="fld"><label for="d-date">Bill date</label><input id="d-date" type="date" value="${safe(d.date)}" required></div>
      ${credit ? "" : `<div class="fld"><label for="d-due">Due date</label><input id="d-due" type="date" value="${safe(d.dueDate)}"></div>`}`,
    readFields: (root, d) => {
      d.supplierReference = root.querySelector("#d-sref").value.trim();
      d.date = root.querySelector("#d-date").value;
      const due = root.querySelector("#d-due");
      if (due) d.dueDate = due.value;
      d.notes = root.querySelector("#d-notes")?.value ?? d.notes;
    },
    onFieldChange: (root, d, el) => {
      if (el.id === "d-due") d.dueTouched = true;
      if (el.id === "d-date" && !d.dueTouched && root.querySelector("#d-due")) root.querySelector("#d-due").value = addDays(el.value, terms(supOf(d.partyId)));
    },
    extraTotals: (d, t) => {
      const s = supOf(d.partyId);
      if (credit || !s || s.hasAbn || s.withholdingExempt) return [];
      const wh = noAbnWithholding(t.subtotal, t.total, setup.noAbnWithholdingRate);
      return wh ? [["No-ABN withholding (to the ATO)", `(${money(wh)})`], ["Payable to supplier", money(Math.round((t.total - wh) * 100) / 100), "grand"]] : [];
    },
    after: d => `<div class="fld"><label for="d-notes">Notes</label><textarea id="d-notes" rows="2" maxlength="3000">${safe(d.notes)}</textarea></div>
      ${d.purchaseOrderId ? '<p class="muted small">Matched to a purchase order. Lines keep their link to the order so differences show on the bill.</p>' : ""}`,
    buttons: setup.can.manage ? [{ value: "draft", label: "Save draft" }, { value: "submit", label: "Save for review" }, { value: "approve", label: "Save and approve", primary: true }] : [],
    cancelHref: id ? `#/bills/${id}` : "#/bills",
    onSubmit: async (d, act) => {
      const r = await call("bill_save", { id: d.id || null, kind: d.kind, supplierId: d.partyId, date: d.date, dueDate: d.dueDate, supplierReference: d.supplierReference,
        purchaseOrderId: d.purchaseOrderId || null, amountsAre: d.amountsAre, notes: d.notes, lines: d.lines, then: act });
      location.hash = r.approveError ? `#/bills/${r.id}?err=${encodeURIComponent(r.approveError)}` : `#/bills/${r.id}`;
    }
  });
}

async function detail(view, id, ctx) {
  const load = async () => {
    const d = await call("bill_get", { id });
    const b = d.bill, credit = b.kind === "credit_note";
    const overdue = !credit && b.status === "approved" && b.owing > 0 && b.dueDate < today();
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PURCHASES · ${credit ? "SUPPLIER CREDIT" : "BILL"}</p>
        <h1>${safe(b.number)} ${statusChip(BILL_STATUS, b.status)} ${overdue ? chip("Overdue", "bad") : ""} ${b.status === "approved" && b.owing === 0 ? chip(credit ? "Fully applied" : "Paid", "good") : ""}</h1>
        <p class="muted"><a href="#/suppliers/${safe(b.supplierId)}">${safe(b.supplier)}</a>${b.supplierReference ? ` · their ref ${safe(b.supplierReference)}` : ""} · ${date(b.date)}${credit ? "" : ` · due ${date(b.dueDate)}`}</p></div></header>
      ${!credit && !b.supplierHasAbn && !b.withholdingExempt && b.status !== "approved" && b.status !== "void" ? '<p class="note">This supplier has no ABN on file. When approved, 47% of a bill over $75 (ex GST) is withheld and recorded as owing to the ATO.</p>' : ""}
      <section class="panel">
        <dl class="facts">
          <dt>Entered by</dt><dd>${safe(b.createdBy || "—")}</dd>
          ${b.approvedAt ? `<dt>Approved</dt><dd>${safe(b.approvedBy || "—")} · ${dateTime(b.approvedAt)}</dd>` : ""}
          ${b.journal ? `<dt>Ledger</dt><dd><a href="#/journals/${safe(b.journal.id)}">${safe(b.journal.number)}</a>${b.voidJournal ? ` · reversed by <a href="#/journals/${safe(b.voidJournal.id)}">${safe(b.voidJournal.number)}</a>` : ""}</dd>` : ""}
          ${d.match ? `<dt>Purchase order</dt><dd><a href="#/purchase-orders/${safe(d.match.id)}">${safe(d.match.number)}</a></dd>` : ""}
          ${b.voidReason ? `<dt>Void reason</dt><dd>${safe(b.voidReason)}</dd>` : ""}
        </dl>
        ${linesTable(d.lines, b.amountsAre)}
        ${totalsList([[b.amountsAre === "no_tax" ? "Subtotal" : "Subtotal (ex GST)", money(b.subtotal)], b.amountsAre === "no_tax" ? null : ["GST", money(b.gst)], ["Total", money(b.total), "grand"],
          b.withholding ? ["No-ABN withholding (to the ATO)", `(${money(b.withholding)})`] : null,
          b.status === "approved" ? [credit ? "Left to apply" : "Owing to supplier", money(b.owing), "grand"] : null])}
        ${b.notes ? `<p class="small prewrap"><strong>Notes:</strong> ${safe(b.notes)}</p>` : ""}
        <div class="actions">
          ${d.can.edit ? `<a class="btn" href="#/bills/${safe(id)}/edit">Edit</a>` : ""}
          ${d.can.submit ? '<button type="button" class="btn" data-submit>Send for review</button>' : ""}
          ${d.can.approve ? '<button type="button" class="btn primary" data-approve>Approve</button>' : ""}
          ${d.can.pay ? `<a class="btn primary" href="#/supplier-payments/new?supplier=${safe(b.supplierId)}&bill=${safe(id)}">Pay</a>` : ""}
          ${d.can.void ? '<button type="button" class="btn danger" data-void>Void</button>' : ""}
          ${d.can.edit ? '<button type="button" class="btn danger" data-delete>Delete</button>' : ""}
        </div>
      </section>
      ${d.match ? `<section class="panel"><h2>Matched to ${safe(d.match.number)}</h2>
        <p class="muted small">Ordered, received and billed quantities. A line is flagged when more is billed than was received, or the price is higher than ordered.</p>
        <table class="tbl"><thead><tr><th scope="col">Item</th><th scope="col" class="num">Ordered</th><th scope="col" class="num">Received</th><th scope="col" class="num">This bill</th><th scope="col" class="num">PO price</th><th scope="col" class="num">Bill price</th><th scope="col">Check</th></tr></thead><tbody>
        ${d.match.differences.map(x => `<tr><td>${safe(x.description)}</td><td class="num mono">${x.ordered}</td><td class="num mono">${x.received}</td><td class="num mono">${x.billed}</td>
          <td class="num mono">${money(x.orderedPrice)}</td><td class="num mono">${x.billedPrice == null ? "" : money(x.billedPrice)}</td><td>${x.ok ? chip("Matches", "good") : chip("Check", "bad")}</td></tr>`).join("")}
        </tbody></table></section>` : ""}
      ${b.status === "approved" ? `<section class="panel"><h2>${credit ? "Applied to" : "Payments and credits"}</h2>
        ${d.allocations.length ? `<table class="tbl"><tbody>${d.allocations.map(a => `<tr><td>${date(a.date)}</td><td>${safe(a.source)}</td><td class="num mono">${money(a.amount)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted small">Nothing yet.</p>'}
        ${!credit && d.available.length && d.can.apply ? `<form class="toolbar" data-apply><div class="fld"><label for="ap-src">Supplier credit</label><select id="ap-src">${options(d.available.map(a => [a.id, `${a.label} · ${money(a.available)}`]))}</select></div>
          <div class="fld"><label for="ap-amt">Amount</label><input id="ap-amt" inputmode="decimal" value="${safe(Math.min(b.owing, d.available[0].available).toFixed(2))}"></div><button class="btn" type="submit">Apply</button></form>` : ""}
      </section>` : ""}
      ${attachmentsPanel(d.attachments, ctx.can("purchases.manage"), "bill", id)}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
    return d;
  };
  let d = await load();
  const err = hashParams().get("err");
  if (err) flash(view, `Saved but not approved: ${err}`, "bad");
  wireAttachments(view, async () => { d = await load(); });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-apply]")) return;
    e.preventDefault();
    try {
      await call("supplier_credit_apply", { creditId: view.querySelector("#ap-src").value, billId: id, amount: view.querySelector("#ap-amt").value });
      d = await load();
      flash(view, "Credit applied.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b || b.closest("[data-attachments]")) return;
    try {
      if ("submit" in b.dataset) { await call("bill_submit", { id }); d = await load(); flash(view, "Sent for review.", "good"); }
      else if ("approve" in b.dataset) {
        if (d.match && d.match.differences.some(x => !x.ok) && !window.confirm("This bill doesn't match the purchase order (more billed than received, or a higher price). Approve it anyway?")) return;
        b.disabled = true;
        await call("bill_approve", { id });
        d = await load();
        flash(view, "Approved and posted to Accounts Payable.", "good");
      } else if ("void" in b.dataset) {
        const reason = window.prompt("Void this bill? The ledger entry is reversed. Reason:", "");
        if (reason === null) return;
        if (reason.trim().length < 3) return flash(view, "Give a reason for voiding it.", "bad");
        await call("bill_void", { id, reason });
        d = await load();
        flash(view, "Voided.", "good");
      } else if ("delete" in b.dataset) {
        if (!window.confirm("Delete this unapproved bill? It isn't in the books.")) return;
        await call("bill_void", { id, reason: "Deleted before approval" });
        location.hash = "#/bills";
      }
    } catch (error) {
      b.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
}
