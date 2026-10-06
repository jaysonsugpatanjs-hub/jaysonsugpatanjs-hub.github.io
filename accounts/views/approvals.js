// Approvals inbox: changes that need a second person.
import { call, chip, dateTime, flash, friendlyError, safe } from "../lib/ui.js";
import { formatBsb } from "../lib/validate.js";

const STATUS = { pending: ["Waiting", "pending"], approved: ["Approved", "good"], rejected: ["Rejected", "bad"], cancelled: ["Cancelled", ""] };

function details(a) {
  const v = a.newValue || {};
  if (a.kind === "company_bank_account") {
    return `<dl class="facts"><dt>Name</dt><dd>${safe(v.nickname)}</dd><dt>Account name</dt><dd>${safe(v.accountName)}</dd>
      <dt>BSB</dt><dd class="mono">${safe(formatBsb(v.bsb))}</dd><dt>Account number</dt><dd class="mono">${safe(v.accountNumber)}</dd>
      <dt>Used for</dt><dd>${safe(v.purpose)}${v.showOnInvoices ? " · shown on invoices" : ""}</dd></dl>
      <p class="note small">Before approving, confirm these details with the bank or the requester by phone, using a number you already know. Never approve from an email request alone.</p>`;
  }
  if (a.kind === "supplier_bank") {
    const was = a.previousValue || {};
    return `<dl class="facts"><dt>Account name</dt><dd>${safe(v.accountName || "—")}</dd>
      <dt>BSB</dt><dd class="mono">${safe(formatBsb(v.bsb))}</dd><dt>Account number</dt><dd class="mono">${safe(v.accountNumber)}</dd>
      ${was.bsb ? `<dt>Replaces</dt><dd class="mono">${safe(formatBsb(was.bsb))} · ${safe(was.accountNumber)}</dd>` : "<dt>Replaces</dt><dd>No bank details on file</dd>"}</dl>
      <p class="note small">Changed supplier bank details are the most common way businesses are defrauded. Phone the supplier on a number you already have (not one from the request or an email) and confirm the BSB and account number before approving.</p>`;
  }
  return "";
}

export async function renderApprovals(view, { refreshCounts }) {
  const load = async () => {
    const d = await call("approvals_list");
    const card = (a, mode) => {
      const [label, tone] = STATUS[a.status] || [a.status, ""];
      return `<article class="approval"><header><div><h3>${safe(a.title)}</h3>
          <p class="muted small">Requested by ${safe(a.requestedBy)} · ${dateTime(a.requestedAt)}${a.decidedBy ? ` · ${label.toLowerCase()} by ${safe(a.decidedBy)} ${dateTime(a.decidedAt)}` : ""}</p></div>${chip(label, tone)}</header>
        ${mode === "decide" ? details(a) : ""}
        ${a.comment ? `<p class="small">Comment: ${safe(a.comment)}</p>` : ""}
        ${mode === "decide" ? `<div class="actions"><button type="button" class="btn primary" data-approve="${safe(a.id)}">Approve</button><button type="button" class="btn danger" data-reject="${safe(a.id)}">Reject</button></div>` : ""}
        ${mode === "mine" && a.status === "pending" ? `<div class="actions"><button type="button" class="link" data-cancel="${safe(a.id)}">Cancel request</button></div>` : ""}
      </article>`;
    };
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ADMINISTRATION</p><h1>Approvals</h1>
        <p class="muted">Some changes need a second person: you can never approve your own request. Every decision is recorded with the previous and new values.</p></div></header>
      <section class="panel"><h2>Waiting for you (${d.toDecide.length})</h2>${d.toDecide.map(a => card(a, "decide")).join("") || '<p class="muted">Nothing waiting for you.</p>'}</section>
      <section class="panel"><h2>Your requests</h2>${d.mine.map(a => card(a, "mine")).join("") || '<p class="muted">You have not requested anything.</p>'}</section>
      ${d.recent.length ? `<section class="panel"><h2>Recent decisions</h2>${d.recent.map(a => card(a, "view")).join("")}</section>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();

  view.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.approve) {
        const comment = window.prompt("Approve this change? Add a note for the record (for example, how you checked it):", "");
        if (comment === null) return;
        b.disabled = true;
        await call("approval_decide", { approvalId: b.dataset.approve, approve: true, comment });
        await load();
        flash(view, "Approved.", "good");
      } else if (b.dataset.reject) {
        const comment = window.prompt("Reject this change? Give a reason; the requester will see it:", "");
        if (comment === null) return;
        b.disabled = true;
        await call("approval_decide", { approvalId: b.dataset.reject, approve: false, comment });
        await load();
        flash(view, "Rejected.", "good");
      } else if (b.dataset.cancel) {
        b.disabled = true;
        await call("approval_cancel", { approvalId: b.dataset.cancel });
        await load();
        flash(view, "Request cancelled.", "good");
      } else return;
      refreshCounts();
    } catch (error) {
      b.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
}
