// Customers: list, form, and a detail page with balance, documents,
// receipts and statements. Routes: #/customers, #/customers/new,
// #/customers/<id>, #/customers/<id>/edit
import { call, chip, clearErrors, date, field, fieldError, flash, friendlyError, money, options, safe, today } from "../lib/ui.js";
import { addressFields, addressText, attachmentsPanel, downloadPdf, readAddress, statusChip, wireAttachments } from "../lib/docs.js";
import { formatAbn, validAbn, validEmail, validPostcode } from "../lib/validate.js";

export const INVOICE_STATUS = { draft: ["Draft", "pending"], approved: ["Approved", "good"], void: ["Void", ""] };
const QUOTE_STATUS = { draft: ["Draft", "pending"], approved: ["Approved", "info"], sent: ["Sent", "info"], accepted: ["Accepted", "good"], declined: ["Declined", "bad"], converted: ["Invoiced", "good"], cancelled: ["Cancelled", ""] };

export async function renderCustomers(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("/");
  if (id === "new") return form(view, null);
  if (id && mode === "edit") return form(view, id);
  if (id) return detail(view, id);
  return list(view);
}

async function list(view) {
  const f = { search: "", status: "active" };
  const setup = await call("sales_setup");
  const load = async () => {
    const d = await call("customers_list", f);
    const total = d.customers.reduce((s, c) => s + Math.round(c.balance * 100), 0) / 100;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">SALES</p><h1>Customers</h1>
        <p class="muted">Who Panalo invoices. Balances include unpaid invoices, less credit notes and unapplied payments.</p></div>
        ${setup.can.manage ? '<a class="btn primary" href="#/customers/new">New customer</a>' : ""}</header>
      <section class="panel">
        <form class="toolbar" data-filter>
          <div class="fld"><label for="c-q">Name contains</label><input id="c-q" value="${safe(f.search)}"></div>
          <div class="fld"><label for="c-st">Show</label><select id="c-st">${options([["active", "Active"], ["archived", "Archived"]], f.status)}</select></div>
          <button class="btn" type="submit">Filter</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Customer</th><th scope="col">ABN</th><th scope="col">Contact</th><th scope="col">Terms</th>
          <th scope="col" class="num">Overdue</th><th scope="col" class="num">Balance</th></tr></thead><tbody>
          ${d.customers.map(c => `<tr><td><a href="#/customers/${safe(c.id)}">${safe(c.name)}</a>${c.tradingName ? `<small>${safe(c.tradingName)}</small>` : ""}</td>
            <td class="mono nowrap">${safe(c.abn ? formatAbn(c.abn) : "—")}</td><td>${safe(c.contact || "")}<small>${safe(c.email || "")}</small></td>
            <td>${c.termsDays != null ? `${c.termsDays} days` : '<span class="muted">Default</span>'}</td>
            <td class="num mono ${c.overdue > 0 ? "bad-text" : ""}">${money(c.overdue, { blankZero: true })}</td>
            <td class="num mono">${money(c.balance, { blankZero: true })}${c.overLimit ? ` ${chip("Over limit", "bad")}` : ""}</td></tr>`).join("")
            || '<tr><td colspan="6" class="muted">No customers yet.</td></tr>'}
        </tbody><tfoot><tr><th colspan="5" scope="row">Total owed to Panalo</th><td class="num mono"><strong>${money(total)}</strong></td></tr></tfoot></table></div>
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    f.search = view.querySelector("#c-q").value.trim();
    f.status = view.querySelector("#c-st").value;
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function form(view, id) {
  const setup = await call("sales_setup");
  const c = id ? (await call("customer_get", { id })).customer : { status: "active", billingAddress: {}, siteAddress: {} };
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">SALES · CUSTOMERS</p><h1>${id ? `Edit ${safe(c.name)}` : "New customer"}</h1>
      <p class="muted">The ABN is checked with the ATO's check-digit rule. A tax invoice of $1,000 or more must show the customer's name or ABN.</p></div></header>
    <form class="panel" data-cust novalidate>
      <div class="grid2">
        ${field({ id: "cu-name", label: "Legal or business name", value: c.name || "", required: true, attrs: 'maxlength="160"' })}
        ${field({ id: "cu-trading", label: "Trading name", value: c.tradingName || "", attrs: 'maxlength="160"' })}
        ${field({ id: "cu-abn", label: "ABN", value: c.abn ? formatAbn(c.abn) : "", attrs: 'inputmode="numeric" maxlength="14"', hint: "11 digits" })}
        ${field({ id: "cu-contact", label: "Accounts contact", value: c.contactName || "", attrs: 'maxlength="120"' })}
        ${field({ id: "cu-email", label: "Accounts email", value: c.email || "", type: "email", hint: "Where invoices and statements go" })}
        ${field({ id: "cu-phone", label: "Phone", value: c.phone || "", type: "tel" })}
      </div>
      ${addressFields("cu-bill", c.billingAddress, "Billing address")}
      ${addressFields("cu-site", c.siteAddress, "Site address (optional)")}
      <div class="grid3">
        ${field({ id: "cu-terms", label: "Payment terms (days)", value: c.termsDays ?? "", attrs: 'inputmode="numeric" maxlength="3"', hint: `Blank uses the company default (${setup.defaultTermsDays} days)` })}
        ${field({ id: "cu-limit", label: "Credit limit ($)", value: c.creditLimit ?? "", attrs: 'inputmode="decimal"', hint: "Optional; flags the customer when exceeded" })}
        <div class="fld"><label for="cu-acc">Default income account</label><select id="cu-acc">${options([["", "None"], ...setup.accounts.map(a => [a.id, `${a.code} ${a.name}`])], c.revenueAccountId || "")}</select></div>
        <div class="fld"><label for="cu-tax">Default tax code</label><select id="cu-tax">${options([["", "From the account"], ...setup.taxCodes.map(t => [t.id, `${t.code} · ${t.name}`])], c.taxCodeId || "")}</select></div>
      </div>
      <label class="check"><input type="checkbox" id="cu-po" ${c.poRequired ? "checked" : ""}> Their purchase order number must be on every invoice</label>
      <div class="fld"><label for="cu-notes">Notes</label><textarea id="cu-notes" rows="3" maxlength="2000">${safe(c.notes || "")}</textarea></div>
      ${id ? `<label class="check"><input type="checkbox" id="cu-archived" ${c.status === "archived" ? "checked" : ""}> Archived (hidden from new invoices)</label>` : ""}
      <div class="actions"><button class="btn primary" type="submit">Save customer</button><a class="btn" href="#/customers${id ? `/${id}` : ""}">Cancel</a></div>
    </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-cust]")) return;
    e.preventDefault();
    clearErrors(view);
    const v = x => view.querySelector(`#${x}`).value.trim();
    const bill = readAddress(view, "cu-bill"), site = readAddress(view, "cu-site");
    if (v("cu-name").length < 2) return fieldError(view, "cu-name", "Enter the customer's name.");
    if (v("cu-abn") && !validAbn(v("cu-abn"))) return fieldError(view, "cu-abn", "That ABN isn't valid. Check the 11 digits.");
    if (v("cu-email") && !validEmail(v("cu-email"))) return fieldError(view, "cu-email", "That email address doesn't look right.");
    if (bill.postcode && !validPostcode(bill.postcode)) return flash(view, "A postcode is 4 digits.", "bad");
    if (v("cu-terms") && !/^\d{1,3}$/.test(v("cu-terms"))) return fieldError(view, "cu-terms", "Enter a number of days.");
    try {
      const r = await call("customer_save", {
        id, name: v("cu-name"), tradingName: v("cu-trading"), abn: v("cu-abn"), contactName: v("cu-contact"), email: v("cu-email"), phone: v("cu-phone"),
        billingAddress: bill, siteAddress: site, termsDays: v("cu-terms"), creditLimit: v("cu-limit").replace(/[$,]/g, ""), revenueAccountId: v("cu-acc"), taxCodeId: v("cu-tax"),
        poRequired: view.querySelector("#cu-po").checked, notes: v("cu-notes"), status: view.querySelector("#cu-archived")?.checked ? "archived" : "active"
      });
      location.hash = `#/customers/${r.id}`;
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function detail(view, id) {
  const t = today();
  const st = { from: `${t.slice(0, 7)}-01`, to: t };
  const load = async () => {
    const d = await call("customer_get", { id });
    const c = d.customer;
    const open = d.invoices.filter(i => i.kind === "invoice" && i.status === "approved" && i.owing > 0);
    const owing = d.invoices.filter(i => i.status === "approved").reduce((s, i) => s + Math.round((i.kind === "invoice" ? i.owing : -i.owing) * 100), 0)
      - d.payments.reduce((s, p) => s + Math.round(p.unallocated * 100), 0);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">SALES · CUSTOMERS</p><h1>${safe(c.name)} ${c.status === "archived" ? chip("Archived") : ""}</h1>
        <p class="muted">${c.abn ? `ABN ${safe(formatAbn(c.abn))} · ` : ""}${safe(addressText(c.billingAddress) || "No billing address")}</p></div>
        <div class="actions tight">${d.can.manage ? `<a class="btn" href="#/customers/${safe(id)}/edit">Edit</a><a class="btn primary" href="#/invoices/new?customer=${safe(id)}">New invoice</a>` : ""}
          ${d.can.bank && open.length ? `<a class="btn" href="#/receipts/new?customer=${safe(id)}">Record payment</a>` : ""}</div></header>
      <div class="cards figures">
        <section class="card"><h2>Balance owing</h2><p class="big mono">${money(owing / 100)}</p><p class="muted small">${open.length} unpaid invoice${open.length === 1 ? "" : "s"}</p></section>
        <section class="card"><h2>Terms</h2><p class="big">${c.termsDays != null ? `${c.termsDays} days` : "Default"}</p><p class="muted small">${c.creditLimit != null ? `Credit limit ${money(c.creditLimit)}` : "No credit limit"}${c.poRequired ? " · PO number required" : ""}</p></section>
        <section class="card"><h2>Contact</h2><p>${safe(c.contactName || "—")}</p><p class="muted small">${safe(c.email || "")}${c.phone ? ` · ${safe(c.phone)}` : ""}</p></section>
      </div>
      <section class="panel"><h2>Invoices and credit notes</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Number</th><th scope="col">Date</th><th scope="col">Due</th><th scope="col">Reference</th><th scope="col">Status</th>
          <th scope="col" class="num">Total</th><th scope="col" class="num">Owing</th></tr></thead><tbody>
          ${d.invoices.map(i => `<tr><td class="mono"><a href="#/invoices/${safe(i.id)}">${safe(i.number || "Draft")}</a>${i.kind === "credit_note" ? "<small>Credit note</small>" : ""}</td>
            <td class="nowrap">${date(i.date)}</td><td class="nowrap">${i.kind === "invoice" ? date(i.dueDate) : ""}</td><td>${safe(i.reference || "")}</td>
            <td>${statusChip(INVOICE_STATUS, i.status)}${i.kind === "invoice" && i.status === "approved" && i.owing > 0 && i.dueDate < t ? ` ${chip("Overdue", "bad")}` : ""}</td>
            <td class="num mono">${money(i.kind === "credit_note" ? -i.total : i.total)}</td><td class="num mono">${money(i.status === "approved" ? (i.kind === "credit_note" ? -i.owing : i.owing) : 0, { blankZero: true })}</td></tr>`).join("")
            || '<tr><td colspan="7" class="muted">No invoices yet.</td></tr>'}
        </tbody></table></div></section>
      <section class="panel"><h2>Payments received</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Status</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Not yet applied</th></tr></thead><tbody>
          ${d.payments.map(p => `<tr><td><a href="#/receipts/${safe(p.id)}">${date(p.date)}</a></td><td>${safe(p.reference || "—")}</td><td>${p.status === "void" ? chip("Void") : chip("Banked", "good")}</td>
            <td class="num mono">${money(p.amount)}</td><td class="num mono">${money(p.unallocated, { blankZero: true })}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No payments yet.</td></tr>'}
        </tbody></table></div></section>
      ${d.quotes.length ? `<section class="panel"><h2>Quotes</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Number</th><th scope="col">Date</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead><tbody>
        ${d.quotes.map(q => `<tr><td class="mono"><a href="#/quotes/${safe(q.id)}">${safe(q.number)}</a></td><td>${date(q.date)}</td><td>${safe(q.title || "")}</td><td>${statusChip(QUOTE_STATUS, q.status)}</td><td class="num mono">${money(q.total)}</td></tr>`).join("")}
      </tbody></table></div></section>` : ""}
      <section class="panel"><h2>Statement</h2>
        <form class="toolbar" data-statement>
          <div class="fld"><label for="st-from">From</label><input id="st-from" type="date" value="${safe(st.from)}"></div>
          <div class="fld"><label for="st-to">To</label><input id="st-to" type="date" value="${safe(st.to)}"></div>
          <button class="btn" type="submit" data-kind="view">Show</button><button class="btn" type="submit" data-kind="pdf">Download PDF</button></form>
        <div data-statement-body></div></section>
      ${attachmentsPanel(d.attachments, d.can.manage, "customer", id)}
      ${c.notes ? `<section class="panel"><h2>Notes</h2><p>${safe(c.notes)}</p></section>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  wireAttachments(view, load);
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-statement]")) return;
    e.preventDefault();
    st.from = view.querySelector("#st-from").value;
    st.to = view.querySelector("#st-to").value;
    try {
      if (e.submitter?.dataset.kind === "pdf") { await downloadPdf("customer_statement", { customerId: id, ...st, pdf: true }); return; }
      const s = await call("customer_statement", { customerId: id, ...st });
      let run = Math.round(s.openingBalance * 100);
      view.querySelector("[data-statement-body]").innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Details</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Balance</th></tr></thead><tbody>
        <tr><td>${date(s.from)}</td><td></td><td>Opening balance</td><td></td><td class="num mono">${money(s.openingBalance)}</td></tr>
        ${s.rows.map(r => { run += Math.round(r.amount * 100); return `<tr><td>${date(r.date)}</td><td class="mono">${safe(r.reference)}</td><td>${safe(r.type)}</td><td class="num mono">${money(r.amount)}</td><td class="num mono">${money(run / 100)}</td></tr>`; }).join("")}
      </tbody><tfoot><tr><th colspan="4" scope="row">Closing balance</th><td class="num mono"><strong>${money(s.closingBalance)}</strong></td></tr></tfoot></table></div>`;
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
