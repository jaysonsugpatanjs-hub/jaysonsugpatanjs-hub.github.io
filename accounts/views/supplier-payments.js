// Payments to suppliers. Only approved bills can be paid. Routes:
// #/supplier-payments, #/supplier-payments/new[?supplier=&bill=], #/supplier-payments/<id>
import { call, chip, date, flash, friendlyError, hashParams, money, options, parseMoney, safe, today } from "../lib/ui.js";
import { METHODS } from "../lib/docs.js";

export async function renderSupplierPayments(view, ctx) {
  const [id] = (ctx.sub || "").split("/");
  if (id === "new") return record(view);
  if (id) return detail(view, id);
  return list(view);
}

async function list(view) {
  const [setup, d] = await Promise.all([call("purchases_setup"), call("supplier_payments_list")]);
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">PURCHASES</p><h1>Supplier payments</h1>
      <p class="muted">Record payments after they leave the bank. Bank file (ABA) exports arrive with banking in Phase 6.</p></div>
      ${setup.can.bank ? '<a class="btn primary" href="#/supplier-payments/new">Pay bills</a>' : ""}</header>
    <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">Supplier</th><th scope="col">Reference</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col" class="num">Amount</th></tr></thead><tbody>
      ${d.payments.map(p => `<tr><td class="nowrap"><a href="#/supplier-payments/${safe(p.id)}">${date(p.date)}</a></td><td>${safe(p.supplier)}</td><td>${safe(p.reference || "—")}</td>
        <td>${safe(METHODS.find(m => m[0] === p.method)?.[1] || p.method)}</td><td>${p.status === "void" ? chip("Void") : chip("Paid", "good")}</td><td class="num mono">${money(p.amount)}</td></tr>`).join("")
        || '<tr><td colspan="6" class="muted">No payments yet.</td></tr>'}
    </tbody></table></div></section>`;
}

async function record(view) {
  const setup = await call("purchases_setup");
  const p = hashParams();
  const st = { supplierId: p.get("supplier") || "", date: today(), bankAccountId: setup.bankAccounts[0]?.id || "", reference: "", method: "bank_transfer", bills: [], pay: {}, supplier: null };
  const focus = p.get("bill");
  const loadBills = async () => {
    st.pay = {};
    if (!st.supplierId) { st.bills = []; st.supplier = null; return; }
    const [bills, sup] = await Promise.all([call("bills_list", { kind: "bill", view: "unpaid", supplierId: st.supplierId }), call("supplier_get", { id: st.supplierId })]);
    st.bills = bills.bills;
    st.supplier = sup.supplier;
    if (focus && st.bills.some(b => b.id === focus)) st.pay[focus] = st.bills.find(b => b.id === focus).owing.toFixed(2);
  };
  const draw = () => {
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PURCHASES · PAYMENTS</p><h1>Pay bills</h1>
        <p class="muted">Choose the supplier and how much of each approved bill was paid. Bills waiting for approval aren't listed and can't be paid.</p></div></header>
      <form class="panel" data-pay novalidate>
        <div class="grid3">
          <div class="fld"><label for="sp-sup">Supplier <span class="req" aria-hidden="true">*</span></label><select id="sp-sup">${options([["", "Choose a supplier…"], ...setup.suppliers.map(s => [s.id, s.name])], st.supplierId)}</select></div>
          <div class="fld"><label for="sp-date">Payment date</label><input id="sp-date" type="date" value="${safe(st.date)}"></div>
          <div class="fld"><label for="sp-bank">Paid from</label><select id="sp-bank">${options(setup.bankAccounts.map(a => [a.id, `${a.code} ${a.name}`]), st.bankAccountId)}</select></div>
          <div class="fld"><label for="sp-method">Method</label><select id="sp-method">${options(METHODS, st.method)}</select></div>
          <div class="fld"><label for="sp-ref">Reference</label><input id="sp-ref" value="${safe(st.reference)}" maxlength="120"></div>
        </div>
        ${st.supplier ? `<p class="muted small">${st.supplier.bank ? `Pay to ${safe(st.supplier.bank.accountName || "")} · BSB ${safe(st.supplier.bank.bsb)} · ${safe(st.supplier.bank.accountNumber)}` : "No bank details on file for this supplier."}</p>` : ""}
        ${st.supplierId ? (st.bills.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Bill</th><th scope="col">Their reference</th><th scope="col">Due</th><th scope="col" class="num">Owing</th><th scope="col" class="num">Pay</th></tr></thead><tbody>
          ${st.bills.map(b => `<tr><td class="mono">${safe(b.number)}</td><td>${safe(b.supplierReference || "—")}</td><td>${date(b.dueDate)}${b.overdue ? ` ${chip("Overdue", "bad")}` : ""}</td>
            <td class="num mono">${money(b.owing)}${b.withholding ? `<small>after ${money(b.withholding)} withheld</small>` : ""}</td>
            <td class="num"><input class="num apply" data-bill="${safe(b.id)}" inputmode="decimal" aria-label="Amount paid on ${safe(b.number)}" value="${safe(st.pay[b.id] || "")}"></td></tr>`).join("")}
          </tbody></table></div><button type="button" class="link" data-all>Pay all in full</button><p class="balance" data-total></p>`
          : '<p class="muted">No approved bills are owing to this supplier.</p>') : ""}
        <div class="actions"><button class="btn primary" type="submit">Record payment</button><a class="btn" href="#/supplier-payments">Cancel</a></div>
      </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
    total();
  };
  const read = () => {
    st.supplierId = view.querySelector("#sp-sup").value;
    st.date = view.querySelector("#sp-date").value;
    st.bankAccountId = view.querySelector("#sp-bank").value;
    st.method = view.querySelector("#sp-method").value;
    st.reference = view.querySelector("#sp-ref").value;
    view.querySelectorAll("[data-bill]").forEach(el => { st.pay[el.dataset.bill] = el.value; });
  };
  const total = () => {
    const el = view.querySelector("[data-total]");
    if (!el) return;
    read();
    let sum = 0, bad = false;
    for (const b of st.bills) {
      const v = parseMoney(st.pay[b.id]);
      const wrong = Number.isNaN(v) || v > b.owing;
      view.querySelector(`[data-bill="${b.id}"]`)?.classList.toggle("invalid", wrong);
      if (wrong) bad = true; else sum += Math.round(v * 100);
    }
    el.className = `balance ${bad ? "bad" : ""}`;
    el.textContent = bad ? "An amount is not valid or is more than the bill owes." : `Total payment ${money(sum / 100)}`;
  };
  await loadBills();
  draw();
  view.addEventListener("input", e => { if (e.target.matches("[data-bill]")) total(); });
  view.addEventListener("change", async e => {
    if (e.target.id !== "sp-sup") return;
    read();
    try { await loadBills(); } catch (error) { flash(view, friendlyError(error), "bad"); }
    draw();
  });
  view.addEventListener("click", e => {
    if (!e.target.closest("[data-all]")) return;
    read();
    st.bills.forEach(b => { st.pay[b.id] = b.owing.toFixed(2); });
    draw();
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-pay]")) return;
    e.preventDefault();
    read();
    if (!st.supplierId) return flash(view, "Choose the supplier.", "bad");
    if (view.querySelector(".invalid")) return flash(view, "Fix the highlighted amounts first.", "bad");
    const allocations = Object.entries(st.pay).filter(([, v]) => parseMoney(v) > 0).map(([billId, v]) => ({ billId, amount: parseMoney(v) }));
    if (!allocations.length) return flash(view, "Enter how much was paid on at least one bill.", "bad");
    const button = view.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const r = await call("supplier_payment_record", { supplierId: st.supplierId, date: st.date, bankAccountId: st.bankAccountId, reference: st.reference, method: st.method, allocations });
      location.hash = `#/supplier-payments/${r.id}`;
    } catch (error) {
      button.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
}

async function detail(view, id) {
  const load = async () => {
    const d = await call("supplier_payment_get", { id });
    const p = d.payment;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PURCHASES · PAYMENT</p><h1>${money(p.amount)} to ${safe(p.supplier)} ${p.status === "void" ? chip("Void") : chip("Paid", "good")}</h1>
        <p class="muted">${date(p.date)} · ${safe(p.reference || "No reference")}</p></div><a class="btn" href="#/suppliers/${safe(p.supplierId)}">Supplier</a></header>
      <section class="panel">
        <dl class="facts"><dt>Paid from</dt><dd>${safe(p.bank || "—")}</dd><dt>Method</dt><dd>${safe(METHODS.find(m => m[0] === p.method)?.[1] || p.method)}</dd>
          ${p.payTo ? `<dt>Supplier account</dt><dd class="mono">${safe(p.payTo.accountName || "")} · ${safe(p.payTo.bsb)} · ${safe(p.payTo.accountNumber)}</dd>` : ""}
          <dt>Recorded by</dt><dd>${safe(p.createdBy || "—")}</dd>
          ${p.journal ? `<dt>Ledger</dt><dd><a href="#/journals/${safe(p.journal.id)}">${safe(p.journal.number)}</a>${p.voidJournal ? ` · reversed by <a href="#/journals/${safe(p.voidJournal.id)}">${safe(p.voidJournal.number)}</a>` : ""}</dd>` : ""}
          ${p.voidReason ? `<dt>Void reason</dt><dd>${safe(p.voidReason)}</dd>` : ""}</dl>
        <table class="tbl"><thead><tr><th scope="col">Bill</th><th scope="col">Their reference</th><th scope="col" class="num">Paid</th></tr></thead><tbody>
          ${d.allocations.map(a => `<tr class="${a.voided ? "inactive" : ""}"><td class="mono"><a href="#/bills/${safe(a.billId)}">${safe(a.number)}</a></td><td>${safe(a.supplierReference || "—")}</td><td class="num mono">${money(a.amount)}</td></tr>`).join("")}
        </tbody></table>
        ${d.can.void ? '<div class="actions"><button type="button" class="btn danger" data-void>Void payment</button></div>' : ""}
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("click", async e => {
    if (!e.target.closest("[data-void]")) return;
    const reason = window.prompt("Void this payment? The bank entry is reversed and the bills go back to unpaid. Reason:", "");
    if (reason === null) return;
    try { await call("supplier_payment_void", { id, reason }); await load(); flash(view, "Payment voided.", "good"); }
    catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
