// Single Touch Payroll Phase 2 information. Events (pay, update,
// finalisation) with year-to-date amounts per employee, checked against the
// reporting rules; pay item mapping; settings. Sending to the ATO is switched
// off: report through the current STP product and use these to check it.
// Routes: #/stp, #/stp/<eventId>.
import { call, chip, date, dateTime, downloadCsv, field, flash, friendlyError, money, options, safe, today } from "../lib/ui.js";

export const STP_STATUS = { draft: ["Has errors", "bad"], validated: ["Checked", "info"], ready: ["Ready", "good"], submitted: ["Sent", "info"], accepted: ["Accepted", "good"],
  partially_accepted: ["Partly accepted", "warn"], rejected: ["Rejected", "bad"], corrected: ["Corrected", ""], finalised: ["Finalised", "good"] };
const KIND = { pay: "Pay event", update: "Update event", finalisation: "Finalisation" };
const CATEGORY = [["gross", "Gross (salary and wages)"], ["overtime", "Overtime"], ["bonus", "Bonuses and commissions"], ["directors_fees", "Directors' fees"],
  ["paid_leave", "Paid leave"], ["allowance", "Allowance"], ["deduction", "Deduction"], ["not_reported", "Not reported"]];
const CODES = {
  paid_leave: [["O", "O · Other paid leave (annual, personal, long service)"], ["C", "C · Cash out of leave in service"], ["U", "U · Unused leave on termination"],
    ["P", "P · Paid parental leave"], ["W", "W · Workers' compensation"], ["A", "A · Ancillary and defence leave"]],
  allowance: [["CD", "CD · Cents per kilometre"], ["AD", "AD · Award transport payments"], ["LD", "LD · Laundry"], ["MD", "MD · Overtime meal"], ["RD", "RD · Travel (domestic or overseas)"],
    ["TD", "TD · Tools"], ["KN", "KN · Task"], ["QN", "QN · Qualification and certificate"], ["G1", "OD G1 · Other: general"], ["H1", "OD H1 · Other: home office"],
    ["ND", "OD ND · Other: non-deductible"], ["T1", "OD T1 · Other: transport and fares"], ["U1", "OD U1 · Other: uniform"], ["V1", "OD V1 · Other: private vehicle"]],
  deduction: [["F", "F · Union or professional association fees"], ["W", "W · Workplace giving"], ["G", "G · Child support garnishee"], ["D", "D · Child support deduction"]]
};
function downloadText(fileName, content, type = "application/json") {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = fileName;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
const pairs = o => Object.entries(o || {}).filter(([, v]) => Number(v)).map(([k, v]) => `${k} ${money(v)}`).join(", ");

export async function renderStp(view, ctx) {
  const [id] = (ctx.sub || "").split("/");
  if (id) return eventView(view, ctx, id);
  const st = { tab: new URLSearchParams(location.hash.split("?")[1] || "").get("tab") || "events" };
  let d;
  const draw = () => {
    const s = d.settings;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PAYROLL</p><h1>Single Touch Payroll</h1>
        <p class="muted">STP Phase 2 information for each pay run, checked against the reporting rules. <strong>Sending to the ATO is switched off</strong>: keep reporting
          through your current STP payroll product and use these to check it. Sending needs ATO product registration, conformance testing and an approved sending service provider first.</p></div></header>
      <div class="tabs" role="tablist">${[["events", "Events"], ["mapping", "Pay item mapping"], ["settings", "Settings"]].map(([k, l]) =>
        `<button type="button" role="tab" aria-selected="${k === st.tab}" class="${k === st.tab ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
      ${st.tab === "events" ? `
        ${d.can.prepare && d.runsWithoutEvent.length ? `<section class="panel"><h2>Pay runs without an STP pay event</h2><table class="tbl compact"><tbody>
          ${d.runsWithoutEvent.map(r => `<tr><td class="mono">${safe(r.number)}</td><td>Paid ${date(r.paymentDate)}</td><td><button type="button" class="btn" data-pay="${safe(r.id)}">Prepare pay event</button></td></tr>`).join("")}
        </tbody></table></section>` : ""}
        ${d.can.prepare ? `<form class="panel toolbar" data-year>
          <div class="fld"><label for="sy-k">Event</label><select id="sy-k">${options([["update", "Update event (corrections)"], ["finalisation", "Finalisation for the year"]])}</select></div>
          <div class="fld"><label for="sy-y">Financial year</label><select id="sy-y">${options(d.years.map(y => [y.start, y.label]))}</select></div>
          ${field({ id: "sy-d", label: "Year to date at (optional)", type: "date" })}
          <button class="btn" type="submit">Prepare</button></form>` : ""}
        <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Event</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col" class="num">Employees</th>
          <th scope="col" class="num">Gross YTD</th><th scope="col" class="num">PAYG YTD</th><th scope="col">Prepared</th><th scope="col">Ready</th></tr></thead><tbody>
          ${d.events.map(e => `<tr><td><a href="#/stp/${safe(e.id)}"><strong>${safe(KIND[e.kind])}</strong></a>${e.payRun ? `<small class="mono">${safe(e.payRun)}</small>` : ""}</td>
            <td class="nowrap">${date(e.asAt)}</td><td>${chip(...STP_STATUS[e.status])}${e.withErrors ? `<small>${e.withErrors} with errors</small>` : ""}</td><td class="num">${e.payees}</td>
            <td class="num mono">${money(e.gross)}</td><td class="num mono">${money(e.payg)}</td><td>${safe(e.createdBy || "")}</td><td>${safe(e.readyBy || "")}</td></tr>`).join("")
            || '<tr><td colspan="8" class="muted">No STP events yet.</td></tr>'}
        </tbody></table></div></section>` : ""}
      ${st.tab === "mapping" ? `<section class="panel"><p class="muted">Each pay item is reported in its STP Phase 2 category. Check these with your accountant;
        changes apply to events prepared from now on.</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Pay item</th><th scope="col">Kind</th><th scope="col">STP category</th><th scope="col">Type</th><th scope="col"></th></tr></thead><tbody>
        ${d.items.map(i => `<tr data-item="${safe(i.id)}"><td><span class="mono">${safe(i.code)}</span> ${safe(i.name)}${i.active ? "" : " <small>Not in use</small>"}</td><td>${safe(i.kind)}</td>
          <td><select name="category" aria-label="STP category for ${safe(i.name)}" ${d.can.settings ? "" : "disabled"}>${options(CATEGORY, i.category)}</select></td>
          <td><select name="code" aria-label="STP type for ${safe(i.name)}" ${d.can.settings && CODES[i.category] ? "" : "disabled"}>${CODES[i.category] ? options(CODES[i.category], i.stpCode) : '<option value="">—</option>'}</select></td>
          <td>${d.can.settings ? '<button type="button" class="link" data-map>Save</button>' : ""}</td></tr>`).join("")}
        </tbody></table></div>
        <p class="muted small">Reimbursements and deductions other than union fees, workplace giving and child support aren't reported. Salary sacrifice to super is reported
          separately (type S) and taken off gross; super guarantee, ordinary time earnings and reportable employer super contributions come from the pay runs.</p></section>` : ""}
      ${st.tab === "settings" ? `<form class="panel" data-settings><h2>Employer details for STP</h2>
        <p>${safe(s.employer.name || "")} · ABN ${safe(s.employer.abn || "not set")} <span class="muted small">(Company settings)</span></p>
        <div class="grid3">
          ${field({ id: "ss-b", label: "Branch number", value: s.branch, attrs: `inputmode="numeric" maxlength="3" ${d.can.settings ? "" : "disabled"}`, hint: "Usually 001" })}
          ${field({ id: "ss-n", label: "Contact name", value: s.contactName || "", attrs: d.can.settings ? 'maxlength="120"' : "disabled" })}
          ${field({ id: "ss-p", label: "Contact phone", value: s.contactPhone || "", attrs: d.can.settings ? 'maxlength="30"' : "disabled" })}
          ${field({ id: "ss-e", label: "Contact email", type: "email", value: s.contactEmail || "", attrs: d.can.settings ? 'maxlength="200"' : "disabled" })}
        </div>
        <p class="muted small">Software ID (BMS ID) for this payroll: <span class="mono">${safe(s.bmsId)}</span>. Sending to the ATO: <strong>off</strong>.</p>
        ${d.can.settings ? '<div class="actions"><button class="btn primary" type="submit">Save</button></div>' : ""}</form>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  const load = async () => { d = await call("stp_overview"); draw(); };
  await load();
  view.addEventListener("change", e => {
    const row = e.target.closest("[data-item]");
    if (row && e.target.name === "category") {
      const codes = CODES[e.target.value];
      const sel = row.querySelector("[name=code]");
      sel.innerHTML = codes ? options(codes) : '<option value="">—</option>';
      sel.disabled = !codes;
    }
  });
  view.addEventListener("click", async e => {
    const tab = e.target.closest("[data-tab]"), pay = e.target.closest("[data-pay]"), map = e.target.closest("[data-map]");
    try {
      if (tab) { st.tab = tab.dataset.tab; draw(); }
      else if (pay) { const r = await call("stp_event_pay", { runId: pay.dataset.pay }); location.hash = `#/stp/${r.id}`; }
      else if (map) {
        const row = map.closest("[data-item]");
        await call("stp_item_map", { id: row.dataset.item, category: row.querySelector("[name=category]").value, code: row.querySelector("[name=code]").value });
        flash(view, "Saved.", "good");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`)?.value ?? "";
    try {
      if (e.target.matches("[data-year]")) {
        const r = await call("stp_event_year", { kind: v("sy-k"), yearStart: v("sy-y"), asAt: v("sy-d") });
        location.hash = `#/stp/${r.id}`;
      } else if (e.target.matches("[data-settings]")) {
        await call("stp_settings_save", { branch: v("ss-b"), contactName: v("ss-n"), contactPhone: v("ss-p"), contactEmail: v("ss-e") });
        await load(); flash(view, "Saved.", "good");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function eventView(view, ctx, id) {
  let d;
  const load = async () => {
    d = await call("stp_event_get", { id });
    const ev = d.event, c = d.can;
    const errs = d.records.filter(r => r.errors.length).length;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PAYROLL · STP</p><h1>${safe(KIND[ev.kind])} ${chip(...STP_STATUS[ev.status])}</h1>
        <p class="muted">${ev.payRun ? `Pay run <a href="#/pay-runs/${safe(ev.payRun.id)}">${safe(ev.payRun.number)}</a>, paid ${date(ev.asAt)}` : `Year to date at ${date(ev.asAt)}`}
          · financial year ${safe(ev.yearStart.slice(0, 4))}-${String(Number(ev.yearStart.slice(0, 4)) + 1).slice(2)} · prepared by ${safe(ev.createdBy || "")} ${dateTime(ev.createdAt)}
          ${ev.readyBy ? ` · ready, ${safe(ev.readyBy)} ${dateTime(ev.readyAt)}` : ""}</p></div>
        <div class="top-actions"><a class="btn" href="#/stp">All events</a></div></header>
      <section class="panel">
        ${ev.errors.length ? `<div class="note bad-text"><strong>Employer details to fix:</strong><ul>${ev.errors.map(x => `<li>${safe(x)}</li>`).join("")}</ul></div>` : ""}
        <p>${d.records.length} employee(s)${errs ? `, <strong class="bad-text">${errs} with errors</strong>` : ", no errors"}. Year to date: gross (salary and wages, after salary sacrifice) ${money(ev.totals.gross)}, PAYG ${money(ev.totals.payg)}${ev.totals.runGross != null ? ` (this pay run: gross ${money(ev.totals.runGross)}, PAYG ${money(ev.totals.runPayg)})` : ""}.</p>
        <div class="actions">
          ${c.check ? '<button type="button" class="btn" data-act="check">Check again</button>' : ""}
          ${c.ready ? '<button type="button" class="btn primary" data-act="ready">Mark ready</button>' : ""}
          ${ev.status === "validated" && !c.ready ? '<span class="muted small">Someone who approves pay runs (not the preparer) marks it ready.</span>' : ""}
          ${c.export ? '<button type="button" class="btn" data-act="json">Download (JSON)</button> <button type="button" class="btn" data-act="csv">Download (CSV)</button>' : ""}
          <button type="button" class="btn" disabled title="Sending to the ATO is switched off">Send to the ATO (off)</button>
          ${c.delete ? '<button type="button" class="btn danger" data-act="delete">Delete</button>' : ""}
        </div>
        <p class="muted small">Downloads hold tax file numbers: keep them private and delete them after use. Every download is logged.</p>
      </section>
      <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Employee</th><th scope="col">Codes</th><th scope="col" class="num">Gross</th>
        <th scope="col">Other amounts</th><th scope="col" class="num">PAYG</th><th scope="col">Super</th></tr></thead><tbody>
        ${d.records.map(r => {
          const y = r.ytd, p = r.payee;
          const other = [y.overtime ? `Overtime ${money(y.overtime)}` : "", y.bonus ? `Bonuses ${money(y.bonus)}` : "", pairs(y.paidLeave) ? `Paid leave ${pairs(y.paidLeave)}` : "",
            pairs(y.allowances) ? `Allowances ${pairs(y.allowances)}` : "", pairs(y.deductions) ? `Deductions ${pairs(y.deductions)}` : "",
            Number(y.salarySacrifice?.S) ? `Salary sacrifice S ${money(y.salarySacrifice.S)}` : ""].filter(Boolean);
          return `<tr><td><a href="#/employees/${safe(r.employeeId)}">${safe(r.name || "")}</a><small>${safe(p.familyName || "")}, ${safe(p.givenNames || "")} · ${safe(r.number || "")} ${p.hidden ? "" : ` · TFN ${safe(p.tfn || "")}`}</small>
              ${r.final ? "<small>Final</small>" : ""}${r.errors.map(x => `<small class="bad-text">${safe(x)}</small>`).join("")}${r.warnings.map(x => `<small class="muted">Note: ${safe(x)}</small>`).join("")}</td>
            <td class="mono small">${safe(p.employmentBasis || "?")} · ${safe(p.taxTreatment)} · ${safe(p.incomeType)}${p.cessationType ? ` · ceased ${safe(p.cessationType)}` : ""}</td>
            <td class="num mono">${money(y.gross)}</td><td class="small">${other.map(safe).join("<br>") || '<span class="muted">—</span>'}</td><td class="num mono">${money(y.payg)}</td>
            <td class="small mono">L ${money(y.super?.L)}<br>OTE ${money(y.super?.OTE)}${Number(y.super?.RESC) ? `<br>RESC ${money(y.super.RESC)}` : ""}</td></tr>`;
        }).join("")}
      </tbody></table></div>
      <p class="muted small">Codes: employment basis (F full-time, P part-time, C casual) · tax treatment · income type. Fix an employee's details on their page (STP details), then check again.</p></section>
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("click", async e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    try {
      if (act === "check") { const r = await call("stp_event_check", { id }); await load(); flash(view, r.status === "validated" ? "Checked: no errors." : "Still has errors.", r.status === "validated" ? "good" : "warn"); }
      else if (act === "ready") {
        if (!window.confirm("Mark this STP event ready? Its figures are fixed now.")) return;
        await call("stp_event_ready", { id }); await load(); flash(view, "Ready.", "good");
      } else if (act === "json" || act === "csv") {
        const f = await call("stp_event_export", { id });
        if (act === "json") downloadText(`${f.fileName}.json`, f.json); else downloadCsv(`${f.fileName}.csv`, f.csv);
      } else if (act === "delete") {
        if (!window.confirm("Delete this STP event?")) return;
        await call("stp_event_delete", { id }); location.hash = "#/stp";
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/** The STP details section on an employee's page. */
export function stpDetailsForm(p, canEdit) {
  const s = p.stp || {}, a = s.homeAddress || {};
  const dis = canEdit ? "" : "disabled";
  return `<form class="panel" data-stp novalidate><h2>STP details</h2>
    <div class="grid3">
      ${field({ id: "st-fn", label: "Family name", value: s.familyName || "", attrs: `maxlength="40" ${dis}`, hint: "As on their tax file number declaration" })}
      ${field({ id: "st-gn", label: "Given names", value: s.givenNames || "", attrs: `maxlength="80" ${dis}` })}
      <div class="fld"><label for="st-it">Income type</label><select id="st-it" ${dis}>${options([["SAW", "SAW · Salary and wages"], ["CHP", "CHP · Closely held payee"], ["WHM", "WHM · Working holiday maker"],
        ["IAA", "IAA · Inbound assignee"], ["FEI", "FEI · Foreign employment income"], ["SWP", "SWP · Seasonal worker programme"], ["LAB", "LAB · Labour hire"],
        ["VOL", "VOL · Voluntary agreement"], ["OSP", "OSP · Other specified payments"], ["JPD", "JPD · Joint petroleum development area"]], s.incomeType || "SAW")}</select></div>
      ${field({ id: "st-st", label: "Home address", value: a.street || "", attrs: `maxlength="120" autocomplete="off" ${dis}` })}
      ${field({ id: "st-sb", label: "Suburb", value: a.suburb || "", attrs: `maxlength="60" ${dis}` })}
      <div class="fld"><label for="st-se">State</label><select id="st-se" ${dis}><option value="">State…</option>${options(["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"].map(x => [x, x]), a.state)}</select></div>
      ${field({ id: "st-pc", label: "Postcode", value: a.postcode || "", attrs: `inputmode="numeric" maxlength="4" ${dis}` })}
      ${field({ id: "st-cc", label: "Country (two letters, if needed)", value: s.country || "", attrs: `maxlength="2" ${dis}`, hint: "Only for WHM, IAA and FEI" })}
      <div class="fld"><label for="st-ce">Reason they left (when they finish)</label><select id="st-ce" ${dis}>${options([["", "Still employed"], ["V", "V · Voluntary (resigned, retired)"],
        ["I", "I · Ill health"], ["D", "D · Deceased"], ["R", "R · Redundancy"], ["F", "F · Dismissal"], ["C", "C · Contract ended"], ["T", "T · Transfer"]], s.cessationType || "")}</select></div>
    </div>
    ${canEdit ? '<div class="actions"><button class="btn" type="submit">Save STP details</button></div>' : ""}</form>`;
}

export function readStpDetails(view) {
  const v = x => view.querySelector(`#${x}`)?.value.trim() ?? "";
  return { familyName: v("st-fn"), givenNames: v("st-gn"), incomeType: v("st-it"), country: v("st-cc"), cessationType: v("st-ce"),
    homeAddress: { street: v("st-st"), suburb: v("st-sb"), state: v("st-se"), postcode: v("st-pc") } };
}
