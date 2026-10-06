// Leave requests (approvers) and My pay (every employee: payslips, leave
// balances, leave requests). Routes: #/leave, #/my-pay
import { call, chip, date, dateTime, field, flash, friendlyError, money, options, safe, today } from "../lib/ui.js";
import { downloadPdf } from "../lib/docs.js";

const STATUS = { submitted: ["Waiting", "pending"], approved: ["Approved", "good"], rejected: ["Declined", "bad"], cancelled: ["Cancelled", ""], paid: ["Taken and paid", "info"] };
const hrs = h => Number(h).toLocaleString("en-AU", { maximumFractionDigits: 2 });

export async function renderLeave(view, ctx) {
  const st = { status: "submitted" };
  const [setup, people] = await Promise.all([call("payroll_setup"), ctx.can("leave.approve") ? call("payroll_employees", {}) : Promise.resolve({ employees: [] })]);
  const load = async () => {
    const d = await call("leave_list", st);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PAYROLL</p><h1>Leave</h1>
        <p class="muted">Approved leave is paid in the next pay run and taken off the balance then. You can't approve your own leave.</p></div></header>
      <section class="panel">
        <div class="tabs" role="tablist">${Object.entries(STATUS).map(([k, [l]]) => `<button type="button" role="tab" aria-selected="${k === st.status}" class="${k === st.status ? "on" : ""}" data-st="${k}">${l}</button>`).join("")}</div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Employee</th><th scope="col">Leave</th><th scope="col">Dates</th><th scope="col" class="num">Hours</th>
          ${st.status === "submitted" ? '<th scope="col" class="num">Balance now</th><th scope="col"></th>' : '<th scope="col">Decided</th>'}</tr></thead><tbody>
          ${d.requests.map(r => `<tr><td><a href="#/employees/${safe(r.employeeId)}">${safe(r.employee)}</a>${r.mine ? " <small>You</small>" : ""}${r.reason ? `<small>${safe(r.reason)}</small>` : ""}</td>
            <td>${safe(r.type)}</td><td class="nowrap">${date(r.start)}${r.end !== r.start ? ` to ${date(r.end)}` : ""}</td><td class="num mono">${hrs(r.hours)}</td>
            ${st.status === "submitted" ? `<td class="num mono ${r.balance != null && r.balance < r.hours && ["ANNUAL", "PERSONAL", "LONGSERV"].includes(r.typeCode) ? "bad-text" : ""}">${r.balance == null ? "" : hrs(r.balance)}</td>
              <td class="row-acts">${ctx.can("leave.approve") && !r.mine ? `<button type="button" class="btn" data-ok="${safe(r.id)}">Approve</button> <button type="button" class="btn danger" data-no="${safe(r.id)}">Decline</button>` : ""}</td>`
              : `<td>${safe(r.decidedBy || "")} ${dateTime(r.decidedAt)}${r.comment ? `<small>${safe(r.comment)}</small>` : ""}</td>`}</tr>`).join("") || `<tr><td colspan="6" class="muted">Nothing here.</td></tr>`}
        </tbody></table></div></section>
      ${ctx.can("leave.approve") ? `<form class="panel" data-for><h2>Record leave for someone</h2>
        <p class="muted small">For leave arranged by phone or on paper. It still needs approval by someone other than the employee.</p>
        <div class="grid3"><div class="fld"><label for="lf-emp">Employee</label><select id="lf-emp">${options(people.employees.filter(e => e.inPayroll && e.status === "active").map(e => [e.id, e.name]))}</select></div>
          <div class="fld"><label for="lf-type">Type</label><select id="lf-type">${options(setup.leaveTypes.filter(t => t.active).map(t => [t.id, t.name]))}</select></div>
          ${field({ id: "lf-hours", label: "Hours", attrs: 'inputmode="decimal"', hint: "A full day is usually 7.6 hours" })}
          ${field({ id: "lf-start", label: "First day", type: "date", value: today() })}${field({ id: "lf-end", label: "Last day", type: "date", value: today() })}
          ${field({ id: "lf-reason", label: "Note", attrs: 'maxlength="500"' })}</div>
        <div class="actions"><button class="btn" type="submit">Record request</button></div></form>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("click", async e => {
    const tab = e.target.closest("[data-st]");
    const okb = e.target.closest("[data-ok]");
    const no = e.target.closest("[data-no]");
    try {
      if (tab) { st.status = tab.dataset.st; await load(); }
      else if (okb) { await call("leave_decide", { id: okb.dataset.ok, decision: "approved" }); await load(); flash(view, "Approved.", "good"); ctx.refreshCounts?.(); }
      else if (no) {
        const comment = window.prompt("Decline this leave? Tell the employee why:", "");
        if (comment === null) return;
        await call("leave_decide", { id: no.dataset.no, decision: "rejected", comment }); await load(); flash(view, "Declined.", "good"); ctx.refreshCounts?.();
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-for]")) return;
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`).value.trim();
    try {
      await call("leave_request", { employeeId: v("lf-emp"), typeId: v("lf-type"), hours: v("lf-hours"), start: v("lf-start"), end: v("lf-end"), reason: v("lf-reason") });
      await load();
      flash(view, "Recorded. It's in the waiting list for approval.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

export async function renderMyPay(view) {
  const load = async () => {
    let d;
    try { d = await call("my_pay"); } catch (error) {
      view.innerHTML = `<header class="page-head"><div><p class="eyebrow">MY PAY</p><h1>My pay</h1></div></header><section class="panel"><p class="muted">${safe(friendlyError(error))}</p></section>`;
      return;
    }
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">MY PAY</p><h1>${safe(d.employee.name)}</h1><p class="muted">Your payslips, leave balances and leave requests.</p></div></header>
      ${d.leave.length ? `<div class="cards figures">${d.leave.map(l => `<section class="card"><h2>${safe(l.name)}</h2><p class="big mono">${hrs(l.balance)} h</p><p class="muted small">≈ ${(l.balance / 7.6).toLocaleString("en-AU", { maximumFractionDigits: 1 })} days of 7.6 hours</p></section>`).join("")}</div>` : ""}
      <section class="panel"><h2>Payslips</h2>
        ${d.payslips.length ? `<table class="tbl"><thead><tr><th scope="col">Paid</th><th scope="col">Period</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Tax</th><th scope="col" class="num">Net</th><th scope="col"></th></tr></thead><tbody>
          ${d.payslips.map(p => `<tr><td>${date(p.paymentDate)}</td><td class="nowrap">${date(p.periodStart)} to ${date(p.periodEnd)}</td><td class="num mono">${money(p.gross)}</td><td class="num mono">${money(p.payg)}</td>
            <td class="num mono"><strong>${money(p.net)}</strong></td><td><button type="button" class="link" data-slip="${safe(p.runId)}">Download</button></td></tr>`).join("")}</tbody></table>`
          : '<p class="muted">No payslips yet.</p>'}
      </section>
      <form class="panel" data-request><h2>Request leave</h2>
        <div class="grid3"><div class="fld"><label for="my-type">Type</label><select id="my-type">${options(d.leaveTypes.map(t => [t.id, t.name]))}</select></div>
          ${field({ id: "my-start", label: "First day", type: "date", value: today() })}${field({ id: "my-end", label: "Last day", type: "date", value: today() })}
          ${field({ id: "my-hours", label: "Hours", attrs: 'inputmode="decimal"', hint: "A full day is usually 7.6 hours" })}
          ${field({ id: "my-reason", label: "Note (optional)", attrs: 'maxlength="500"' })}</div>
        <div class="actions"><button class="btn primary" type="submit">Send request</button></div></form>
      ${d.leaveRequests.length ? `<section class="panel"><h2>My requests</h2><table class="tbl"><tbody>
        ${d.leaveRequests.map(r => `<tr><td>${safe(d.leaveTypes.find(t => t.id === r.typeId)?.name || "Leave")}</td><td class="nowrap">${date(r.start)}${r.end !== r.start ? ` to ${date(r.end)}` : ""}</td>
          <td class="num mono">${hrs(r.hours)} h</td><td>${chip(...STATUS[r.status])}${r.comment ? `<small>${safe(r.comment)}</small>` : ""}</td>
          <td>${["submitted", "approved"].includes(r.status) ? `<button type="button" class="link" data-cancel="${safe(r.id)}">Cancel</button>` : ""}</td></tr>`).join("")}</tbody></table></section>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("click", async e => {
    const slip = e.target.closest("[data-slip]");
    const cancel = e.target.closest("[data-cancel]");
    try {
      if (slip) await downloadPdf("my_payslip", { id: slip.dataset.slip });
      else if (cancel) {
        if (!window.confirm("Cancel this leave request?")) return;
        await call("leave_decide", { id: cancel.dataset.cancel, decision: "cancelled" }); await load(); flash(view, "Cancelled.", "good");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-request]")) return;
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`).value.trim();
    try {
      await call("leave_request", { typeId: v("my-type"), start: v("my-start"), end: v("my-end"), hours: v("my-hours"), reason: v("my-reason") });
      await load();
      flash(view, "Sent. You'll get a notification when it's decided.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
