// Customer payments (receipts). Routes: #/receipts, #/receipts/new[?customer=&invoice=],
// #/receipts/<id>. A receipt posts Dr bank, Cr Accounts Receivable, and is
// applied to invoices; anything not applied stays as a credit for the customer.
import { call, chip, date, flash, friendlyError, hashParams, money, options, parseMoney, safe, today } from "../lib/ui.js";
import { METHODS } from "../lib/docs.js";
import { allocateOldestFirst } from "../lib/validate.js";

export async function renderReceipts(view, ctx) {
  const [id] = (ctx.sub || "").split("/");
  if (id === "new") return record(view);
  if (id) return detail(view, id);
  return list(view);
}

async function list(view) {
  const [setup, d] = await Promise.all([call("sales_setup"), call("receipts_list")]);
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">SALES</p><h1>Payments received</h1>
      <p class="muted">Money customers have paid in. Each payment is banked to the ledger and applied to their invoices.</p></div>
      ${setup.can.bank ? '<a class="btn primary" href="#/receipts/new">Record a payment</a>' : ""}</header>
    <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">Reference</th><th scope="col">Method</th>
      <th scope="col">Status</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Not applied</th></tr></thead><tbody>
      ${d.receipts.map(r => `<tr><td class="nowrap"><a href="#/receipts/${safe(r.id)}">${date(r.date)}</a></td><td>${safe(r.customer)}</td><td>${safe(r.reference || "—")}</td>
        <td>${safe(METHODS.find(m => m[0] === r.method)?.[1] || r.method)}</td><td>${r.status === "void" ? chip("Void") : chip("Banked", "good")}</td>
        <td class="num mono">${money(r.amount)}</td><td class="num mono">${money(r.unallocated, { blankZero: true })}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No payments recorded yet.</td></tr>'}
    </tbody></table></div></section>`;
}

async function record(view) {
  const setup = await call("sales_setup");
  const p = hashParams();
  const st = { customerId: p.get("customer") || "", date: today(), amount: "", bankAccountId: setup.bankAccounts[0]?.id || "", reference: "", method: "bank_transfer", invoices: [], applied: {} };
  const focusInvoice = p.get("invoice");

  const loadInvoices = async () => {
    st.invoices = st.customerId ? (await call("invoices_list", { kind: "invoice", view: "unpaid", customerId: st.customerId })).invoices.sort((a, b) => a.dueDate.localeCompare(b.dueDate)) : [];
    st.applied = {};
    if (focusInvoice && st.invoices.some(i => i.id === focusInvoice)) {
      const inv = st.invoices.find(i => i.id === focusInvoice);
      st.applied[inv.id] = inv.owing.toFixed(2);
      if (!st.amount) st.amount = inv.owing.toFixed(2);
    }
  };
  const draw = () => {
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">SALES · PAYMENTS</p><h1>Record a payment</h1>
        <p class="muted">Enter what arrived in the bank, then say which invoices it pays. Anything left over is kept as a credit for the customer.</p></div></header>
      <form class="panel" data-receipt novalidate>
        <div class="grid3">
          <div class="fld"><label for="r-cust">Customer <span class="req" aria-hidden="true">*</span></label><select id="r-cust">${options([["", "Choose a customer…"], ...setup.customers.map(c => [c.id, c.name])], st.customerId)}</select></div>
          <div class="fld"><label for="r-date">Date received</label><input id="r-date" type="date" value="${safe(st.date)}"></div>
          <div class="fld"><label for="r-amt">Amount received ($) <span class="req" aria-hidden="true">*</span></label><input id="r-amt" class="num" inputmode="decimal" value="${safe(st.amount)}"></div>
          <div class="fld"><label for="r-bank">Paid into</label><select id="r-bank">${options(setup.bankAccounts.map(a => [a.id, `${a.code} ${a.name}`]), st.bankAccountId)}</select></div>
          <div class="fld"><label for="r-method">Method</label><select id="r-method">${options(METHODS, st.method)}</select></div>
          <div class="fld"><label for="r-ref">Reference</label><input id="r-ref" value="${safe(st.reference)}" maxlength="120" placeholder="As shown on the bank statement"></div>
        </div>
        ${st.customerId ? `<h2>Apply to invoices</h2>
          ${st.invoices.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th scope="col">Due</th><th scope="col" class="num">Owing</th><th scope="col" class="num">Apply</th></tr></thead><tbody>
            ${st.invoices.map(i => `<tr><td class="mono">${safe(i.number)}${i.reference ? `<small>${safe(i.reference)}</small>` : ""}</td><td>${date(i.date)}</td><td>${date(i.dueDate)}${i.overdue ? ` ${chip("Overdue", "bad")}` : ""}</td>
              <td class="num mono">${money(i.owing)}</td><td class="num"><input class="num apply" data-apply="${safe(i.id)}" inputmode="decimal" aria-label="Amount applied to ${safe(i.number)}" value="${safe(st.applied[i.id] || "")}"></td></tr>`).join("")}
          </tbody></table></div><button type="button" class="link" data-auto>Apply oldest first</button>` : '<p class="muted">This customer has no unpaid invoices. The whole payment will be kept as a credit.</p>'}
          <p class="balance" data-left></p>` : ""}
        <div class="actions"><button class="btn primary" type="submit">Record payment</button><a class="btn" href="#/receipts">Cancel</a></div>
      </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
    left();
  };
  const read = () => {
    st.customerId = view.querySelector("#r-cust").value;
    st.date = view.querySelector("#r-date").value;
    st.amount = view.querySelector("#r-amt").value;
    st.bankAccountId = view.querySelector("#r-bank").value;
    st.method = view.querySelector("#r-method").value;
    st.reference = view.querySelector("#r-ref").value;
    view.querySelectorAll("[data-apply]").forEach(el => { st.applied[el.dataset.apply] = el.value; });
  };
  const left = () => {
    const el = view.querySelector("[data-left]");
    if (!el) return;
    read();
    const amt = parseMoney(st.amount);
    let applied = 0, bad = false;
    for (const i of st.invoices) {
      const v = parseMoney(st.applied[i.id]);
      const input = view.querySelector(`[data-apply="${i.id}"]`);
      const wrong = Number.isNaN(v) || v > i.owing;
      input?.classList.toggle("invalid", wrong);
      if (wrong) bad = true; else applied += Math.round(v * 100);
    }
    const rest = Math.round((Number.isNaN(amt) ? 0 : amt) * 100) - applied;
    el.className = `balance ${bad || rest < 0 ? "bad" : ""}`;
    el.textContent = bad ? "An applied amount is not valid or is more than the invoice owes."
      : rest < 0 ? `You've applied ${money(-rest / 100)} more than was received.`
      : `Applied ${money(applied / 100)}${rest > 0 ? ` · ${money(rest / 100)} kept as a credit` : ""}`;
  };

  await loadInvoices();
  draw();
  view.addEventListener("input", e => { if (e.target.matches("[data-apply], #r-amt")) left(); });
  view.addEventListener("change", async e => {
    if (e.target.id !== "r-cust") return;
    read();
    try { await loadInvoices(); } catch (error) { flash(view, friendlyError(error), "bad"); }
    draw();
  });
  view.addEventListener("click", e => {
    if (!e.target.closest("[data-auto]")) return;
    read();
    const amt = parseMoney(st.amount);
    if (Number.isNaN(amt) || !amt) return flash(view, "Enter the amount received first.", "bad");
    const plan = allocateOldestFirst(st.invoices, amt);
    st.applied = Object.fromEntries(st.invoices.map(i => [i.id, plan[i.id] ? plan[i.id].toFixed(2) : ""]));
    draw();
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-receipt]")) return;
    e.preventDefault();
    read();
    const amt = parseMoney(st.amount);
    if (!st.customerId) return flash(view, "Choose the customer.", "bad");
    if (Number.isNaN(amt) || amt <= 0) return flash(view, "Enter the amount received, in dollars and cents.", "bad");
    if (view.querySelector(".invalid") || view.querySelector("[data-left].bad")) return flash(view, "Fix the amounts applied first.", "bad");
    const button = view.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const r = await call("receipt_record", { customerId: st.customerId, date: st.date, amount: amt, bankAccountId: st.bankAccountId, reference: st.reference, method: st.method,
        allocations: Object.entries(st.applied).filter(([, v]) => parseMoney(v) > 0).map(([invoiceId, v]) => ({ invoiceId, amount: parseMoney(v) })) });
      location.hash = `#/receipts/${r.id}`;
    } catch (error) {
      button.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
}

async function detail(view, id) {
  const load = async () => {
    const d = await call("receipt_get", { id });
    const r = d.receipt;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">SALES · PAYMENT RECEIVED</p><h1>${money(r.amount)} from ${safe(r.customer)} ${r.status === "void" ? chip("Void") : chip("Banked", "good")}</h1>
        <p class="muted">${date(r.date)} · ${safe(r.reference || "No reference")}</p></div><a class="btn" href="#/customers/${safe(r.customerId)}">Customer</a></header>
      <section class="panel">
        <dl class="facts"><dt>Paid into</dt><dd>${safe(r.bank || "—")}</dd><dt>Method</dt><dd>${safe(METHODS.find(m => m[0] === r.method)?.[1] || r.method)}</dd>
          <dt>Recorded by</dt><dd>${safe(r.createdBy || "—")}</dd>
          ${r.journal ? `<dt>Ledger</dt><dd><a href="#/journals/${safe(r.journal.id)}">${safe(r.journal.number)}</a>${r.voidJournal ? ` · reversed by <a href="#/journals/${safe(r.voidJournal.id)}">${safe(r.voidJournal.number)}</a>` : ""}</dd>` : ""}
          ${r.voidReason ? `<dt>Void reason</dt><dd>${safe(r.voidReason)}</dd>` : ""}
          <dt>Not yet applied</dt><dd class="mono">${money(r.unallocated)}</dd></dl>
        <h2>Applied to</h2>
        ${d.allocations.length ? `<table class="tbl"><thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th scope="col" class="num">Amount</th></tr></thead><tbody>
          ${d.allocations.map(a => `<tr class="${a.voided ? "inactive" : ""}"><td class="mono"><a href="#/invoices/${safe(a.invoiceId)}">${safe(a.number)}</a>${a.voided ? " <small>Removed when the payment was voided</small>" : ""}</td><td>${date(a.date)}</td><td class="num mono">${money(a.amount)}</td></tr>`).join("")}</tbody></table>`
          : '<p class="muted small">Not applied to any invoice.</p>'}
        ${d.can.allocate && d.openInvoices.length ? `<h3>Apply the credit</h3><form class="toolbar" data-allocate>
          <div class="fld"><label for="al-inv">Invoice</label><select id="al-inv">${options(d.openInvoices.map(i => [i.id, `${i.number} · ${money(i.owing)} owing`]))}</select></div>
          <div class="fld"><label for="al-amt">Amount</label><input id="al-amt" inputmode="decimal" value="${safe(Math.min(r.unallocated, d.openInvoices[0].owing).toFixed(2))}"></div>
          <button class="btn" type="submit">Apply</button></form>` : ""}
        ${d.can.void ? '<div class="actions"><button type="button" class="btn danger" data-void>Void payment</button></div>' : ""}
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-allocate]")) return;
    e.preventDefault();
    try {
      await call("receipt_allocate", { paymentId: id, invoiceId: view.querySelector("#al-inv").value, amount: view.querySelector("#al-amt").value });
      await load();
      flash(view, "Applied.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    if (!e.target.closest("[data-void]")) return;
    const reason = window.prompt("Void this payment? Use this if it was entered by mistake or the payment bounced. The bank entry is reversed and the invoices go back to unpaid. Reason:", "");
    if (reason === null) return;
    try {
      await call("receipt_void", { id, reason });
      await load();
      flash(view, "Payment voided.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
