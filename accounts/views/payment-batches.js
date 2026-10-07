// Paying approved bills by bank file (ABA). A batch is made, approved by a
// second person, the file is downloaded and uploaded to the bank, and once
// the bank has paid it is marked as paid (one supplier payment each).
// Routes: #/payment-batches, #/payment-batches/new, #/payment-batches/<id>
import { call, chip, date, dateTime, field, flash, friendlyError, money, options, safe, today } from "../lib/ui.js";

const STATUS = { draft: ["Waiting for approval", "pending"], approved: ["Approved", "info"], paid: ["Paid", "good"], cancelled: ["Cancelled", ""] };

function downloadText(fileName, content) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

export async function renderPaymentBatches(view, ctx) {
  const [id] = (ctx.sub || "").split("/");
  if (id === "new") return create(view, ctx);
  if (id) return detail(view, ctx, id);
  const d = await call("payment_batches_list");
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">BANKING</p><h1>Payment batches</h1>
      <p class="muted">Pay approved bills with one bank file. Someone other than the person who makes a batch approves it before the file can be downloaded.</p></div>
      <a class="btn primary" href="#/payment-batches/new">New batch</a></header>
    <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Batch</th><th scope="col">Pay on</th><th scope="col">From</th><th scope="col">Bills</th>
      <th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead><tbody>
      ${d.batches.map(b => `<tr><td><a href="#/payment-batches/${safe(b.id)}"><strong>${safe(b.number)}</strong></a><small>${safe(b.by)}</small></td><td>${date(b.date)}</td><td>${safe(b.source)}</td>
        <td>${b.count}</td><td>${chip(...STATUS[b.status])}${b.status === "draft" && !b.mine ? " " + chip("For you to approve", "pending") : ""}</td><td class="num mono">${money(b.total)}</td></tr>`).join("")
        || '<tr><td colspan="6" class="muted">No batches yet.</td></tr>'}
    </tbody></table></div></section>`;
}

async function create(view) {
  const o = await call("payment_batch_options");
  const ready = o.sources.filter(s => s.ready);
  const st = { pick: new Set(), amounts: {}, due: "" };
  const draw = () => {
    const shown = o.bills.filter(b => !st.due || b.due <= st.due);
    const total = [...st.pick].reduce((t, id) => t + Math.round(Number(st.amounts[id] ?? o.bills.find(b => b.id === id).owing) * 100), 0) / 100;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">BANKING</p><h1>New payment batch</h1>
        <p class="muted">Bills need an approved supplier bank account. The bank details are copied now and checked again when the batch is approved.</p></div>
        <a class="btn" href="#/payment-batches">Back</a></header>
      ${ready.length ? "" : '<p class="note">No company bank account is set up for bank files yet. Add the APCA user ID, bank code and user name in <a href="#/bank-accounts">Bank accounts</a>.</p>'}
      <form class="panel" data-batch>
        <div class="grid3">
          <div class="fld"><label for="pb-src">Pay from</label><select id="pb-src">${options(ready.map(s => [s.id, `${s.nickname} (${s.bsb} ${s.accountNumber})`]))}</select></div>
          ${field({ id: "pb-date", label: "Payment date", type: "date", value: st.date || today() })}
          ${field({ id: "pb-desc", label: "Description on the bank file", value: st.desc || "SUPPLIERS", attrs: 'maxlength="12"', hint: "Up to 12 letters or numbers" })}
          ${field({ id: "pb-due", label: "Show bills due by", type: "date", value: st.due })}
        </div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col"></th><th scope="col">Bill</th><th scope="col">Supplier</th><th scope="col">Due</th><th scope="col">Pay to</th>
          <th scope="col" class="num">Owing</th><th scope="col" class="num">Pay</th></tr></thead><tbody>
          ${shown.map(b => `<tr><td>${b.problem ? "" : `<input type="checkbox" data-pick="${safe(b.id)}" aria-label="Pay ${safe(b.number)}" ${st.pick.has(b.id) ? "checked" : ""}>`}</td>
            <td>${safe(b.number)}${b.reference ? `<small>${safe(b.reference)}</small>` : ""}</td><td>${safe(b.supplier)}</td><td class="nowrap ${b.due < today() ? "bad-text" : ""}">${date(b.due)}</td>
            <td>${b.problem ? `<span class="muted small">${safe(b.problem)}</span>` : `<span class="mono">${safe(b.payTo)}</span>`}</td><td class="num mono">${money(b.owing)}</td>
            <td class="num">${st.pick.has(b.id) ? `<input class="num" data-amt="${safe(b.id)}" inputmode="decimal" aria-label="Amount for ${safe(b.number)}" value="${safe(st.amounts[b.id] ?? b.owing.toFixed(2))}">` : ""}</td></tr>`).join("")
            || '<tr><td colspan="7" class="muted">No unpaid approved bills.</td></tr>'}
        </tbody></table></div>
        <p><strong>${st.pick.size} bill(s), ${money(total)}</strong></p>
        <div class="actions"><button class="btn primary" type="submit" ${st.pick.size && ready.length ? "" : "disabled"}>Make the batch</button></div>
      </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  const keep = () => {
    st.date = view.querySelector("#pb-date")?.value; st.desc = view.querySelector("#pb-desc")?.value;
  };
  draw();
  view.addEventListener("change", e => {
    const t = e.target;
    if (t.dataset.pick) { keep(); t.checked ? st.pick.add(t.dataset.pick) : st.pick.delete(t.dataset.pick); draw(); }
    else if (t.dataset.amt) { keep(); st.amounts[t.dataset.amt] = t.value.replace(/[$,\s]/g, ""); draw(); }
    else if (t.id === "pb-due") { keep(); st.due = t.value; draw(); }
  });
  view.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const r = await call("payment_batch_create", { sourceId: view.querySelector("#pb-src").value, date: view.querySelector("#pb-date").value, description: view.querySelector("#pb-desc").value,
        items: [...st.pick].map(id => ({ billId: id, amount: st.amounts[id] ?? null })) });
      location.hash = `#/payment-batches/${r.id}`;
    } catch (error) { btn.disabled = false; flash(view, friendlyError(error), "bad"); }
  });
}

async function detail(view, ctx, id) {
  const load = async () => {
    const d = await call("payment_batch_get", { id });
    const b = d.batch, c = d.can;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">BANKING</p><h1>Payment batch ${safe(b.number)} ${chip(...STATUS[b.status])}</h1>
        <p class="muted">Pay on ${date(b.date)} from ${safe(b.source.nickname)} (${safe(b.source.bsb)} ${safe(b.source.accountNumber)}) · "${safe(b.description)}"</p></div>
        <a class="btn" href="#/payment-batches">Back</a></header>
      <section class="panel">
        <ol class="steps">
          <li>Made by ${safe(b.createdBy)} ${dateTime(b.createdAt)}</li>
          <li>${b.approvedAt ? `Approved by ${safe(b.approvedBy)} ${dateTime(b.approvedAt)}` : b.status === "draft" ? "Waiting for someone else to approve" : "Not approved"}</li>
          <li>${b.downloadedAt ? `Bank file downloaded by ${safe(b.downloadedBy)} ${dateTime(b.downloadedAt)}` : "Bank file not downloaded yet"}</li>
          <li>${b.paidAt ? `Marked as paid by ${safe(b.paidBy)} ${dateTime(b.paidAt)}` : b.cancelledAt ? `Cancelled: ${safe(b.cancelReason)}` : "Mark as paid once the bank has processed the file"}</li>
        </ol>
        <div class="actions">
          ${c.approve ? '<button type="button" class="btn primary" data-act="approve">Approve</button>' : ""}
          ${b.status === "draft" && !c.approve ? '<span class="muted small">You made this batch, so someone else must approve it.</span>' : ""}
          ${c.download ? `<button type="button" class="btn ${b.status === "approved" && !b.downloadedAt ? "primary" : ""}" data-act="aba">Download bank file (ABA)</button>` : ""}
          ${c.markPaid ? '<button type="button" class="btn primary" data-act="paid">Mark as paid</button>' : ""}
          ${c.cancel ? '<button type="button" class="btn danger" data-act="cancel">Cancel batch</button>' : ""}
        </div>
      </section>
      <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Supplier</th><th scope="col">Bill</th><th scope="col">Account</th><th scope="col">Reference</th><th scope="col" class="num">Amount</th></tr></thead><tbody>
        ${d.items.map(i => `<tr><td>${safe(i.supplier)}</td><td><a href="#/bills/${safe(i.billId)}">${safe(i.bill)}</a>${i.supplierReference ? `<small>${safe(i.supplierReference)}</small>` : ""}</td>
          <td class="mono">${safe(i.accountName)}<small>${safe(i.bsb)} ${safe(i.accountNumber)}</small></td><td class="mono">${safe(i.reference)}</td><td class="num mono">${money(i.amount)}</td></tr>`).join("")}
        <tr><th scope="row" colspan="4">Total</th><td class="num mono"><strong>${money(b.total)}</strong></td></tr>
      </tbody></table></div></section>
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
    return d;
  };
  let d = await load();
  view.addEventListener("click", async e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    try {
      if (act === "approve") {
        if (!window.confirm(`Approve ${d.batch.number}: ${d.items.length} payment(s), ${money(d.batch.total)}? Check the bills and the bank details first.`)) return;
        await call("payment_batch_approve", { id }); d = await load(); flash(view, "Approved. The bank file can now be downloaded.", "good"); ctx.refreshCounts?.();
      } else if (act === "aba") {
        const f = await call("payment_batch_aba", { id });
        downloadText(f.fileName, f.content);
        d = await load();
        flash(view, `Downloaded ${f.fileName}: ${f.count} payment(s), ${money(f.total)}. Upload it in your bank's internet banking, then mark the batch as paid once the bank has processed it. The file holds bank details: delete it after uploading.`, "warn");
      } else if (act === "paid") {
        if (!window.confirm("Has the bank processed the file? This records a payment for each supplier from the bank account.")) return;
        await call("payment_batch_mark_paid", { id }); d = await load(); flash(view, "Marked as paid. The bills are paid.", "good");
      } else if (act === "cancel") {
        const reason = window.prompt(d.batch.downloadedAt ? "Cancel this batch? The bank file was downloaded: make sure it wasn't uploaded to the bank. Say why:" : "Cancel this batch? Say why:", "");
        if (reason === null) return;
        await call("payment_batch_cancel", { id, reason }); d = await load(); flash(view, "Cancelled.", "good");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
