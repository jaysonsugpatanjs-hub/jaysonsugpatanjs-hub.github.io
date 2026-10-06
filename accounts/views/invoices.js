// Invoices and credit notes (adjustment notes). Routes: #/invoices,
// #/invoices/new[?customer=&kind=credit_note&from=<invoice>], #/invoices/<id>,
// #/invoices/<id>/edit. Approving posts to the ledger; after that a document
// is fixed and is corrected by a void or a credit note.
import { call, chip, date, dateTime, flash, friendlyError, hashParams, money, options, safe, today } from "../lib/ui.js";
import { addDays, attachmentsPanel, documentEditor, downloadPdf, linesTable, statusChip, totalsList, wireAttachments } from "../lib/docs.js";
import { INVOICE_STATUS } from "./customers.js";

const TYPES = [["standard", "Standard"], ["progress", "Progress claim"], ["deposit", "Deposit"], ["final", "Final claim"], ["variation", "Variation"], ["materials", "Materials"], ["labour", "Labour"]];
const VIEWS = [["all", "All"], ["draft", "Draft"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"], ["void", "Void"]];

export async function renderInvoices(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("/");
  if (id === "new") return editor(view, null);
  if (id && mode === "edit") return editor(view, id);
  if (id) return detail(view, id, ctx);
  return list(view);
}

async function list(view) {
  const p = hashParams();
  const f = { kind: p.get("kind") === "credit_note" ? "credit_note" : "invoice", view: VIEWS.some(v => v[0] === p.get("view")) ? p.get("view") : "all", search: "", page: 1 };
  const setup = await call("sales_setup");
  const load = async () => {
    const d = await call("invoices_list", f);
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const credit = f.kind === "credit_note";
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">SALES</p><h1>${credit ? "Credit notes" : "Invoices"}</h1>
        <p class="muted">${credit ? "Adjustment notes reduce what a customer owes, including the GST." : "Drafts aren't in the books. Approving gives the invoice its number and posts it to Accounts Receivable, income and GST."}</p></div>
        ${setup.can.manage ? `<div class="actions tight"><a class="btn" href="#/invoices?kind=${credit ? "invoice" : "credit_note"}">${credit ? "Invoices" : "Credit notes"}</a>
          <a class="btn primary" href="#/invoices/new${credit ? "?kind=credit_note" : ""}">New ${credit ? "credit note" : "invoice"}</a></div>` : ""}</header>
      ${setup.companyAbnSet ? "" : '<p class="note">Add Panalo\'s ABN in Company settings: invoices can\'t be approved without it, because a tax invoice must show it.</p>'}
      <section class="panel">
        <div class="tabs" role="tablist">${VIEWS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === f.view}" class="${k === f.view ? "on" : ""}" data-view-tab="${k}">${l}</button>`).join("")}</div>
        <form class="toolbar" data-filter><div class="fld"><label for="i-q">Number contains</label><input id="i-q" value="${safe(f.search)}"></div><button class="btn" type="submit">Search</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Number</th><th scope="col">Customer</th><th scope="col">Date</th>${credit ? "" : '<th scope="col">Due</th>'}
          <th scope="col">Status</th><th scope="col" class="num">Total</th><th scope="col" class="num">${credit ? "Unapplied" : "Owing"}</th></tr></thead><tbody>
          ${d.invoices.map(i => `<tr><td class="mono"><a href="#/invoices/${safe(i.id)}">${safe(i.number || "Draft")}</a>${i.reference ? `<small>${safe(i.reference)}</small>` : ""}</td>
            <td>${safe(i.customer)}${i.type !== "standard" ? `<small>${safe(TYPES.find(t => t[0] === i.type)?.[1] || "")}</small>` : ""}</td>
            <td class="nowrap">${date(i.date)}</td>${credit ? "" : `<td class="nowrap">${date(i.dueDate)}${i.overdue ? `<small class="bad-text">${i.daysOverdue} days overdue</small>` : ""}</td>`}
            <td>${statusChip(INVOICE_STATUS, i.status)}${i.status === "approved" && i.owing === 0 ? ` ${chip(credit ? "Applied" : "Paid", "good")}` : ""}${i.sent ? ` ${chip("Sent", "info")}` : ""}</td>
            <td class="num mono">${money(i.total)}</td><td class="num mono">${money(i.status === "approved" ? i.owing : 0, { blankZero: true })}</td></tr>`).join("")
            || `<tr><td colspan="7" class="muted">Nothing here.</td></tr>`}
        </tbody><tfoot><tr><th colspan="${credit ? 4 : 5}" scope="row">${d.totals.count} shown</th><td class="num mono">${money(d.totals.total)}</td><td class="num mono"><strong>${money(d.totals.owing)}</strong></td></tr></tfoot></table></div>
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
    f.search = view.querySelector("#i-q").value.trim();
    f.page = 1;
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function editor(view, id) {
  const setup = await call("sales_setup");
  const p = hashParams();
  let doc = { partyId: p.get("customer") || "", kind: p.get("kind") === "credit_note" ? "credit_note" : "invoice", date: today(), dueDate: "", dueTouched: false,
    reference: "", type: "standard", amountsAre: "exclusive", notes: "", terms: "", lines: [], originalInvoiceId: p.get("from") || "" };
  if (id) {
    const d = await call("invoice_get", { id });
    if (d.invoice.status !== "draft") { location.hash = `#/invoices/${id}`; return; }
    const i = d.invoice;
    doc = { id, partyId: i.customerId, kind: i.kind, date: i.date, dueDate: i.dueDate, dueTouched: true, reference: i.reference || "", type: i.type, amountsAre: i.amountsAre,
      notes: i.notes, terms: i.terms, quoteId: i.quoteId, originalInvoiceId: i.originalInvoiceId || "", lines: d.lines };
  } else if (doc.originalInvoiceId) {
    // Credit note against an invoice: start from its lines.
    const d = await call("invoice_get", { id: doc.originalInvoiceId });
    Object.assign(doc, { partyId: d.invoice.customerId, amountsAre: d.invoice.amountsAre, reference: d.invoice.number, lines: d.lines.map(l => ({ ...l, id: undefined })) });
  }
  const credit = doc.kind === "credit_note";
  const custOf = id => setup.customers.find(c => c.id === id);
  const defaults = c => {
    const acc = c?.revenueAccountId || setup.accounts.find(a => a.code === "4000")?.id || "";
    return { acc, tax: c?.taxCodeId || setup.accounts.find(a => a.id === acc)?.defaultTaxCodeId || "" };
  };
  if (!doc.lines.length) { const dft = defaults(custOf(doc.partyId)); doc.lines = [{ accountId: dft.acc, taxCodeId: dft.tax }]; }
  const terms = c => c?.termsDays ?? setup.defaultTermsDays;
  if (!doc.dueDate) doc.dueDate = addDays(doc.date, terms(custOf(doc.partyId)));

  documentEditor(view, {
    eyebrow: `SALES · ${credit ? "CREDIT NOTES" : "INVOICES"}`,
    title: id ? `Edit draft ${credit ? "credit note" : "invoice"}` : credit ? "New credit note" : "New invoice",
    intro: credit ? "A credit note (adjustment note) reduces what the customer owes, and the GST, once approved. Apply it to an invoice afterwards."
      : "Saved drafts don't affect the books. Approve to number the invoice and post it.",
    partyLabel: "Customer", parties: setup.customers, accounts: setup.accounts, taxCodes: setup.taxCodes, doc,
    partyNote: c => [c.termsDays != null ? `${c.termsDays}-day terms` : `Default terms (${setup.defaultTermsDays} days)`, c.poRequired ? "needs their PO number" : ""].filter(Boolean).join(" · "),
    defaultAccount: c => defaults(c).acc, defaultTax: c => defaults(c).tax,
    onParty: (d, c) => {
      const dft = defaults(c);
      d.lines.forEach(l => { if (!l.accountId) l.accountId = dft.acc; if (!l.taxCodeId) l.taxCodeId = dft.tax; });
      if (!d.dueTouched) d.dueDate = addDays(d.date, terms(c));
    },
    fields: d => `
      <div class="fld"><label for="d-date">${credit ? "Date" : "Invoice date"}</label><input id="d-date" type="date" value="${safe(d.date)}" required></div>
      ${credit ? "" : `<div class="fld"><label for="d-due">Due date</label><input id="d-due" type="date" value="${safe(d.dueDate)}"></div>`}
      <div class="fld"><label for="d-ref">${credit ? "Reference (invoice it adjusts)" : "Customer PO / reference"}</label><input id="d-ref" value="${safe(d.reference)}" maxlength="120"></div>
      ${credit ? "" : `<div class="fld"><label for="d-type">Invoice type</label><select id="d-type">${options(TYPES, d.type)}</select></div>`}`,
    readFields: (root, d) => {
      const nd = root.querySelector("#d-date").value;
      d.date = nd;
      const due = root.querySelector("#d-due");
      if (due) d.dueDate = due.value;
      d.reference = root.querySelector("#d-ref").value.trim();
      d.type = root.querySelector("#d-type")?.value || "standard";
      d.notes = root.querySelector("#d-notes")?.value ?? d.notes;
      d.terms = root.querySelector("#d-terms")?.value ?? d.terms;
    },
    onFieldChange: (root, d, el) => {
      if (el.id === "d-due") d.dueTouched = true;
      if (el.id === "d-date" && !d.dueTouched && root.querySelector("#d-due")) root.querySelector("#d-due").value = addDays(el.value, terms(custOf(d.partyId)));
    },
    after: d => `<div class="grid2">
      <div class="fld"><label for="d-notes">Notes on the ${credit ? "credit note" : "invoice"}</label><textarea id="d-notes" rows="2" maxlength="3000">${safe(d.notes)}</textarea></div>
      <div class="fld"><label for="d-terms">Terms</label><textarea id="d-terms" rows="2" maxlength="3000" placeholder="${credit ? "" : "For example: payment within 30 days of the invoice date"}">${safe(d.terms)}</textarea></div></div>`,
    buttons: [{ value: "draft", label: "Save draft" }, { value: "approve", label: `Save and approve`, primary: true }],
    cancelHref: id ? `#/invoices/${id}` : credit ? "#/invoices?kind=credit_note" : "#/invoices",
    onSubmit: async (d, act) => {
      const r = await call("invoice_save", { id: d.id || null, kind: d.kind, customerId: d.partyId, date: d.date, dueDate: d.dueDate, reference: d.reference, type: d.type,
        amountsAre: d.amountsAre, notes: d.notes, terms: d.terms, quoteId: d.quoteId || null, originalInvoiceId: d.originalInvoiceId || null, lines: d.lines, approve: act === "approve" });
      location.hash = r.approveError ? `#/invoices/${r.id}?err=${encodeURIComponent(r.approveError)}` : `#/invoices/${r.id}`;
    }
  });
}

async function detail(view, id, ctx) {
  const load = async () => {
    const d = await call("invoice_get", { id });
    const i = d.invoice, credit = i.kind === "credit_note";
    const overdue = !credit && i.status === "approved" && i.owing > 0 && i.dueDate < today();
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">SALES · ${credit ? "CREDIT NOTE" : "INVOICE"}</p>
        <h1>${safe(i.number || `Draft ${credit ? "credit note" : "invoice"}`)} ${statusChip(INVOICE_STATUS, i.status)} ${overdue ? chip("Overdue", "bad") : ""} ${i.status === "approved" && i.owing === 0 ? chip(credit ? "Fully applied" : "Paid", "good") : ""}</h1>
        <p class="muted"><a href="#/customers/${safe(i.customerId)}">${safe(i.customer)}</a> · ${date(i.date)}${credit ? "" : ` · due ${date(i.dueDate)}`}</p></div>
        <div class="actions tight"><button type="button" class="btn" data-pdf>Download PDF</button></div></header>
      <section class="panel">
        <dl class="facts">
          ${i.reference ? `<dt>${credit ? "Reference" : "Customer reference"}</dt><dd>${safe(i.reference)}</dd>` : ""}
          ${!credit && i.type !== "standard" ? `<dt>Type</dt><dd>${safe(TYPES.find(t => t[0] === i.type)?.[1])}</dd>` : ""}
          <dt>Amounts</dt><dd>${safe({ exclusive: "Tax exclusive", inclusive: "Tax inclusive", no_tax: "No GST" }[i.amountsAre])}</dd>
          <dt>Created</dt><dd>${safe(i.createdBy || "—")}</dd>
          ${i.approvedAt ? `<dt>Approved</dt><dd>${safe(i.approvedBy || "—")} · ${dateTime(i.approvedAt)}</dd>` : ""}
          ${i.journal ? `<dt>Ledger</dt><dd><a href="#/journals/${safe(i.journal.id)}">${safe(i.journal.number)}</a>${i.voidJournal ? ` · reversed by <a href="#/journals/${safe(i.voidJournal.id)}">${safe(i.voidJournal.number)}</a>` : ""}</dd>` : ""}
          ${i.sentAt ? `<dt>Sent</dt><dd>${dateTime(i.sentAt)}</dd>` : ""}
          ${i.voidReason ? `<dt>Void reason</dt><dd>${safe(i.voidReason)}</dd>` : ""}
        </dl>
        ${linesTable(d.lines, i.amountsAre)}
        ${totalsList([
          [i.amountsAre === "no_tax" ? "Subtotal" : "Subtotal (ex GST)", money(i.subtotal)], i.amountsAre === "no_tax" ? null : ["GST", money(i.gst)],
          ["Total", money(i.total), "grand"],
          i.status === "approved" ? [credit ? "Applied" : "Paid and credited", money(i.paid)] : null,
          i.status === "approved" ? [credit ? "Left to apply" : "Balance due", money(i.owing), "grand"] : null])}
        ${i.notes ? `<p class="small"><strong>Notes:</strong> ${safe(i.notes)}</p>` : ""}
        <div class="actions">
          ${d.can.edit ? `<a class="btn" href="#/invoices/${safe(id)}/edit">Edit</a>` : ""}
          ${d.can.approve ? `<button type="button" class="btn primary" data-approve>Approve${credit ? "" : " and number"}</button>` : ""}
          ${d.can.receive ? `<a class="btn primary" href="#/receipts/new?customer=${safe(i.customerId)}&invoice=${safe(id)}">Record payment</a>` : ""}
          ${!credit && i.status === "approved" && !i.sentAt && d.can.void ? '<button type="button" class="btn" data-sent>Mark as sent</button>' : ""}
          ${!credit && i.status === "approved" && d.can.void ? `<a class="btn" href="#/invoices/new?kind=credit_note&from=${safe(id)}">Credit note</a>` : ""}
          ${d.can.void ? '<button type="button" class="btn danger" data-void>Void</button>' : ""}
          ${i.status === "draft" && d.can.edit ? '<button type="button" class="btn danger" data-delete>Delete draft</button>' : ""}
        </div>
      </section>
      ${i.status === "approved" ? `<section class="panel"><h2>${credit ? "Applied to" : "Payments and credits"}</h2>
        ${d.allocations.length ? `<table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">From</th><th scope="col" class="num">Amount</th></tr></thead><tbody>
          ${d.allocations.map(a => `<tr><td>${date(a.date)}</td><td>${a.paymentId ? `<a href="#/receipts/${safe(a.paymentId)}">${safe(a.source)}</a>` : a.invoiceId ? `<a href="#/invoices/${safe(a.invoiceId)}">${safe(a.source)}</a>` : a.creditNoteId ? `<a href="#/invoices/${safe(a.creditNoteId)}">${safe(a.source)}</a>` : safe(a.source)}</td><td class="num mono">${money(a.amount)}</td></tr>`).join("")}
        </tbody></table>` : '<p class="muted small">Nothing applied yet.</p>'}
        ${credit && i.owing > 0 && d.can.apply ? await creditApplyForm(i) : ""}
        ${!credit && d.available.length && (d.can.apply || d.can.allocate) ? `<h3>Apply existing credit</h3><form class="toolbar" data-apply>
          <div class="fld"><label for="ap-src">Credit</label><select id="ap-src">${options(d.available.map(a => [`${a.kind}:${a.id}`, `${a.label} · ${money(a.available)} available`]))}</select></div>
          <div class="fld"><label for="ap-amt">Amount</label><input id="ap-amt" inputmode="decimal" value="${safe(Math.min(i.owing, d.available[0].available).toFixed(2))}"></div>
          <button class="btn" type="submit">Apply</button></form>` : ""}
      </section>` : ""}
      ${attachmentsPanel(d.attachments, d.can.edit || d.can.void, "invoice", id)}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
    return d;
  };
  let d = await load();
  const err = hashParams().get("err");
  if (err) flash(view, `Saved as a draft but not approved: ${err}`, "bad");
  wireAttachments(view, async () => { d = await load(); });

  async function creditApplyForm(i) {
    const list = await call("invoices_list", { kind: "invoice", view: "unpaid", customerId: i.customerId });
    if (!list.invoices.length) return '<p class="muted small">This customer has no unpaid invoices to apply it to.</p>';
    return `<h3>Apply to an invoice</h3><form class="toolbar" data-apply-credit>
      <div class="fld"><label for="ac-inv">Invoice</label><select id="ac-inv">${options(list.invoices.map(x => [x.id, `${x.number} · ${money(x.owing)} owing`]))}</select></div>
      <div class="fld"><label for="ac-amt">Amount</label><input id="ac-amt" inputmode="decimal" value="${safe(Math.min(i.owing, list.invoices[0].owing).toFixed(2))}"></div>
      <button class="btn" type="submit">Apply</button></form>`;
  }

  view.addEventListener("submit", async e => {
    e.preventDefault();
    try {
      if (e.target.matches("[data-apply]")) {
        const [kind, src] = view.querySelector("#ap-src").value.split(":");
        const amount = view.querySelector("#ap-amt").value;
        if (kind === "credit_note") await call("credit_apply", { creditNoteId: src, invoiceId: id, amount });
        else await call("receipt_allocate", { paymentId: src, invoiceId: id, amount });
      } else if (e.target.matches("[data-apply-credit]")) {
        await call("credit_apply", { creditNoteId: id, invoiceId: view.querySelector("#ac-inv").value, amount: view.querySelector("#ac-amt").value });
      } else return;
      d = await load();
      flash(view, "Applied.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b || b.closest("[data-attachments]")) return;
    try {
      if ("pdf" in b.dataset) { b.disabled = true; await downloadPdf("invoice_pdf", { id }); b.disabled = false; return; }
      if ("approve" in b.dataset) {
        b.disabled = true;
        const r = await call("invoice_approve", { id });
        d = await load();
        flash(view, `Approved as ${r.number} and posted to the ledger.`, "good");
      } else if ("sent" in b.dataset) {
        await call("invoice_mark_sent", { id });
        d = await load();
        flash(view, "Marked as sent.", "good");
      } else if ("void" in b.dataset) {
        const reason = window.prompt(`Void ${d.invoice.number}? The ledger entry is reversed and the number stays used. Reason:`, "");
        if (reason === null) return;
        if (reason.trim().length < 3) return flash(view, "Give a reason for voiding it.", "bad");
        await call("invoice_void", { id, reason });
        d = await load();
        flash(view, "Voided. The ledger entry has been reversed.", "good");
      } else if ("delete" in b.dataset) {
        if (!window.confirm("Delete this draft? It isn't in the books, so nothing else changes.")) return;
        await call("invoice_void", { id, reason: "Draft deleted" });
        location.hash = d.invoice.kind === "credit_note" ? "#/invoices?kind=credit_note" : "#/invoices";
      }
      ctx.refreshCounts?.();
    } catch (error) {
      b.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
}
