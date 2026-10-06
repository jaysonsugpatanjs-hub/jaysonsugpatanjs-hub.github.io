// Suppliers and subcontractors. Routes: #/suppliers, #/suppliers/new,
// #/suppliers/<id>, #/suppliers/<id>/edit. Bank details change only through a
// second-person approval, to stop payment-redirection fraud.
import { call, chip, clearErrors, date, field, fieldError, flash, friendlyError, money, options, safe } from "../lib/ui.js";
import { addressFields, addressText, attachmentsPanel, readAddress, statusChip, wireAttachments } from "../lib/docs.js";
import { formatAbn, validAbn, validAccountNumber, validBsb, validEmail } from "../lib/validate.js";

export const BILL_STATUS = { draft: ["Draft", "pending"], submitted: ["For review", "pending"], approved: ["Approved", "good"], void: ["Void", ""] };
export const PO_STATUS = { draft: ["Draft", "pending"], submitted: ["Awaiting approval", "pending"], approved: ["Approved", "info"], issued: ["Issued", "info"],
  partially_received: ["Part received", "info"], completed: ["Completed", "good"], cancelled: ["Cancelled", ""] };

export async function renderSuppliers(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("/");
  if (id === "new") return form(view, null);
  if (id && mode === "edit") return form(view, id);
  if (id) return detail(view, id, ctx);
  return list(view);
}

async function list(view) {
  const f = { search: "", status: "active" };
  const setup = await call("purchases_setup");
  const load = async () => {
    const d = await call("suppliers_list", f);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PURCHASES</p><h1>Suppliers</h1>
        <p class="muted">Suppliers and subcontractors. Warnings show missing ABNs (47% must then be withheld) and insurance or licences about to expire.</p></div>
        ${setup.can.manage ? '<a class="btn primary" href="#/suppliers/new">New supplier</a>' : ""}</header>
      <section class="panel">
        <form class="toolbar" data-filter>
          <div class="fld"><label for="s-q">Name contains</label><input id="s-q" value="${safe(f.search)}"></div>
          <div class="fld"><label for="s-st">Show</label><select id="s-st">${options([["active", "Active"], ["archived", "Archived"]], f.status)}</select></div>
          <button class="btn" type="submit">Filter</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Supplier</th><th scope="col">ABN</th><th scope="col">Trade</th><th scope="col">Insurance</th><th scope="col">Licence</th>
          <th scope="col" class="num">Owing</th></tr></thead><tbody>
          ${d.suppliers.map(s => `<tr><td><a href="#/suppliers/${safe(s.id)}">${safe(s.name)}</a>${s.subcontractor ? ` ${chip("Subcontractor", "info")}` : ""}${s.tpar ? ` ${chip("TPAR")}` : ""}
              ${s.warnings.map(w => `<small class="warn-text">${safe(w)}</small>`).join("")}</td>
            <td class="mono nowrap">${s.abn ? safe(formatAbn(s.abn)) : chip("No ABN", "bad")}</td><td>${safe(s.tradeType || "")}</td>
            <td class="nowrap">${expiry(s.insuranceExpiry, s.insuranceDays)}</td><td class="nowrap">${expiry(s.licenceExpiry, s.licenceDays)}</td>
            <td class="num mono">${money(s.balance, { blankZero: true })}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No suppliers yet.</td></tr>'}
        </tbody></table></div></section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    f.search = view.querySelector("#s-q").value.trim();
    f.status = view.querySelector("#s-st").value;
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

function expiry(iso, days) {
  if (!iso) return '<span class="muted">—</span>';
  return `${date(iso)}${days < 0 ? ` ${chip("Expired", "bad")}` : days <= 30 ? ` ${chip(`${days} days`, "pending")}` : ""}`;
}

async function form(view, id) {
  const setup = await call("purchases_setup");
  const s = id ? (await call("supplier_get", { id })).supplier : { status: "active", gstRegistered: true, address: {} };
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">PURCHASES · SUPPLIERS</p><h1>${id ? `Edit ${safe(s.name)}` : "New supplier"}</h1>
      <p class="muted">Bank details are added separately, from the supplier's page, and need a second person to approve them.</p></div></header>
    <form class="panel" data-sup novalidate>
      <div class="grid2">
        ${field({ id: "su-name", label: "Legal or business name", value: s.name || "", required: true, attrs: 'maxlength="160"' })}
        ${field({ id: "su-trading", label: "Trading name", value: s.tradingName || "", attrs: 'maxlength="160"' })}
        ${field({ id: "su-abn", label: "ABN", value: s.abn ? formatAbn(s.abn) : "", attrs: 'inputmode="numeric" maxlength="14"', hint: "If a supplier doesn't quote an ABN, 47% of payments over $75 (ex GST) must be withheld and paid to the ATO" })}
        ${field({ id: "su-trade", label: "Trade or category", value: s.tradeType || "", attrs: 'maxlength="80"', hint: "For example: steel supply, rigging, NDT" })}
        ${field({ id: "su-contact", label: "Contact", value: s.contactName || "", attrs: 'maxlength="120"' })}
        ${field({ id: "su-email", label: "Accounts email", value: s.email || "", type: "email" })}
        ${field({ id: "su-phone", label: "Phone", value: s.phone || "", type: "tel" })}
        ${field({ id: "su-terms", label: "Payment terms (days)", value: s.termsDays ?? "", attrs: 'inputmode="numeric" maxlength="3"', hint: "Blank means 30 days" })}
      </div>
      ${addressFields("su-addr", s.address, "Address")}
      <div class="grid2">
        <div class="fld"><label for="su-acc">Default expense account</label><select id="su-acc">${options([["", "None"], ...setup.accounts.map(a => [a.id, `${a.code} ${a.name}`])], s.expenseAccountId || "")}</select></div>
        <div class="fld"><label for="su-tax">Default tax code</label><select id="su-tax">${options([["", "From the account"], ...setup.taxCodes.map(t => [t.id, `${t.code} · ${t.name}`])], s.taxCodeId || "")}</select></div>
      </div>
      <fieldset class="addr"><legend>Tax and compliance</legend>
        <label class="check"><input type="checkbox" id="su-gst" ${s.gstRegistered !== false ? "checked" : ""}> Registered for GST</label>
        <label class="check"><input type="checkbox" id="su-sub" ${s.subcontractor ? "checked" : ""}> Subcontractor</label>
        <label class="check"><input type="checkbox" id="su-tpar" ${s.tpar ? "checked" : ""}> Report on the Taxable Payments Annual Report (TPAR)</label>
        <label class="check"><input type="checkbox" id="su-exempt" ${s.withholdingExempt ? "checked" : ""}> No-ABN withholding doesn't apply (for example, a hobbyist or private individual statement is held)</label>
        <div class="grid2">
          ${field({ id: "su-ins", label: "Insurance expires", value: s.insuranceExpiry || "", type: "date", hint: "Public liability / workers compensation for subcontractors" })}
          ${field({ id: "su-lic", label: "Licence expires", value: s.licenceExpiry || "", type: "date" })}
        </div></fieldset>
      <div class="fld"><label for="su-notes">Notes</label><textarea id="su-notes" rows="3" maxlength="2000">${safe(s.notes || "")}</textarea></div>
      ${id ? `<label class="check"><input type="checkbox" id="su-archived" ${s.status === "archived" ? "checked" : ""}> Archived</label>` : ""}
      <div class="actions"><button class="btn primary" type="submit">Save supplier</button><a class="btn" href="#/suppliers${id ? `/${id}` : ""}">Cancel</a></div>
    </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-sup]")) return;
    e.preventDefault();
    clearErrors(view);
    const v = x => view.querySelector(`#${x}`).value.trim();
    const ck = x => view.querySelector(`#${x}`)?.checked === true;
    if (v("su-name").length < 2) return fieldError(view, "su-name", "Enter the supplier's name.");
    if (v("su-abn") && !validAbn(v("su-abn"))) return fieldError(view, "su-abn", "That ABN isn't valid. Check the 11 digits.");
    if (v("su-email") && !validEmail(v("su-email"))) return fieldError(view, "su-email", "That email address doesn't look right.");
    try {
      const r = await call("supplier_save", {
        id, name: v("su-name"), tradingName: v("su-trading"), abn: v("su-abn"), tradeType: v("su-trade"), contactName: v("su-contact"), email: v("su-email"), phone: v("su-phone"),
        termsDays: v("su-terms"), address: readAddress(view, "su-addr"), expenseAccountId: v("su-acc"), taxCodeId: v("su-tax"), gstRegistered: ck("su-gst"),
        subcontractor: ck("su-sub"), tpar: ck("su-tpar"), withholdingExempt: ck("su-exempt"), insuranceExpiry: v("su-ins"), licenceExpiry: v("su-lic"), notes: v("su-notes"),
        status: ck("su-archived") ? "archived" : "active"
      });
      location.hash = `#/suppliers/${r.id}`;
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function detail(view, id, ctx) {
  const load = async () => {
    const d = await call("supplier_get", { id });
    const s = d.supplier;
    const owing = d.bills.filter(b => b.status === "approved").reduce((t, b) => t + Math.round((b.kind === "bill" ? b.owing : -b.owing) * 100), 0) / 100;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PURCHASES · SUPPLIERS</p><h1>${safe(s.name)} ${s.subcontractor ? chip("Subcontractor", "info") : ""} ${s.status === "archived" ? chip("Archived") : ""}</h1>
        <p class="muted">${s.abn ? `ABN ${safe(formatAbn(s.abn))}` : '<span class="bad-text">No ABN quoted</span>'}${s.tradeType ? ` · ${safe(s.tradeType)}` : ""}${addressText(s.address) ? ` · ${safe(addressText(s.address))}` : ""}</p></div>
        <div class="actions tight">${d.can.manage ? `<a class="btn" href="#/suppliers/${safe(id)}/edit">Edit</a><a class="btn primary" href="#/bills/new?supplier=${safe(id)}">Enter a bill</a>` : ""}
          ${ctx.can("purchases.raise") || d.can.manage ? `<a class="btn" href="#/purchase-orders/new?supplier=${safe(id)}">New purchase order</a>` : ""}</div></header>
      ${!s.abn && !s.withholdingExempt ? '<p class="note">This supplier has no ABN on file. When a bill over $75 (ex GST) is approved, 47% is withheld and recorded as owing to the ATO; only the rest is paid to the supplier. Ask them for their ABN.</p>' : ""}
      <div class="cards figures">
        <section class="card"><h2>Owing to them</h2><p class="big mono">${money(owing)}</p></section>
        <section class="card"><h2>Insurance</h2><p>${s.insuranceExpiry ? date(s.insuranceExpiry) : "Not recorded"}</p><h2>Licence</h2><p>${s.licenceExpiry ? date(s.licenceExpiry) : "Not recorded"}</p></section>
        <section class="card"><h2>Pay to</h2>${s.bank ? `<p class="mono">${safe(s.bank.accountName || "")}<br>BSB ${safe(s.bank.bsb)} · ${safe(s.bank.accountNumber)}</p><p class="muted small">Changed ${date(s.bank.changedAt)}</p>` : '<p class="muted">No bank details</p>'}
          ${s.bankChangePending ? `<p>${chip("Change waiting for approval", "pending")}</p>` : d.can.manage ? '<button type="button" class="link" data-bank>Change bank details</button>' : ""}</section>
      </div>
      <form class="panel hidden" data-bank-form novalidate><h2>New bank details</h2>
        <p class="muted small">Only change bank details after confirming them with the supplier by phone, on a number you already have. Never act on an emailed request alone. Someone else must approve the change before it is used.</p>
        <div class="grid3">${field({ id: "bk-name", label: "Account name", attrs: 'maxlength="120"' })}${field({ id: "bk-bsb", label: "BSB", attrs: 'inputmode="numeric" maxlength="7"' })}${field({ id: "bk-acct", label: "Account number", attrs: 'inputmode="numeric" maxlength="12"' })}</div>
        <div class="actions"><button class="btn primary" type="submit">Request approval</button><button class="btn" type="button" data-bank-cancel>Cancel</button></div></form>
      <section class="panel"><h2>Bills</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Bill</th><th scope="col">Their reference</th><th scope="col">Date</th><th scope="col">Due</th>
        <th scope="col">Status</th><th scope="col" class="num">Total</th><th scope="col" class="num">Owing</th></tr></thead><tbody>
        ${d.bills.map(b => `<tr><td class="mono"><a href="#/bills/${safe(b.id)}">${safe(b.number)}</a>${b.kind === "credit_note" ? "<small>Credit</small>" : ""}</td><td>${safe(b.supplierReference || "—")}</td>
          <td>${date(b.date)}</td><td>${date(b.dueDate)}</td><td>${statusChip(BILL_STATUS, b.status)}</td><td class="num mono">${money(b.total)}</td><td class="num mono">${money(b.owing, { blankZero: true })}</td></tr>`).join("")
          || '<tr><td colspan="7" class="muted">No bills yet.</td></tr>'}</tbody></table></div></section>
      ${d.purchaseOrders.length ? `<section class="panel"><h2>Purchase orders</h2><table class="tbl"><thead><tr><th scope="col">Number</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead><tbody>
        ${d.purchaseOrders.map(p => `<tr><td class="mono"><a href="#/purchase-orders/${safe(p.id)}">${safe(p.number)}</a></td><td>${date(p.date)}</td><td>${statusChip(PO_STATUS, p.status)}</td><td class="num mono">${money(p.total)}</td></tr>`).join("")}
      </tbody></table></section>` : ""}
      ${d.payments.length ? `<section class="panel"><h2>Payments</h2><table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Status</th><th scope="col" class="num">Amount</th></tr></thead><tbody>
        ${d.payments.map(p => `<tr><td><a href="#/supplier-payments/${safe(p.id)}">${date(p.date)}</a></td><td>${safe(p.reference || "—")}</td><td>${p.status === "void" ? chip("Void") : chip("Paid", "good")}</td><td class="num mono">${money(p.amount)}</td></tr>`).join("")}
      </tbody></table></section>` : ""}
      ${attachmentsPanel(d.attachments, d.can.manage, "supplier", id)}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  wireAttachments(view, load);
  view.addEventListener("click", e => {
    if (e.target.closest("[data-bank]")) { view.querySelector("[data-bank-form]").classList.remove("hidden"); view.querySelector("#bk-name").focus(); }
    if (e.target.closest("[data-bank-cancel]")) view.querySelector("[data-bank-form]").classList.add("hidden");
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-bank-form]")) return;
    e.preventDefault();
    clearErrors(view);
    const v = x => view.querySelector(`#${x}`).value.trim();
    if (!validBsb(v("bk-bsb"))) return fieldError(view, "bk-bsb", "A BSB is 6 digits, like 062-000.");
    if (!validAccountNumber(v("bk-acct"))) return fieldError(view, "bk-acct", "An account number is 5 to 10 digits.");
    try {
      await call("supplier_bank_request", { supplierId: id, accountName: v("bk-name"), bsb: v("bk-bsb"), accountNumber: v("bk-acct") });
      await load();
      flash(view, "Sent for approval. The new details are used once someone else approves them.", "good");
      ctx.refreshCounts?.();
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
