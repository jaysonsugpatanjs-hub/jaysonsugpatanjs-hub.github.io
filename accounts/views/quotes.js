// Quotes. Routes: #/quotes, #/quotes/new[?customer=], #/quotes/<id>, #/quotes/<id>/edit.
// Quotes never touch the ledger. An approved or accepted quote becomes a draft
// invoice; the quote is marked invoiced when that invoice is approved.
import { call, chip, date, dateTime, flash, friendlyError, hashParams, money, options, safe, today } from "../lib/ui.js";
import { addDays, attachmentsPanel, documentEditor, downloadPdf, linesTable, statusChip, totalsList, wireAttachments } from "../lib/docs.js";

export const QUOTE_STATUS = { draft: ["Draft", "pending"], approved: ["Approved", "info"], sent: ["Sent", "info"], accepted: ["Accepted", "good"], declined: ["Declined", "bad"], converted: ["Invoiced", "good"], cancelled: ["Cancelled", ""] };

export async function renderQuotes(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("/");
  if (id === "new") return editor(view, null);
  if (id && mode === "edit") return editor(view, id);
  if (id) return detail(view, id);
  return list(view);
}

async function list(view) {
  const f = { status: hashParams().get("status") || "", search: "" };
  const setup = await call("sales_setup");
  const load = async () => {
    const d = await call("quotes_list", f);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">SALES</p><h1>Quotes</h1>
        <p class="muted">Quotes don't affect the books. Once accepted, turn one into an invoice in a click.</p></div>
        ${setup.can.manage ? '<a class="btn primary" href="#/quotes/new">New quote</a>' : ""}</header>
      <section class="panel">
        <form class="toolbar" data-filter>
          <div class="fld"><label for="q-st">Status</label><select id="q-st">${options([["", "All"], ...Object.entries(QUOTE_STATUS).map(([k, v]) => [k, v[0]])], f.status)}</select></div>
          <div class="fld"><label for="q-q">Title contains</label><input id="q-q" value="${safe(f.search)}"></div><button class="btn" type="submit">Filter</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Number</th><th scope="col">Customer</th><th scope="col">Title</th><th scope="col">Date</th><th scope="col">Valid until</th>
          <th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead><tbody>
          ${d.quotes.map(q => `<tr><td class="mono"><a href="#/quotes/${safe(q.id)}">${safe(q.number)}</a></td><td>${safe(q.customer)}</td><td>${safe(q.title || "—")}</td>
            <td class="nowrap">${date(q.date)}</td><td class="nowrap">${date(q.expiryDate)}</td><td>${statusChip(QUOTE_STATUS, q.status)}${q.expired ? ` ${chip("Expired", "bad")}` : ""}</td>
            <td class="num mono">${money(q.total)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No quotes yet.</td></tr>'}
        </tbody></table></div></section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    f.status = view.querySelector("#q-st").value;
    f.search = view.querySelector("#q-q").value.trim();
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function editor(view, id) {
  const setup = await call("sales_setup");
  let doc = { partyId: hashParams().get("customer") || "", date: today(), expiryDate: addDays(today(), 30), title: "", scope: "", reference: "", terms: "", amountsAre: "exclusive", lines: [] };
  if (id) {
    const d = await call("quote_get", { id });
    if (d.quote.status !== "draft") { location.hash = `#/quotes/${id}`; return; }
    const q = d.quote;
    doc = { id, partyId: q.customerId, date: q.date, expiryDate: q.expiryDate || "", title: q.title, scope: q.scope, reference: q.reference || "", terms: q.terms, amountsAre: q.amountsAre, lines: d.lines };
  }
  const defaults = c => {
    const acc = c?.revenueAccountId || setup.accounts.find(a => a.code === "4000")?.id || "";
    return { acc, tax: c?.taxCodeId || setup.accounts.find(a => a.id === acc)?.defaultTaxCodeId || "" };
  };
  if (!doc.lines.length) { const dft = defaults(setup.customers.find(c => c.id === doc.partyId)); doc.lines = [{ accountId: dft.acc, taxCodeId: dft.tax }]; }
  const fromProject = hashParams().get("project");
  if (fromProject && !id) doc.lines.forEach(l => { if (!l.projectId) l.projectId = fromProject; });
  documentEditor(view, {
    eyebrow: "SALES · QUOTES", title: id ? "Edit draft quote" : "New quote",
    intro: "Describe the work and price it line by line. Approve the quote before sending it to the customer.",
    partyLabel: "Customer", parties: setup.customers, accounts: setup.accounts, taxCodes: setup.taxCodes, doc,
    projects: setup.projects,
    defaultAccount: c => defaults(c).acc, defaultTax: c => defaults(c).tax,
    onParty: (d, c) => { const dft = defaults(c); d.lines.forEach(l => { if (!l.accountId) l.accountId = dft.acc; if (!l.taxCodeId) l.taxCodeId = dft.tax; }); },
    fields: d => `
      <div class="fld"><label for="d-date">Quote date</label><input id="d-date" type="date" value="${safe(d.date)}" required></div>
      <div class="fld"><label for="d-exp">Valid until</label><input id="d-exp" type="date" value="${safe(d.expiryDate)}"></div>
      <div class="fld"><label for="d-title">Title</label><input id="d-title" value="${safe(d.title)}" maxlength="200" placeholder="For example: Shutdown pipework, Unit 3"></div>
      <div class="fld"><label for="d-ref">Customer reference</label><input id="d-ref" value="${safe(d.reference)}" maxlength="120"></div>`,
    readFields: (root, d) => {
      d.date = root.querySelector("#d-date").value;
      d.expiryDate = root.querySelector("#d-exp").value;
      d.title = root.querySelector("#d-title").value.trim();
      d.reference = root.querySelector("#d-ref").value.trim();
      d.scope = root.querySelector("#d-scope")?.value ?? d.scope;
      d.terms = root.querySelector("#d-terms")?.value ?? d.terms;
    },
    after: d => `<div class="grid2">
      <div class="fld"><label for="d-scope">Scope of work</label><textarea id="d-scope" rows="4" maxlength="5000" placeholder="What's included, what isn't, assumptions">${safe(d.scope)}</textarea></div>
      <div class="fld"><label for="d-terms">Terms and conditions</label><textarea id="d-terms" rows="4" maxlength="3000">${safe(d.terms)}</textarea></div></div>`,
    buttons: [{ value: "save", label: "Save draft", primary: true }],
    cancelHref: id ? `#/quotes/${id}` : "#/quotes",
    onSubmit: async d => {
      const r = await call("quote_save", { id: d.id || null, customerId: d.partyId, date: d.date, expiryDate: d.expiryDate, title: d.title, scope: d.scope, reference: d.reference,
        terms: d.terms, amountsAre: d.amountsAre, lines: d.lines });
      location.hash = `#/quotes/${r.id}`;
    }
  });
}

async function detail(view, id) {
  const load = async () => {
    const d = await call("quote_get", { id });
    const q = d.quote, m = d.can.manage;
    const next = {
      draft: m ? [["approved", "Approve", true]] : [],
      approved: m ? [["sent", "Mark as sent"], ["accepted", "Customer accepted"], ["draft", "Back to draft"]] : [],
      sent: m ? [["accepted", "Customer accepted", true], ["declined", "Customer declined"]] : [],
      accepted: [], declined: m ? [["sent", "Reopen"]] : [], converted: [], cancelled: []
    }[q.status] || [];
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">SALES · QUOTE</p><h1>${safe(q.number)} ${statusChip(QUOTE_STATUS, q.status)} ${q.expired ? chip("Expired", "bad") : ""}</h1>
        <p class="muted"><a href="#/customers/${safe(q.customerId)}">${safe(q.customer)}</a> · ${date(q.date)}${q.expiryDate ? ` · valid until ${date(q.expiryDate)}` : ""}</p></div>
        <div class="actions tight"><button type="button" class="btn" data-pdf>Download PDF</button></div></header>
      <section class="panel">
        ${q.title ? `<h2>${safe(q.title)}</h2>` : ""}
        ${q.scope ? `<p class="prewrap">${safe(q.scope)}</p>` : ""}
        <dl class="facts">${q.reference ? `<dt>Customer reference</dt><dd>${safe(q.reference)}</dd>` : ""}<dt>Prepared by</dt><dd>${safe(q.createdBy || "—")}</dd>
          ${q.approvedAt ? `<dt>Approved</dt><dd>${safe(q.approvedBy || "—")} · ${dateTime(q.approvedAt)}</dd>` : ""}
          ${q.invoice ? `<dt>Invoice</dt><dd><a href="#/invoices/${safe(q.invoice.id)}">${safe(q.invoice.number || "Draft")}</a></dd>` : ""}</dl>
        ${linesTable(d.lines, q.amountsAre)}
        ${totalsList([[q.amountsAre === "no_tax" ? "Subtotal" : "Subtotal (ex GST)", money(q.subtotal)], q.amountsAre === "no_tax" ? null : ["GST", money(q.gst)], ["Total", money(q.total), "grand"]])}
        ${q.terms ? `<p class="small prewrap"><strong>Terms:</strong> ${safe(q.terms)}</p>` : ""}
        <div class="actions">
          ${d.can.edit ? `<a class="btn" href="#/quotes/${safe(id)}/edit">Edit</a>` : ""}
          ${next.map(([s, l, p]) => `<button type="button" class="btn ${p ? "primary" : ""}" data-status="${s}">${safe(l)}</button>`).join("")}
          ${m && ["approved", "sent", "accepted"].includes(q.status) ? '<button type="button" class="btn primary" data-invoice>Create invoice</button>' : ""}
          ${m && !["converted", "cancelled"].includes(q.status) ? '<button type="button" class="btn danger" data-status="cancelled">Cancel quote</button>' : ""}
        </div>
      </section>
      ${attachmentsPanel(d.attachments, m, "quote", id)}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  wireAttachments(view, load);
  view.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b || b.closest("[data-attachments]")) return;
    try {
      if ("pdf" in b.dataset) { b.disabled = true; await downloadPdf("quote_pdf", { id }); b.disabled = false; return; }
      if (b.dataset.status) {
        if (b.dataset.status === "cancelled" && !window.confirm("Cancel this quote?")) return;
        b.disabled = true;
        await call("quote_status", { id, status: b.dataset.status });
        await load();
        flash(view, "Updated.", "good");
      } else if ("invoice" in b.dataset) {
        b.disabled = true;
        const r = await call("quote_to_invoice", { id });
        location.hash = `#/invoices/${r.id}/edit`;
      }
    } catch (error) {
      b.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
}
