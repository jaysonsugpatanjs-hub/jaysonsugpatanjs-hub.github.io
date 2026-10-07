// Pay runs: Draft -> Submitted -> Approved (posted) -> Paid, plus super.
// Routes: #/pay-runs, #/pay-runs/new, #/pay-runs/<id>; #/super (super due and
// paid, by pay run); #/payroll-reports (year to date by employee).
import { call, chip, date, dateTime, downloadCsv, flash, friendlyError, money, options, safe, today } from "../lib/ui.js";
import { downloadPdf } from "../lib/docs.js";

export const RUN_STATUS = { draft: ["Draft", "pending"], submitted: ["Waiting for approval", "info"], approved: ["Approved, not yet paid", "good"], paid: ["Paid", "good"] };
const SCALE = { "1": "Scale 1 (no tax-free threshold)", "2": "Scale 2 (tax-free threshold)", "3": "Scale 3 (foreign resident)", "5": "Scale 5 (full Medicare exemption)",
  "6": "Scale 6 (half Medicare exemption)", "4r": "No TFN: 47%", "4f": "No TFN, foreign: 45%" };
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hrs = h => (h == null ? "" : Number(h).toLocaleString("en-AU", { maximumFractionDigits: 2 }));

export async function renderPayRuns(view, ctx) {
  const [id] = (ctx.sub || "").split("/");
  if (id === "new") return create(view);
  if (id) return detail(view, id, ctx);
  return list(view, ctx);
}

async function list(view, ctx) {
  const d = await call("pay_runs_list");
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">PAYROLL</p><h1>Pay runs</h1>
      <p class="muted">Hours come from approved timesheets, leave from approved requests. Someone other than the preparer approves each pay run; approving posts it to the ledger and makes it final.</p></div>
      ${ctx.can("payroll.run") ? '<a class="btn primary" href="#/pay-runs/new">New pay run</a>' : ""}</header>
    <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Pay run</th><th scope="col">Period</th><th scope="col">Payment</th><th scope="col">Status</th>
      <th scope="col" class="num">People</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Tax</th><th scope="col" class="num">Net</th><th scope="col">Super</th></tr></thead><tbody>
      ${d.runs.map(r => `<tr><td class="mono"><a href="#/pay-runs/${safe(r.id)}">${safe(r.number)}</a><small>${safe(r.frequency)}</small></td>
        <td class="nowrap">${date(r.periodStart)} to ${date(r.periodEnd)}</td><td class="nowrap">${date(r.paymentDate)}</td><td>${chip(...RUN_STATUS[r.status])}</td>
        <td class="num">${r.employees}</td><td class="num mono">${money(r.gross)}</td><td class="num mono">${money(r.payg)}</td><td class="num mono">${money(r.net)}</td>
        <td class="nowrap">${r.superPaidAt ? chip(`Paid ${date(r.superPaidAt)}`, "good") : ["approved", "paid"].includes(r.status) && r.super ? chip(`Due ${date(r.superDue)}`, r.superOverdue ? "bad" : "pending") : ""}</td></tr>`).join("")
        || '<tr><td colspan="9" class="muted">No pay runs yet.</td></tr>'}
    </tbody></table></div></section>`;
}

async function create(view) {
  const setup = await call("payroll_setup");
  const t = today();
  const dow = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].indexOf(setup.payDay);
  const weekStart = (() => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7); return d.toISOString().slice(0, 10); })();
  const defaults = f => f === "monthly"
    ? (() => { const s = `${t.slice(0, 7)}-01`; const e = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)), 0)).toISOString().slice(0, 10); return [s, e, e]; })()
    : [f === "fortnightly" ? addDays(weekStart, -7) : weekStart, addDays(weekStart, 6), addDays(weekStart, 7 + Math.max(0, dow))];
  const draw = f => {
    const [s, e, p] = defaults(f);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PAYROLL · PAY RUNS</p><h1>New pay run</h1>
        <p class="muted">Everyone on this pay frequency is included and worked out straight away. You can add allowances, bonuses and deductions before submitting it for approval.</p></div></header>
      <form class="panel" data-create><div class="grid3">
        <div class="fld"><label for="pr-f">Frequency</label><select id="pr-f">${options([["weekly", "Weekly"], ["fortnightly", "Fortnightly"], ["monthly", "Monthly"]], f)}</select></div>
        <div class="fld"><label for="pr-s">Period start</label><input id="pr-s" type="date" value="${safe(s)}"></div>
        <div class="fld"><label for="pr-e">Period end</label><input id="pr-e" type="date" value="${safe(e)}"></div>
        <div class="fld"><label for="pr-p">Payment date</label><input id="pr-p" type="date" value="${safe(p)}"></div></div>
        <p class="muted small">Super must reach each fund within 7 business days of the payment date (Payday Super).</p>
        <div class="actions"><button class="btn primary" type="submit">Create and calculate</button><a class="btn" href="#/pay-runs">Cancel</a></div>
      </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  draw(setup.payFrequency);
  view.addEventListener("change", e => {
    if (e.target.id === "pr-f") draw(e.target.value);
    if (e.target.id === "pr-s") {
      const f = view.querySelector("#pr-f").value;
      if (f !== "monthly") view.querySelector("#pr-e").value = addDays(e.target.value, f === "weekly" ? 6 : 13);
    }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-create]")) return;
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`).value;
    try {
      const r = await call("pay_run_create", { frequency: v("pr-f"), periodStart: v("pr-s"), periodEnd: v("pr-e"), paymentDate: v("pr-p") });
      location.hash = `#/pay-runs/${r.id}`;
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function detail(view, id, ctx) {
  const setup = await call("payroll_setup");
  const open = new Set();
  const load = async () => {
    const d = await call("pay_run_get", { id });
    const r = d.run, c = d.can;
    const warnings = d.employees.reduce((n, e) => n + e.warnings.length, 0);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PAYROLL · PAY RUN</p><h1>${safe(r.number)} ${chip(...RUN_STATUS[r.status])}</h1>
        <p class="muted">${safe(r.frequency)} · ${date(r.periodStart)} to ${date(r.periodEnd)} · paid ${date(r.paymentDate)}${r.preparedBy ? ` · prepared by ${safe(r.preparedBy)}` : ""}${r.approvedBy ? ` · approved by ${safe(r.approvedBy)} ${dateTime(r.approvedAt)}` : ""}</p></div></header>
      <div class="cards figures">
        <section class="card"><h2>Gross</h2><p class="big mono">${money(r.gross)}</p></section>
        <section class="card"><h2>Tax withheld</h2><p class="big mono">${money(r.payg)}</p><p class="muted small">Owed to the ATO, reported on the BAS</p></section>
        <section class="card"><h2>Net pay</h2><p class="big mono">${money(r.net)}</p><p class="muted small">${r.paidAt ? `Paid ${date(r.paidAt)}` : "To pay employees"}</p></section>
        <section class="card ${["approved", "paid"].includes(r.status) && !r.superPaidAt && r.super > 0 && r.superDue < today() ? "attention" : ""}"><h2>Super</h2><p class="big mono">${money(r.super)}</p>
          <p class="muted small">${r.superPaidAt ? `Paid ${date(r.superPaidAt)}` : `Due by ${date(r.superDue)}`}</p></section>
      </div>
      ${warnings ? `<p class="note">${warnings} thing${warnings === 1 ? "" : "s"} to check below.</p>` : ""}
      <section class="panel">
        <div class="tbl-wrap"><table class="tbl payrun"><thead><tr><th scope="col">Employee</th><th scope="col" class="num">Hours</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Tax</th>
          <th scope="col" class="num">Deductions</th><th scope="col" class="num">Net</th><th scope="col" class="num">Super</th><th scope="col"></th></tr></thead>
          ${d.employees.map(e => `<tbody class="emp"><tr class="${e.warnings.length ? "warn-row" : ""}"><td><button type="button" class="link" data-toggle="${safe(e.id)}" aria-expanded="${open.has(e.id)}">${open.has(e.id) ? "▾" : "▸"} ${safe(e.name)}</button>
              <small>${safe(SCALE[e.scale] || "")}${e.stsl ? " · study loan" : ""}</small>${e.warnings.map(w => `<small class="warn-text">${safe(w)}</small>`).join("")}</td>
            <td class="num mono">${hrs(e.ordinaryHours)}</td><td class="num mono">${money(e.gross)}</td><td class="num mono">${money(e.payg)}</td>
            <td class="num mono">${money(e.salarySacrifice + e.deductions, { blankZero: true })}</td><td class="num mono"><strong>${money(e.net)}</strong></td>
            <td class="num mono">${money(e.superGuarantee + e.salarySacrifice)}</td>
            <td class="row-acts">${["approved", "paid"].includes(r.status) ? `<button type="button" class="link" data-slip="${safe(e.id)}">Payslip</button>` : ""}</td></tr>
            ${open.has(e.id) ? `<tr class="lines-row"><td colspan="8"><table class="tbl inner"><thead><tr><th scope="col">Item</th><th scope="col" class="num">Hours</th><th scope="col" class="num">Rate</th><th scope="col" class="num">Amount</th><th scope="col"></th></tr></thead><tbody>
              ${e.lines.map(l => `<tr><td>${safe(l.description || l.name)}<small>${safe(l.name)}${l.manual ? " · added by hand" : ""}</small></td><td class="num mono">${hrs(l.hours)}</td>
                <td class="num mono">${l.rate != null ? `$${Number(l.rate).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : ""}</td>
                <td class="num mono">${l.kind === "deduction" ? `(${money(l.amount)})` : money(l.amount)}</td>
                <td>${c.edit && l.manual ? `<button type="button" class="link" data-remove="${safe(l.id)}">Remove</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No earnings this period.</td></tr>'}
              <tr class="sub"><td colspan="3">Taxable ${money(e.taxable)} · tax ${money(e.payg)}${e.stsl ? ` (incl. ${money(e.stsl)} study loan)` : ""}${e.salarySacrifice ? ` · salary sacrifice ${money(e.salarySacrifice)}` : ""} · super guarantee ${money(e.superGuarantee)} on ${money(e.qualifyingEarnings)}</td><td></td><td></td></tr>
              </tbody></table>
              ${c.edit ? `<form class="toolbar add-line" data-add="${safe(e.id)}">
                <div class="fld"><label for="al-i-${safe(e.id)}">Add</label><select id="al-i-${safe(e.id)}" data-f="item">${options(setup.payItems.filter(i => i.active && !["SALARY"].includes(i.code)).map(i => [i.id, `${i.name} (${i.kind})`]))}</select></div>
                <div class="fld wide"><label for="al-d-${safe(e.id)}">Description on the payslip</label><input id="al-d-${safe(e.id)}" data-f="description" maxlength="200"></div>
                <div class="fld t"><label for="al-h-${safe(e.id)}">Hours</label><input id="al-h-${safe(e.id)}" data-f="hours" inputmode="decimal"></div>
                <div class="fld t"><label for="al-r-${safe(e.id)}">Rate</label><input id="al-r-${safe(e.id)}" data-f="rate" inputmode="decimal"></div>
                <div class="fld t"><label for="al-a-${safe(e.id)}">or Amount</label><input id="al-a-${safe(e.id)}" data-f="amount" inputmode="decimal"></div>
                <button class="btn" type="submit">Add</button></form>` : ""}</td></tr>` : ""}</tbody>`).join("")}
          <tfoot><tr class="grand"><th scope="row">Total</th><td></td><td class="num mono">${money(r.gross)}</td><td class="num mono">${money(r.payg)}</td><td></td><td class="num mono">${money(r.net)}</td><td class="num mono">${money(r.super)}</td><td></td></tr></tfoot></table></div>
        ${r.calculatedAt && r.status === "draft" ? `<p class="muted small">Worked out ${dateTime(r.calculatedAt)}. Recalculate after approving more timesheets or leave.</p>` : ""}
        <div class="actions">
          ${c.edit ? '<button type="button" class="btn" data-act="recalc">Recalculate</button>' : ""}
          ${c.submit ? '<button type="button" class="btn primary" data-act="submit">Submit for approval</button>' : ""}
          ${c.approve ? '<button type="button" class="btn primary" data-act="approve">Approve and post</button>' : ""}
          ${r.status === "submitted" && !c.approve && ctx.can("payroll.approve") ? '<span class="muted small">You prepared this pay run or are paid in it, so someone else must approve it.</span>' : ""}
          ${c.sendBack ? '<button type="button" class="btn" data-act="return">Send back</button>' : ""}
          ${c.bankList ? '<button type="button" class="btn" data-act="aba">Bank file (ABA)</button> <button type="button" class="btn" data-act="banklist">Bank payment list (CSV)</button>' : ""}
          ${c.delete ? '<button type="button" class="btn danger" data-act="delete">Delete draft</button>' : ""}
        </div>
        ${r.journal ? `<p class="muted small">Ledger: <a href="#/journals/${safe(r.journal.id)}">${safe(r.journal.number)}</a>${r.paymentJournal ? ` · net pay <a href="#/journals/${safe(r.paymentJournal.id)}">${safe(r.paymentJournal.number)}</a>` : ""}${r.superJournal ? ` · super <a href="#/journals/${safe(r.superJournal.id)}">${safe(r.superJournal.number)}</a>` : ""}</p>` : ""}
      </section>
      ${c.pay || c.paySuper ? `<section class="panel"><h2>Record payments</h2>
        <p class="muted small">Record each payment after it has left the bank, or match the bank statement line in Reconciliation, which records it for you.</p>
        <div class="grid2">
          ${c.pay ? `<form class="toolbar" data-pay="net"><div class="fld"><label for="pn-b">Net pay from</label><select id="pn-b">${options(setup.bankAccounts.map(a => [a.id, `${a.code} ${a.name}`]))}</select></div>
            <div class="fld"><label for="pn-d">Date</label><input id="pn-d" type="date" value="${safe(r.paymentDate)}"></div><button class="btn primary" type="submit">Net pay ${money(r.net)} paid</button></form>` : ""}
          ${c.paySuper ? `<form class="toolbar" data-pay="super"><div class="fld"><label for="ps-b">Super from</label><select id="ps-b">${options(setup.bankAccounts.map(a => [a.id, `${a.code} ${a.name}`]))}</select></div>
            <div class="fld"><label for="ps-d">Date</label><input id="ps-d" type="date" value="${safe(today())}"></div><button class="btn primary" type="submit">Super ${money(r.super)} paid</button></form>` : ""}
        </div></section>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
    return d;
  };
  let d = await load();
  view.addEventListener("click", async e => {
    const tg = e.target.closest("[data-toggle]");
    if (tg) { open.has(tg.dataset.toggle) ? open.delete(tg.dataset.toggle) : open.add(tg.dataset.toggle); d = await load(); return; }
    const slip = e.target.closest("[data-slip]");
    const rm = e.target.closest("[data-remove]");
    const act = e.target.closest("[data-act]")?.dataset.act;
    try {
      if (slip) { await downloadPdf("payslip_pdf", { id, employeeId: slip.dataset.slip }); return; }
      if (rm) { await call("pay_run_line_remove", { lineId: rm.dataset.remove }); d = await load(); return; }
      if (!act) return;
      if (act === "recalc") { await call("pay_run_recalculate", { id }); d = await load(); flash(view, "Recalculated.", "good"); }
      else if (act === "submit") { await call("pay_run_submit", { id }); d = await load(); flash(view, "Submitted. Someone with \"Approve pay runs\" approves it next.", "good"); ctx.refreshCounts?.(); }
      else if (act === "approve") {
        if (!window.confirm(`Approve ${d.run.number}? It posts to the ledger, marks the timesheet hours and leave as paid, and can't be changed afterwards. Corrections go in a later pay run.`)) return;
        await call("pay_run_approve", { id }); d = await load(); flash(view, "Approved and posted. Pay the net amounts and the super, then record both here.", "good"); ctx.refreshCounts?.();
      } else if (act === "return") {
        const reason = window.prompt("Send this pay run back to draft? Say what needs changing:", "");
        if (reason === null) return;
        await call("pay_run_return", { id, reason }); d = await load(); flash(view, "Sent back to draft.", "good");
      } else if (act === "delete") {
        if (!window.confirm("Delete this draft pay run? Nothing has been paid or posted.")) return;
        await call("pay_run_delete", { id }); location.hash = "#/pay-runs";
      } else if (act === "aba") {
        const f = await call("pay_run_aba", { id });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([f.content], { type: "text/plain" }));
        link.download = f.fileName;
        document.body.appendChild(link); link.click(); link.remove();
        flash(view, `Downloaded ${f.fileName}: ${f.count} payment(s), ${money(f.total)}. Upload it in your bank's internet banking, then record the net pay as paid. It holds bank details: delete it after uploading. The download is recorded in the audit log.`, "warn");
      } else if (act === "banklist") {
        const b = await call("pay_run_bank_list", { id });
        downloadCsv(`net-pay-${b.number}.csv`, [["Name", "Employee no.", "Account name", "BSB", "Account number", "Amount", "Reference"],
          ...b.rows.map(x => [x.name, x.number, x.accountName, x.bsb, x.accountNumber, x.net.toFixed(2), x.reference])]);
        flash(view, "Downloaded. It contains full bank details: delete it once the payments are made. The download is recorded in the audit log.", "warn");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const add = e.target.closest("[data-add]");
      if (add) {
        const f = k => add.querySelector(`[data-f="${k}"]`).value.trim();
        await call("pay_run_line_add", { id, employeeId: add.dataset.add, itemId: f("item"), description: f("description") || add.querySelector('[data-f="item"] option:checked').textContent.replace(/ \(.*\)$/, ""),
          hours: f("hours"), rate: f("rate"), amount: f("amount") });
        d = await load();
        flash(view, "Added and recalculated.", "good");
        return;
      }
      const pay = e.target.closest("[data-pay]");
      if (pay?.dataset.pay === "net") { await call("pay_run_record_payment", { id, bankAccountId: view.querySelector("#pn-b").value, date: view.querySelector("#pn-d").value }); }
      else if (pay?.dataset.pay === "super") { await call("pay_run_record_super", { id, bankAccountId: view.querySelector("#ps-b").value, date: view.querySelector("#ps-d").value }); }
      else return;
      d = await load();
      flash(view, "Recorded.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Super ---------------- */

export async function renderSuper(view, ctx) {
  const [d, setup] = await Promise.all([call("pay_runs_list"), call("payroll_setup")]);
  const runs = d.runs.filter(r => ["approved", "paid"].includes(r.status) && r.super > 0);
  const unpaid = runs.filter(r => !r.superPaidAt);
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">PAYROLL</p><h1>Super</h1>
      <p class="muted">From 1 July 2026 super guarantee is worked out on qualifying earnings each pay and must reach the fund within 7 business days of payday (Payday Super). Rate ${((setup.rules.superGuaranteeRate || 0) * 100).toFixed(0)}%; maximum contribution base ${money(setup.rules.maxContributionBase)} a year.</p></div></header>
    <div class="cards figures"><section class="card ${unpaid.some(r => r.superOverdue) ? "attention" : ""}"><h2>Not yet paid</h2><p class="big mono">${money(unpaid.reduce((s, r) => s + Math.round(r.super * 100), 0) / 100)}</p>
      <p class="muted small">${unpaid.some(r => r.superOverdue) ? "Some is overdue: late super attracts the super guarantee charge." : unpaid.length ? `Next due ${date(unpaid.map(r => r.superDue).sort()[0])}` : "All recorded as paid"}</p></section></div>
    <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Pay run</th><th scope="col">Payday</th><th scope="col">Due by</th><th scope="col" class="num">Super</th><th scope="col">Status</th></tr></thead><tbody>
      ${runs.map(r => `<tr><td class="mono"><a href="#/pay-runs/${safe(r.id)}">${safe(r.number)}</a></td><td>${date(r.paymentDate)}</td><td>${date(r.superDue)}</td><td class="num mono">${money(r.super)}</td>
        <td>${r.superPaidAt ? chip(`Paid ${date(r.superPaidAt)}`, "good") : r.superOverdue ? chip("Overdue", "bad") : chip("Due", "pending")}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No super yet.</td></tr>'}
    </tbody></table></div>
    <p class="muted small">The due date counts weekdays only; if a public holiday falls in between, the real due date is a day later. Contributions are paid through your clearing house${ctx.can("payroll.run") ? "; record each payment on its pay run" : ""}.</p></section>`;
}

/* ---------------- Payroll reports ---------------- */

export async function renderPayrollReports(view, ctx) {
  const t = today();
  const st = { from: `${Number(t.slice(5, 7)) >= 7 ? t.slice(0, 4) : Number(t.slice(0, 4)) - 1}-07-01`, to: t };
  let d = null;
  const draw = () => {
    const sum = k => d.rows.reduce((s, r) => s + Math.round(r[k] * 100), 0) / 100;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PAYROLL</p><h1>Payroll summary</h1>
        <p class="muted">Approved pay by employee for a date range (by payment date). Single Touch Payroll reporting to the ATO arrives in Phase 8; until then, keep lodging STP from your current payroll product.</p></div>
        ${ctx.can("data.export") ? '<button class="btn" type="button" data-csv>Export CSV</button>' : ""}</header>
      <section class="panel"><form class="toolbar" data-run><div class="fld"><label for="ps-f">From</label><input id="ps-f" type="date" value="${safe(st.from)}"></div>
        <div class="fld"><label for="ps-t">To</label><input id="ps-t" type="date" value="${safe(st.to)}"></div><button class="btn primary" type="submit">Show</button></form>
        <div class="tbl-wrap"><table class="tbl report"><thead><tr><th scope="col">Employee</th><th scope="col" class="num">Pays</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Tax</th>
          <th scope="col" class="num">incl. study loan</th><th scope="col" class="num">Salary sacrifice</th><th scope="col" class="num">Deductions</th><th scope="col" class="num">Super guarantee</th><th scope="col" class="num">Net</th></tr></thead><tbody>
          ${d.rows.map(r => `<tr><td><a href="#/employees/${safe(r.employeeId)}">${safe(r.name)}</a><small>${safe(r.number || "")}</small></td><td class="num">${r.pays}</td><td class="num mono">${money(r.gross)}</td>
            <td class="num mono">${money(r.payg)}</td><td class="num mono">${money(r.stsl, { blankZero: true })}</td><td class="num mono">${money(r.salarySacrifice, { blankZero: true })}</td>
            <td class="num mono">${money(r.deductions, { blankZero: true })}</td><td class="num mono">${money(r.superGuarantee)}</td><td class="num mono">${money(r.net)}</td></tr>`).join("")
            || '<tr><td colspan="9" class="muted">No approved pay in this range.</td></tr>'}
        </tbody><tfoot><tr class="grand"><th scope="row">Total</th><td></td><td class="num mono">${money(sum("gross"))}</td><td class="num mono">${money(sum("payg"))}</td><td class="num mono">${money(sum("stsl"))}</td>
          <td class="num mono">${money(sum("salarySacrifice"))}</td><td class="num mono">${money(sum("deductions"))}</td><td class="num mono">${money(sum("superGuarantee"))}</td><td class="num mono">${money(sum("net"))}</td></tr></tfoot></table></div>
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  const run = async (exp = false) => { d = await call("payroll_summary", { ...st, export: exp }); draw(); };
  await run();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-run]")) return;
    e.preventDefault();
    st.from = view.querySelector("#ps-f").value; st.to = view.querySelector("#ps-t").value;
    try { await run(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    if (!e.target.closest("[data-csv]")) return;
    try {
      await run(true);
      downloadCsv(`payroll-summary-${st.from}-to-${st.to}.csv`, [["Employee", "Employee no.", "Pays", "Gross", "Tax withheld", "Study loan component", "Salary sacrifice", "Deductions", "Reimbursements", "Super guarantee", "Net"],
        ...d.rows.map(r => [r.name, r.number, r.pays, r.gross, r.payg, r.stsl, r.salarySacrifice, r.deductions, r.reimbursements, r.superGuarantee, r.net])]);
      flash(view, "Exported. Exports are recorded in the audit log.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
