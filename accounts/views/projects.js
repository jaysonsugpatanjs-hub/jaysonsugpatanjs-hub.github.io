// Projects and job costing. Routes:
//   #/projects                list          #/projects/new, #/projects/<id>/edit   form with budgets
//   #/projects/<id>           job costing for one project
//   #/projects/settings       cost codes, labour rates, who is costed at which rate
//   #/job-costing             every project's figures side by side, with CSV export
// Labour is costed at the class rate frozen when a timesheet is approved;
// other costs come from approved bills, commitments from open purchase orders,
// revenue from approved invoices. Nothing here posts to the ledger.
import { call, chip, date, downloadCsv, field, flash, friendlyError, hashParams, money, options, safe, today } from "../lib/ui.js";

export const PROJECT_STATUS = { tender: ["Tender", "pending"], active: ["Active", "good"], on_hold: ["On hold", "pending"], completed: ["Completed", "info"],
  closed: ["Closed", ""], cancelled: ["Cancelled", ""] };
const BILLING = [["fixed_price", "Fixed price"], ["schedule_of_rates", "Schedule of rates"], ["cost_plus", "Cost plus"], ["internal", "Internal (no customer)"]];
const CATEGORIES = [["labour", "Labour"], ["materials", "Materials"], ["equipment", "Equipment"], ["subcontract", "Subcontract"], ["travel", "Travel"],
  ["consumables", "Consumables"], ["freight", "Freight"], ["other", "Other"]];
const pct = v => (v == null ? "—" : `${Number(v).toLocaleString("en-AU", { maximumFractionDigits: 1 })}%`);
const hrs = v => (Number(v) || 0).toLocaleString("en-AU", { maximumFractionDigits: 2 });
const statusChip = s => chip(...(PROJECT_STATUS[s] || [s, ""]));

export async function renderProjects(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("/");
  if (id === "settings") return settings(view, ctx);
  if (id === "new") return form(view, null);
  if (id && mode === "edit") return form(view, id);
  if (id) return detail(view, id, ctx);
  return list(view, ctx);
}

/* ---------------- List ---------------- */

async function list(view, ctx) {
  const f = { status: hashParams().get("status") || "open", search: "" };
  const load = async () => {
    const d = await call("projects_list", f);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PROJECTS</p><h1>Projects</h1>
        <p class="muted">Jobs that time, purchases and invoices are tagged to. Open one to see its budget, costs to date and margin.</p></div>
        <div class="actions tight">${ctx.can("projects.manage") ? '<a class="btn" href="#/projects/settings">Cost codes and rates</a><a class="btn primary" href="#/projects/new">New project</a>' : ""}</div></header>
      <section class="panel">
        <form class="toolbar" data-filter>
          <div class="fld"><label for="p-st">Show</label><select id="p-st">${options([["open", "Open (tender, active, on hold)"], ["all", "All"], ...Object.entries(PROJECT_STATUS).map(([k, v]) => [k, v[0]])], f.status)}</select></div>
          <div class="fld"><label for="p-q">Number or name</label><input id="p-q" value="${safe(f.search)}"></div><button class="btn" type="submit">Filter</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Project</th><th scope="col">Customer</th><th scope="col">Manager</th><th scope="col">Status</th>
          <th scope="col" class="num">Contract</th><th scope="col" class="num">Cost to date</th><th scope="col" class="num">Invoiced</th><th scope="col" class="num">Complete</th></tr></thead><tbody>
          ${d.projects.map(p => `<tr><td><a href="#/projects/${safe(p.id)}"><span class="mono">${safe(p.number)}</span> ${safe(p.name)}</a>${p.site ? `<small>${safe(p.site)}</small>` : ""}</td>
            <td>${safe(p.customer || "—")}</td><td>${safe(p.manager || "—")}</td><td>${statusChip(p.status)}</td>
            <td class="num mono">${money(p.contractValue, { blankZero: true })}</td><td class="num mono">${money(p.cost, { blankZero: true })}</td>
            <td class="num mono">${money(p.invoiced, { blankZero: true })}</td><td class="num">${pct(p.percentComplete)}</td></tr>`).join("")
            || '<tr><td colspan="8" class="muted">No projects here yet.</td></tr>'}
        </tbody></table></div></section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    f.status = view.querySelector("#p-st").value;
    f.search = view.querySelector("#p-q").value.trim();
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Job costing across projects ---------------- */

export async function renderJobCosting(view, ctx) {
  const f = { status: hashParams().get("status") || "open" };
  let d = null;
  const draw = () => {
    const sum = k => d.projects.reduce((s, p) => s + Math.round((Number(p[k]) || 0) * 100), 0) / 100;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PROJECTS</p><h1>Job costing</h1>
        <p class="muted">Every project's budget, costs, commitments, invoicing and margin as at today. Margin is invoiced less cost to date; over/under billing compares invoicing with progress on cost.</p></div>
        ${ctx.can("data.export") ? '<button class="btn" type="button" data-csv>Export CSV</button>' : ""}</header>
      <section class="panel">
        <form class="toolbar" data-filter><div class="fld"><label for="jc-st">Show</label><select id="jc-st">${options([["open", "Open projects"], ["all", "All"], ...Object.entries(PROJECT_STATUS).map(([k, v]) => [k, v[0]])], f.status)}</select></div>
          <button class="btn" type="submit">Show</button></form>
        <div class="tbl-wrap"><table class="tbl report"><thead><tr><th scope="col">Project</th><th scope="col" class="num">Contract</th><th scope="col" class="num">Budget</th>
          <th scope="col" class="num">Cost to date</th><th scope="col" class="num">Committed</th><th scope="col" class="num">Hours</th><th scope="col" class="num">Invoiced</th>
          <th scope="col" class="num">Margin</th><th scope="col" class="num">Complete</th><th scope="col" class="num">Over / (under) billed</th></tr></thead><tbody>
          ${d.projects.map(p => `<tr><td><a href="#/projects/${safe(p.id)}"><span class="mono">${safe(p.number)}</span> ${safe(p.name)}</a> ${p.status !== "active" ? statusChip(p.status) : ""}</td>
            <td class="num mono">${money(p.contractValue, { blankZero: true })}</td><td class="num mono">${money(p.budget, { blankZero: true })}</td>
            <td class="num mono ${p.budget && p.cost > p.budget ? "bad-text" : ""}">${money(p.cost, { blankZero: true })}</td><td class="num mono">${money(p.committed, { blankZero: true })}</td>
            <td class="num mono">${p.hours ? hrs(p.hours) : ""}</td><td class="num mono">${money(p.invoiced, { blankZero: true })}</td>
            <td class="num mono ${p.margin < 0 ? "bad-text" : ""}">${money(p.margin, { blankZero: true })}${p.marginPercent != null ? `<small>${pct(p.marginPercent)}</small>` : ""}</td>
            <td class="num">${pct(p.percentComplete)}</td><td class="num mono">${p.overUnderBilling == null ? "—" : money(p.overUnderBilling)}</td></tr>`).join("")
            || '<tr><td colspan="10" class="muted">No projects.</td></tr>'}
        </tbody>${d.projects.length ? `<tfoot><tr class="grand"><th scope="row">Total</th><td class="num mono">${money(sum("contractValue"))}</td><td class="num mono">${money(sum("budget"))}</td>
          <td class="num mono">${money(sum("cost"))}</td><td class="num mono">${money(sum("committed"))}</td><td class="num mono">${hrs(sum("hours"))}</td>
          <td class="num mono">${money(sum("invoiced"))}</td><td class="num mono">${money(sum("margin"))}</td><td></td><td></td></tr></tfoot>` : ""}</table></div>
        <p class="muted small">Labour is costed at each person's labour rate when their timesheet is approved. Other costs are approved bills tagged to the project, excluding GST. Committed is approved purchase orders not yet billed.</p>
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  const load = async () => { d = await call("projects_list", f); draw(); };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    f.status = view.querySelector("#jc-st").value;
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    if (!e.target.closest("[data-csv]")) return;
    try {
      const x = await call("projects_list", { ...f, export: true });
      downloadCsv(`job-costing-${today()}.csv`, [["Project", "Name", "Status", "Customer", "Contract", "Budget", "Cost to date", "Committed", "Hours", "Invoiced", "Margin", "Margin %", "Complete %", "Over/(under) billed"],
        ...x.projects.map(p => [p.number, p.name, p.status, p.customer || "", p.contractValue, p.budget, p.cost, p.committed, p.hours, p.invoiced, p.margin, p.marginPercent ?? "", p.percentComplete ?? "", p.overUnderBilling ?? ""])]);
      flash(view, "Exported. Exports are recorded in the audit log.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Form ---------------- */

async function form(view, id) {
  const [setup, people] = await Promise.all([call("projects_setup"), call("project_people")]);
  let p = { billingType: "fixed_price", status: "active", contractValue: "", budgets: [] };
  if (id) {
    const d = await call("project_get", { id });
    p = { ...d.project, budgets: d.budgets };
  } else if (hashParams().get("customer")) p.customerId = hashParams().get("customer");
  const budget = Object.fromEntries((p.budgets || []).map(b => [b.costCodeId, b]));
  const codes = setup.costCodes.filter(c => c.active || budget[c.id]);
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">PROJECTS</p><h1>${id ? `Edit ${safe(p.number)}` : "New project"}</h1>
      <p class="muted">${id ? "" : "The project number is given when you save. "}Budgets by cost code drive the remaining-budget and progress figures; leave codes you won't use blank.</p></div></header>
    <form class="panel" data-project novalidate>
      <div class="grid2">
        ${field({ id: "pj-name", label: "Project name", value: p.name || "", required: true, attrs: 'maxlength="160"' })}
        <div class="fld"><label for="pj-cust">Customer</label><select id="pj-cust">${options([["", "None (internal job)"], ...setup.customers.map(c => [c.id, c.name])], p.customerId || "")}</select></div>
        ${field({ id: "pj-site", label: "Site", value: p.site || "", attrs: 'maxlength="300"', hint: "Where the work is done" })}
        ${field({ id: "pj-ref", label: "Customer's order / contract number", value: p.customerReference || "", attrs: 'maxlength="120"' })}
        <div class="fld"><label for="pj-mgr">Project manager</label><select id="pj-mgr">${options([["", "—"], ...people.people.map(x => [x.id, x.name])], p.managerId || "")}</select></div>
        <div class="fld"><label for="pj-bill">Contract type</label><select id="pj-bill">${options(BILLING, p.billingType)}</select></div>
        ${field({ id: "pj-value", label: "Contract value ($, ex GST)", value: p.contractValue || "", attrs: 'inputmode="decimal"', hint: "The agreed price, or an estimate for schedule-of-rates work" })}
        <div class="grid2">${field({ id: "pj-start", label: "Start", value: p.startDate || "", type: "date" })}${field({ id: "pj-end", label: "Finish", value: p.endDate || "", type: "date" })}</div>
      </div>
      <h2>Budget</h2>
      <div class="tbl-wrap"><table class="tbl form-tbl"><thead><tr><th scope="col">Cost code</th><th scope="col">Category</th><th scope="col" class="num">Hours</th><th scope="col" class="num">Amount ($)</th></tr></thead><tbody>
        ${codes.map(c => `<tr data-budget="${safe(c.id)}"><td><span class="mono">${safe(c.code)}</span> ${safe(c.name)}</td><td class="muted">${safe(CATEGORIES.find(x => x[0] === c.category)?.[1] || c.category)}</td>
          <td class="num"><input class="num apply" data-h aria-label="Budget hours, ${safe(c.name)}" inputmode="decimal" value="${budget[c.id]?.hours || ""}" ${c.category === "labour" ? "" : 'placeholder="—"'}></td>
          <td class="num"><input class="num apply" data-a aria-label="Budget amount, ${safe(c.name)}" inputmode="decimal" value="${budget[c.id]?.amount || ""}"></td></tr>`).join("")}
      </tbody><tfoot><tr><th colspan="2" scope="row">Total budget</th><td class="num mono" data-th></td><td class="num mono" data-ta></td></tr></tfoot></table></div>
      <p class="balance" data-margin></p>
      <div class="fld"><label for="pj-notes">Notes</label><textarea id="pj-notes" rows="3" maxlength="3000">${safe(p.notes || "")}</textarea></div>
      <div class="actions"><button class="btn primary" type="submit">Save project</button><a class="btn" href="#/projects${id ? `/${id}` : ""}">Cancel</a></div>
    </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  const num = v => Number(String(v || "").replace(/[$,\s]/g, "")) || 0;
  const totals = () => {
    let h = 0, a = 0;
    view.querySelectorAll("[data-budget]").forEach(r => { h += num(r.querySelector("[data-h]").value); a += Math.round(num(r.querySelector("[data-a]").value) * 100); });
    view.querySelector("[data-th]").textContent = hrs(h);
    view.querySelector("[data-ta]").textContent = money(a / 100);
    const contract = num(view.querySelector("#pj-value").value);
    const el = view.querySelector("[data-margin]");
    el.className = `balance ${contract && a / 100 > contract ? "bad" : ""}`;
    el.textContent = contract && a ? `Budgeted margin ${money(contract - a / 100)} (${pct(((contract - a / 100) / contract) * 100)})` : "";
  };
  totals();
  view.addEventListener("input", e => { if (e.target.closest("[data-budget]") || e.target.id === "pj-value") totals(); });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-project]")) return;
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`).value.trim();
    if (v("pj-name").length < 2) return flash(view, "Give the project a name.", "bad");
    const budgets = [...view.querySelectorAll("[data-budget]")].map(r => ({ costCodeId: r.dataset.budget, hours: r.querySelector("[data-h]").value.trim(), amount: r.querySelector("[data-a]").value.replace(/[$,\s]/g, "") }))
      .filter(b => b.hours || b.amount);
    if (budgets.some(b => (b.hours && !(Number(b.hours) >= 0)) || (b.amount && !/^\d+(\.\d{1,2})?$/.test(b.amount)))) return flash(view, "Budgets are positive numbers, with dollars and cents.", "bad");
    try {
      const r = await call("project_save", { id, name: v("pj-name"), customerId: v("pj-cust"), site: v("pj-site"), customerReference: v("pj-ref"), managerId: v("pj-mgr"),
        billingType: v("pj-bill"), contractValue: v("pj-value"), startDate: v("pj-start"), endDate: v("pj-end"), notes: v("pj-notes"), budgets, quoteId: p.quoteId || null });
      location.hash = `#/projects/${r.id}`;
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Detail (job costing for one project) ---------------- */

async function detail(view, id, ctx) {
  let asAt = today();
  const load = async () => {
    const d = await call("project_get", { id, asAt });
    const p = d.project, c = d.costing, t = c.totals, m = d.can.manage;
    const nextStatus = { tender: [["active", "Won: make active"], ["cancelled", "Lost / cancelled"]], active: [["on_hold", "Put on hold"], ["completed", "Mark completed"]],
      on_hold: [["active", "Resume"], ["cancelled", "Cancel"]], completed: [["closed", "Close project"], ["active", "Reopen"]], closed: [["active", "Reopen"]], cancelled: [["tender", "Reopen as tender"]] }[p.status] || [];
    const bar = (used, committed) => {
      const u = Math.max(0, Math.min(100, used || 0)), cm = Math.max(0, Math.min(100 - u, committed || 0));
      // SVG attributes, not inline styles: the page's security policy forbids inline styles.
      return `<svg class="meter" width="90" height="8" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="8" rx="3"></rect>
        <rect class="u ${used > 100 ? "over" : ""}" width="${u.toFixed(1)}" height="8"></rect><rect class="c" x="${u.toFixed(1)}" width="${cm.toFixed(1)}" height="8"></rect></svg>`;
    };
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PROJECTS · <span class="mono">${safe(p.number)}</span></p><h1>${safe(p.name)} ${statusChip(p.status)}</h1>
        <p class="muted">${p.customer ? `<a href="#/customers/${safe(p.customerId)}">${safe(p.customer)}</a>` : "Internal job"}${p.site ? ` · ${safe(p.site)}` : ""}${p.manager ? ` · managed by ${safe(p.manager)}` : ""}${p.startDate ? ` · ${date(p.startDate)}${p.endDate ? ` to ${date(p.endDate)}` : ""}` : ""}</p></div>
        <div class="actions tight">${m ? `<a class="btn" href="#/projects/${safe(id)}/edit">Edit</a>` : ""}</div></header>
      <div class="cards figures">
        <section class="card"><h2>Contract</h2><p class="big mono">${money(p.contractValue)}</p><p class="muted small">${safe(BILLING.find(b => b[0] === p.billingType)?.[1] || "")}${p.customerReference ? ` · ${safe(p.customerReference)}` : ""}</p></section>
        <section class="card"><h2>Cost to date</h2><p class="big mono">${money(t.actualCost)}</p><p class="muted small">of ${money(t.budgetAmount)} budget · ${money(t.committed)} committed</p></section>
        <section class="card"><h2>Invoiced</h2><p class="big mono">${money(c.revenue.invoiced)}</p><p class="muted small">${money(c.revenue.toInvoice)} left to invoice</p></section>
        <section class="card ${c.margin.grossMargin < 0 ? "attention" : ""}"><h2>Margin so far</h2><p class="big mono">${money(c.margin.grossMargin)}</p><p class="muted small">${c.margin.marginPercent != null ? `${pct(c.margin.marginPercent)} of invoiced · ` : ""}budgeted ${pct(c.margin.budgetMarginPercent)}</p></section>
        <section class="card"><h2>Progress</h2><p class="big">${pct(c.progress.percentComplete)}</p><p class="muted small">${c.progress.overUnderBilling == null ? "Set a budget to measure progress" : c.progress.overUnderBilling >= 0 ? `Over-billed ${money(c.progress.overUnderBilling)}` : `Under-billed ${money(-c.progress.overUnderBilling)}`}</p></section>
      </div>
      <section class="panel">
        <div class="head-row"><h2>Budget and costs by cost code</h2>
          <form class="toolbar inline" data-asat><div class="fld"><label for="pj-asat">As at</label><input id="pj-asat" type="date" value="${safe(asAt)}"></div><button class="btn" type="submit">Update</button></form></div>
        <div class="tbl-wrap"><table class="tbl report"><thead><tr><th scope="col">Cost code</th><th scope="col" class="num">Budget hrs</th><th scope="col" class="num">Actual hrs</th>
          <th scope="col" class="num">Budget</th><th scope="col" class="num">Labour</th><th scope="col" class="num">Other</th><th scope="col" class="num">Actual</th>
          <th scope="col" class="num">Committed</th><th scope="col" class="num">Remaining</th><th scope="col">Used</th></tr></thead><tbody>
          ${c.rows.map(r => `<tr><td><span class="mono">${safe(r.code)}</span> ${safe(r.name)}</td>
            <td class="num mono">${r.budgetHours ? hrs(r.budgetHours) : ""}</td><td class="num mono ${r.budgetHours && r.actualHours > r.budgetHours ? "bad-text" : ""}">${r.actualHours ? hrs(r.actualHours) : ""}</td>
            <td class="num mono">${money(r.budgetAmount, { blankZero: true })}</td><td class="num mono">${money(r.labourCost, { blankZero: true })}</td><td class="num mono">${money(r.otherCost, { blankZero: true })}</td>
            <td class="num mono">${money(r.actualCost, { blankZero: true })}</td><td class="num mono">${money(r.committed, { blankZero: true })}</td>
            <td class="num mono ${r.remaining < 0 ? "bad-text" : ""}">${money(r.remaining)}</td>
            <td class="nowrap">${r.budgetAmount ? `${bar(r.percentUsed, (r.committed / r.budgetAmount) * 100)} <span class="small ${r.percentUsed > 100 ? "bad-text" : "muted"}">${pct(r.percentUsed)}</span>` : '<span class="muted small">No budget</span>'}</td></tr>`).join("")
            || '<tr><td colspan="10" class="muted">No budget or costs yet.</td></tr>'}
        </tbody><tfoot><tr class="grand"><th scope="row">Total</th><td class="num mono">${hrs(t.budgetHours)}</td><td class="num mono">${hrs(t.actualHours)}</td><td class="num mono">${money(t.budgetAmount)}</td>
          <td class="num mono">${money(t.labourCost)}</td><td class="num mono">${money(t.otherCost)}</td><td class="num mono">${money(t.actualCost)}</td><td class="num mono">${money(t.committed)}</td>
          <td class="num mono">${money(t.remaining)}</td><td></td></tr></tfoot></table></div>
        <p class="muted small">Labour: approved timesheet hours at the labour rate when approved. Other: approved bills tagged to this project, excluding GST. Committed: approved purchase orders not yet billed.</p>
      </section>
      <div class="grid2 align-top">
        <section class="panel"><h2>Labour</h2>
          ${d.labour.length ? `<table class="tbl"><thead><tr><th scope="col">Person</th><th scope="col" class="num">Approved hrs</th>${m ? '<th scope="col" class="num">Cost</th>' : ""}<th scope="col" class="num">Waiting</th></tr></thead><tbody>
            ${d.labour.map(x => `<tr><td>${safe(x.name)}</td><td class="num mono">${hrs(x.hours)}</td>${m ? `<td class="num mono">${money(x.cost)}</td>` : ""}<td class="num mono muted">${x.pendingHours ? hrs(x.pendingHours) : ""}</td></tr>`).join("")}
          </tbody></table>` : '<p class="muted small">No hours recorded against this project yet.</p>'}
          <a class="link" href="#/timesheets">Timesheets</a></section>
        <section class="panel"><h2>Invoices</h2>
          ${d.invoices.length ? `<table class="tbl"><tbody>${d.invoices.map(x => `<tr><td class="mono"><a href="#/invoices/${safe(x.id)}">${safe(x.number || "Draft")}</a>${x.kind === "credit_note" ? "<small>Credit note</small>" : ""}</td>
            <td>${date(x.date)}</td><td>${x.status === "draft" ? chip("Draft", "pending") : ""}</td><td class="num mono">${money(x.amount)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted small">Nothing invoiced on this project yet.</p>'}
          ${ctx.can("sales.manage") && p.customerId ? `<a class="btn" href="#/invoices/new?customer=${safe(p.customerId)}&project=${safe(id)}">New invoice for this project</a>` : ""}</section>
      </div>
      <section class="panel"><h2>Bills and supplier credits</h2>
        ${d.bills.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Bill</th><th scope="col">Supplier</th><th scope="col">Their reference</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col" class="num">On this project (ex GST)</th></tr></thead><tbody>
          ${d.bills.map(x => `<tr><td class="mono"><a href="#/bills/${safe(x.id)}">${safe(x.number)}</a></td><td>${safe(x.supplier || "")}</td><td>${safe(x.reference || "—")}</td><td>${date(x.date)}</td>
            <td>${x.status === "approved" ? chip("Approved", "good") : chip("Not approved", "pending")}</td><td class="num mono">${money(x.amount)}</td></tr>`).join("")}</tbody></table></div>`
          : '<p class="muted small">No bills tagged to this project yet.</p>'}
        <div class="actions">${ctx.can("purchases.raise") || ctx.can("purchases.manage") ? `<a class="btn" href="#/purchase-orders/new?project=${safe(id)}">Purchase order for this project</a>` : ""}
          ${ctx.can("purchases.manage") ? `<a class="btn" href="#/bills/new?project=${safe(id)}">Bill for this project</a>` : ""}</div></section>
      ${m && nextStatus.length ? `<section class="panel"><h2>Status</h2><div class="actions">${nextStatus.map(([s, l]) => `<button type="button" class="btn" data-status="${s}">${safe(l)}</button>`).join("")}</div>
        <p class="muted small">A project can't be closed while timesheets with hours on it are still waiting for approval.</p></section>` : ""}
      ${p.notes ? `<section class="panel"><h2>Notes</h2><p class="prewrap">${safe(p.notes)}</p></section>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-asat]")) return;
    e.preventDefault();
    asAt = view.querySelector("#pj-asat").value || today();
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    const b = e.target.closest("[data-status]");
    if (!b) return;
    try {
      b.disabled = true;
      await call("project_status", { id, status: b.dataset.status });
      await load();
      flash(view, "Status updated.", "good");
    } catch (error) { b.disabled = false; flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Settings: cost codes, labour rates, people ---------------- */

async function settings(view, ctx) {
  if (!ctx.can("projects.manage")) { location.hash = "#/projects"; return; }
  const load = async () => {
    const [s, people] = await Promise.all([call("projects_setup"), call("labour_people")]);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PROJECTS</p><h1>Cost codes and labour rates</h1>
        <p class="muted">Labour rates are what an hour costs Panalo (wages plus on-costs such as super, workers compensation and leave) and what it is charged out at. Job costing uses the rate of each person's class, so nobody's individual pay is shown on projects.</p></div>
        <a class="btn" href="#/projects">Projects</a></header>
      <section class="panel"><h2>Labour classes</h2>
        ${s.labourClasses.some(c => c.active && !c.costRate) ? '<p class="note">Some classes have no cost rate yet, so their hours are costed at $0. Set a loaded cost per hour for each class you use.</p>' : ""}
        <div class="tbl-wrap"><table class="tbl form-tbl"><thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col" class="num">Cost per hour ($)</th><th scope="col" class="num">Charge-out per hour ($)</th><th scope="col">Active</th><th scope="col"></th></tr></thead><tbody>
          ${[...s.labourClasses, { id: "", code: "", name: "", costRate: "", chargeRate: "", active: true }].map(c => `<tr data-class="${safe(c.id)}">
            <td><input data-f="code" value="${safe(c.code)}" maxlength="12" aria-label="Code" placeholder="${c.id ? "" : "NEW"}"></td>
            <td><input data-f="name" value="${safe(c.name)}" maxlength="80" aria-label="Name" placeholder="${c.id ? "" : "Add a class"}"></td>
            <td class="num"><input class="num apply" data-f="costRate" inputmode="decimal" value="${safe(c.costRate === "" ? "" : Number(c.costRate).toFixed(2))}" aria-label="Cost per hour"></td>
            <td class="num"><input class="num apply" data-f="chargeRate" inputmode="decimal" value="${safe(c.chargeRate === "" ? "" : Number(c.chargeRate).toFixed(2))}" aria-label="Charge-out per hour"></td>
            <td><input type="checkbox" data-f="active" ${c.active ? "checked" : ""} aria-label="Active"></td>
            <td><button type="button" class="btn" data-save-class>${c.id ? "Save" : "Add"}</button></td></tr>`).join("")}
        </tbody></table></div></section>
      <section class="panel"><h2>Who is costed at which rate</h2>
        <p class="muted small">Everyone who can enter timesheets. A person's timesheets can't be approved until they have a class. A change applies to timesheets approved from then on; approved weeks keep the rate they were approved at.</p>
        <div class="tbl-wrap"><table class="tbl form-tbl"><thead><tr><th scope="col">Person</th><th scope="col">Labour class</th></tr></thead><tbody>
          ${people.people.map(x => `<tr><td>${safe(x.name)}<small>${safe(x.email)}</small></td><td><select data-assign="${safe(x.id)}" aria-label="Labour class for ${safe(x.name)}">
            ${options([["", "Not set"], ...s.labourClasses.filter(c => c.active || c.id === x.labourClassId).map(c => [c.id, `${c.code} ${c.name}`])], x.labourClassId || "")}</select></td></tr>`).join("")
            || '<tr><td colspan="2" class="muted">Nobody can enter timesheets yet. Give people "Enter my timesheets" in Users and roles.</td></tr>'}
        </tbody></table></div></section>
      <section class="panel"><h2>Cost codes</h2>
        <div class="tbl-wrap"><table class="tbl form-tbl"><thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Category</th><th scope="col">Active</th><th scope="col"></th></tr></thead><tbody>
          ${[...s.costCodes, { id: "", code: "", name: "", category: "other", active: true }].map(c => `<tr data-code="${safe(c.id)}">
            <td><input data-f="code" value="${safe(c.code)}" maxlength="10" aria-label="Code" placeholder="${c.id ? "" : "New"}"></td>
            <td><input data-f="name" value="${safe(c.name)}" maxlength="80" aria-label="Name" placeholder="${c.id ? "" : "Add a cost code"}"></td>
            <td><select data-f="category" aria-label="Category">${options(CATEGORIES, c.category)}</select></td>
            <td><input type="checkbox" data-f="active" ${c.active ? "checked" : ""} aria-label="Active"></td>
            <td><button type="button" class="btn" data-save-code>${c.id ? "Save" : "Add"}</button></td></tr>`).join("")}
        </tbody></table></div>
        <p class="muted small">Labour cost codes are the ones offered on timesheets. Codes in use can be made inactive but not deleted.</p></section>
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  const row = (tr, k) => tr.querySelector(`[data-f="${k}"]`);
  view.addEventListener("click", async e => {
    const cls = e.target.closest("[data-save-class]");
    const code = e.target.closest("[data-save-code]");
    if (!cls && !code) return;
    const tr = e.target.closest("tr");
    try {
      if (cls) await call("labour_class_save", { id: tr.dataset.class || null, code: row(tr, "code").value, name: row(tr, "name").value,
        costRate: row(tr, "costRate").value || "0", chargeRate: row(tr, "chargeRate").value || "0", active: row(tr, "active").checked });
      else await call("cost_code_save", { id: tr.dataset.code || null, code: row(tr, "code").value, name: row(tr, "name").value, category: row(tr, "category").value, active: row(tr, "active").checked });
      await load();
      flash(view, "Saved.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("change", async e => {
    const sel = e.target.closest("[data-assign]");
    if (!sel) return;
    try { await call("labour_assign", { profileId: sel.dataset.assign, classId: sel.value || null }); flash(view, "Labour class updated.", "good"); }
    catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
